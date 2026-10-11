//! Dependency and CVE center: the packages a project's manifests name, and
//! the known vulnerabilities OSV.dev has for each exact version.
//!
//! The user picks the manifests (Rust opens the dialog and reads them); the
//! page shows the list and the count before anything is sent. On the
//! user's click only package names, versions and ecosystems go to
//! api.osv.dev, in batches; then the advisories found are fetched by their
//! ids. Nothing else of the project leaves the machine.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use serde_json::{json, Value};

use super::{clean, clean_long, read_capped};

pub const OSV_API: &str = "https://api.osv.dev";
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_PACKAGES: usize = 5000;
const BATCH: usize = 500;
const MAX_ADVISORIES: usize = 80;
const MAX_ANSWER: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "camelCase")]
pub struct Package {
    /// OSV's ecosystem name: npm, PyPI, crates.io, Packagist, RubyGems, Go.
    pub ecosystem: String,
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManifestFile {
    /// The file's name, never its folder.
    pub name: String,
    /// The format read: package-lock, yarn-lock, requirements…, or unknown.
    pub format: String,
    pub packages: usize,
    /// Entries without an exact version, which OSV cannot match.
    pub skipped: usize,
    pub error: Option<String>,
}

/// What the last pick read, kept in Rust until the check sends it.
#[derive(Debug, Clone)]
pub struct Picked {
    pub token: String,
    pub files: Vec<ManifestFile>,
    pub packages: Vec<Package>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PickedView {
    pub token: String,
    pub files: Vec<ManifestFile>,
    pub packages: Vec<Package>,
    pub ecosystems: BTreeMap<String, usize>,
}

impl Picked {
    pub fn view(&self) -> PickedView {
        let mut ecosystems = BTreeMap::new();
        for package in &self.packages {
            *ecosystems.entry(package.ecosystem.clone()).or_insert(0) += 1;
        }
        PickedView {
            token: self.token.clone(),
            files: self.files.clone(),
            packages: self.packages.clone(),
            ecosystems,
        }
    }
}

#[derive(Default)]
struct Parsed {
    packages: Vec<Package>,
    skipped: usize,
}

impl Parsed {
    fn add(&mut self, ecosystem: &str, name: &str, version: &str) {
        let name = name.trim();
        let version = version.trim().trim_start_matches('=').trim();
        let exact = !version.is_empty()
            && version.len() <= 64
            && version
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_digit() || c == 'v')
            && version
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+' | '_'));
        if name.is_empty()
            || name.len() > 214
            || name.chars().any(|c| c.is_whitespace() || c.is_control())
        {
            return;
        }
        if !exact {
            self.skipped += 1;
            return;
        }
        self.packages.push(Package {
            ecosystem: ecosystem.into(),
            name: name.into(),
            version: version.into(),
        });
    }
}

/// The plain version an npm range pins, when it pins one: `^1.2.3`, `~1.2.3`,
/// `1.2.3`. Anything wider (`>=1`, `1.x`, `*`, a URL) is not a version.
fn npm_pinned(range: &str) -> Option<&str> {
    let bare = range.trim().trim_start_matches(['^', '~', '=', 'v']);
    let parts: Vec<&str> = bare.split(['-', '+']).next()?.split('.').collect();
    (parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())))
    .then_some(bare)
}

fn package_lock(value: &Value, out: &mut Parsed) {
    if let Some(packages) = value.get("packages").and_then(Value::as_object) {
        for (path, entry) in packages {
            if path.is_empty() || entry.get("link").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let name = entry
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| {
                    path.rsplit("node_modules/")
                        .next()
                        .unwrap_or(path)
                        .to_string()
                });
            match entry.get("version").and_then(Value::as_str) {
                Some(version) => out.add("npm", &name, version),
                None => out.skipped += 1,
            }
        }
        return;
    }
    fn walk(deps: &serde_json::Map<String, Value>, out: &mut Parsed, depth: usize) {
        if depth > 64 {
            return;
        }
        for (name, entry) in deps {
            match entry.get("version").and_then(Value::as_str) {
                Some(version) => out.add("npm", name, version),
                None => out.skipped += 1,
            }
            if let Some(nested) = entry.get("dependencies").and_then(Value::as_object) {
                walk(nested, out, depth + 1);
            }
        }
    }
    if let Some(deps) = value.get("dependencies").and_then(Value::as_object) {
        walk(deps, out, 0);
    }
}

fn package_json(value: &Value, out: &mut Parsed) {
    for section in [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
    ] {
        for (name, range) in value
            .get(section)
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
        {
            match range.as_str().and_then(npm_pinned) {
                Some(version) => out.add("npm", name, version),
                None => out.skipped += 1,
            }
        }
    }
}

/// yarn.lock v1 (`"name@range":` then `version "x"`) and Berry
/// (`version: x`).
fn yarn_lock(text: &str, out: &mut Parsed) {
    let mut names: Vec<String> = Vec::new();
    for line in text.lines() {
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        if !line.starts_with(' ') && line.ends_with(':') {
            names = line
                .trim_end_matches(':')
                .split(", ")
                .filter_map(|spec| {
                    let spec = spec.trim().trim_matches('"');
                    // The name ends at the first `@` after its own first
                    // character (a scope starts with `@`).
                    let (at, _) = spec.char_indices().skip(1).find(|&(_, c)| c == '@')?;
                    Some(spec[..at].to_string())
                })
                .collect();
            names.dedup();
            continue;
        }
        let trimmed = line.trim();
        let version = trimmed
            .strip_prefix("version ")
            .or_else(|| trimmed.strip_prefix("version: "))
            .map(|v| v.trim().trim_matches('"'));
        if let Some(version) = version {
            for name in names.drain(..) {
                out.add("npm", &name, version);
            }
        }
    }
}

fn requirements(text: &str, out: &mut Parsed) {
    for raw in text.lines() {
        let line = raw.split(" #").next().unwrap_or("").trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('-') || line.contains("://")
        {
            continue;
        }
        let spec = line.split(';').next().unwrap_or("").trim();
        match spec.split_once("==") {
            Some((name, version)) => {
                let name = name.split('[').next().unwrap_or(name);
                out.add("PyPI", name, version.split(',').next().unwrap_or(version));
            }
            None => out.skipped += 1,
        }
    }
}

fn pipfile_lock(value: &Value, out: &mut Parsed) {
    for section in ["default", "develop"] {
        for (name, entry) in value
            .get(section)
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
        {
            match entry.get("version").and_then(Value::as_str) {
                Some(version) => out.add("PyPI", name, version),
                None => out.skipped += 1,
            }
        }
    }
}

/// `[[package]]` tables with `name = "…"` and `version = "…"`: Cargo.lock
/// and poetry.lock.
fn toml_packages(text: &str, ecosystem: &str, out: &mut Parsed) {
    let mut name: Option<String> = None;
    let mut version: Option<String> = None;
    let mut inside = false;
    let flush = |name: &mut Option<String>, version: &mut Option<String>, out: &mut Parsed| {
        if let (Some(n), Some(v)) = (name.take(), version.take()) {
            out.add(ecosystem, &n, &v);
        }
    };
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            flush(&mut name, &mut version, out);
            inside = line == "[[package]]";
            continue;
        }
        if !inside {
            continue;
        }
        let value = |key: &str| {
            line.strip_prefix(key)
                .map(str::trim_start)
                .and_then(|rest| rest.strip_prefix('='))
                .map(|v| v.trim().trim_matches('"').to_string())
        };
        if let Some(v) = value("name") {
            name = Some(v);
        } else if let Some(v) = value("version") {
            version = Some(v);
        }
    }
    flush(&mut name, &mut version, out);
}

fn composer_lock(value: &Value, out: &mut Parsed) {
    for section in ["packages", "packages-dev"] {
        for entry in value
            .get(section)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let name = entry
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let version = entry
                .get("version")
                .and_then(Value::as_str)
                .unwrap_or_default();
            out.add("Packagist", name, version.trim_start_matches('v'));
        }
    }
}

fn gemfile_lock(text: &str, out: &mut Parsed) {
    let mut in_specs = false;
    for line in text.lines() {
        if line.trim() == "specs:" {
            in_specs = true;
            continue;
        }
        if !line.starts_with(' ') {
            in_specs = false;
            continue;
        }
        // Exactly four spaces: a gem; six are its own requirements.
        if in_specs && line.starts_with("    ") && !line.starts_with("     ") {
            let entry = line.trim();
            if let Some((name, rest)) = entry.split_once(" (") {
                let version = rest.trim_end_matches(')').split('-').next().unwrap_or("");
                out.add("RubyGems", name, version);
            }
        }
    }
}

fn go_mod(text: &str, out: &mut Parsed) {
    let mut block = false;
    for raw in text.lines() {
        let line = raw.split("//").next().unwrap_or("").trim();
        if line.starts_with("require (") {
            block = true;
            continue;
        }
        if block && line == ")" {
            block = false;
            continue;
        }
        let spec = if block {
            Some(line)
        } else {
            line.strip_prefix("require ")
        };
        if let Some(spec) = spec {
            let mut words = spec.split_whitespace();
            if let (Some(module), Some(version)) = (words.next(), words.next()) {
                out.add("Go", module, version);
            }
        }
    }
}

/// Read one manifest by its file name.
pub fn parse_manifest(name: &str, bytes: &[u8]) -> (String, Result<(Vec<Package>, usize), String>) {
    let lower = name.to_ascii_lowercase();
    let format = match lower.as_str() {
        "package-lock.json" | "npm-shrinkwrap.json" => "package-lock",
        "package.json" => "package-json",
        "yarn.lock" => "yarn-lock",
        "pipfile.lock" => "pipfile-lock",
        "poetry.lock" => "poetry-lock",
        "cargo.lock" => "cargo-lock",
        "composer.lock" => "composer-lock",
        "gemfile.lock" => "gemfile-lock",
        "go.mod" => "go-mod",
        _ if lower.ends_with(".txt") && lower.contains("requirements") => "requirements",
        _ => return ("unknown".into(), Err("unknown_format".into())),
    };
    let text = String::from_utf8_lossy(bytes);
    let mut parsed = Parsed::default();
    let json = || serde_json::from_str::<Value>(&text).map_err(|_| "bad_manifest".to_string());
    let outcome = match format {
        "package-lock" => json().map(|v| package_lock(&v, &mut parsed)),
        "package-json" => json().map(|v| package_json(&v, &mut parsed)),
        "pipfile-lock" => json().map(|v| pipfile_lock(&v, &mut parsed)),
        "composer-lock" => json().map(|v| composer_lock(&v, &mut parsed)),
        "yarn-lock" => {
            yarn_lock(&text, &mut parsed);
            Ok(())
        }
        "requirements" => {
            requirements(&text, &mut parsed);
            Ok(())
        }
        "poetry-lock" => {
            toml_packages(&text, "PyPI", &mut parsed);
            Ok(())
        }
        "cargo-lock" => {
            toml_packages(&text, "crates.io", &mut parsed);
            Ok(())
        }
        "gemfile-lock" => {
            gemfile_lock(&text, &mut parsed);
            Ok(())
        }
        _ => {
            go_mod(&text, &mut parsed);
            Ok(())
        }
    };
    (
        format.into(),
        outcome.map(|_| (parsed.packages, parsed.skipped)),
    )
}

/// Read the picked files: names only are kept, packages deduplicated and
/// capped.
pub fn read_picked(paths: &[std::path::PathBuf]) -> Picked {
    let mut files = Vec::new();
    let mut all: BTreeSet<Package> = BTreeSet::new();
    for path in paths.iter().take(20) {
        let name = path
            .file_name()
            .map(|n| clean(&n.to_string_lossy()))
            .unwrap_or_default();
        let read = std::fs::metadata(path)
            .map_err(|_| "unreadable".to_string())
            .and_then(|meta| {
                if meta.len() > MAX_FILE_BYTES {
                    Err("too_large".to_string())
                } else {
                    std::fs::read(path).map_err(|_| "unreadable".to_string())
                }
            });
        let (format, outcome) = match read {
            Ok(bytes) => parse_manifest(&name, &bytes),
            Err(error) => ("unknown".into(), Err(error)),
        };
        match outcome {
            Ok((packages, skipped)) => {
                files.push(ManifestFile {
                    name,
                    format,
                    packages: packages.len(),
                    skipped,
                    error: None,
                });
                for package in packages {
                    if all.len() >= MAX_PACKAGES {
                        break;
                    }
                    all.insert(package);
                }
            }
            Err(error) => files.push(ManifestFile {
                name,
                format,
                packages: 0,
                skipped: 0,
                error: Some(error),
            }),
        }
    }
    Picked {
        token: uuid::Uuid::new_v4().to_string(),
        files,
        packages: all.into_iter().collect(),
    }
}

/* ---------------- OSV ---------------- */

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Advisory {
    pub id: String,
    pub aliases: Vec<String>,
    pub summary: String,
    /// critical, high, moderate/medium, low, or empty when unknown.
    pub severity: String,
    /// A CVSS vector, when the advisory gives one.
    pub cvss: Option<String>,
    pub score: Option<f64>,
    pub published: String,
    /// The versions that fix it, for each affected package name.
    pub fixed: BTreeMap<String, Vec<String>>,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub package: Package,
    pub ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OsvReport {
    pub checked: usize,
    pub findings: Vec<Finding>,
    pub advisories: Vec<Advisory>,
    /// More advisories were found than were fetched.
    pub advisories_cut: bool,
    pub checked_at: u64,
}

pub fn batch_body(packages: &[Package]) -> Value {
    json!({
        "queries": packages
            .iter()
            .map(|p| json!({"package": {"name": p.name, "ecosystem": p.ecosystem}, "version": p.version}))
            .collect::<Vec<_>>()
    })
}

/// The advisory ids OSV gave for each package of one batch, in order.
pub fn batch_ids(answer: &Value, expected: usize) -> Result<Vec<Vec<String>>, String> {
    let results = answer
        .get("results")
        .and_then(Value::as_array)
        .ok_or_else(|| "bad_answer".to_string())?;
    if results.len() != expected {
        return Err("bad_answer".into());
    }
    Ok(results
        .iter()
        .map(|result| {
            result
                .get("vulns")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|v| v.get("id").and_then(Value::as_str))
                .map(clean)
                .filter(|id| !id.is_empty() && id.len() <= 64)
                .collect()
        })
        .collect())
}

/// The CVSS v3.x base score of a vector (FIRST's specification).
pub fn cvss3_score(vector: &str) -> Option<f64> {
    let mut metrics = BTreeMap::new();
    for part in vector.split('/').skip(1) {
        let (key, value) = part.split_once(':')?;
        metrics.insert(key, value);
    }
    if !vector.starts_with("CVSS:3") {
        return None;
    }
    let scope_changed = *metrics.get("S")? == "C";
    let av = match *metrics.get("AV")? {
        "N" => 0.85,
        "A" => 0.62,
        "L" => 0.55,
        "P" => 0.2,
        _ => return None,
    };
    let ac = match *metrics.get("AC")? {
        "L" => 0.77,
        "H" => 0.44,
        _ => return None,
    };
    let pr = match (*metrics.get("PR")?, scope_changed) {
        ("N", _) => 0.85,
        ("L", false) => 0.62,
        ("L", true) => 0.68,
        ("H", false) => 0.27,
        ("H", true) => 0.5,
        _ => return None,
    };
    let ui = match *metrics.get("UI")? {
        "N" => 0.85,
        "R" => 0.62,
        _ => return None,
    };
    let cia = |key: &str| -> Option<f64> {
        Some(match *metrics.get(key)? {
            "H" => 0.56,
            "L" => 0.22,
            "N" => 0.0,
            _ => return None,
        })
    };
    let (c, i, a) = (cia("C")?, cia("I")?, cia("A")?);
    let iss = 1.0 - (1.0 - c) * (1.0 - i) * (1.0 - a);
    let impact = if scope_changed {
        7.52 * (iss - 0.029) - 3.25 * (iss - 0.02).powi(15)
    } else {
        6.42 * iss
    };
    let exploitability = 8.22 * av * ac * pr * ui;
    if impact <= 0.0 {
        return Some(0.0);
    }
    let raw = if scope_changed {
        (1.08 * (impact + exploitability)).min(10.0)
    } else {
        (impact + exploitability).min(10.0)
    };
    // Round up to one decimal, as the specification's Roundup does.
    let scaled = (raw * 100_000.0).round() as i64;
    Some(if scaled % 10_000 == 0 {
        scaled as f64 / 100_000.0
    } else {
        ((scaled / 10_000) as f64 + 1.0) / 10.0
    })
}

fn severity_of_score(score: f64) -> &'static str {
    match score {
        s if s >= 9.0 => "critical",
        s if s >= 7.0 => "high",
        s if s >= 4.0 => "medium",
        s if s > 0.0 => "low",
        _ => "none",
    }
}

/// One advisory from `GET /v1/vulns/{id}`.
pub fn parse_advisory(value: &Value) -> Advisory {
    let text = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(clean)
            .unwrap_or_default()
    };
    let cvss = value
        .get("severity")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|s| s.get("score").and_then(Value::as_str))
        .find(|vector| vector.starts_with("CVSS:3"))
        .map(clean);
    let score = cvss.as_deref().and_then(cvss3_score);
    let labelled = value
        .get("database_specific")
        .and_then(|d| d.get("severity"))
        .and_then(Value::as_str)
        .map(|s| clean(s).to_ascii_lowercase());
    let severity = labelled
        .or_else(|| score.map(|s| severity_of_score(s).to_string()))
        .unwrap_or_default();
    let mut fixed: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for affected in value
        .get("affected")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(40)
    {
        let Some(name) = affected
            .get("package")
            .and_then(|p| p.get("name"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        for range in affected
            .get("ranges")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            // Git ranges name commits, not versions.
            if range.get("type").and_then(Value::as_str) == Some("GIT") {
                continue;
            }
            for event in range
                .get("events")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(version) = event.get("fixed").and_then(Value::as_str) {
                    let list = fixed.entry(clean(name)).or_default();
                    let version = clean(version);
                    if !list.contains(&version) && list.len() < 8 {
                        list.push(version);
                    }
                }
            }
        }
    }
    let url = value
        .get("references")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let kind = r.get("type").and_then(Value::as_str)?;
            let url = r.get("url").and_then(Value::as_str)?;
            url.starts_with("https://").then_some((kind, url))
        })
        .min_by_key(|(kind, _)| match *kind {
            "ADVISORY" => 0,
            "WEB" => 1,
            _ => 2,
        })
        .map(|(_, url)| clean_long(url, 300))
        .unwrap_or_default();
    let summary = {
        let summary = text("summary");
        if summary.is_empty() {
            clean_long(
                value
                    .get("details")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .lines()
                    .next()
                    .unwrap_or(""),
                200,
            )
        } else {
            summary
        }
    };
    Advisory {
        id: text("id"),
        aliases: value
            .get("aliases")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(clean)
            .take(8)
            .collect(),
        summary,
        severity,
        cvss,
        score,
        published: text("published"),
        fixed,
        url,
    }
}

/// Check `packages` against OSV: the batch queries, then each advisory.
pub async fn check(
    client: &reqwest::Client,
    packages: &[Package],
    now_ms: u64,
) -> Result<OsvReport, String> {
    let mut findings = Vec::new();
    for chunk in packages.chunks(BATCH) {
        let response = client
            .post(format!("{OSV_API}/v1/querybatch"))
            .json(&batch_body(chunk))
            .send()
            .await
            .map_err(|error| super::transport_error(&error))?;
        match response.status().as_u16() {
            200 => {}
            429 => return Err("rate_limited".into()),
            400 => return Err("bad_request".into()),
            _ => return Err("server_error".into()),
        }
        let body = read_capped(response, MAX_ANSWER).await?;
        let answer: Value = serde_json::from_slice(&body).map_err(|_| "bad_answer".to_string())?;
        for (package, ids) in chunk.iter().zip(batch_ids(&answer, chunk.len())?) {
            if !ids.is_empty() {
                findings.push(Finding {
                    package: package.clone(),
                    ids,
                });
            }
        }
    }
    let unique: BTreeSet<String> = findings
        .iter()
        .flat_map(|f| f.ids.iter().cloned())
        .collect();
    let advisories_cut = unique.len() > MAX_ADVISORIES;
    let mut advisories = Vec::new();
    let wanted: Vec<String> = unique.into_iter().take(MAX_ADVISORIES).collect();
    for group in wanted.chunks(8) {
        let requests = group.iter().map(|id| {
            let url = format!("{OSV_API}/v1/vulns/{id}");
            async move {
                let response = client.get(url).send().await.ok()?;
                if !response.status().is_success() {
                    return None;
                }
                let body = read_capped(response, MAX_ANSWER).await.ok()?;
                serde_json::from_slice::<Value>(&body)
                    .ok()
                    .map(|v| parse_advisory(&v))
            }
        });
        for advisory in futures_util::future::join_all(requests)
            .await
            .into_iter()
            .flatten()
        {
            advisories.push(advisory);
        }
    }
    Ok(OsvReport {
        checked: packages.len(),
        findings,
        advisories,
        advisories_cut,
        checked_at: now_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packages(name: &str, text: &str) -> (Vec<Package>, usize) {
        parse_manifest(name, text.as_bytes()).1.unwrap()
    }

    fn names(list: &[Package]) -> Vec<String> {
        list.iter()
            .map(|p| format!("{}:{}@{}", p.ecosystem, p.name, p.version))
            .collect()
    }

    #[test]
    fn npm_lockfiles_of_both_shapes_are_read() {
        let v3 = r#"{"lockfileVersion":3,"packages":{"":{"name":"app"},"node_modules/lodash":{"version":"4.17.15"},"node_modules/@scope/a":{"version":"1.0.0"},"node_modules/a/node_modules/b":{"version":"2.0.0"},"node_modules/linked":{"link":true}}}"#;
        let (list, skipped) = packages("package-lock.json", v3);
        // serde_json keeps object keys sorted.
        assert_eq!(
            names(&list),
            vec!["npm:@scope/a@1.0.0", "npm:b@2.0.0", "npm:lodash@4.17.15"]
        );
        assert_eq!(skipped, 0);
        let v1 = r#"{"lockfileVersion":1,"dependencies":{"left-pad":{"version":"1.3.0","dependencies":{"x":{"version":"0.1.0"}}}}}"#;
        assert_eq!(
            names(&packages("package-lock.json", v1).0),
            vec!["npm:left-pad@1.3.0", "npm:x@0.1.0"]
        );
    }

    #[test]
    fn a_package_json_keeps_only_pinned_ranges() {
        let text = r#"{"dependencies":{"react":"^18.3.1","a":"~1.2.3","b":">=2","c":"latest","d":"github:x/y"},"devDependencies":{"vitest":"2.1.0"}}"#;
        let (list, skipped) = packages("package.json", text);
        assert_eq!(
            names(&list),
            vec!["npm:a@1.2.3", "npm:react@18.3.1", "npm:vitest@2.1.0"]
        );
        assert_eq!(skipped, 3);
    }

    #[test]
    fn yarn_python_cargo_composer_ruby_and_go_are_read() {
        let yarn = "# yarn lockfile v1\n\n\"lodash@^4.17.0\", lodash@^4.17.15:\n  version \"4.17.15\"\n  resolved \"x\"\n\n\"@babel/core@^7.0.0\":\n  version \"7.1.0\"\n";
        assert_eq!(
            names(&packages("yarn.lock", yarn).0),
            vec!["npm:lodash@4.17.15", "npm:@babel/core@7.1.0"]
        );

        let req = "# comment\nrequests==2.19.0\nDjango[bcrypt]==3.2.1 ; python_version > '3'\nflask>=2\n-r other.txt\n";
        let (list, skipped) = packages("requirements.txt", req);
        assert_eq!(
            names(&list),
            vec!["PyPI:requests@2.19.0", "PyPI:Django@3.2.1"]
        );
        assert_eq!(skipped, 1);

        let cargo = "version = 3\n\n[[package]]\nname = \"serde\"\nversion = \"1.0.0\"\nsource = \"x\"\n\n[[package]]\nname = \"app\"\nversion = \"0.1.0\"\n";
        assert_eq!(
            names(&packages("Cargo.lock", cargo).0),
            vec!["crates.io:serde@1.0.0", "crates.io:app@0.1.0"]
        );

        let poetry =
            "[[package]]\nname = \"urllib3\"\nversion = \"1.24.1\"\n\n[package.extras]\nx = []\n";
        assert_eq!(
            names(&packages("poetry.lock", poetry).0),
            vec!["PyPI:urllib3@1.24.1"]
        );

        let composer = r#"{"packages":[{"name":"guzzlehttp/guzzle","version":"v7.4.0"}],"packages-dev":[{"name":"phpunit/phpunit","version":"9.5.0"}]}"#;
        assert_eq!(
            names(&packages("composer.lock", composer).0),
            vec![
                "Packagist:guzzlehttp/guzzle@7.4.0",
                "Packagist:phpunit/phpunit@9.5.0"
            ]
        );

        let gems = "GEM\n  remote: https://rubygems.org/\n  specs:\n    rack (2.0.1)\n    nokogiri (1.10.0-x86_64-linux)\n      mini_portile2 (~> 2.4.0)\n\nPLATFORMS\n  ruby\n";
        assert_eq!(
            names(&packages("Gemfile.lock", gems).0),
            vec!["RubyGems:rack@2.0.1", "RubyGems:nokogiri@1.10.0"]
        );

        let gomod = "module x\n\ngo 1.21\n\nrequire (\n\tgolang.org/x/net v0.0.1 // indirect\n\tgithub.com/a/b v1.2.3\n)\nrequire github.com/c/d v0.1.0\n";
        assert_eq!(
            names(&packages("go.mod", gomod).0),
            vec![
                "Go:golang.org/x/net@v0.0.1",
                "Go:github.com/a/b@v1.2.3",
                "Go:github.com/c/d@v0.1.0"
            ]
        );

        assert_eq!(
            parse_manifest("notes.md", b"x").1,
            Err("unknown_format".into())
        );
        assert_eq!(
            parse_manifest("package.json", b"{").1,
            Err("bad_manifest".into())
        );
    }

    #[test]
    fn a_batch_answer_maps_ids_back_to_packages() {
        let answer: Value = serde_json::from_str(include_str!("fixtures/osv-batch.json")).unwrap();
        let ids = batch_ids(&answer, 3).unwrap();
        assert_eq!(ids[0].len(), 6);
        assert!(ids[0].contains(&"GHSA-35jh-r3h4-6jhm".to_string()));
        assert!(ids[1].is_empty());
        assert_eq!(ids[2].len(), 10);
        assert_eq!(batch_ids(&answer, 2), Err("bad_answer".into()));
        let body = batch_body(&[Package {
            ecosystem: "npm".into(),
            name: "lodash".into(),
            version: "4.17.15".into(),
        }]);
        assert_eq!(
            body,
            json!({"queries": [{"package": {"name": "lodash", "ecosystem": "npm"}, "version": "4.17.15"}]})
        );
    }

    #[test]
    fn an_advisory_has_its_severity_fix_and_aliases() {
        let ghsa = parse_advisory(
            &serde_json::from_str(include_str!("fixtures/osv-vuln-ghsa.json")).unwrap(),
        );
        assert_eq!(ghsa.id, "GHSA-35jh-r3h4-6jhm");
        assert_eq!(ghsa.summary, "Command Injection in lodash");
        assert_eq!(ghsa.severity, "high");
        assert!(ghsa.aliases.contains(&"CVE-2021-23337".to_string()));
        assert_eq!(ghsa.fixed.get("lodash"), Some(&vec!["4.17.21".to_string()]));
        assert_eq!(ghsa.score, Some(7.2));
        assert!(ghsa.url.starts_with("https://"));

        let pysec = parse_advisory(
            &serde_json::from_str(include_str!("fixtures/osv-vuln-pysec.json")).unwrap(),
        );
        assert_eq!(
            pysec.fixed.get("requests"),
            Some(&vec!["2.20.0".to_string()]),
            "git commits are skipped"
        );
        assert!(
            !pysec.summary.is_empty(),
            "the details' first line stands in for a summary"
        );
        assert_eq!(pysec.severity, "");
    }

    #[test]
    fn cvss_scores_match_the_specification() {
        assert_eq!(
            cvss3_score("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"),
            Some(9.8)
        );
        assert_eq!(
            cvss3_score("CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H"),
            Some(7.2)
        );
        assert_eq!(
            cvss3_score("CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N"),
            Some(6.1)
        );
        assert_eq!(
            cvss3_score("CVSS:3.0/AV:L/AC:L/PR:L/UI:N/S:U/C:N/I:N/A:N"),
            Some(0.0)
        );
        assert_eq!(cvss3_score("AV:N/AC:L"), None);
    }
}
