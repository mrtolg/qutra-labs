//! IP / RDAP / ASN lookup: who holds an address, a domain or an autonomous
//! system, from the public registration data (RDAP, RFC 9082/9083).
//!
//! The query goes to rdap.org, which redirects to the registry that holds
//! the record (ARIN, RIPE NCC, Verisign…); only the target typed is sent.
//! Redirects are followed only over HTTPS, at most `MAX_HOPS` times, and
//! each server that answered is reported. The target itself is never
//! contacted.

use std::net::IpAddr;

use serde::Serialize;
use serde_json::Value;

use super::{clean, clean_long, read_capped};
use crate::net_guard::{check_literal_host, Access};

pub const BOOTSTRAP: &str = "https://rdap.org";
const MAX_HOPS: usize = 4;
const MAX_ANSWER: usize = 1024 * 1024;
const MAX_ENTITIES: usize = 24;
const MAX_LIST: usize = 24;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Query {
    Ip(IpAddr),
    Domain(String),
    Asn(u32),
}

impl Query {
    pub fn kind(&self) -> &'static str {
        match self {
            Query::Ip(_) => "ip",
            Query::Domain(_) => "domain",
            Query::Asn(_) => "autnum",
        }
    }

    /// The host the scope check reads.
    pub fn host(&self) -> String {
        match self {
            Query::Ip(ip) => ip.to_string(),
            Query::Domain(domain) => domain.clone(),
            Query::Asn(n) => format!("as{n}"),
        }
    }

    pub fn path(&self) -> String {
        match self {
            Query::Ip(ip) => format!("/ip/{ip}"),
            Query::Domain(domain) => format!("/domain/{domain}"),
            Query::Asn(n) => format!("/autnum/{n}"),
        }
    }
}

/// What the user typed, as one RDAP query: an IP address, `AS<number>` or a
/// domain name in plain letters (an IDN must be typed as `xn--…`).
pub fn parse_query(input: &str) -> Result<Query, String> {
    let text = input.trim();
    if text.is_empty() {
        return Err("target_empty".into());
    }
    if let Ok(ip) = text
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
    {
        return Ok(Query::Ip(ip));
    }
    let lower = text.to_ascii_lowercase();
    let digits = lower.strip_prefix("as").unwrap_or(&lower);
    if !digits.is_empty() && digits.len() <= 10 && digits.bytes().all(|b| b.is_ascii_digit()) {
        return digits
            .parse::<u32>()
            .map(Query::Asn)
            .map_err(|_| "target_invalid".into());
    }
    let domain = lower.trim_end_matches('.');
    let labels: Vec<&str> = domain.split('.').collect();
    let valid = domain.len() <= 253
        && labels.len() >= 2
        && labels.iter().all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
        && !labels
            .last()
            .is_some_and(|tld| tld.bytes().all(|b| b.is_ascii_digit()));
    if valid {
        Ok(Query::Domain(domain.to_string()))
    } else {
        Err("target_invalid".into())
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub action: String,
    pub date: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Entity {
    pub handle: String,
    pub roles: Vec<String>,
    pub name: String,
    /// org, individual, group…
    pub kind: String,
    pub emails: Vec<String>,
    pub country: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RdapReport {
    /// ip, domain or autnum.
    pub kind: String,
    pub query: String,
    /// Every server that answered, in order (rdap.org, then the registry).
    pub servers: Vec<String>,
    pub handle: String,
    pub name: String,
    pub status: Vec<String>,
    pub events: Vec<Event>,
    pub entities: Vec<Entity>,
    /// IP networks: the range, its prefixes, type and country.
    pub range: String,
    pub cidrs: Vec<String>,
    pub network_type: String,
    pub country: String,
    pub parent: String,
    /// Autonomous systems: the number range.
    pub asn_range: String,
    /// Domains: the name servers and DNSSEC.
    pub nameservers: Vec<String>,
    pub dnssec: Option<bool>,
    /// The registry's whois server, for reference.
    pub port43: String,
    pub remarks: Vec<String>,
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(clean)
        .unwrap_or_default()
}

fn strings(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(clean)
                .filter(|item| !item.is_empty())
                .take(MAX_LIST)
                .collect()
        })
        .unwrap_or_default()
}

fn events(value: &Value) -> Vec<Event> {
    value
        .get("events")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|event| Event {
                    action: text(event, "eventAction"),
                    date: text(event, "eventDate"),
                })
                .filter(|event| !event.action.is_empty())
                .take(MAX_LIST)
                .collect()
        })
        .unwrap_or_default()
}

/// One entity's name, kind, emails and country from its jCard (RFC 7095).
fn entity(value: &Value) -> Entity {
    let mut out = Entity {
        handle: text(value, "handle"),
        roles: strings(value, "roles"),
        ..Entity::default()
    };
    let properties = value
        .get("vcardArray")
        .and_then(|card| card.get(1))
        .and_then(Value::as_array);
    for property in properties.into_iter().flatten() {
        let Some(parts) = property.as_array() else {
            continue;
        };
        let name = parts.first().and_then(Value::as_str).unwrap_or("");
        let shown = parts
            .get(3)
            .and_then(Value::as_str)
            .map(clean)
            .unwrap_or_default();
        match name {
            "fn" => out.name = shown,
            "kind" => out.kind = shown,
            "email" if !shown.is_empty() && out.emails.len() < 4 => out.emails.push(shown),
            "adr" => {
                // The country is the last part of a structured address.
                if let Some(country) = parts
                    .get(3)
                    .and_then(Value::as_array)
                    .and_then(|adr| adr.last())
                    .and_then(Value::as_str)
                {
                    out.country = clean(country);
                }
            }
            _ => {}
        }
    }
    out
}

/// Every entity, nested ones too (a registrar's abuse contact), each once.
fn entities(value: &Value, out: &mut Vec<Entity>, depth: usize) {
    if depth > 3 {
        return;
    }
    for item in value
        .get("entities")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if out.len() >= MAX_ENTITIES {
            return;
        }
        let found = entity(item);
        match out
            .iter_mut()
            .find(|seen| !found.handle.is_empty() && seen.handle == found.handle)
        {
            Some(seen) => {
                for role in found.roles {
                    if !seen.roles.contains(&role) {
                        seen.roles.push(role);
                    }
                }
            }
            None => out.push(found),
        }
        entities(item, out, depth + 1);
    }
}

/// Read one RDAP answer into the report the page shows.
pub fn parse_answer(query: &Query, answer: &Value, servers: Vec<String>) -> RdapReport {
    let mut report = RdapReport {
        kind: query.kind().into(),
        query: query.host(),
        servers,
        handle: text(answer, "handle"),
        name: text(answer, "name"),
        status: strings(answer, "status"),
        events: events(answer),
        port43: text(answer, "port43"),
        ..RdapReport::default()
    };
    entities(answer, &mut report.entities, 0);
    report.remarks = answer
        .get("remarks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|remark| strings(remark, "description"))
        .take(6)
        .map(|line| clean_long(&line, 200))
        .collect();
    match query {
        Query::Ip(_) => {
            let start = text(answer, "startAddress");
            let end = text(answer, "endAddress");
            if !start.is_empty() {
                report.range = format!("{start} – {end}");
            }
            report.cidrs = answer
                .get("cidr0_cidrs")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|cidr| {
                    let prefix = cidr
                        .get("v4prefix")
                        .or_else(|| cidr.get("v6prefix"))
                        .and_then(Value::as_str)?;
                    let length = cidr.get("length").and_then(Value::as_u64)?;
                    Some(format!("{}/{length}", clean(prefix)))
                })
                .take(MAX_LIST)
                .collect();
            report.network_type = text(answer, "type");
            report.country = text(answer, "country");
            report.parent = text(answer, "parentHandle");
        }
        Query::Asn(_) => {
            let start = answer.get("startAutnum").and_then(Value::as_u64);
            let end = answer.get("endAutnum").and_then(Value::as_u64);
            report.asn_range = match (start, end) {
                (Some(a), Some(b)) if a == b => format!("AS{a}"),
                (Some(a), Some(b)) => format!("AS{a} – AS{b}"),
                _ => String::new(),
            };
            report.country = text(answer, "country");
        }
        Query::Domain(_) => {
            if report.name.is_empty() {
                report.name = text(answer, "ldhName").to_ascii_lowercase();
            }
            report.nameservers = answer
                .get("nameservers")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|ns| text(ns, "ldhName").to_ascii_lowercase())
                .filter(|ns| !ns.is_empty())
                .take(MAX_LIST)
                .collect();
            report.dnssec = answer
                .get("secureDNS")
                .and_then(|dns| dns.get("delegationSigned"))
                .and_then(Value::as_bool);
        }
    }
    report
}

/// Where a redirect may go: an absolute HTTPS URL on a public host. A name is
/// checked when it is resolved (the client's guard); an address written in
/// the URL never reaches a resolver, so it is checked here.
fn next_hop(current: &reqwest::Url, location: &str) -> Result<reqwest::Url, String> {
    let next = current
        .join(location)
        .map_err(|_| "rdap_bad_redirect".to_string())?;
    if next.scheme() != "https" || next.host_str().is_none() {
        return Err("rdap_bad_redirect".into());
    }
    check_literal_host(&next, Access::Public).map_err(|_| "target_not_public".to_string())?;
    Ok(next)
}

/// Ask rdap.org about `query`, following its redirect to the registry.
pub async fn lookup(client: &reqwest::Client, query: &Query) -> Result<RdapReport, String> {
    let mut url = reqwest::Url::parse(&format!("{BOOTSTRAP}{}", query.path()))
        .map_err(|_| "target_invalid".to_string())?;
    let mut servers = Vec::new();
    for _ in 0..MAX_HOPS {
        servers.push(url.host_str().unwrap_or_default().to_string());
        let response = client
            .get(url.clone())
            .header(
                reqwest::header::ACCEPT,
                "application/rdap+json, application/json",
            )
            .send()
            .await
            .map_err(|error| super::transport_error(&error))?;
        let status = response.status();
        if status.is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "rdap_bad_redirect".to_string())?;
            url = next_hop(&url, location)?;
            continue;
        }
        match status.as_u16() {
            200 => {}
            404 => return Err("not_found".into()),
            429 => return Err("rate_limited".into()),
            400 | 422 => return Err("target_invalid".into()),
            _ => return Err("server_error".into()),
        }
        let body = read_capped(response, MAX_ANSWER).await?;
        let answer: Value = serde_json::from_slice(&body).map_err(|_| "bad_answer".to_string())?;
        return Ok(parse_answer(query, &answer, servers));
    }
    Err("rdap_too_many_redirects".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Value {
        let text = match name {
            "ip-arin" => include_str!("fixtures/rdap-ip-arin.json"),
            "ip-ripe" => include_str!("fixtures/rdap-ip-ripe.json"),
            "domain" => include_str!("fixtures/rdap-domain.json"),
            "autnum" => include_str!("fixtures/rdap-autnum.json"),
            _ => unreachable!(),
        };
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn a_query_is_an_address_a_number_or_a_plain_domain() {
        assert_eq!(
            parse_query(" 8.8.8.8 "),
            Ok(Query::Ip("8.8.8.8".parse().unwrap()))
        );
        assert_eq!(
            parse_query("[2001:db8::1]"),
            Ok(Query::Ip("2001:db8::1".parse().unwrap()))
        );
        assert_eq!(parse_query("AS3333"), Ok(Query::Asn(3333)));
        assert_eq!(parse_query("15169"), Ok(Query::Asn(15169)));
        assert_eq!(
            parse_query("Example.COM."),
            Ok(Query::Domain("example.com".into()))
        );
        assert_eq!(
            parse_query("xn--bcher-kva.de"),
            Ok(Query::Domain("xn--bcher-kva.de".into()))
        );
        for bad in [
            "",
            "localhost",
            "exa mple.com",
            "-a.com",
            "a..com",
            "bücher.de",
            "1.2.3",
            "as99999999999",
            "http://example.com",
        ] {
            assert!(parse_query(bad).is_err(), "{bad}");
        }
        assert_eq!(Query::Asn(3333).path(), "/autnum/3333");
        assert_eq!(Query::Asn(3333).host(), "as3333");
    }

    #[test]
    fn an_arin_network_names_its_holder_and_abuse_contact() {
        let query = parse_query("8.8.8.8").unwrap();
        let report = parse_answer(
            &query,
            &fixture("ip-arin"),
            vec!["rdap.org".into(), "rdap.arin.net".into()],
        );
        assert_eq!(report.kind, "ip");
        assert_eq!(report.range, "8.8.8.0 – 8.8.8.255");
        assert_eq!(report.cidrs, vec!["8.8.8.0/24"]);
        assert_eq!(report.name, "GOGL");
        let holder = report
            .entities
            .iter()
            .find(|e| e.roles.contains(&"registrant".to_string()))
            .unwrap();
        assert_eq!(holder.name, "Google LLC");
        let abuse = report
            .entities
            .iter()
            .find(|e| e.roles.contains(&"abuse".to_string()))
            .unwrap();
        assert_eq!(abuse.emails, vec!["network-abuse@google.com"]);
        assert!(report.events.iter().any(|e| e.action == "registration"));
        assert_eq!(report.servers, vec!["rdap.org", "rdap.arin.net"]);
    }

    #[test]
    fn a_ripe_network_keeps_its_country_and_merges_repeated_entities() {
        let query = parse_query("193.0.6.139").unwrap();
        let report = parse_answer(&query, &fixture("ip-ripe"), vec!["rdap.db.ripe.net".into()]);
        assert_eq!(report.country, "NL");
        assert!(!report.cidrs.is_empty());
        let ops: Vec<_> = report
            .entities
            .iter()
            .filter(|e| e.handle == "OPS4-RIPE")
            .collect();
        assert_eq!(ops.len(), 1, "one entity per handle");
        assert!(ops[0].roles.contains(&"abuse".to_string()));
        assert!(ops[0].roles.contains(&"technical".to_string()));
    }

    #[test]
    fn a_domain_lists_its_registrar_name_servers_and_dnssec() {
        let query = parse_query("example.com").unwrap();
        let report = parse_answer(&query, &fixture("domain"), vec![]);
        assert_eq!(report.name, "example.com");
        assert_eq!(report.nameservers.len(), 2);
        assert!(report
            .nameservers
            .iter()
            .all(|ns| ns.ends_with(".ns.cloudflare.com")));
        assert_eq!(report.dnssec, Some(true));
        assert!(report
            .entities
            .iter()
            .any(|e| e.roles.contains(&"registrar".to_string())));
        assert!(report.events.iter().any(|e| e.action == "expiration"));
    }

    #[test]
    fn an_autonomous_system_shows_its_number_and_holder() {
        let query = parse_query("AS3333").unwrap();
        let report = parse_answer(&query, &fixture("autnum"), vec![]);
        assert_eq!(report.asn_range, "AS3333");
        assert_eq!(report.handle, "AS3333");
        assert!(report.entities.iter().any(|e| e.kind == "org"));
        assert!(report.remarks.len() <= 6);
    }

    #[test]
    fn answers_are_cleaned_and_bounded() {
        let query = parse_query("8.8.8.8").unwrap();
        let hostile = serde_json::json!({
            "handle": "NET\u{202E}-1\n",
            "name": "x".repeat(500),
            "status": (0..100).map(|n| format!("s{n}")).collect::<Vec<_>>(),
            "entities": (0..100).map(|n| serde_json::json!({"handle": format!("E{n}"), "roles": ["abuse"]})).collect::<Vec<_>>(),
        });
        let report = parse_answer(&query, &hostile, vec![]);
        assert_eq!(report.handle, "NET-1");
        assert_eq!(report.name.chars().count(), 200);
        assert_eq!(report.status.len(), MAX_LIST);
        assert_eq!(report.entities.len(), MAX_ENTITIES);
    }

    #[test]
    fn a_redirect_must_stay_on_https() {
        let here = reqwest::Url::parse("https://rdap.org/ip/8.8.8.8").unwrap();
        assert_eq!(
            next_hop(&here, "https://rdap.arin.net/registry/ip/8.8.8.8")
                .unwrap()
                .host_str(),
            Some("rdap.arin.net")
        );
        assert!(next_hop(&here, "http://rdap.arin.net/registry/ip/8.8.8.8").is_err());
        assert!(next_hop(&here, "file:///c:/x").is_err());
    }

    /// A registry answer that points at an address inside the network must
    /// not be followed: an address in a URL is never resolved, so the
    /// client's guard cannot see it.
    #[test]
    fn a_redirect_may_not_point_at_a_local_address() {
        let here = reqwest::Url::parse("https://rdap.org/ip/8.8.8.8").unwrap();
        for location in [
            "https://127.0.0.1/x",
            "https://10.0.0.5/x",
            "https://169.254.169.254/latest/meta-data/",
            "https://[::1]/x",
            "https://[fd00::1]/x",
        ] {
            assert_eq!(
                next_hop(&here, location),
                Err("target_not_public".to_string()),
                "{location}"
            );
        }
        assert!(next_hop(&here, "https://8.8.4.4/x").is_ok());
    }
}
