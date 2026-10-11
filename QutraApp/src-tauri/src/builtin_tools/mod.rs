//! The app's own built-in tools: they run inside
//! Qutra Labs, need no runtime or install, and never execute what they read.
//!
//! - Local, no network: the metadata inspector (`metadata`) and the
//!   connection and PID monitor (`conns`). The keyboard-event viewer is the
//!   page's own; it needs nothing from here.
//! - Network, only on the user's click and only to the place the page names:
//!   RDAP (`rdap`), the TLS inspector (`tls`), the HTTP security analyzer
//!   (`httpsec`) and the dependency check against OSV.dev (`deps`). A target
//!   the user types arrives with the investigation's scope decision, which
//!   Rust checks again here (`check_scope`) before anything is sent.
//!
//! Each network command runs under a request id the page may cancel, and
//! under a time limit; every answer is read within a size cap.

pub mod commands;
pub mod conns;
pub mod deps;
pub mod httpsec;
pub mod metadata;
pub mod rdap;
pub mod tls;
mod x509;

use std::{
    collections::HashMap,
    future::Future,
    net::IpAddr,
    sync::{Arc, Mutex},
    time::Duration,
};

use futures_util::StreamExt;
use tokio::sync::Notify;

pub use crate::net_guard::is_local_ip;
use crate::net_guard::{self, Access};
use crate::tool_supervisor::ScopeAttestation;

/// How old a scope decision may be when it arrives.
const SCOPE_MAX_AGE_MS: u64 = 5 * 60 * 1000;
/// Clock skew allowed between the page and Rust.
const SCOPE_FUTURE_SKEW_MS: u64 = 30_000;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// The commands' shared state: requests in flight, and the packages the
/// last picked manifests held (the only list the OSV check may send).
#[derive(Default)]
pub struct BuiltinTools {
    requests: Mutex<HashMap<String, Arc<Notify>>>,
    manifests: Mutex<Option<deps::Picked>>,
}

impl BuiltinTools {
    fn register(&self, id: &str) -> Result<Arc<Notify>, String> {
        let mut requests = lock(&self.requests);
        if requests.contains_key(id) {
            return Err("request_busy".into());
        }
        let notify = Arc::new(Notify::new());
        requests.insert(id.to_string(), notify.clone());
        Ok(notify)
    }

    fn unregister(&self, id: &str) {
        lock(&self.requests).remove(id);
    }

    /// Stop a request in flight. A stored permit makes a cancel that comes
    /// before the request waits still count.
    pub fn cancel(&self, id: &str) -> bool {
        match lock(&self.requests).get(id) {
            Some(notify) => {
                notify.notify_one();
                true
            }
            None => false,
        }
    }

    fn set_manifests(&self, picked: deps::Picked) {
        *lock(&self.manifests) = Some(picked);
    }

    fn manifests(&self, token: &str) -> Option<deps::Picked> {
        lock(&self.manifests)
            .as_ref()
            .filter(|picked| picked.token == token)
            .cloned()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// Removes a request from the table however its future ends.
struct Registration<'a> {
    tools: &'a BuiltinTools,
    id: String,
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        self.tools.unregister(&self.id);
    }
}

pub fn validate_request_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    ok.then_some(()).ok_or_else(|| "invalid_request".into())
}

/// Run `work` under `request_id` until it ends, the page cancels it or
/// `limit` passes.
pub async fn guarded<T>(
    tools: &BuiltinTools,
    request_id: &str,
    limit: Duration,
    work: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    validate_request_id(request_id)?;
    let notify = tools.register(request_id)?;
    let _registration = Registration {
        tools,
        id: request_id.to_string(),
    };
    tokio::select! {
        outcome = tokio::time::timeout(limit, work) => {
            outcome.unwrap_or_else(|_| Err("timeout".into()))
        }
        _ = notify.notified() => Err("cancelled".into()),
    }
}

/// The client every built-in network tool uses: redirects are never
/// followed on their own (each tool decides which it may follow), an
/// answer's size is checked as it is read (`read_capped`), and names resolve
/// through `net_guard`, so a request only reaches an address `access` allows,
/// whatever the name answers.
pub fn client(limit: Duration, access: Access) -> Result<reqwest::Client, String> {
    client_with(limit, net_guard::GuardedResolver::new(access))
}

fn client_with(
    limit: Duration,
    resolver: Arc<net_guard::GuardedResolver>,
) -> Result<reqwest::Client, String> {
    let builder = reqwest::Client::builder()
        .use_rustls_tls()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(limit)
        .user_agent(concat!("QutraLabs/", env!("CARGO_PKG_VERSION")));
    net_guard::guard_with(builder, resolver)
        .build()
        .map_err(|_| "client_failed".to_string())
}

/// Read a whole answer, refusing one larger than `cap` bytes.
pub async fn read_capped(response: reqwest::Response, cap: usize) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > cap as u64)
    {
        return Err("answer_too_large".into());
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| transport_error(&error))?;
        if body.len() + chunk.len() > cap {
            return Err("answer_too_large".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// A transport failure as a code the page can word.
pub fn transport_error(error: &reqwest::Error) -> String {
    if net_guard::is_refusal(error) {
        "target_not_public".into()
    } else if error.is_timeout() {
        "timeout".into()
    } else if error.is_connect() {
        let text = format!("{error:?}").to_ascii_lowercase();
        if text.contains("certificate") || text.contains("invalidcertificate") {
            "tls_untrusted".into()
        } else if text.contains("dns") || text.contains("resolve") {
            "dns_failed".into()
        } else {
            "connect_failed".into()
        }
    } else {
        "request_failed".into()
    }
}

/// A host the scope may call local without an investigation: `localhost`
/// or a literal local address. A name is never local, whatever it resolves
/// to, as in the page's `normalizeTarget`.
pub fn is_local_host(host: &str) -> bool {
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    bare.eq_ignore_ascii_case("localhost") || bare.parse::<IpAddr>().is_ok_and(is_local_ip)
}

/// Where a request to `host` may go. A host the user typed as `localhost` or
/// a local address may reach local addresses; any other name or address may
/// reach public ones only, however the name resolves (a name is never local,
/// as in `is_local_host`). To inspect a machine on a private network, type
/// its address.
pub fn access_for(host: &str) -> Access {
    if is_local_host(host) {
        Access::Local
    } else {
        Access::Public
    }
}

/// Check, again in Rust, the scope decision the page made for `target`
/// (`evaluateTarget`, src/domain/lab/scope.ts): it must allow this very
/// target, be fresh, and name a scope unless the host is local.
pub fn check_scope(
    target: &str,
    host: &str,
    scope: &ScopeAttestation,
    now: u64,
) -> Result<(), String> {
    if !scope.allowed {
        return Err("scope_blocked".into());
    }
    if scope.target.trim() != target.trim() || scope.target.chars().any(char::is_control) {
        return Err("scope_target_mismatch".into());
    }
    match scope.reason.as_str() {
        "allowed_local" => {
            // The page may only call a local host local.
            if !is_local_host(host) {
                return Err("scope_blocked".into());
            }
        }
        "allowed_in_scope" => {
            if scope.scope_id.is_empty() {
                return Err("scope_required".into());
            }
        }
        _ => return Err("scope_blocked".into()),
    }
    if !scope.scope_id.is_empty()
        && (scope.scope_revision == 0
            || scope.scope_id.len() > 128
            || !scope
                .scope_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.')))
    {
        return Err("scope_invalid".into());
    }
    if scope.decided_at > now.saturating_add(SCOPE_FUTURE_SKEW_MS)
        || now.saturating_sub(scope.decided_at) > SCOPE_MAX_AGE_MS
    {
        return Err("scope_stale".into());
    }
    if scope.expires_at.is_some_and(|expires| expires < now) {
        return Err("scope_expired".into());
    }
    Ok(())
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Text from an answer or a file, safe to show: see `analysis::clean_text`.
pub(crate) fn clean(text: &str) -> String {
    crate::analysis::clean_text(text)
}

/// Like `clean`, for longer values (a policy, a header): control characters
/// and direction marks go, the length is capped at `max` characters.
pub(crate) fn clean_long(text: &str, max: usize) -> String {
    let kept: String = text
        .chars()
        .filter(|c| {
            !c.is_control()
                && !matches!(
                    c,
                    '\u{00AD}'
                        | '\u{061C}'
                        | '\u{180E}'
                        | '\u{200B}'..='\u{200F}'
                        | '\u{2028}'..='\u{202E}'
                        | '\u{2060}'..='\u{2069}'
                        | '\u{FEFF}'
                        | '\u{E0000}'..='\u{E007F}'
                )
        })
        .take(max + 1)
        .collect();
    if kept.chars().count() > max {
        let mut cut: String = kept.chars().take(max).collect();
        cut.push('…');
        cut.trim().to_string()
    } else {
        kept.trim().to_string()
    }
}

/// Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
pub(crate) fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Days since 1970-01-01 from a civil date.
pub(crate) fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let m = m as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Milliseconds since the epoch as an ISO 8601 UTC time.
pub(crate) fn iso_utc(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    let rem = secs.rem_euclid(86_400);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem / 60) % 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attestation(
        target: &str,
        reason: &str,
        scope_id: &str,
        decided_at: u64,
    ) -> ScopeAttestation {
        ScopeAttestation {
            scope_id: scope_id.into(),
            scope_revision: if scope_id.is_empty() { 0 } else { 3 },
            target: target.into(),
            allowed: true,
            reason: reason.into(),
            decided_at,
            expires_at: None,
        }
    }

    #[test]
    fn a_scope_decision_must_allow_this_target_and_be_fresh() {
        let now = 1_800_000_000_000;
        let ok = attestation("example.com", "allowed_in_scope", "scope_1", now - 1000);
        assert_eq!(check_scope("example.com", "example.com", &ok, now), Ok(()));
        assert_eq!(
            check_scope("other.com", "other.com", &ok, now),
            Err("scope_target_mismatch".into())
        );
        let stale = attestation(
            "example.com",
            "allowed_in_scope",
            "scope_1",
            now - SCOPE_MAX_AGE_MS - 1,
        );
        assert_eq!(
            check_scope("example.com", "example.com", &stale, now),
            Err("scope_stale".into())
        );
        let mut blocked = ok.clone();
        blocked.allowed = false;
        assert_eq!(
            check_scope("example.com", "example.com", &blocked, now),
            Err("scope_blocked".into())
        );
        let mut expired = ok.clone();
        expired.expires_at = Some(now - 1);
        assert_eq!(
            check_scope("example.com", "example.com", &expired, now),
            Err("scope_expired".into())
        );
        let no_scope = attestation("example.com", "allowed_in_scope", "", now);
        assert_eq!(
            check_scope("example.com", "example.com", &no_scope, now),
            Err("scope_required".into())
        );
    }

    #[test]
    fn only_a_local_host_may_be_called_local() {
        let now = 1_800_000_000_000;
        for host in [
            "localhost",
            "127.0.0.1",
            "10.1.2.3",
            "192.168.1.10",
            "[::1]",
            "fe80::1",
        ] {
            let local = attestation(host, "allowed_local", "", now);
            assert_eq!(check_scope(host, host, &local, now), Ok(()), "{host}");
        }
        for host in [
            "8.8.8.8",
            "example.com",
            "localhost.evil.com",
            "2001:db8::1",
        ] {
            let lie = attestation(host, "allowed_local", "", now);
            assert_eq!(
                check_scope(host, host, &lie, now),
                Err("scope_blocked".into()),
                "{host}"
            );
        }
        let odd = attestation("example.com", "no_scope", "", now);
        assert_eq!(
            check_scope("example.com", "example.com", &odd, now),
            Err("scope_blocked".into())
        );
    }

    #[test]
    fn only_a_typed_local_host_may_reach_local_addresses() {
        for host in [
            "localhost",
            "LocalHost",
            "127.0.0.1",
            "[::1]",
            "10.0.0.5",
            "192.168.1.1",
        ] {
            assert_eq!(access_for(host), Access::Local, "{host}");
        }
        for host in [
            "example.com",
            "8.8.8.8",
            "localhost.evil.com",
            "intranet.corp",
            "0.0.0.0",
            "2001:db8::1",
            "100.64.0.1",
        ] {
            assert_eq!(access_for(host), Access::Public, "{host}");
        }
    }

    /// A public-looking name whose answer is a local address must not be
    /// connected to, even though a listener waits there. The lookup is
    /// recorded; no name server is asked.
    #[tokio::test]
    async fn a_built_in_client_refuses_a_name_that_resolves_inside_the_network() {
        use crate::net_guard::{tests::Recorded, GuardedResolver};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let lookup = Recorded::new(&[("rebind.example.com", &["127.0.0.1"])]);
        let http = client_with(
            Duration::from_secs(5),
            GuardedResolver::with_lookup(lookup.clone(), Access::Public),
        )
        .unwrap();
        let error = http
            .get(format!("http://rebind.example.com:{port}/"))
            .send()
            .await
            .unwrap_err();
        assert_eq!(transport_error(&error), "target_not_public");
        assert_eq!(lookup.asked(), ["rebind.example.com"]);
        assert!(listener.accept().is_err(), "something connected");
    }

    #[test]
    fn request_ids_are_short_and_plain() {
        assert!(validate_request_id("req-1_a").is_ok());
        assert!(validate_request_id("").is_err());
        assert!(validate_request_id("a b").is_err());
        assert!(validate_request_id(&"a".repeat(65)).is_err());
    }

    #[tokio::test]
    async fn a_request_ends_on_cancel_or_on_its_time_limit() {
        let tools = Arc::new(BuiltinTools::default());
        let waiting = {
            let tools = tools.clone();
            tokio::spawn(async move {
                guarded(&tools, "r1", Duration::from_secs(30), async {
                    tokio::time::sleep(Duration::from_secs(60)).await;
                    Ok::<_, String>(1)
                })
                .await
            })
        };
        // Let the request register, then cancel it.
        for _ in 0..100 {
            if tools.cancel("r1") {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(waiting.await.unwrap(), Err("cancelled".into()));
        assert!(!tools.cancel("r1"), "the request left the table");

        let slow = guarded(&tools, "r2", Duration::from_millis(20), async {
            tokio::time::sleep(Duration::from_secs(5)).await;
            Ok::<_, String>(1)
        })
        .await;
        assert_eq!(slow, Err("timeout".into()));
        let quick = guarded(&tools, "r3", Duration::from_secs(5), async {
            Ok::<_, String>(7)
        })
        .await;
        assert_eq!(quick, Ok(7));
    }

    #[test]
    fn dates_convert_both_ways() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(days_from_civil(2000, 2, 29), 11_016);
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
        assert_eq!(iso_utc(1_791_640_800_000), "2026-10-10T14:00:00Z");
        assert_eq!(clean_long("a\u{202E}b\ncd", 3), "abc…");
        assert_eq!(clean_long("abc", 3), "abc");
    }
}
