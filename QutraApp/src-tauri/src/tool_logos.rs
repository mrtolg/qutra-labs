//! Official logos for registered tools the app has no bundled logo for.
//!
//! The renderer names an installation; Rust reads that installation's own
//! documentation address from the registry and decides where a logo may come
//! from:
//! - a GitHub repository: the owner's avatar when the owner is an
//!   organization, else the repository's homepage;
//! - any other site: its apple-touch-icon, its icon links, then
//!   `/favicon.ico`.
//!
//! Every request is HTTPS to a public host name, follows at most three
//! redirects that stay HTTPS, and reads a capped body. The name is resolved
//! by `net_guard`, which drops every address that is not public and connects
//! to what is left, on the first request and on every redirect, so a name that
//! points inside the network (or answers differently a second time) reaches
//! nothing. The picture is decoded
//! with limits and re-encoded as a 64 px PNG, so what is stored is pixels the
//! app made, never the downloaded bytes. Each installation is tried once: the
//! outcome, found or not, is recorded and a later request returns it without
//! touching the network.

use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use futures_util::StreamExt;
use image::{imageops::FilterType, DynamicImage, ImageFormat, ImageReader, Limits, RgbaImage};
use reqwest::Url;

use crate::net_guard::{self, check_public_https, Access, GuardedResolver};

/// The stored logo's edge, in pixels.
pub const LOGO_SIZE: u32 = 64;
/// A source smaller than this would only be blurred up; the letter tile reads
/// better.
const MIN_SOURCE_EDGE: u32 = 32;
const MAX_SOURCE_EDGE: u32 = 4096;
const PAGE_CAP: usize = 512 * 1024;
const IMAGE_CAP: usize = 512 * 1024;
const API_CAP: usize = 64 * 1024;
const MAX_REDIRECTS: usize = 3;
/// Icon links tried from one page before giving up on it.
const MAX_ICON_LINKS: usize = 4;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
const INDEX_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LogoState {
    Found,
    None,
}

/// The backdrop a logo needs to stay visible: `light` for dark ink on a
/// transparent background, `dark` for light ink, `none` for an opaque square.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Plate {
    None,
    Light,
    Dark,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct LogoRecord {
    state: LogoState,
    /// Where the picture came from, for the user to see.
    source: Option<String>,
    plate: Plate,
    checked_at: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct LogoIndex {
    version: u32,
    logos: BTreeMap<String, LogoRecord>,
}

impl Default for LogoIndex {
    fn default() -> Self {
        Self {
            version: INDEX_VERSION,
            logos: BTreeMap::new(),
        }
    }
}

/// What the renderer gets: a found logo as a `data:` URL (the page's CSP
/// already allows those), or the state that says to keep the letter tile.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolLogoView {
    pub installation_id: String,
    /// `found`, `none` (tried, nothing usable) or `unknown` (never tried).
    pub state: String,
    pub data_url: Option<String>,
    pub source: Option<String>,
    pub plate: Option<Plate>,
}

impl ToolLogoView {
    fn unknown(id: &str) -> Self {
        Self {
            installation_id: id.to_string(),
            state: "unknown".into(),
            data_url: None,
            source: None,
            plate: None,
        }
    }
}

pub struct ToolLogos {
    dir: PathBuf,
    index: Mutex<LogoIndex>,
    in_flight: Mutex<HashSet<String>>,
}

impl ToolLogos {
    /// Opens `<app data>/tool-logos`. An unreadable index starts empty: the
    /// worst case is one more attempt per tool.
    pub fn load(base_dir: &Path) -> Self {
        let dir = base_dir.join("tool-logos");
        let index = fs::read(dir.join("index.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<LogoIndex>(&bytes).ok())
            .unwrap_or_default();
        Self {
            dir,
            index: Mutex::new(index),
            in_flight: Mutex::new(HashSet::new()),
        }
    }

    /// The recorded outcome for an installation, read from disk only.
    pub fn view(&self, id: &str) -> Result<ToolLogoView, String> {
        validate_id(id)?;
        let record = self.lock_index()?.logos.get(id).cloned();
        Ok(match record {
            None => ToolLogoView::unknown(id),
            Some(record) => self.view_of(id, &record),
        })
    }

    /// Every recorded outcome among `ids`, for one call per page.
    pub fn views(&self, ids: &[String]) -> Result<Vec<ToolLogoView>, String> {
        let index = self.lock_index()?;
        Ok(ids
            .iter()
            .filter(|id| validate_id(id).is_ok())
            .filter_map(|id| index.logos.get(id).map(|record| (id, record.clone())))
            .collect::<Vec<_>>()
            .into_iter()
            .map(|(id, record)| self.view_of(id, &record))
            .collect())
    }

    /// Claims an installation for one attempt. `Ok(None)` means it may be
    /// fetched now; `Ok(Some(view))` is the outcome already recorded.
    pub fn begin(&self, id: &str) -> Result<Option<ToolLogoView>, String> {
        validate_id(id)?;
        if self.lock_index()?.logos.contains_key(id) {
            return self.view(id).map(Some);
        }
        let mut in_flight = self
            .in_flight
            .lock()
            .map_err(|_| "logo_state_poisoned".to_string())?;
        if !in_flight.insert(id.to_string()) {
            return Err("logo_fetch_in_progress".into());
        }
        Ok(None)
    }

    /// Records the attempt's outcome and releases the claim.
    pub fn finish(&self, id: &str, outcome: Option<Fetched>) -> Result<ToolLogoView, String> {
        let result = self.record(id, outcome);
        self.abandon(id);
        result
    }

    /// Releases the claim without recording anything: the attempt never
    /// reached a source (offline), so a later request may try again.
    pub fn abandon(&self, id: &str) {
        if let Ok(mut in_flight) = self.in_flight.lock() {
            in_flight.remove(id);
        }
    }

    fn record(&self, id: &str, outcome: Option<Fetched>) -> Result<ToolLogoView, String> {
        validate_id(id)?;
        fs::create_dir_all(&self.dir).map_err(|_| "logo_store_unavailable".to_string())?;
        let record = match outcome {
            Some(found) => {
                crate::durable_file::replace_file(&self.png_path(id), &found.png)
                    .map_err(|_| "logo_store_unavailable".to_string())?;
                LogoRecord {
                    state: LogoState::Found,
                    source: Some(found.source),
                    plate: found.plate,
                    checked_at: crate::tool_registry::now_ms(),
                }
            }
            None => LogoRecord {
                state: LogoState::None,
                source: None,
                plate: Plate::None,
                checked_at: crate::tool_registry::now_ms(),
            },
        };
        let mut index = self.lock_index()?;
        index.logos.insert(id.to_string(), record.clone());
        let bytes = serde_json::to_vec_pretty(&*index).map_err(|_| "logo_store_unavailable")?;
        crate::durable_file::replace_file(&self.dir.join("index.json"), &bytes)
            .map_err(|_| "logo_store_unavailable".to_string())?;
        drop(index);
        Ok(self.view_of(id, &record))
    }

    fn view_of(&self, id: &str, record: &LogoRecord) -> ToolLogoView {
        let data_url = match record.state {
            LogoState::Found => fs::read(self.png_path(id))
                .ok()
                .map(|png| format!("data:image/png;base64,{}", base64(&png))),
            LogoState::None => None,
        };
        // A found logo whose file is gone reads as "none" rather than as a
        // broken picture; the letter tile stands in.
        let state = if data_url.is_some() { "found" } else { "none" };
        ToolLogoView {
            installation_id: id.to_string(),
            state: state.into(),
            data_url,
            source: record.source.clone(),
            plate: (state == "found").then_some(record.plate),
        }
    }

    fn png_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.png"))
    }

    fn lock_index(&self) -> Result<std::sync::MutexGuard<'_, LogoIndex>, String> {
        self.index
            .lock()
            .map_err(|_| "logo_state_poisoned".to_string())
    }
}

/// Installation ids are `tool-<uuid>`; anything else never reaches a path.
fn validate_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err("invalid_installation_id".into())
    }
}

/* ---------- Where a logo may come from ---------- */

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LogoPlan {
    /// A GitHub owner, with the repository when the address names one.
    GitHub {
        owner: String,
        repo: Option<String>,
    },
    /// A site's page, read for its icon links.
    Site(Url),
    Nothing,
}

/// GitHub paths that are not an owner.
const GITHUB_RESERVED: &[&str] = &[
    "about",
    "apps",
    "collections",
    "enterprise",
    "explore",
    "features",
    "issues",
    "login",
    "marketplace",
    "notifications",
    "pricing",
    "pulls",
    "search",
    "settings",
    "sponsors",
    "topics",
];

/// Decides the source from an installation's documentation address. An
/// `http://` address is read over HTTPS; anything else, or an address that
/// fails the public-host check, plans nothing.
pub fn plan_for(doc_url: &str) -> LogoPlan {
    let Ok(mut url) = Url::parse(doc_url.trim()) else {
        return LogoPlan::Nothing;
    };
    if url.scheme() == "http" && url.set_scheme("https").is_err() {
        return LogoPlan::Nothing;
    }
    if url.scheme() != "https" || check_public_https(&url).is_err() {
        return LogoPlan::Nothing;
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if host == "github.com" || host == "www.github.com" {
        let mut segments = url
            .path_segments()
            .map(|parts| parts.filter(|part| !part.is_empty()).collect::<Vec<_>>())
            .unwrap_or_default();
        if segments.first() == Some(&"orgs") {
            segments.remove(0);
        }
        let Some(owner) = segments.first().filter(|owner| valid_github_name(owner)) else {
            return LogoPlan::Nothing;
        };
        if GITHUB_RESERVED.contains(&owner.to_ascii_lowercase().as_str()) {
            return LogoPlan::Nothing;
        }
        let repo = segments
            .get(1)
            .map(|repo| repo.trim_end_matches(".git"))
            .filter(|repo| valid_github_name(repo))
            .map(str::to_string);
        return LogoPlan::GitHub {
            owner: owner.to_string(),
            repo,
        };
    }
    url.set_fragment(None);
    LogoPlan::Site(url)
}

fn valid_github_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && name != "."
        && name != ".."
}

/// The page's icon links, best first: apple-touch-icon, then icons by their
/// declared size, then `/favicon.ico`. SVG is skipped: the app cannot draw
/// it into a PNG.
pub fn icon_links(html: &str, page: &Url) -> Vec<Url> {
    let tag = regex::Regex::new(r"(?is)<link\b[^>]*>").expect("static regex");
    let mut ranked: Vec<(u8, i64, Url)> = Vec::new();
    for found in tag.find_iter(html).take(200) {
        let tag = found.as_str();
        let (Some(rel), Some(href)) = (attribute(tag, "rel"), attribute(tag, "href")) else {
            continue;
        };
        let rel = rel.to_ascii_lowercase();
        let rank = if rel.contains("apple-touch-icon") {
            0
        } else if rel.split_whitespace().any(|word| word == "icon") {
            1
        } else {
            continue;
        };
        let type_svg = attribute(tag, "type").is_some_and(|t| t.contains("svg"));
        let Ok(url) = page.join(href.trim()) else {
            continue;
        };
        if type_svg || url.path().to_ascii_lowercase().ends_with(".svg") {
            continue;
        }
        let size = attribute(tag, "sizes")
            .and_then(|sizes| {
                sizes
                    .split_whitespace()
                    .filter_map(|size| size.split(['x', 'X']).next()?.parse::<i64>().ok())
                    .max()
            })
            .unwrap_or(0);
        ranked.push((rank, -size, url));
    }
    ranked.sort_by_key(|(rank, size, _)| (*rank, *size));
    let mut links: Vec<Url> = Vec::new();
    for (_, _, url) in ranked {
        if !links.contains(&url) {
            links.push(url);
        }
    }
    if let Ok(favicon) = page.join("/favicon.ico") {
        if !links.contains(&favicon) {
            links.push(favicon);
        }
    }
    links
}

/// One attribute's value from a tag, quoted or not.
fn attribute(tag: &str, name: &str) -> Option<String> {
    let pattern = format!(r#"(?is)\s{name}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#);
    let found = regex::Regex::new(&pattern).ok()?.captures(tag)?;
    found
        .get(1)
        .or_else(|| found.get(2))
        .or_else(|| found.get(3))
        .map(|value| value.as_str().replace("&amp;", "&"))
}

/* ---------- Turning a download into the app's own PNG ---------- */

/// Decodes PNG, JPEG, ICO or BMP with size limits, refuses a picture too
/// small to show, and draws it centred on a transparent 64 px square.
pub fn normalize_logo(bytes: &[u8]) -> Result<(Vec<u8>, Plate), String> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "not_an_image".to_string())?;
    match reader.format() {
        Some(ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::Ico | ImageFormat::Bmp) => {}
        Some(_) => return Err("unsupported_image".into()),
        None => return Err("not_an_image".into()),
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SOURCE_EDGE);
    limits.max_image_height = Some(MAX_SOURCE_EDGE);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|_| "not_an_image".to_string())?;
    if decoded.width().min(decoded.height()) < MIN_SOURCE_EDGE {
        return Err("image_too_small".into());
    }
    let trimmed = trim_transparent(decoded.to_rgba8());
    let plate = plate_for(&trimmed);
    let pad = if plate == Plate::None { 0 } else { 6 };
    let inner = LOGO_SIZE - 2 * pad;
    let fitted = DynamicImage::ImageRgba8(trimmed)
        .resize(inner, inner, FilterType::Lanczos3)
        .to_rgba8();
    let mut canvas = RgbaImage::new(LOGO_SIZE, LOGO_SIZE);
    let x = i64::from((LOGO_SIZE - fitted.width()) / 2);
    let y = i64::from((LOGO_SIZE - fitted.height()) / 2);
    image::imageops::overlay(&mut canvas, &fitted, x, y);
    let mut png = Vec::new();
    DynamicImage::ImageRgba8(canvas)
        .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
        .map_err(|_| "encode_failed".to_string())?;
    Ok((png, plate))
}

/// Crops fully transparent margins, so a small mark in a big empty canvas
/// still fills its tile.
fn trim_transparent(image: RgbaImage) -> RgbaImage {
    let (width, height) = image.dimensions();
    let (mut left, mut top, mut right, mut bottom) = (width, height, 0, 0);
    for (x, y, pixel) in image.enumerate_pixels() {
        if pixel[3] > 8 {
            left = left.min(x);
            top = top.min(y);
            right = right.max(x);
            bottom = bottom.max(y);
        }
    }
    if left > right || top > bottom {
        return image;
    }
    image::imageops::crop_imm(&image, left, top, right - left + 1, bottom - top + 1).to_image()
}

/// Opaque squares need no backdrop; transparent marks get the one that keeps
/// their ink visible (the same rule the bundled logos were built with).
fn plate_for(image: &RgbaImage) -> Plate {
    let total = (image.width() * image.height()).max(1) as f64;
    let see_through = image.pixels().filter(|p| p[3] < 250).count() as f64 / total;
    if see_through < 0.04 {
        return Plate::None;
    }
    let (sum, count) =
        image
            .pixels()
            .filter(|p| p[3] > 200)
            .fold((0.0_f64, 0_u32), |(sum, count), p| {
                let lum = (0.2126 * f64::from(p[0])
                    + 0.7152 * f64::from(p[1])
                    + 0.0722 * f64::from(p[2]))
                    / 255.0;
                (sum + lum, count + 1)
            });
    if count == 0 || sum / f64::from(count) < 0.42 {
        Plate::Light
    } else {
        Plate::Dark
    }
}

/// Standard base64 with padding, for the `data:` URL.
pub fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/* ---------- Fetching ---------- */

/// A logo the attempt found, ready to store.
#[derive(Debug)]
pub struct Fetched {
    pub png: Vec<u8>,
    pub plate: Plate,
    pub source: String,
}

/// One HTTPS GET with a capped body. Tests answer from recorded fixtures.
pub(crate) trait Fetch {
    async fn get(&self, url: &Url, cap: usize) -> Result<Vec<u8>, String>;
}

#[derive(Deserialize)]
struct GitHubOwner {
    #[serde(rename = "type")]
    kind: String,
    avatar_url: Option<String>,
}

#[derive(Deserialize)]
struct GitHubRepo {
    homepage: Option<String>,
}

/// Follows the plan to the first picture that normalizes. `None` means
/// nothing usable was found; network errors count as that, since the
/// attempt is made once and the letter tile is the honest fallback.
pub(crate) async fn resolve(plan: &LogoPlan, fetch: &impl Fetch) -> Option<Fetched> {
    match plan {
        LogoPlan::Nothing => None,
        LogoPlan::Site(page) => from_site(page, fetch).await,
        LogoPlan::GitHub { owner, repo } => {
            let api = Url::parse(&format!("https://api.github.com/users/{owner}")).ok()?;
            let body = fetch.get(&api, API_CAP).await.ok()?;
            let profile: GitHubOwner = serde_json::from_slice(&body).ok()?;
            if profile.kind == "Organization" {
                let avatar = profile.avatar_url.as_deref().and_then(avatar_url)?;
                return from_image(&avatar, fetch).await;
            }
            // A person's avatar is a photo, not the tool's mark: try the
            // repository's own homepage instead.
            let repo = repo.as_ref()?;
            let api = Url::parse(&format!("https://api.github.com/repos/{owner}/{repo}")).ok()?;
            let body = fetch.get(&api, API_CAP).await.ok()?;
            let homepage = serde_json::from_slice::<GitHubRepo>(&body).ok()?.homepage?;
            match plan_for(&homepage) {
                LogoPlan::Site(page) => from_site(&page, fetch).await,
                _ => None,
            }
        }
    }
}

/// GitHub's avatar address, asked at 128 px; only GitHub's avatar host.
fn avatar_url(raw: &str) -> Option<Url> {
    let mut url = Url::parse(raw).ok()?;
    if url.host_str() != Some("avatars.githubusercontent.com") || check_public_https(&url).is_err()
    {
        return None;
    }
    let keep: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(key, _)| key != "s" && key != "size")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    url.query_pairs_mut()
        .clear()
        .extend_pairs(keep)
        .append_pair("s", "128");
    Some(url)
}

async fn from_site(page: &Url, fetch: &impl Fetch) -> Option<Fetched> {
    let links = match fetch.get(page, PAGE_CAP).await {
        Ok(body) => icon_links(&String::from_utf8_lossy(&body), page),
        // The page itself may refuse a plain GET; its favicon may not.
        Err(_) => page.join("/favicon.ico").into_iter().collect(),
    };
    for link in links.iter().take(MAX_ICON_LINKS) {
        if let Some(found) = from_image(link, fetch).await {
            return Some(found);
        }
    }
    None
}

async fn from_image(url: &Url, fetch: &impl Fetch) -> Option<Fetched> {
    check_public_https(url).ok()?;
    let bytes = fetch.get(url, IMAGE_CAP).await.ok()?;
    let (png, plate) = normalize_logo(&bytes).ok()?;
    Some(Fetched {
        png,
        plate,
        source: url.to_string(),
    })
}

/// Remembers whether any request got an answer from a server, so an attempt
/// made while offline is not recorded as "no logo".
pub(crate) struct Tracked<F> {
    inner: F,
    reached: std::sync::atomic::AtomicBool,
}

impl<F: Fetch> Tracked<F> {
    pub fn new(inner: F) -> Self {
        Self {
            inner,
            reached: std::sync::atomic::AtomicBool::new(false),
        }
    }

    pub fn reached(&self) -> bool {
        self.reached.load(std::sync::atomic::Ordering::Relaxed)
    }
}

impl<F: Fetch> Fetch for Tracked<F> {
    async fn get(&self, url: &Url, cap: usize) -> Result<Vec<u8>, String> {
        let result = self.inner.get(url, cap).await;
        if !matches!(&result, Err(reason) if reason == "network_error") {
            self.reached
                .store(true, std::sync::atomic::Ordering::Relaxed);
        }
        result
    }
}

/// The real network: HTTPS only, redirects checked hop by hop, and every
/// connection made to an address `net_guard` found public.
pub struct HttpFetch {
    client: reqwest::Client,
}

impl HttpFetch {
    pub fn new() -> Result<Self, String> {
        Self::with_resolver(GuardedResolver::new(Access::Public))
    }

    pub(crate) fn with_resolver(resolver: std::sync::Arc<GuardedResolver>) -> Result<Self, String> {
        let policy = reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS {
                attempt.error("too_many_redirects")
            } else if check_public_https(attempt.url()).is_err() {
                attempt.stop()
            } else {
                attempt.follow()
            }
        });
        let builder = reqwest::Client::builder()
            .use_rustls_tls()
            .https_only(true)
            .redirect(policy)
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .user_agent(concat!("QutraLabs/", env!("CARGO_PKG_VERSION")));
        let client = net_guard::guard_with(builder, resolver)
            .build()
            .map_err(|_| "logo_client_unavailable".to_string())?;
        Ok(Self { client })
    }
}

impl Fetch for HttpFetch {
    async fn get(&self, url: &Url, cap: usize) -> Result<Vec<u8>, String> {
        check_public_https(url)?;
        let response = self.client.get(url.clone()).send().await.map_err(|error| {
            // A refusal is an answer, not an outage: it is recorded like
            // any other source that has no logo.
            if net_guard::is_refusal(&error) {
                "not_public".to_string()
            } else {
                "network_error".to_string()
            }
        })?;
        if !response.status().is_success() {
            return Err(format!("http_{}", response.status().as_u16()));
        }
        check_public_https(response.url())?;
        if response
            .content_length()
            .is_some_and(|length| length > cap as u64)
        {
            return Err("too_large".into());
        }
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "network_error".to_string())?;
            if body.len() + chunk.len() > cap {
                return Err("too_large".into());
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    }
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex as StdMutex;

    /// Answers from recorded fixtures and remembers what was asked.
    struct Fixtures {
        answers: HashMap<String, Vec<u8>>,
        asked: StdMutex<Vec<String>>,
    }

    impl Fixtures {
        fn new(answers: &[(&str, Vec<u8>)]) -> Self {
            Self {
                answers: answers
                    .iter()
                    .map(|(url, body)| (url.to_string(), body.clone()))
                    .collect(),
                asked: StdMutex::new(Vec::new()),
            }
        }
        fn asked(&self) -> Vec<String> {
            self.asked.lock().unwrap().clone()
        }
    }

    impl Fetch for Fixtures {
        async fn get(&self, url: &Url, cap: usize) -> Result<Vec<u8>, String> {
            self.asked.lock().unwrap().push(url.to_string());
            let body = self.answers.get(url.as_str()).cloned().ok_or("http_404")?;
            if body.len() > cap {
                return Err("too_large".into());
            }
            Ok(body)
        }
    }

    fn png(width: u32, height: u32, pixel: [u8; 4]) -> Vec<u8> {
        let image = RgbaImage::from_pixel(width, height, image::Rgba(pixel));
        let mut out = Vec::new();
        DynamicImage::ImageRgba8(image)
            .write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
            .unwrap();
        out
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(future)
    }

    #[test]
    fn a_github_repository_plans_its_owner_and_repo() {
        assert_eq!(
            plan_for("https://github.com/nmap/nmap"),
            LogoPlan::GitHub {
                owner: "nmap".into(),
                repo: Some("nmap".into())
            }
        );
        assert_eq!(
            plan_for("http://github.com/orgs/zaproxy"),
            LogoPlan::GitHub {
                owner: "zaproxy".into(),
                repo: None
            }
        );
        assert_eq!(
            plan_for("https://github.com/sullo/nikto.git"),
            LogoPlan::GitHub {
                owner: "sullo".into(),
                repo: Some("nikto".into())
            }
        );
        assert_eq!(
            plan_for("https://github.com/features/actions"),
            LogoPlan::Nothing
        );
    }

    #[test]
    fn a_site_is_read_over_https_and_local_addresses_plan_nothing() {
        assert_eq!(
            plan_for("http://nmap.org/download.html#windows"),
            LogoPlan::Site(Url::parse("https://nmap.org/download.html").unwrap())
        );
        for refused in [
            "",
            "nmap.org",
            "ftp://nmap.org/",
            "https://127.0.0.1/",
            "https://[::1]/",
            "https://localhost/",
            "https://printer.local/",
            "https://intranet/",
            "https://user:pw@nmap.org/",
            "https://nmap.org:8443/",
            "file:///C:/tools/nmap.exe",
        ] {
            assert_eq!(plan_for(refused), LogoPlan::Nothing, "{refused}");
        }
    }

    #[test]
    fn icon_links_put_apple_touch_first_then_the_largest_icon_then_favicon() {
        let page = Url::parse("https://example.org/docs/index.html").unwrap();
        let html = r#"
            <link rel="stylesheet" href="/site.css">
            <link rel="icon" type="image/svg+xml" href="/mark.svg">
            <link rel="icon" sizes="16x16" href="/icon-16.png">
            <link href='icon-64.png' rel='shortcut icon' sizes='64x64'>
            <LINK REL=apple-touch-icon HREF=https://cdn.example.org/touch.png>
        "#;
        let links: Vec<String> = icon_links(html, &page).iter().map(Url::to_string).collect();
        assert_eq!(
            links,
            vec![
                "https://cdn.example.org/touch.png",
                "https://example.org/docs/icon-64.png",
                "https://example.org/icon-16.png",
                "https://example.org/favicon.ico",
            ]
        );
    }

    #[test]
    fn a_logo_becomes_a_64_px_png_and_a_tiny_one_is_refused() {
        let (out, plate) = normalize_logo(&png(200, 100, [10, 120, 200, 255])).unwrap();
        let decoded = image::load_from_memory(&out).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (LOGO_SIZE, LOGO_SIZE));
        assert_eq!(plate, Plate::None);
        assert_eq!(
            normalize_logo(&png(16, 16, [0, 0, 0, 255])).unwrap_err(),
            "image_too_small"
        );
        assert_eq!(
            normalize_logo(b"<html>no</html>").unwrap_err(),
            "not_an_image"
        );
    }

    fn encode(image: RgbaImage) -> Vec<u8> {
        let mut out = Vec::new();
        DynamicImage::ImageRgba8(image)
            .write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
            .unwrap();
        out
    }

    /// Two horizontal bars on a transparent 64 px canvas.
    fn bars(ink: [u8; 4]) -> Vec<u8> {
        let mut image = RgbaImage::new(64, 64);
        for x in 0..64 {
            image.put_pixel(x, 0, image::Rgba(ink));
            image.put_pixel(x, 63, image::Rgba(ink));
        }
        encode(image)
    }

    #[test]
    fn transparent_dark_ink_gets_a_light_plate_and_light_ink_a_dark_one() {
        assert_eq!(
            normalize_logo(&bars([20, 20, 20, 255])).unwrap().1,
            Plate::Light
        );
        assert_eq!(
            normalize_logo(&bars([240, 240, 240, 255])).unwrap().1,
            Plate::Dark
        );
        // A solid mark in an empty canvas is trimmed first: an opaque square.
        let mut framed = RgbaImage::new(64, 64);
        for x in 16..48 {
            for y in 16..48 {
                framed.put_pixel(x, y, image::Rgba([20, 20, 20, 255]));
            }
        }
        assert_eq!(normalize_logo(&encode(framed)).unwrap().1, Plate::None);
    }

    #[test]
    fn base64_matches_the_standard_alphabet() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xff, 0xfe, 0xfd]), "//79");
    }

    #[test]
    fn an_organization_uses_its_github_avatar() {
        let fixtures = Fixtures::new(&[
            (
                "https://api.github.com/users/nmap",
                br#"{"type":"Organization","avatar_url":"https://avatars.githubusercontent.com/u/63385?v=4"}"#.to_vec(),
            ),
            (
                "https://avatars.githubusercontent.com/u/63385?v=4&s=128",
                png(128, 128, [40, 30, 90, 255]),
            ),
        ]);
        let plan = plan_for("https://github.com/nmap/nmap");
        let found = run(resolve(&plan, &fixtures)).expect("a logo");
        assert_eq!(
            found.source,
            "https://avatars.githubusercontent.com/u/63385?v=4&s=128"
        );
        assert_eq!(found.plate, Plate::None);
    }

    #[test]
    fn a_person_owned_repository_uses_its_homepage_not_the_persons_photo() {
        let fixtures = Fixtures::new(&[
            (
                "https://api.github.com/users/sullo",
                br#"{"type":"User","avatar_url":"https://avatars.githubusercontent.com/u/1?v=4"}"#
                    .to_vec(),
            ),
            (
                "https://api.github.com/repos/sullo/nikto",
                br#"{"homepage":"https://cirt.net/Nikto2"}"#.to_vec(),
            ),
            (
                "https://cirt.net/Nikto2",
                br#"<link rel="apple-touch-icon" href="/touch.png">"#.to_vec(),
            ),
            (
                "https://cirt.net/touch.png",
                png(180, 180, [200, 200, 200, 255]),
            ),
        ]);
        let found = run(resolve(
            &plan_for("https://github.com/sullo/nikto"),
            &fixtures,
        ))
        .unwrap();
        assert_eq!(found.source, "https://cirt.net/touch.png");
        assert!(!fixtures
            .asked()
            .iter()
            .any(|url| url.contains("avatars.githubusercontent.com")));
    }

    #[test]
    fn a_site_falls_back_to_its_favicon_and_a_dead_end_finds_nothing() {
        let fixtures = Fixtures::new(&[
            (
                "https://example.org/",
                b"<html><head></head></html>".to_vec(),
            ),
            (
                "https://example.org/favicon.ico",
                png(48, 48, [0, 0, 0, 255]),
            ),
        ]);
        let found = run(resolve(&plan_for("https://example.org/"), &fixtures)).unwrap();
        assert_eq!(found.source, "https://example.org/favicon.ico");

        let empty = Fixtures::new(&[("https://example.net/", b"<html></html>".to_vec())]);
        assert!(run(resolve(&plan_for("https://example.net/"), &empty)).is_none());
        assert!(run(resolve(&LogoPlan::Nothing, &empty)).is_none());
    }

    #[test]
    fn an_icon_link_to_a_local_or_plain_http_address_is_never_fetched() {
        let fixtures = Fixtures::new(&[(
            "https://example.org/",
            br#"<link rel="icon" href="http://example.org/a.png"><link rel="icon" href="https://192.168.1.4/b.png">"#.to_vec(),
        )]);
        assert!(run(resolve(&plan_for("https://example.org/"), &fixtures)).is_none());
        let asked = fixtures.asked();
        assert!(
            asked
                .iter()
                .all(|url| url.starts_with("https://example.org/")),
            "{asked:?}"
        );
    }

    #[test]
    fn each_installation_is_tried_once_and_its_outcome_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let logos = ToolLogos::load(dir.path());
        let id = "tool-1b4e28ba-2fa1-11d2-883f-0016d3cca427";
        assert_eq!(logos.view(id).unwrap().state, "unknown");
        assert!(logos.begin(id).unwrap().is_none());
        // A second request while the first is running is refused, not doubled.
        assert_eq!(logos.begin(id).unwrap_err(), "logo_fetch_in_progress");
        let (png, plate) = normalize_logo(&png(64, 64, [1, 2, 3, 255])).unwrap();
        let view = logos
            .finish(
                id,
                Some(Fetched {
                    png,
                    plate,
                    source: "https://example.org/favicon.ico".into(),
                }),
            )
            .unwrap();
        assert_eq!(view.state, "found");
        assert!(view
            .data_url
            .as_deref()
            .unwrap()
            .starts_with("data:image/png;base64,iVBOR"));

        let reopened = ToolLogos::load(dir.path());
        let again = reopened.begin(id).unwrap().expect("recorded");
        assert_eq!(again.state, "found");
        assert_eq!(
            again.source.as_deref(),
            Some("https://example.org/favicon.ico")
        );

        let other = "tool-other";
        assert!(reopened.begin(other).unwrap().is_none());
        assert_eq!(reopened.finish(other, None).unwrap().state, "none");
        assert_eq!(reopened.begin(other).unwrap().unwrap().state, "none");
        let listed = reopened
            .views(&[id.to_string(), other.to_string(), "tool-never".to_string()])
            .unwrap();
        assert_eq!(listed.len(), 2);
    }

    struct Offline;

    impl Fetch for Offline {
        async fn get(&self, _url: &Url, _cap: usize) -> Result<Vec<u8>, String> {
            Err("network_error".into())
        }
    }

    #[test]
    fn an_offline_attempt_is_told_apart_from_a_site_with_no_logo() {
        let offline = Tracked::new(Offline);
        assert!(run(resolve(&plan_for("https://example.org/"), &offline)).is_none());
        assert!(!offline.reached());

        let answered = Tracked::new(Fixtures::new(&[]));
        assert!(run(resolve(&plan_for("https://example.org/"), &answered)).is_none());
        assert!(answered.reached(), "a 404 is an answer");
    }

    /// A public-looking name whose answer points inside the network is the
    /// DNS rebinding case: the name check passes, so only the connection
    /// check stops it. The lookup is recorded, never a real name server.
    #[tokio::test]
    async fn a_name_that_resolves_to_a_private_address_is_never_connected_to() {
        use crate::net_guard::tests::Recorded;
        let lookup = Recorded::new(&[
            ("rebind.example.com", &["127.0.0.1"]),
            ("metadata.example.com", &["169.254.169.254"]),
            ("lan.example.com", &["192.168.1.10", "fd00::10"]),
        ]);
        let fetch = Tracked::new(
            HttpFetch::with_resolver(GuardedResolver::with_lookup(lookup.clone(), Access::Public))
                .unwrap(),
        );
        for host in ["rebind", "metadata", "lan"] {
            let url = Url::parse(&format!("https://{host}.example.com/logo.png")).unwrap();
            assert_eq!(
                fetch.get(&url, IMAGE_CAP).await,
                Err("not_public".to_string()),
                "{host}"
            );
        }
        assert_eq!(
            lookup.asked(),
            [
                "rebind.example.com",
                "metadata.example.com",
                "lan.example.com"
            ],
            "every name went through the guard"
        );
        assert!(
            fetch.reached(),
            "a refusal is recorded, not retried as an outage"
        );
    }

    #[test]
    fn an_id_that_is_not_an_installation_id_never_reaches_a_path() {
        let dir = tempfile::tempdir().unwrap();
        let logos = ToolLogos::load(dir.path());
        for bad in ["", "../index", "a/b", "tool-1\\x", "x".repeat(81).as_str()] {
            assert_eq!(logos.view(bad).unwrap_err(), "invalid_installation_id");
            assert!(logos.begin(bad).is_err());
        }
    }
}
