//! One rule for every request whose target a person, a page or a remote
//! answer chose: connect only to a public address, and only to the address
//! that was checked.
//!
//! A host name is resolved here. Answers that are not public (loopback,
//! private, link-local, shared, unspecified, multicast, documentation and the
//! like) are dropped and the connection goes to what is left; when nothing is
//! left there is no connection. The resolver hands the checked addresses to
//! the connector, so a name that answers differently a second time (DNS
//! rebinding) cannot send the request elsewhere, and the same holds for every
//! redirect hop. An address written as a literal never reaches a resolver, so
//! `check_literal_host` tests it before the request. Clients built with
//! `guard_with` ignore proxy settings: a proxy would resolve the name again, out
//! of sight.

use std::{
    error::Error,
    fmt,
    future::Future,
    io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    pin::Pin,
    sync::Arc,
};

use reqwest::Url;

/// Which addresses a request may reach.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    /// Public addresses only.
    Public,
    /// This machine and its private network, for a target the user typed as a
    /// local address.
    Local,
}

impl Access {
    pub fn allows(self, ip: IpAddr) -> bool {
        match self {
            Access::Public => is_public_ip(ip),
            Access::Local => is_local_ip(ip),
        }
    }
}

/// Why a request was not sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuardError {
    /// The name answered, and no answer was an allowed address.
    NotPublic,
    /// The name did not answer.
    Dns,
}

impl fmt::Display for GuardError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            GuardError::NotPublic => "target_not_public",
            GuardError::Dns => "dns_failed",
        })
    }
}

impl Error for GuardError {}

/// Whether a failed request was refused by the guard rather than by the
/// network. Looks through the error's causes, where the resolver's refusal
/// sits under the connector's.
pub fn is_refusal(error: &(dyn Error + 'static)) -> bool {
    let mut current: Option<&(dyn Error + 'static)> = Some(error);
    while let Some(found) = current {
        if found
            .downcast_ref::<GuardError>()
            .is_some_and(|guard| *guard == GuardError::NotPublic)
        {
            return true;
        }
        current = found.source();
    }
    false
}

/* ---------- Addresses ---------- */

/// An address on the public internet. Everything else, including ranges that
/// only look public (shared address space, documentation, multicast), is not.
/// An IPv6 address that carries an IPv4 address (mapped, NAT64, 6to4) is as
/// public as the IPv4 address it carries.
pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => is_public_v6(v6),
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        // 100.64.0.0/10, shared address space (carrier-grade NAT).
        || (a == 100 && (b & 0xc0) == 64)
        // 192.0.0.0/24, IETF protocol assignments.
        || (a == 192 && b == 0 && c == 0)
        // Documentation: 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24.
        || (a == 192 && b == 0 && c == 2)
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        // 198.18.0.0/15, benchmarking.
        || (a == 198 && (b & 0xfe) == 18)
        // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved, and the broadcast address.
        || a >= 224)
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_public_v4(v4);
    }
    let s = ip.segments();
    let carried = |high: u16, low: u16| {
        let [a, b] = high.to_be_bytes();
        let [c, d] = low.to_be_bytes();
        Ipv4Addr::new(a, b, c, d)
    };
    // ::/96 holds the unspecified address, the loopback address and the
    // deprecated IPv4-compatible form.
    if s[..6] == [0; 6] {
        return false;
    }
    // 64:ff9b::/96, NAT64: the IPv4 address it reaches.
    if s[0] == 0x0064 && s[1] == 0xff9b && s[2..6] == [0; 4] {
        return is_public_v4(carried(s[6], s[7]));
    }
    // 2002::/16, 6to4: the IPv4 address it relays to.
    if s[0] == 0x2002 {
        return is_public_v4(carried(s[1], s[2]));
    }
    !((s[0] & 0xfe00) == 0xfc00 // fc00::/7 unique local
        || (s[0] & 0xffc0) == 0xfe80 // fe80::/10 link-local
        || (s[0] & 0xffc0) == 0xfec0 // fec0::/10 site-local, deprecated
        || (s[0] & 0xff00) == 0xff00 // ff00::/8 multicast
        || (s[0] == 0x0100 && s[1..4] == [0; 3]) // 100::/64 discard
        || (s[0] == 0x2001 && s[1] == 0) // 2001::/32 Teredo
        || (s[0] == 0x2001 && s[1] == 0x0db8) // 2001:db8::/32 documentation
        || (s[0] == 0x3fff && (s[1] & 0xf000) == 0) // 3fff::/20 documentation
        || (s[0] == 0x0064 && s[1] == 0xff9b)) // 64:ff9b:1::/48 local-use NAT64
}

/// An address that stays on this machine or its private network.
pub fn is_local_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => is_local_ip(IpAddr::V4(v4)),
            None => {
                let first = v6.segments()[0];
                v6.is_loopback() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
            }
        },
    }
}

/// A host that plainly names this machine or a non-public address: `localhost`
/// and its subdomains, or an address literal that is not public. Any other
/// name may resolve anywhere; the guard checks that when it connects.
pub fn names_non_public(host: &str) -> bool {
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    let lower = bare.trim_end_matches('.').to_ascii_lowercase();
    if lower == "localhost" || lower.ends_with(".localhost") {
        return true;
    }
    bare.parse::<IpAddr>().is_ok_and(|ip| !is_public_ip(ip))
}

/// An address literal in `url` that `access` does not allow. A name passes:
/// the resolver checks what it resolves to.
pub fn check_literal_host(url: &Url, access: Access) -> Result<(), GuardError> {
    let Some(host) = url.host_str() else {
        return Err(GuardError::NotPublic);
    };
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    match bare.parse::<IpAddr>() {
        Ok(ip) if !access.allows(ip) => Err(GuardError::NotPublic),
        _ => Ok(()),
    }
}

/// HTTPS to a public host name only: no IP literals, no single-label or
/// local names, no credentials and no port but 443. What the name resolves
/// to is the resolver's business (`guard_with`).
pub fn check_public_https(url: &Url) -> Result<(), String> {
    if url.scheme() != "https" {
        return Err("not_https".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("credentials_in_url".into());
    }
    if url.port().is_some_and(|port| port != 443) {
        return Err("unexpected_port".into());
    }
    // The URL parser writes an IPv6 literal in brackets and normalizes IPv4
    // shorthand ("127.1"), so both are caught here.
    let Some(host) = url.host_str() else {
        return Err("not_a_host_name".into());
    };
    if host.starts_with('[') || host.parse::<IpAddr>().is_ok() {
        return Err("not_a_host_name".into());
    }
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let local = [
        "localhost",
        "local",
        "internal",
        "lan",
        "home.arpa",
        "intranet",
        "corp",
    ];
    if !host.contains('.')
        || local
            .iter()
            .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
    {
        return Err("not_a_public_host".into());
    }
    Ok(())
}

/* ---------- Resolving ---------- */

pub type LookupFuture = Pin<Box<dyn Future<Output = io::Result<Vec<IpAddr>>> + Send>>;

/// What turns a host name into addresses. The system's resolver in the app;
/// recorded answers in tests, so no test asks a real name server.
pub trait Lookup: Send + Sync + 'static {
    fn lookup(&self, host: &str) -> LookupFuture;
}

pub struct SystemLookup;

impl Lookup for SystemLookup {
    fn lookup(&self, host: &str) -> LookupFuture {
        let host = host.to_string();
        Box::pin(async move {
            let found = tokio::net::lookup_host((host, 0u16)).await?;
            Ok(found.map(|address| address.ip()).collect())
        })
    }
}

/// The addresses of `host` that `access` allows, each once. An error when the
/// name does not answer, or when no answer is allowed.
pub async fn allowed_addresses(
    lookup: &dyn Lookup,
    host: &str,
    access: Access,
) -> Result<Vec<IpAddr>, GuardError> {
    let answers = lookup.lookup(host).await.map_err(|_| GuardError::Dns)?;
    if answers.is_empty() {
        return Err(GuardError::Dns);
    }
    let mut kept: Vec<IpAddr> = Vec::new();
    for ip in answers {
        if access.allows(ip) && !kept.contains(&ip) {
            kept.push(ip);
        }
    }
    if kept.is_empty() {
        Err(GuardError::NotPublic)
    } else {
        Ok(kept)
    }
}

/// The resolver a guarded client uses: it hands the connector only the
/// addresses `allowed_addresses` kept.
pub struct GuardedResolver {
    lookup: Arc<dyn Lookup>,
    access: Access,
}

impl GuardedResolver {
    pub fn new(access: Access) -> Arc<Self> {
        Self::with_lookup(Arc::new(SystemLookup), access)
    }

    pub fn with_lookup(lookup: Arc<dyn Lookup>, access: Access) -> Arc<Self> {
        Arc::new(Self { lookup, access })
    }
}

impl reqwest::dns::Resolve for GuardedResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let lookup = self.lookup.clone();
        let access = self.access;
        let host = name.as_str().to_string();
        Box::pin(async move {
            let kept = allowed_addresses(&*lookup, &host, access).await?;
            let addresses: reqwest::dns::Addrs =
                Box::new(kept.into_iter().map(|ip| SocketAddr::new(ip, 0)));
            Ok(addresses)
        })
    }
}

/// A client that connects only where `access` allows: names resolve through
/// the guard and proxy settings are ignored.
pub fn guard_with(
    builder: reqwest::ClientBuilder,
    resolver: Arc<GuardedResolver>,
) -> reqwest::ClientBuilder {
    builder.no_proxy().dns_resolver(resolver)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// Recorded answers by host name, and the names asked.
    pub struct Recorded {
        answers: HashMap<String, Vec<IpAddr>>,
        asked: Mutex<Vec<String>>,
    }

    impl Recorded {
        pub fn new(answers: &[(&str, &[&str])]) -> Arc<Self> {
            Arc::new(Self {
                answers: answers
                    .iter()
                    .map(|(host, ips)| {
                        (
                            host.to_string(),
                            ips.iter().map(|ip| ip.parse().unwrap()).collect(),
                        )
                    })
                    .collect(),
                asked: Mutex::new(Vec::new()),
            })
        }

        pub fn asked(&self) -> Vec<String> {
            self.asked.lock().unwrap().clone()
        }
    }

    impl Lookup for Recorded {
        fn lookup(&self, host: &str) -> LookupFuture {
            self.asked.lock().unwrap().push(host.to_string());
            let answer = self.answers.get(host).cloned();
            Box::pin(async move {
                answer.ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no such name"))
            })
        }
    }

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    #[test]
    fn only_public_addresses_are_public() {
        for public in [
            "8.8.8.8",
            "93.184.216.34",
            "1.1.1.1",
            "172.15.255.255",
            "172.32.0.1",
            "100.63.255.255",
            "100.128.0.1",
            "2606:4700:4700::1111",
            "2a00:1450:4001:81b::200e",
            // IPv4 carried in IPv6 is as public as the IPv4 address.
            "::ffff:8.8.8.8",
            "64:ff9b::808:808",
            "2002:808:808::1",
        ] {
            assert!(is_public_ip(ip(public)), "{public}");
        }
        for private in [
            "0.0.0.0",
            "0.1.2.3",
            "127.0.0.1",
            "127.255.255.254",
            "10.0.0.1",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "169.254.0.1",
            "100.64.0.1",
            "100.127.255.254",
            "192.0.0.8",
            "192.0.2.1",
            "198.51.100.7",
            "203.0.113.9",
            "198.18.0.1",
            "198.19.255.255",
            "224.0.0.1",
            "239.255.255.250",
            "240.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "::127.0.0.1",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "fec0::1",
            "ff02::1",
            "100::1",
            "2001::1",
            "2001:db8::1",
            "3fff::1",
            // IPv4 carried in IPv6 is as private as the IPv4 address.
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.5",
            "::ffff:169.254.169.254",
            "64:ff9b::7f00:1",
            "64:ff9b::a00:1",
            "2002:7f00:1::1",
            "2002:c0a8:101::1",
        ] {
            assert!(!is_public_ip(ip(private)), "{private}");
        }
    }

    #[test]
    fn a_local_address_is_loopback_private_or_link_local() {
        for local in [
            "127.0.0.1",
            "10.1.2.3",
            "192.168.0.9",
            "169.254.1.1",
            "::1",
            "fd00::5",
            "fe80::1",
            "::ffff:192.168.0.9",
        ] {
            assert!(is_local_ip(ip(local)), "{local}");
        }
        for other in [
            "8.8.8.8",
            "100.64.0.1",
            "0.0.0.0",
            "2001:db8::1",
            "::ffff:8.8.8.8",
        ] {
            assert!(!is_local_ip(ip(other)), "{other}");
        }
    }

    #[tokio::test]
    async fn a_name_that_answers_with_private_addresses_is_refused() {
        let lookup = Recorded::new(&[
            ("rebind.example.com", &["127.0.0.1"]),
            ("metadata.example.com", &["169.254.169.254"]),
            ("lan.example.com", &["10.0.0.7", "192.168.1.5"]),
            ("v6.example.com", &["::1", "fd00::1"]),
            (
                "mixed.example.com",
                &["10.0.0.7", "93.184.216.34", "93.184.216.34"],
            ),
            (
                "fine.example.com",
                &["93.184.216.34", "2606:4700:4700::1111"],
            ),
        ]);
        for refused in [
            "rebind.example.com",
            "metadata.example.com",
            "lan.example.com",
            "v6.example.com",
        ] {
            assert_eq!(
                allowed_addresses(&*lookup, refused, Access::Public).await,
                Err(GuardError::NotPublic),
                "{refused}"
            );
        }
        // Only the public answers are kept, each once.
        assert_eq!(
            allowed_addresses(&*lookup, "mixed.example.com", Access::Public).await,
            Ok(vec![ip("93.184.216.34")])
        );
        assert_eq!(
            allowed_addresses(&*lookup, "fine.example.com", Access::Public)
                .await
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            allowed_addresses(&*lookup, "missing.example.com", Access::Public).await,
            Err(GuardError::Dns)
        );
    }

    #[tokio::test]
    async fn a_local_target_may_reach_local_addresses_only() {
        let lookup = Recorded::new(&[
            ("localhost", &["127.0.0.1", "::1"]),
            ("liar.example.com", &["93.184.216.34"]),
        ]);
        assert_eq!(
            allowed_addresses(&*lookup, "localhost", Access::Local)
                .await
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            allowed_addresses(&*lookup, "liar.example.com", Access::Local).await,
            Err(GuardError::NotPublic)
        );
        assert_eq!(
            allowed_addresses(&*lookup, "localhost", Access::Public).await,
            Err(GuardError::NotPublic)
        );
    }

    #[test]
    fn an_address_literal_is_checked_before_the_request() {
        let url = |text: &str| Url::parse(text).unwrap();
        for refused in [
            "https://127.0.0.1/",
            "https://[::1]/",
            "http://10.1.2.3:8080/x",
            "https://169.254.169.254/latest/meta-data",
            "https://0.0.0.0/",
            "https://[fd00::1]/",
            // The URL parser turns these into 127.0.0.1.
            "https://127.1/",
            "https://2130706433/",
            "https://0x7f.0.0.1/",
            "https://[::ffff:7f00:1]/",
        ] {
            assert_eq!(
                check_literal_host(&url(refused), Access::Public),
                Err(GuardError::NotPublic),
                "{refused}"
            );
        }
        for passed in [
            "https://example.com/",
            "https://8.8.8.8/",
            "https://[2606:4700:4700::1111]/",
        ] {
            assert_eq!(
                check_literal_host(&url(passed), Access::Public),
                Ok(()),
                "{passed}"
            );
        }
        assert_eq!(
            check_literal_host(&url("http://127.0.0.1:9/"), Access::Local),
            Ok(())
        );
        assert_eq!(
            check_literal_host(&url("http://8.8.8.8/"), Access::Local),
            Err(GuardError::NotPublic)
        );
    }

    #[test]
    fn a_host_that_plainly_names_this_machine_is_recognised() {
        for host in [
            "localhost",
            "LOCALHOST.",
            "app.localhost",
            "127.0.0.1",
            "[::1]",
            "10.0.0.1",
            "192.168.1.9",
            "169.254.169.254",
            "0.0.0.0",
        ] {
            assert!(names_non_public(host), "{host}");
        }
        for host in [
            "example.com",
            "docs.example.org",
            "8.8.8.8",
            "notlocalhost.com",
        ] {
            assert!(!names_non_public(host), "{host}");
        }
    }

    #[test]
    fn a_public_https_address_is_a_public_name_on_443() {
        let url = |text: &str| Url::parse(text).unwrap();
        assert_eq!(check_public_https(&url("https://example.com/a")), Ok(()));
        assert_eq!(
            check_public_https(&url("https://example.com:443/a")),
            Ok(())
        );
        for (text, reason) in [
            ("http://example.com/", "not_https"),
            ("https://user:pw@example.com/", "credentials_in_url"),
            ("https://example.com:8443/", "unexpected_port"),
            ("https://127.0.0.1/", "not_a_host_name"),
            ("https://[::1]/", "not_a_host_name"),
            ("https://127.1/", "not_a_host_name"),
            ("https://localhost/", "not_a_public_host"),
            ("https://intranet/", "not_a_public_host"),
            ("https://printer.local/", "not_a_public_host"),
            ("https://wiki.corp/", "not_a_public_host"),
        ] {
            assert_eq!(
                check_public_https(&url(text)),
                Err(reason.to_string()),
                "{text}"
            );
        }
    }

    /// A client built with `guard_with` never connects to an address the
    /// guard drops, even when a listener waits there: the name answers with
    /// this machine's loopback, as a rebinding name would.
    #[tokio::test]
    async fn a_guarded_client_does_not_connect_to_what_the_guard_drops() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let lookup = Recorded::new(&[("rebind.example.com", &["127.0.0.1"])]);
        let resolver = GuardedResolver::with_lookup(lookup.clone(), Access::Public);
        let client = guard_with(reqwest::Client::builder(), resolver)
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap();
        let error = client
            .get(format!("http://rebind.example.com:{port}/"))
            .send()
            .await
            .unwrap_err();
        assert!(error.is_connect(), "{error:?}");
        assert!(is_refusal(&error), "{error:?}");
        assert_eq!(lookup.asked(), ["rebind.example.com"]);
        let accepted =
            tokio::time::timeout(std::time::Duration::from_millis(200), listener.accept()).await;
        assert!(accepted.is_err(), "something connected to the listener");
    }

    /// The same client, allowed to reach local addresses, does connect: the
    /// refusal above is the guard's doing, not the test's setup.
    #[tokio::test]
    async fn the_same_client_connects_where_the_guard_allows() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
            }
        });
        let lookup = Recorded::new(&[("printer.example.com", &["127.0.0.1"])]);
        let resolver = GuardedResolver::with_lookup(lookup, Access::Local);
        let client = guard_with(reqwest::Client::builder(), resolver)
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap();
        let response = client
            .get(format!("http://printer.example.com:{port}/"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 204);
    }
}
