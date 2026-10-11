//! TLS certificate inspector: one handshake to `host:port` shows the chain
//! the server sends, the protocol and cipher it picks, ALPN, the names on
//! the certificate and when it expires; two more handshakes, one per
//! protocol version, say which of TLS 1.3 and 1.2 it accepts.
//!
//! The chain is verified against the bundled Mozilla roots (webpki-roots)
//! and the result is reported, not enforced, so an untrusted or expired
//! certificate can still be inspected. Nothing is sent after the handshake.
//! TLS 1.0 and 1.1 cannot be tried: the TLS library refuses them.

use std::{
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::Duration,
};

use rustls::{
    client::{
        danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
        WebPkiServerVerifier,
    },
    crypto::CryptoProvider,
    pki_types::{CertificateDer, ServerName, UnixTime},
    CertificateError, DigitallySignedStruct, SignatureScheme,
};
use serde::Serialize;

use super::x509::{self, CertInfo};
use crate::net_guard;

const MAX_CHAIN: usize = 8;
/// Fewer days than this left on a certificate is worth a warning.
const EXPIRY_WARNING_DAYS: i64 = 30;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub host: String,
    pub port: u16,
}

/// `host`, `host:port`, `[v6]:port` or an `https://` URL; port 443 unless
/// another is named.
pub fn parse_target(input: &str) -> Result<Target, String> {
    let mut text = input.trim();
    if text.is_empty() {
        return Err("target_empty".into());
    }
    if let Some(rest) = text.strip_prefix("https://") {
        text = rest;
    } else if text.contains("://") {
        return Err("target_invalid".into());
    }
    let text = text.split(['/', '?', '#']).next().unwrap_or_default();
    if text.contains('@') || text.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("target_invalid".into());
    }
    let (host, port) = if let Some(rest) = text.strip_prefix('[') {
        let (host, after) = rest.split_once(']').ok_or("target_invalid")?;
        let port = match after.strip_prefix(':') {
            Some(port) => Some(port),
            None if after.is_empty() => None,
            None => return Err("target_invalid".into()),
        };
        (host.to_string(), port)
    } else if text.matches(':').count() > 1 {
        // A bare IPv6 address, without a port.
        (text.to_string(), None)
    } else {
        match text.split_once(':') {
            Some((host, port)) => (host.to_string(), Some(port)),
            None => (text.to_string(), None),
        }
    };
    let port = match port {
        Some(port) => port
            .parse::<u16>()
            .ok()
            .filter(|&p| p != 0)
            .ok_or("target_invalid")?,
        None => 443,
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let valid_name = !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        });
    if host.parse::<std::net::IpAddr>().is_err() && !valid_name {
        return Err("target_invalid".into());
    }
    Ok(Target { host, port })
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolProbe {
    pub version: String,
    pub supported: bool,
    pub cipher: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TlsReport {
    pub host: String,
    pub port: u16,
    /// The address the name resolved to and the handshakes went to.
    pub address: String,
    pub protocol: String,
    pub cipher: String,
    pub alpn: Option<String>,
    /// The chain verifies against the bundled roots for this host.
    pub trusted: bool,
    /// Why not: unknown_issuer, expired, not_yet_valid, name_mismatch…
    pub trust_error: Option<String>,
    pub name_matches: bool,
    pub protocols: Vec<ProtocolProbe>,
    pub chain: Vec<CertInfo>,
    pub days_left: Option<i64>,
    pub warnings: Vec<String>,
    pub checked_at: u64,
}

/// Verifies like the browser would, records the outcome and lets the
/// handshake go on, so that a certificate that fails can still be read.
/// Handshake signatures are always checked.
#[derive(Debug)]
struct Recorder {
    inner: Arc<WebPkiServerVerifier>,
    outcome: Mutex<Option<Result<(), String>>>,
}

fn trust_code(error: &rustls::Error) -> String {
    match error {
        rustls::Error::InvalidCertificate(certificate) => {
            match certificate {
                CertificateError::Expired | CertificateError::ExpiredContext { .. } => "expired",
                CertificateError::NotValidYet | CertificateError::NotValidYetContext { .. } => {
                    "not_yet_valid"
                }
                CertificateError::UnknownIssuer => "unknown_issuer",
                CertificateError::NotValidForName
                | CertificateError::NotValidForNameContext { .. } => "name_mismatch",
                CertificateError::BadSignature => "bad_signature",
                CertificateError::Revoked => "revoked",
                CertificateError::BadEncoding => "bad_encoding",
                CertificateError::InvalidPurpose
                | CertificateError::InvalidPurposeContext { .. } => "invalid_purpose",
                _ => "untrusted",
            }
        }
        _ => "untrusted",
    }
    .into()
}

impl ServerCertVerifier for Recorder {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let outcome = self
            .inner
            .verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
            .map(|_| ())
            .map_err(|error| trust_code(&error));
        *self.outcome.lock().unwrap_or_else(|p| p.into_inner()) = Some(outcome);
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// The roots a certificate is checked against: Mozilla's, as bundled.
pub fn mozilla_roots() -> rustls::RootCertStore {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    roots
}

struct Handshake {
    protocol: String,
    cipher: String,
    alpn: Option<String>,
    chain: Vec<Vec<u8>>,
    trust: Option<Result<(), String>>,
}

fn version_name(version: rustls::ProtocolVersion) -> String {
    match version {
        rustls::ProtocolVersion::TLSv1_3 => "TLS 1.3".into(),
        rustls::ProtocolVersion::TLSv1_2 => "TLS 1.2".into(),
        other => format!("{other:?}"),
    }
}

fn handshake_error(error: &std::io::Error) -> String {
    let text = error.to_string().to_ascii_lowercase();
    if text.contains("protocolversion")
        || text.contains("protocol version")
        || text.contains("incompatible")
    {
        "tls_incompatible".into()
    } else if text.contains("handshakefailure") || text.contains("handshake") {
        "tls_handshake_failed".into()
    } else if error.kind() == std::io::ErrorKind::UnexpectedEof
        || error.kind() == std::io::ErrorKind::ConnectionReset
    {
        "tls_closed".into()
    } else if error.kind() == std::io::ErrorKind::InvalidData {
        "tls_not_tls".into()
    } else {
        "tls_handshake_failed".into()
    }
}

async fn handshake(
    address: SocketAddr,
    host: &str,
    roots: Arc<rustls::RootCertStore>,
    versions: &[&'static rustls::SupportedProtocolVersion],
    limit: Duration,
) -> Result<Handshake, String> {
    let provider = provider();
    let inner = WebPkiServerVerifier::builder_with_provider(roots, provider.clone())
        .build()
        .map_err(|_| "tls_setup_failed".to_string())?;
    let recorder = Arc::new(Recorder {
        inner,
        outcome: Mutex::new(None),
    });
    let mut config = rustls::ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(versions)
        .map_err(|_| "tls_setup_failed".to_string())?
        .dangerous()
        .with_custom_certificate_verifier(recorder.clone())
        .with_no_client_auth();
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    let name = ServerName::try_from(host.to_string()).map_err(|_| "target_invalid".to_string())?;
    let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
    let work = async {
        let tcp = tokio::net::TcpStream::connect(address)
            .await
            .map_err(|_| "connect_failed".to_string())?;
        connector
            .connect(name, tcp)
            .await
            .map_err(|error| handshake_error(&error))
    };
    let stream = tokio::time::timeout(limit, work)
        .await
        .map_err(|_| "timeout".to_string())??;
    let (_, connection) = stream.get_ref();
    let shake = Handshake {
        protocol: connection
            .protocol_version()
            .map(version_name)
            .unwrap_or_default(),
        cipher: connection
            .negotiated_cipher_suite()
            .map(|suite| format!("{:?}", suite.suite()))
            .unwrap_or_default(),
        alpn: connection
            .alpn_protocol()
            .map(|alpn| String::from_utf8_lossy(alpn).into_owned()),
        chain: connection
            .peer_certificates()
            .unwrap_or_default()
            .iter()
            .take(MAX_CHAIN)
            .map(|cert| cert.as_ref().to_vec())
            .collect(),
        trust: recorder
            .outcome
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone(),
    };
    Ok(shake)
}

/// What the report warns about, from what was found.
pub fn warnings(report: &TlsReport) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(error) = &report.trust_error {
        out.push(format!("untrusted:{error}"));
    }
    if !report.name_matches {
        out.push("name_mismatch".into());
    }
    match report.days_left {
        Some(days) if days < 0 => out.push("expired".into()),
        Some(days) if days < EXPIRY_WARNING_DAYS => out.push("expires_soon".into()),
        _ => {}
    }
    if let Some(leaf) = report.chain.first() {
        if leaf.self_signed {
            out.push("self_signed".into());
        }
        if leaf.signature.contains("SHA-1") {
            out.push("sha1_signature".into());
        }
        if leaf.key == "RSA" && leaf.key_bits > 0 && leaf.key_bits < 2048 {
            out.push("weak_key".into());
        }
    }
    if !report
        .protocols
        .iter()
        .any(|probe| probe.version == "TLS 1.3" && probe.supported)
    {
        out.push("no_tls13".into());
    }
    out
}

/// Inspect `target` at the address it resolves to (`address`), checking the
/// chain against `roots`.
pub async fn inspect_at(
    target: &Target,
    address: SocketAddr,
    roots: rustls::RootCertStore,
    limit: Duration,
    now_ms: u64,
) -> Result<TlsReport, String> {
    let roots = Arc::new(roots);
    let main = handshake(
        address,
        &target.host,
        roots.clone(),
        &[&rustls::version::TLS13, &rustls::version::TLS12],
        limit,
    )
    .await?;
    let mut protocols = Vec::new();
    for (name, version) in [
        ("TLS 1.3", &rustls::version::TLS13),
        ("TLS 1.2", &rustls::version::TLS12),
    ] {
        let probe = if main.protocol == name {
            Ok(main.cipher.clone())
        } else {
            handshake(address, &target.host, roots.clone(), &[version], limit)
                .await
                .map(|shake| shake.cipher)
        };
        protocols.push(ProtocolProbe {
            version: name.into(),
            supported: probe.is_ok(),
            cipher: probe.ok(),
        });
    }
    let chain: Vec<CertInfo> = main.chain.iter().map(|der| x509::parse(der)).collect();
    let name_matches = chain
        .first()
        .is_some_and(|leaf| x509::matches_host(leaf, &target.host));
    let days_left = chain
        .first()
        .filter(|leaf| !leaf.unreadable)
        .map(|leaf| (leaf.not_after_ms - now_ms as i64).div_euclid(86_400_000));
    let trust_error = match main.trust {
        Some(Ok(())) => None,
        Some(Err(code)) => Some(code),
        None => Some("untrusted".into()),
    };
    let mut report = TlsReport {
        host: target.host.clone(),
        port: target.port,
        address: address.ip().to_string(),
        protocol: main.protocol,
        cipher: main.cipher,
        alpn: main.alpn,
        trusted: trust_error.is_none(),
        trust_error,
        name_matches,
        protocols,
        chain,
        days_left,
        warnings: Vec::new(),
        checked_at: now_ms,
    };
    report.warnings = warnings(&report);
    Ok(report)
}

/// Resolve `target` and inspect it. Only an address the target's access
/// allows is used (`access_for`), so a public name that answers with a local
/// address is refused, as in every other built-in network tool.
pub async fn inspect(target: &Target, limit: Duration) -> Result<TlsReport, String> {
    let access = super::access_for(&target.host);
    let address = resolve(&net_guard::SystemLookup, target, access, limit).await?;
    inspect_at(target, address, mozilla_roots(), limit, super::now_ms()).await
}

/// The address to handshake with: the first answer `access` allows.
async fn resolve(
    lookup: &dyn net_guard::Lookup,
    target: &Target,
    access: net_guard::Access,
    limit: Duration,
) -> Result<SocketAddr, String> {
    let addresses = tokio::time::timeout(
        limit,
        net_guard::allowed_addresses(lookup, &target.host, access),
    )
    .await
    .map_err(|_| "timeout".to_string())?
    .map_err(|error| match error {
        net_guard::GuardError::NotPublic => "target_not_public".to_string(),
        net_guard::GuardError::Dns => "dns_failed".to_string(),
    })?;
    let ip = *addresses.first().ok_or_else(|| "dns_failed".to_string())?;
    Ok(SocketAddr::new(ip, target.port))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};

    const LEAF: &[u8] = include_bytes!("fixtures/tls-leaf.der");
    const CA: &[u8] = include_bytes!("fixtures/tls-ca.der");
    const KEY: &[u8] = include_bytes!("fixtures/tls-leaf-key.der");

    /// A public-looking name that answers with an address inside the network
    /// is never handshaken with; a typed local address still is.
    #[tokio::test]
    async fn a_public_name_answering_locally_is_refused() {
        use crate::net_guard::{tests::Recorded, Access};
        let lookup = Recorded::new(&[
            ("rebind.example.com", &["127.0.0.1", "10.0.0.7"]),
            ("mixed.example.com", &["192.168.0.2", "93.184.216.34"]),
            ("127.0.0.1", &["127.0.0.1"]),
        ]);
        let limit = Duration::from_secs(2);
        let target = |host: &str| Target {
            host: host.into(),
            port: 443,
        };
        assert_eq!(
            resolve(
                &*lookup,
                &target("rebind.example.com"),
                Access::Public,
                limit
            )
            .await,
            Err("target_not_public".to_string())
        );
        let kept = resolve(
            &*lookup,
            &target("mixed.example.com"),
            Access::Public,
            limit,
        )
        .await;
        assert_eq!(kept, Ok("93.184.216.34:443".parse().unwrap()));
        let local = resolve(&*lookup, &target("127.0.0.1"), Access::Local, limit).await;
        assert_eq!(local, Ok("127.0.0.1:443".parse().unwrap()));
        assert_eq!(
            resolve(&*lookup, &target("127.0.0.1"), Access::Public, limit).await,
            Err("target_not_public".to_string())
        );
        assert_eq!(
            resolve(
                &*lookup,
                &target("nowhere.example.com"),
                Access::Public,
                limit
            )
            .await,
            Err("dns_failed".to_string())
        );
    }

    #[test]
    fn a_target_is_a_host_and_a_port() {
        let t = |host: &str, port| {
            Ok(Target {
                host: host.into(),
                port,
            })
        };
        assert_eq!(parse_target("example.com"), t("example.com", 443));
        assert_eq!(parse_target("Example.com:8443"), t("example.com", 8443));
        assert_eq!(
            parse_target("https://example.com/login?x"),
            t("example.com", 443)
        );
        assert_eq!(parse_target("[::1]:9443"), t("::1", 9443));
        assert_eq!(parse_target("::1"), t("::1", 443));
        assert_eq!(parse_target("127.0.0.1:443"), t("127.0.0.1", 443));
        for bad in [
            "",
            "http://example.com",
            "ftp://x",
            "a b",
            "user@example.com",
            "example.com:0",
            "example.com:99999",
            "[::1",
        ] {
            assert!(parse_target(bad).is_err(), "{bad}");
        }
    }

    fn server_config() -> Arc<rustls::ServerConfig> {
        let chain = vec![
            CertificateDer::from(LEAF.to_vec()),
            CertificateDer::from(CA.to_vec()),
        ];
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(KEY.to_vec()));
        let mut config = rustls::ServerConfig::builder_with_provider(provider())
            .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(chain, key)
            .unwrap();
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        Arc::new(config)
    }

    /// A TLS server on this machine's loopback, for as many handshakes as
    /// the test makes. No network is used.
    async fn loopback_server() -> SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(server_config());
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let acceptor = acceptor.clone();
                tokio::spawn(async move {
                    let _ = acceptor.accept(tcp).await;
                });
            }
        });
        address
    }

    fn test_roots() -> rustls::RootCertStore {
        let mut roots = rustls::RootCertStore::empty();
        roots.add(CertificateDer::from(CA.to_vec())).unwrap();
        roots
    }

    #[tokio::test]
    async fn a_trusted_server_shows_its_chain_protocols_and_expiry() {
        let address = loopback_server().await;
        let target = Target {
            host: "localhost".into(),
            port: address.port(),
        };
        let now = 1_800_000_000_000;
        let report = inspect_at(&target, address, test_roots(), Duration::from_secs(10), now)
            .await
            .unwrap();
        assert_eq!(report.protocol, "TLS 1.3");
        assert!(report.cipher.starts_with("TLS13_"), "{}", report.cipher);
        assert_eq!(report.alpn.as_deref(), Some("http/1.1"));
        assert!(report.trusted, "{:?}", report.trust_error);
        assert!(report.name_matches);
        assert_eq!(report.chain.len(), 2);
        assert_eq!(report.chain[0].subject_cn, "localhost");
        assert_eq!(report.chain[1].subject_cn, "Qutra Labs Test Root");
        assert_eq!(
            report
                .protocols
                .iter()
                .map(|p| (p.version.as_str(), p.supported))
                .collect::<Vec<_>>(),
            vec![("TLS 1.3", true), ("TLS 1.2", true)]
        );
        assert!(report.protocols[1]
            .cipher
            .as_deref()
            .unwrap()
            .starts_with("TLS_ECDHE_ECDSA"));
        assert!(report.days_left.unwrap() > 365);
        assert!(report.warnings.is_empty(), "{:?}", report.warnings);
    }

    #[tokio::test]
    async fn an_untrusted_or_misnamed_server_is_still_read_and_warned_about() {
        let address = loopback_server().await;
        // Mozilla's roots do not know the test root.
        let target = Target {
            host: "app.other.test".into(),
            port: address.port(),
        };
        let report = inspect_at(
            &target,
            address,
            mozilla_roots(),
            Duration::from_secs(10),
            1_800_000_000_000,
        )
        .await
        .unwrap();
        assert!(!report.trusted);
        assert_eq!(report.trust_error.as_deref(), Some("unknown_issuer"));
        assert!(!report.name_matches);
        assert_eq!(report.chain.len(), 2);
        assert!(report
            .warnings
            .contains(&"untrusted:unknown_issuer".to_string()));
        assert!(report.warnings.contains(&"name_mismatch".to_string()));
    }

    #[tokio::test]
    async fn a_port_that_does_not_speak_tls_fails_with_a_code() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            while let Ok((mut tcp, _)) = listener.accept().await {
                let _ = tcp.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n").await;
            }
        });
        let target = Target {
            host: "localhost".into(),
            port: address.port(),
        };
        let error = inspect_at(&target, address, test_roots(), Duration::from_secs(5), 0)
            .await
            .unwrap_err();
        assert!(error.starts_with("tls_"), "{error}");
    }

    #[test]
    fn warnings_follow_the_findings() {
        let mut report = TlsReport {
            host: "h".into(),
            port: 443,
            address: "1.2.3.4".into(),
            protocol: "TLS 1.2".into(),
            cipher: "x".into(),
            alpn: None,
            trusted: true,
            trust_error: None,
            name_matches: true,
            protocols: vec![ProtocolProbe {
                version: "TLS 1.3".into(),
                supported: false,
                cipher: None,
            }],
            chain: vec![x509::parse(LEAF)],
            days_left: Some(10),
            warnings: vec![],
            checked_at: 0,
        };
        assert_eq!(warnings(&report), vec!["expires_soon", "no_tls13"]);
        report.days_left = Some(-1);
        report.chain[0].self_signed = true;
        assert_eq!(
            warnings(&report),
            vec!["expired", "self_signed", "no_tls13"]
        );
    }
}
