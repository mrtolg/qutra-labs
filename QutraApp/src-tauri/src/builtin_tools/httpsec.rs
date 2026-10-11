//! HTTP security analyzer: one GET to the URL the user typed, then a read
//! of what the answer's headers promise: HSTS, CSP, framing, MIME sniffing,
//! referrer and permissions policies, CORS, caching, cookies, and what the
//! server says about itself. The body is never read.
//!
//! A redirect to the same host is followed (at most `MAX_HOPS` requests in
//! all); one to another host is reported and not followed, because the scope
//! decision covered this host only. The request carries an `Origin` header
//! naming a host that cannot exist (`CORS_PROBE_ORIGIN`), to see whether the
//! server echoes any origin back.

use serde::Serialize;

use super::{clean, clean_long};

pub const CORS_PROBE_ORIGIN: &str = "https://cors-check.invalid";
const MAX_HOPS: usize = 5;
const MAX_HEADERS: usize = 80;
const MAX_COOKIES: usize = 40;
/// Six months, the least HSTS max-age worth calling enough.
const HSTS_MIN_SECONDS: u64 = 15_552_000;

/// The URL to ask: `https://` is added to a bare host; credentials in a URL
/// are refused.
pub fn parse_url(input: &str) -> Result<reqwest::Url, String> {
    let text = input.trim();
    if text.is_empty() {
        return Err("target_empty".into());
    }
    if text.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("target_invalid".into());
    }
    let with_scheme = if text.contains("://") {
        text.to_string()
    } else {
        format!("https://{text}")
    };
    let url = reqwest::Url::parse(&with_scheme).map_err(|_| "target_invalid".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("target_invalid".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("target_credentials".into());
    }
    Ok(url)
}

/// The host part of a URL as the scope check reads it.
pub fn scope_host(url: &reqwest::Url) -> String {
    url.host_str().unwrap_or_default().to_ascii_lowercase()
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    /// hsts, csp, frame, nosniff, referrer, permissions, coop, corp,
    /// coep, cors, cache, server, https.
    pub id: String,
    /// pass, warn, fail or info.
    pub level: String,
    /// What the header said, when it said anything.
    pub value: Option<String>,
    /// Codes for the page to word: "missing", "shortMaxAge", "unsafeInline"…
    pub notes: Vec<String>,
}

impl Check {
    fn new(id: &str, level: &str, value: Option<String>, notes: &[&str]) -> Self {
        Self {
            id: id.into(),
            level: level.into(),
            value,
            notes: notes.iter().map(|note| note.to_string()).collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Cookie {
    pub name: String,
    pub secure: bool,
    pub http_only: bool,
    pub same_site: Option<String>,
    pub domain: Option<String>,
    pub path: Option<String>,
    pub persistent: bool,
    /// noSecure, noHttpOnly, noSameSite, sameSiteNoneInsecure, badHostPrefix,
    /// badSecurePrefix.
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hop {
    pub url: String,
    pub status: u16,
    pub location: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HttpReport {
    pub requested: String,
    pub final_url: String,
    pub status: u16,
    pub hops: Vec<Hop>,
    /// A redirect not followed: where it pointed and why (otherHost,
    /// tooMany, badLocation).
    pub stopped: Option<(String, String)>,
    pub headers: Vec<(String, String)>,
    pub checks: Vec<Check>,
    pub cookies: Vec<Cookie>,
    pub csp_directives: Vec<(String, String)>,
    pub counts: Counts,
    pub checked_at: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub pass: usize,
    pub warn: usize,
    pub fail: usize,
    pub info: usize,
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

fn hsts(headers: &[(String, String)], https: bool) -> Check {
    if !https {
        return Check::new("hsts", "info", None, &["plainHttp"]);
    }
    let Some(value) = header(headers, "strict-transport-security") else {
        return Check::new("hsts", "fail", None, &["missing"]);
    };
    let lower = value.to_ascii_lowercase();
    let max_age = lower
        .split(';')
        .filter_map(|part| part.trim().strip_prefix("max-age="))
        .find_map(|age| age.trim_matches('"').parse::<u64>().ok());
    let mut notes = Vec::new();
    let level = match max_age {
        None => {
            notes.push("noMaxAge");
            "fail"
        }
        Some(0) => {
            notes.push("disabled");
            "fail"
        }
        Some(age) if age < HSTS_MIN_SECONDS => {
            notes.push("shortMaxAge");
            "warn"
        }
        Some(_) => "pass",
    };
    if lower.contains("includesubdomains") {
        notes.push("includeSubDomains");
    }
    if lower.contains("preload") {
        notes.push("preload");
    }
    Check::new("hsts", level, Some(clean_long(value, 300)), &notes)
}

/// A policy's directives, in order, the first of each name only (as a
/// browser reads it).
pub fn csp_directives(policy: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for part in policy.split(';') {
        let mut words = part.split_whitespace();
        let Some(name) = words.next() else { continue };
        let name = name.to_ascii_lowercase();
        if out.iter().any(|(seen, _)| *seen == name) || out.len() >= 40 {
            continue;
        }
        out.push((
            clean(&name),
            clean_long(&words.collect::<Vec<_>>().join(" "), 400),
        ));
    }
    out
}

fn csp(headers: &[(String, String)]) -> (Check, Vec<(String, String)>) {
    let report_only = header(headers, "content-security-policy-report-only");
    let Some(policy) = header(headers, "content-security-policy") else {
        let notes: &[&str] = if report_only.is_some() {
            &["missing", "reportOnly"]
        } else {
            &["missing"]
        };
        return (Check::new("csp", "warn", None, notes), Vec::new());
    };
    let directives = csp_directives(policy);
    let get = |name: &str| {
        directives
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.to_ascii_lowercase())
    };
    let scripts = get("script-src").or_else(|| get("default-src"));
    let mut notes = Vec::new();
    let mut level = "pass";
    match &scripts {
        None => {
            notes.push("noScriptSrc");
            level = "warn";
        }
        Some(sources) => {
            let tokens: Vec<&str> = sources.split_whitespace().collect();
            let nonce_or_hash = tokens.iter().any(|t| {
                t.starts_with("'nonce-")
                    || t.starts_with("'sha256-")
                    || t.starts_with("'sha384-")
                    || t.starts_with("'sha512-")
            });
            if tokens.contains(&"'unsafe-inline'")
                && !nonce_or_hash
                && !tokens.contains(&"'strict-dynamic'")
            {
                notes.push("unsafeInline");
                level = "fail";
            }
            if tokens.contains(&"'unsafe-eval'") {
                notes.push("unsafeEval");
                if level == "pass" {
                    level = "warn";
                }
            }
            if tokens
                .iter()
                .any(|t| *t == "*" || *t == "https:" || *t == "http:" || *t == "data:")
            {
                notes.push("wideSources");
                level = "fail";
            }
        }
    }
    let default_none =
        get("default-src").is_some_and(|v| v.split_whitespace().any(|t| t == "'none'"));
    if get("object-src").is_none() && !default_none {
        notes.push("noObjectSrc");
        if level == "pass" {
            level = "warn";
        }
    }
    if get("base-uri").is_none() {
        notes.push("noBaseUri");
    }
    if get("frame-ancestors").is_none() {
        notes.push("noFrameAncestors");
    }
    (
        Check::new("csp", level, Some(clean_long(policy, 600)), &notes),
        directives,
    )
}

fn framing(headers: &[(String, String)], directives: &[(String, String)]) -> Check {
    let ancestors = directives
        .iter()
        .find(|(name, _)| name == "frame-ancestors");
    let xfo = header(headers, "x-frame-options");
    match (xfo, ancestors) {
        (_, Some((_, value))) => {
            let open = value.split_whitespace().any(|t| t == "*");
            Check::new(
                "frame",
                if open { "warn" } else { "pass" },
                Some(format!("frame-ancestors {value}")),
                if open { &["anyAncestor"] } else { &["byCsp"] },
            )
        }
        (Some(value), None) => {
            let upper = value.trim().to_ascii_uppercase();
            if upper == "DENY" || upper == "SAMEORIGIN" {
                Check::new("frame", "pass", Some(clean(value)), &[])
            } else {
                Check::new("frame", "warn", Some(clean(value)), &["oddValue"])
            }
        }
        (None, None) => Check::new("frame", "warn", None, &["missing"]),
    }
}

fn simple_checks(headers: &[(String, String)], out: &mut Vec<Check>) {
    out.push(match header(headers, "x-content-type-options") {
        Some(v) if v.trim().eq_ignore_ascii_case("nosniff") => {
            Check::new("nosniff", "pass", Some(clean(v)), &[])
        }
        Some(v) => Check::new("nosniff", "warn", Some(clean(v)), &["oddValue"]),
        None => Check::new("nosniff", "warn", None, &["missing"]),
    });
    out.push(match header(headers, "referrer-policy") {
        Some(v) => {
            let last = v
                .rsplit(',')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            let leaky = matches!(
                last.as_str(),
                "unsafe-url" | "no-referrer-when-downgrade" | "origin-when-cross-origin"
            );
            Check::new(
                "referrer",
                if leaky { "warn" } else { "pass" },
                Some(clean(v)),
                if leaky { &["leaky"] } else { &[] },
            )
        }
        None => Check::new("referrer", "info", None, &["missingDefault"]),
    });
    out.push(match header(headers, "permissions-policy") {
        Some(v) => Check::new("permissions", "pass", Some(clean_long(v, 300)), &[]),
        None => Check::new("permissions", "info", None, &["missing"]),
    });
    for (id, name) in [
        ("coop", "cross-origin-opener-policy"),
        ("coep", "cross-origin-embedder-policy"),
        ("corp", "cross-origin-resource-policy"),
    ] {
        out.push(match header(headers, name) {
            Some(v) => Check::new(id, "pass", Some(clean(v)), &[]),
            None => Check::new(id, "info", None, &["missing"]),
        });
    }
}

fn cors(headers: &[(String, String)]) -> Check {
    let origin = header(headers, "access-control-allow-origin").map(str::trim);
    let credentials = header(headers, "access-control-allow-credentials")
        .is_some_and(|v| v.trim().eq_ignore_ascii_case("true"));
    match origin {
        None => Check::new("cors", "pass", None, &["notShared"]),
        Some(value) if value == CORS_PROBE_ORIGIN => Check::new(
            "cors",
            "fail",
            Some(clean(value)),
            if credentials {
                &["reflectsOrigin", "withCredentials"]
            } else {
                &["reflectsOrigin"]
            },
        ),
        Some("*") if credentials => Check::new(
            "cors",
            "fail",
            Some("*".into()),
            &["anyOrigin", "withCredentials"],
        ),
        Some("*") => Check::new("cors", "warn", Some("*".into()), &["anyOrigin"]),
        Some(value) if value.eq_ignore_ascii_case("null") => {
            Check::new("cors", "warn", Some("null".into()), &["nullOrigin"])
        }
        Some(value) => Check::new("cors", "pass", Some(clean(value)), &["oneOrigin"]),
    }
}

fn cache(headers: &[(String, String)], sets_cookies: bool) -> Check {
    let control = header(headers, "cache-control").map(|v| v.to_ascii_lowercase());
    match control {
        Some(value) if value.contains("no-store") => {
            Check::new("cache", "pass", Some(clean(&value)), &["noStore"])
        }
        Some(value) if sets_cookies && value.contains("public") => {
            Check::new("cache", "warn", Some(clean(&value)), &["publicWithCookies"])
        }
        Some(value) if value.contains("private") || value.contains("no-cache") => {
            Check::new("cache", "pass", Some(clean(&value)), &[])
        }
        Some(value) => Check::new("cache", "info", Some(clean(&value)), &["cacheable"]),
        None if sets_cookies => Check::new("cache", "warn", None, &["missingWithCookies"]),
        None => Check::new("cache", "info", None, &["missing"]),
    }
}

fn server(headers: &[(String, String)]) -> Check {
    let disclosed: Vec<String> = [
        "server",
        "x-powered-by",
        "x-aspnet-version",
        "x-aspnetmvc-version",
        "x-generator",
    ]
    .iter()
    .filter_map(|name| header(headers, name).map(|value| format!("{name}: {}", clean(value))))
    .collect();
    if disclosed.is_empty() {
        return Check::new("server", "pass", None, &["silent"]);
    }
    let versioned = disclosed.iter().any(|line| {
        line.split_once(": ")
            .is_some_and(|(_, v)| v.chars().any(|c| c.is_ascii_digit()))
    });
    Check::new(
        "server",
        if versioned { "warn" } else { "info" },
        Some(disclosed.join(" · ")),
        if versioned {
            &["versionDisclosed"]
        } else {
            &["productNamed"]
        },
    )
}

/// One `Set-Cookie` header, its attributes and what is wrong with them.
pub fn parse_cookie(line: &str, https: bool) -> Option<Cookie> {
    let mut parts = line.split(';');
    let (name, _) = parts.next()?.split_once('=')?;
    let name = clean(name.trim());
    if name.is_empty() {
        return None;
    }
    let mut cookie = Cookie {
        name: name.clone(),
        ..Cookie::default()
    };
    for attribute in parts {
        let (key, value) = match attribute.split_once('=') {
            Some((key, value)) => (key.trim().to_ascii_lowercase(), Some(value.trim())),
            None => (attribute.trim().to_ascii_lowercase(), None),
        };
        match key.as_str() {
            "secure" => cookie.secure = true,
            "httponly" => cookie.http_only = true,
            "samesite" => cookie.same_site = value.map(|v| clean(v).to_ascii_lowercase()),
            "domain" => cookie.domain = value.map(clean),
            "path" => cookie.path = value.map(clean),
            "expires" | "max-age" => cookie.persistent = true,
            _ => {}
        }
    }
    if https && !cookie.secure {
        cookie.issues.push("noSecure".into());
    }
    if !cookie.http_only {
        cookie.issues.push("noHttpOnly".into());
    }
    match cookie.same_site.as_deref() {
        None => cookie.issues.push("noSameSite".into()),
        Some("none") if !cookie.secure => cookie.issues.push("sameSiteNoneInsecure".into()),
        _ => {}
    }
    if name.starts_with("__Host-")
        && (!cookie.secure || cookie.domain.is_some() || cookie.path.as_deref() != Some("/"))
    {
        cookie.issues.push("badHostPrefix".into());
    }
    if name.starts_with("__Secure-") && !cookie.secure {
        cookie.issues.push("badSecurePrefix".into());
    }
    Some(cookie)
}

/// Read one final answer's headers into checks and cookies.
pub fn assess(
    final_url: &reqwest::Url,
    headers: &[(String, String)],
) -> (Vec<Check>, Vec<Cookie>, Vec<(String, String)>) {
    let https = final_url.scheme() == "https";
    let cookies: Vec<Cookie> = headers
        .iter()
        .filter(|(key, _)| key.eq_ignore_ascii_case("set-cookie"))
        .filter_map(|(_, value)| parse_cookie(value, https))
        .take(MAX_COOKIES)
        .collect();
    let mut checks = Vec::new();
    checks.push(if https {
        Check::new("https", "pass", None, &[])
    } else {
        Check::new("https", "fail", None, &["plainHttp"])
    });
    checks.push(hsts(headers, https));
    let (csp_check, directives) = csp(headers);
    checks.push(csp_check);
    checks.push(framing(headers, &directives));
    simple_checks(headers, &mut checks);
    checks.push(cors(headers));
    checks.push(cache(headers, !cookies.is_empty()));
    checks.push(server(headers));
    (checks, cookies, directives)
}

pub fn counts(checks: &[Check]) -> Counts {
    let mut out = Counts::default();
    for check in checks {
        match check.level.as_str() {
            "pass" => out.pass += 1,
            "warn" => out.warn += 1,
            "fail" => out.fail += 1,
            _ => out.info += 1,
        }
    }
    out
}

fn same_host(a: &reqwest::Url, b: &reqwest::Url) -> bool {
    a.host_str().map(str::to_ascii_lowercase) == b.host_str().map(str::to_ascii_lowercase)
}

/// Ask `url` once (and its same-host redirects), and read the answer.
pub async fn analyze(
    client: &reqwest::Client,
    url: reqwest::Url,
    now_ms: u64,
) -> Result<HttpReport, String> {
    let requested = url.to_string();
    let mut current = url;
    let mut hops = Vec::new();
    let mut stopped = None;
    let response = loop {
        let response = client
            .get(current.clone())
            .header(reqwest::header::ORIGIN, CORS_PROBE_ORIGIN)
            .header(
                reqwest::header::ACCEPT,
                "text/html,application/xhtml+xml,*/*;q=0.8",
            )
            .send()
            .await
            .map_err(|error| super::transport_error(&error))?;
        let status = response.status();
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .map(|value| clean_long(value, 500));
        hops.push(Hop {
            url: current.to_string(),
            status: status.as_u16(),
            location: location.clone(),
        });
        if !status.is_redirection() {
            break response;
        }
        let Some(location) = location else {
            break response;
        };
        let next = match current.join(&location) {
            Ok(next) if matches!(next.scheme(), "http" | "https") => next,
            _ => {
                stopped = Some((location, "badLocation".to_string()));
                break response;
            }
        };
        if !same_host(&current, &next) {
            stopped = Some((next.to_string(), "otherHost".to_string()));
            break response;
        }
        if hops.len() >= MAX_HOPS {
            stopped = Some((next.to_string(), "tooMany".to_string()));
            break response;
        }
        current = next;
    };
    let headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .take(MAX_HEADERS)
        .map(|(name, value)| {
            (
                name.as_str().to_string(),
                clean_long(&String::from_utf8_lossy(value.as_bytes()), 1000),
            )
        })
        .collect();
    let status = response.status().as_u16();
    drop(response);
    let (checks, cookies, csp_directives) = assess(&current, &headers);
    Ok(HttpReport {
        requested,
        final_url: current.to_string(),
        status,
        hops,
        stopped,
        counts: counts(&checks),
        headers,
        checks,
        cookies,
        csp_directives,
        checked_at: now_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn check<'a>(checks: &'a [Check], id: &str) -> &'a Check {
        checks.iter().find(|c| c.id == id).unwrap()
    }

    /// Headers recorded from a well-configured site (trimmed).
    const STRONG: &[(&str, &str)] = &[
        ("strict-transport-security", "max-age=63072000; includeSubDomains; preload"),
        ("content-security-policy", "default-src 'none'; script-src 'self' 'nonce-abc'; style-src 'self'; img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'; object-src 'none'"),
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "strict-origin-when-cross-origin"),
        ("permissions-policy", "camera=(), microphone=()"),
        ("cross-origin-opener-policy", "same-origin"),
        ("cache-control", "no-store"),
        ("set-cookie", "__Host-session=abc; Path=/; Secure; HttpOnly; SameSite=Lax"),
    ];

    /// Headers recorded from a careless one (trimmed).
    const WEAK: &[(&str, &str)] = &[
        ("server", "Apache/2.4.29 (Ubuntu)"),
        ("x-powered-by", "PHP/7.2.24"),
        ("strict-transport-security", "max-age=3600"),
        (
            "content-security-policy",
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:",
        ),
        ("access-control-allow-origin", "https://cors-check.invalid"),
        ("access-control-allow-credentials", "true"),
        ("cache-control", "public, max-age=600"),
        ("set-cookie", "PHPSESSID=abc; path=/"),
        ("set-cookie", "track=1; SameSite=None"),
        ("set-cookie", "__Host-x=1; Secure; Path=/app"),
    ];

    #[test]
    fn a_strong_site_passes_every_check_that_matters() {
        let url = reqwest::Url::parse("https://example.com/").unwrap();
        let (checks, cookies, directives) = assess(&url, &h(STRONG));
        for id in [
            "https",
            "hsts",
            "csp",
            "frame",
            "nosniff",
            "referrer",
            "permissions",
            "coop",
            "cors",
            "cache",
            "server",
        ] {
            assert_eq!(
                check(&checks, id).level,
                "pass",
                "{id}: {:?}",
                check(&checks, id)
            );
        }
        assert_eq!(
            check(&checks, "hsts").notes,
            vec!["includeSubDomains", "preload"]
        );
        assert_eq!(check(&checks, "frame").notes, vec!["byCsp"]);
        assert_eq!(cookies.len(), 1);
        assert!(cookies[0].issues.is_empty(), "{:?}", cookies[0].issues);
        assert_eq!(directives[0], ("default-src".into(), "'none'".into()));
        assert_eq!(counts(&checks).fail, 0);
    }

    #[test]
    fn a_weak_site_is_told_what_is_wrong() {
        let url = reqwest::Url::parse("https://example.com/").unwrap();
        let (checks, cookies, _) = assess(&url, &h(WEAK));
        assert_eq!(check(&checks, "hsts").level, "warn");
        assert_eq!(check(&checks, "hsts").notes, vec!["shortMaxAge"]);
        let csp = check(&checks, "csp");
        assert_eq!(csp.level, "fail");
        assert!(csp.notes.contains(&"unsafeInline".to_string()));
        assert!(csp.notes.contains(&"unsafeEval".to_string()));
        assert!(csp.notes.contains(&"wideSources".to_string()));
        assert!(csp.notes.contains(&"noObjectSrc".to_string()));
        assert_eq!(check(&checks, "frame").notes, vec!["missing"]);
        assert_eq!(check(&checks, "nosniff").level, "warn");
        assert_eq!(
            check(&checks, "cors").notes,
            vec!["reflectsOrigin", "withCredentials"]
        );
        assert_eq!(check(&checks, "cors").level, "fail");
        assert_eq!(check(&checks, "cache").notes, vec!["publicWithCookies"]);
        assert_eq!(check(&checks, "server").notes, vec!["versionDisclosed"]);
        assert_eq!(
            cookies[0].issues,
            vec!["noSecure", "noHttpOnly", "noSameSite"]
        );
        assert_eq!(
            cookies[1].issues,
            vec!["noSecure", "noHttpOnly", "sameSiteNoneInsecure"]
        );
        assert!(cookies[2].issues.contains(&"badHostPrefix".to_string()));
    }

    #[test]
    fn plain_http_is_a_failure_and_hsts_does_not_apply() {
        let url = reqwest::Url::parse("http://example.com/").unwrap();
        let (checks, cookies, _) = assess(
            &url,
            &h(&[("set-cookie", "a=1; HttpOnly; SameSite=Strict")]),
        );
        assert_eq!(check(&checks, "https").level, "fail");
        assert_eq!(check(&checks, "hsts").level, "info");
        assert!(
            cookies[0].issues.is_empty(),
            "Secure is not required over plain HTTP"
        );
        assert_eq!(check(&checks, "cache").notes, vec!["missingWithCookies"]);
    }

    #[test]
    fn cors_wildcards_and_nonces_are_read_right() {
        let wildcard = cors(&h(&[("access-control-allow-origin", "*")]));
        assert_eq!(
            (wildcard.level.as_str(), wildcard.notes.clone()),
            ("warn", vec!["anyOrigin".to_string()])
        );
        let one = cors(&h(&[(
            "access-control-allow-origin",
            "https://app.example.com",
        )]));
        assert_eq!(one.level, "pass");
        let (nonce, _) = csp(&h(&[(
            "content-security-policy",
            "script-src 'self' 'unsafe-inline' 'nonce-x'; object-src 'none'",
        )]));
        assert!(
            !nonce.notes.contains(&"unsafeInline".to_string()),
            "a nonce disables unsafe-inline"
        );
        let directives = csp_directives("script-src a; SCRIPT-SRC b;; img-src *");
        assert_eq!(
            directives,
            vec![
                ("script-src".into(), "a".into()),
                ("img-src".into(), "*".into())
            ]
        );
    }

    #[test]
    fn urls_get_https_and_lose_nothing_else() {
        assert_eq!(
            parse_url("example.com").unwrap().as_str(),
            "https://example.com/"
        );
        assert_eq!(
            parse_url("http://localhost:8080/a?b").unwrap().as_str(),
            "http://localhost:8080/a?b"
        );
        assert_eq!(
            parse_url("https://u:p@example.com"),
            Err("target_credentials".into())
        );
        for bad in ["", "ftp://example.com", "a b", "https://"] {
            assert!(parse_url(bad).is_err(), "{bad}");
        }
        assert_eq!(
            scope_host(&parse_url("https://WWW.Example.com:8443/").unwrap()),
            "www.example.com"
        );
    }
}
