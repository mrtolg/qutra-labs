//! Just enough X.509 (RFC 5280) to show a certificate: its names, validity,
//! alternative names, keys and fingerprint. A small DER reader, bounds
//! checked at every step; a certificate it cannot read is reported as such,
//! never trusted or rejected on its strength.

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{clean, days_from_civil, iso_utc};

const OID_CN: &str = "2.5.4.3";
const OID_SAN: &str = "2.5.29.17";
const OID_BASIC_CONSTRAINTS: &str = "2.5.29.19";
const MAX_SANS: usize = 100;

/// One DER element: its tag, its content and everything after it.
struct Tlv<'a> {
    tag: u8,
    content: &'a [u8],
}

struct Reader<'a> {
    data: &'a [u8],
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data }
    }

    fn is_empty(&self) -> bool {
        self.data.is_empty()
    }

    fn peek_tag(&self) -> Option<u8> {
        self.data.first().copied()
    }

    fn next(&mut self) -> Option<Tlv<'a>> {
        let tag = *self.data.first()?;
        // Multi-byte tags never occur in a certificate's fields read here.
        if tag & 0x1f == 0x1f {
            return None;
        }
        let first = *self.data.get(1)?;
        let (len, header) = if first < 0x80 {
            (first as usize, 2)
        } else {
            let count = (first & 0x7f) as usize;
            if count == 0 || count > 4 {
                return None;
            }
            let mut len = 0usize;
            for i in 0..count {
                len = (len << 8) | *self.data.get(2 + i)? as usize;
            }
            (len, 2 + count)
        };
        let end = header.checked_add(len)?;
        let content = self.data.get(header..end)?;
        self.data = &self.data[end..];
        Some(Tlv { tag, content })
    }

    fn expect(&mut self, tag: u8) -> Option<&'a [u8]> {
        let tlv = self.next()?;
        (tlv.tag == tag).then_some(tlv.content)
    }
}

fn oid(content: &[u8]) -> String {
    let mut parts: Vec<u64> = Vec::new();
    let mut value: u64 = 0;
    for (i, &byte) in content.iter().enumerate() {
        value = (value << 7) | (byte & 0x7f) as u64;
        if byte & 0x80 == 0 {
            if parts.is_empty() && i < content.len() {
                let (a, b) = if value < 40 {
                    (0, value)
                } else if value < 80 {
                    (1, value - 40)
                } else {
                    (2, value - 80)
                };
                parts.push(a);
                parts.push(b);
            } else {
                parts.push(value);
            }
            value = 0;
        }
        if value > (u64::MAX >> 8) {
            return String::new();
        }
    }
    parts
        .iter()
        .map(u64::to_string)
        .collect::<Vec<_>>()
        .join(".")
}

fn string_value(tag: u8, content: &[u8]) -> String {
    let text = match tag {
        // BMPString: UTF-16BE.
        0x1e => {
            let units: Vec<u16> = content
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u16::from_be_bytes(*pair))
                .collect();
            String::from_utf16_lossy(&units)
        }
        // Latin-1 for T61String, UTF-8 for the rest.
        0x14 => content.iter().map(|&b| b as char).collect(),
        _ => String::from_utf8_lossy(content).into_owned(),
    };
    clean(&text)
}

/// A distinguished name as `CN=…, O=…`, and its common name alone.
fn name(content: &[u8]) -> (String, String) {
    let mut parts = Vec::new();
    let mut common = String::new();
    let mut sets = Reader::new(content);
    while let Some(set) = sets.next() {
        let mut attributes = Reader::new(set.content);
        while let Some(attribute) = attributes.next() {
            let mut inner = Reader::new(attribute.content);
            let (Some(kind), Some(value)) = (inner.expect(0x06), inner.next()) else {
                continue;
            };
            let kind = oid(kind);
            let shown = string_value(value.tag, value.content);
            let label = match kind.as_str() {
                OID_CN => "CN",
                "2.5.4.6" => "C",
                "2.5.4.7" => "L",
                "2.5.4.8" => "ST",
                "2.5.4.10" => "O",
                "2.5.4.11" => "OU",
                "1.2.840.113549.1.9.1" => "E",
                _ => "",
            };
            if kind == OID_CN && common.is_empty() {
                common = shown.clone();
            }
            if !label.is_empty() && parts.len() < 12 {
                parts.push(format!("{label}={shown}"));
            }
        }
    }
    (parts.join(", "), common)
}

/// UTCTime or GeneralizedTime as milliseconds since the epoch.
fn time(tag: u8, content: &[u8]) -> Option<i64> {
    let text = std::str::from_utf8(content).ok()?;
    let text = text.strip_suffix('Z')?;
    let (year, rest) = match tag {
        0x17 => {
            let yy: i64 = text.get(..2)?.parse().ok()?;
            (if yy >= 50 { 1900 + yy } else { 2000 + yy }, text.get(2..)?)
        }
        0x18 => (text.get(..4)?.parse().ok()?, text.get(4..)?),
        _ => return None,
    };
    let field = |at: usize| -> Option<u32> { rest.get(at..at + 2)?.parse().ok() };
    let (month, day, hour, minute) = (field(0)?, field(2)?, field(4)?, field(6)?);
    let second = field(8).unwrap_or(0);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let days = days_from_civil(year, month, day);
    Some(((days * 86_400) + hour as i64 * 3600 + minute as i64 * 60 + second as i64) * 1000)
}

fn signature_name(oid: &str) -> String {
    match oid {
        "1.2.840.113549.1.1.5" => "SHA-1 with RSA",
        "1.2.840.113549.1.1.11" => "SHA-256 with RSA",
        "1.2.840.113549.1.1.12" => "SHA-384 with RSA",
        "1.2.840.113549.1.1.13" => "SHA-512 with RSA",
        "1.2.840.113549.1.1.10" => "RSA-PSS",
        "1.2.840.10045.4.1" => "ECDSA with SHA-1",
        "1.2.840.10045.4.3.2" => "ECDSA with SHA-256",
        "1.2.840.10045.4.3.3" => "ECDSA with SHA-384",
        "1.2.840.10045.4.3.4" => "ECDSA with SHA-512",
        "1.3.101.112" => "Ed25519",
        "1.3.101.113" => "Ed448",
        other => return other.to_string(),
    }
    .to_string()
}

/// The key's algorithm and size: RSA from its modulus, EC from its curve.
fn public_key(content: &[u8]) -> (String, u32) {
    let mut spki = Reader::new(content);
    let Some(algorithm) = spki.expect(0x30) else {
        return (String::new(), 0);
    };
    let mut alg = Reader::new(algorithm);
    let kind = alg.expect(0x06).map(oid).unwrap_or_default();
    match kind.as_str() {
        "1.2.840.113549.1.1.1" => {
            let bits = spki
                .expect(0x03)
                .and_then(|bits| bits.get(1..))
                .and_then(|key| Reader::new(key).expect(0x30))
                .and_then(|seq| Reader::new(seq).expect(0x02))
                .map(|modulus| {
                    let trimmed: &[u8] = {
                        let start = modulus
                            .iter()
                            .position(|&b| b != 0)
                            .unwrap_or(modulus.len());
                        &modulus[start..]
                    };
                    match trimmed.first() {
                        Some(&top) => (trimmed.len() as u32 - 1) * 8 + (8 - top.leading_zeros()),
                        None => 0,
                    }
                })
                .unwrap_or(0);
            ("RSA".into(), bits)
        }
        "1.2.840.10045.2.1" => {
            let curve = alg.expect(0x06).map(oid).unwrap_or_default();
            match curve.as_str() {
                "1.2.840.10045.3.1.7" => ("EC P-256".into(), 256),
                "1.3.132.0.34" => ("EC P-384".into(), 384),
                "1.3.132.0.35" => ("EC P-521".into(), 521),
                other => (format!("EC {other}"), 0),
            }
        }
        "1.3.101.112" => ("Ed25519".into(), 256),
        "1.3.101.113" => ("Ed448".into(), 456),
        other => (other.to_string(), 0),
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CertInfo {
    pub subject: String,
    pub subject_cn: String,
    pub issuer: String,
    pub issuer_cn: String,
    pub serial: String,
    pub not_before: String,
    pub not_after: String,
    pub not_after_ms: i64,
    pub not_before_ms: i64,
    pub san: Vec<String>,
    pub signature: String,
    pub key: String,
    pub key_bits: u32,
    pub is_ca: bool,
    pub self_signed: bool,
    pub sha256: String,
    /// The reader could not read it all; what it could read is kept.
    pub unreadable: bool,
}

fn san_names(content: &[u8], out: &mut Vec<String>) {
    let mut names = Reader::new(content);
    let Some(seq) = names.expect(0x30) else {
        return;
    };
    let mut general = Reader::new(seq);
    while let Some(entry) = general.next() {
        if out.len() >= MAX_SANS {
            return;
        }
        match entry.tag {
            0x82 => out.push(clean(&String::from_utf8_lossy(entry.content)).to_ascii_lowercase()),
            0x87 => match entry.content.len() {
                4 => {
                    let b = entry.content;
                    out.push(format!("{}.{}.{}.{}", b[0], b[1], b[2], b[3]));
                }
                16 => {
                    let mut octets = [0u8; 16];
                    octets.copy_from_slice(entry.content);
                    out.push(std::net::Ipv6Addr::from(octets).to_string());
                }
                _ => {}
            },
            _ => {}
        }
    }
}

/// Read one certificate. Never fails: what cannot be read stays empty and
/// `unreadable` says so.
pub fn parse(der: &[u8]) -> CertInfo {
    let mut info = CertInfo {
        sha256: hex::encode(Sha256::digest(der)),
        unreadable: true,
        ..CertInfo::default()
    };
    if read(der, &mut info).is_some() {
        info.unreadable = false;
    }
    info
}

fn read(der: &[u8], info: &mut CertInfo) -> Option<()> {
    let cert = Reader::new(der).expect(0x30)?;
    let mut cert = Reader::new(cert);
    let tbs = cert.expect(0x30)?;
    let signature = cert
        .expect(0x30)
        .and_then(|alg| Reader::new(alg).expect(0x06));
    info.signature = signature
        .map(|s| signature_name(&oid(s)))
        .unwrap_or_default();

    let mut tbs = Reader::new(tbs);
    if tbs.peek_tag() == Some(0xa0) {
        tbs.next()?;
    }
    let serial = tbs.expect(0x02)?;
    info.serial = hex::encode_upper(
        serial
            .iter()
            .skip_while(|&&b| b == 0)
            .copied()
            .collect::<Vec<_>>(),
    );
    tbs.expect(0x30)?; // signature algorithm, again
    let issuer = tbs.expect(0x30)?;
    (info.issuer, info.issuer_cn) = name(issuer);
    let mut validity = Reader::new(tbs.expect(0x30)?);
    let before = validity.next()?;
    let after = validity.next()?;
    info.not_before_ms = time(before.tag, before.content)?;
    info.not_after_ms = time(after.tag, after.content)?;
    info.not_before = iso_utc(info.not_before_ms);
    info.not_after = iso_utc(info.not_after_ms);
    let subject = tbs.expect(0x30)?;
    (info.subject, info.subject_cn) = name(subject);
    info.self_signed = subject == issuer;
    (info.key, info.key_bits) = public_key(tbs.expect(0x30)?);

    while !tbs.is_empty() {
        let field = tbs.next()?;
        if field.tag != 0xa3 {
            continue;
        }
        let extensions = Reader::new(field.content).expect(0x30)?;
        let mut extensions = Reader::new(extensions);
        while let Some(extension) = extensions.next() {
            let mut parts = Reader::new(extension.content);
            let id = parts.expect(0x06).map(oid).unwrap_or_default();
            let mut value = parts.next();
            if value.as_ref().is_some_and(|v| v.tag == 0x01) {
                value = parts.next();
            }
            let Some(value) = value.filter(|v| v.tag == 0x04) else {
                continue;
            };
            match id.as_str() {
                OID_SAN => san_names(value.content, &mut info.san),
                OID_BASIC_CONSTRAINTS => {
                    if let Some(seq) = Reader::new(value.content).expect(0x30) {
                        let mut seq = Reader::new(seq);
                        info.is_ca = seq.next().is_some_and(|flag| {
                            flag.tag == 0x01 && flag.content.first().is_some_and(|&b| b != 0)
                        });
                    }
                }
                _ => {}
            }
        }
    }
    Some(())
}

/// Does `host` match one of the certificate's names (RFC 6125: a wildcard
/// stands for exactly one leftmost label)? Without alternative names the
/// common name is read, as old certificates need.
pub fn matches_host(cert: &CertInfo, host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let names: Vec<String> = if cert.san.is_empty() {
        vec![cert.subject_cn.to_ascii_lowercase()]
    } else {
        cert.san.clone()
    };
    names.iter().any(|name| {
        if let Some(suffix) = name.strip_prefix("*.") {
            match host.split_once('.') {
                Some((first, rest)) => !first.is_empty() && rest == suffix,
                None => false,
            }
        } else {
            name == host
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEAF: &[u8] = include_bytes!("fixtures/tls-leaf.der");
    const CA: &[u8] = include_bytes!("fixtures/tls-ca.der");

    #[test]
    fn a_leaf_certificate_shows_its_names_validity_and_key() {
        let leaf = parse(LEAF);
        assert!(!leaf.unreadable);
        assert_eq!(leaf.subject, "O=Qutra Labs Test, CN=localhost");
        assert_eq!(leaf.subject_cn, "localhost");
        assert_eq!(leaf.issuer_cn, "Qutra Labs Test Root");
        assert_eq!(leaf.san, vec!["localhost", "*.qutra.test", "127.0.0.1"]);
        assert_eq!(leaf.key, "EC P-256");
        assert_eq!(leaf.signature, "SHA-256 with RSA");
        assert!(!leaf.is_ca);
        assert!(!leaf.self_signed);
        assert!(leaf.not_before.starts_with("2026-10-10T"));
        assert!(leaf.not_after.starts_with("2045-12-09T"));
        assert!(leaf.not_after_ms > leaf.not_before_ms);
        assert_eq!(leaf.sha256.len(), 64);
        assert!(!leaf.serial.is_empty());
    }

    #[test]
    fn a_root_is_self_signed_with_an_rsa_key() {
        let ca = parse(CA);
        assert!(ca.self_signed);
        assert!(ca.is_ca);
        assert_eq!((ca.key.as_str(), ca.key_bits), ("RSA", 2048));
        assert_eq!(
            ca.subject,
            "C=TR, O=Qutra Labs Test, CN=Qutra Labs Test Root"
        );
    }

    #[test]
    fn names_match_by_the_wildcard_rule() {
        let leaf = parse(LEAF);
        assert!(matches_host(&leaf, "localhost"));
        assert!(matches_host(&leaf, "LOCALHOST."));
        assert!(matches_host(&leaf, "app.qutra.test"));
        assert!(!matches_host(&leaf, "a.b.qutra.test"));
        assert!(!matches_host(&leaf, "qutra.test"));
        assert!(matches_host(&leaf, "127.0.0.1"));
        assert!(!matches_host(&leaf, "example.com"));
    }

    #[test]
    fn broken_input_is_reported_not_trusted() {
        for bytes in [
            &b""[..],
            &b"\x30\x84\xff\xff\xff\xff"[..],
            &LEAF[..LEAF.len() / 2],
            &[0x30, 0x03, 0x02, 0x01],
        ] {
            let info = parse(bytes);
            assert!(info.unreadable);
        }
        assert_eq!(oid(&[0x55, 0x1d, 0x11]), "2.5.29.17");
        assert_eq!(
            oid(&[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]),
            "1.2.840.113549.1.1.11"
        );
        assert_eq!(time(0x17, b"491231235959Z"), Some(2_524_607_999_000));
        assert_eq!(time(0x18, b"20260101000000Z"), Some(1_767_225_600_000));
        assert_eq!(time(0x17, b"261301000000Z"), None);
    }
}
