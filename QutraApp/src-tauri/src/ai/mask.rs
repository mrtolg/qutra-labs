//! Secrets in what goes to a cloud service are masked before a turn is built
//! (spec 2026-10-07 §7.5; D9): private keys, cloud,
//! GitHub, GitLab, Slack, package-registry and payment tokens, JWTs, bearer,
//! basic and cookie headers, passwords in URLs and command lines, and
//! `password=`-style pairs under any name (`DB_PASSWORD`, `aws_secret_key`).
//!
//! What is masked: the text of user messages, and of answers kept without
//! content blocks (a local model's or an OpenAI-compatible service's).
//! Claude's answers go out as their stored blocks, unchanged, so the thinking
//! bound to them stays valid; only the plain text kept beside the blocks,
//! which a service that does not take blocks is sent instead, is masked.
//! A message the page marks `sent` went out before, masked. The user's
//! exclusions are not applied to it again, so adding one never rewrites a
//! conversation's past, but its secrets are masked once more: the mark comes
//! from the page, and masking twice changes nothing, so a message that really
//! went out before is unchanged and one that did not is not let through.
//!
//! The `regex` engine runs in linear time: no input can make it hang. Key
//! names are bounded by character classes, not Unicode `\b`, which would push
//! the engine off its fast path on Turkish text. Masking is a safety net,
//! not a guarantee: a secret in a form this table does not know still leaves.
//!
//! The user's exclusions (Settings → Privacy: names, paths, domains) are
//! masked too, in the same texts, after the secrets: a marker put in first
//! would break the secret patterns around it (`ACME_DB_PASSWORD=x`,
//! `-u acme:x`) and the secret next to it would leave. The core reads the
//! exclusions itself (`super::exclusions`); the page never supplies them.

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::{Captures, Regex};

use super::turn::ChatMessage;

/// What takes a secret's place. It names the kind, so the model can still
/// follow the question, and never contains a value.
const KEY: &str = "[masked private key]";
const TOKEN: &str = "[masked token]";
const PASSWORD: &str = "[masked password]";
const COOKIE: &str = "[masked cookie]";
/// What takes an excluded value's place.
const EXCLUDED: &str = "[masked exclusion]";

/// An exclusion shorter than this would mask half of every text; one longer
/// than the maximum is pasted text, not a name or a path.
const MIN_TERM_CHARS: usize = 2;
const MAX_TERM_CHARS: usize = 256;
/// More than any real list; bounds the patterns one call builds.
pub const MAX_TERMS: usize = 500;

struct Rule {
    pattern: Regex,
    /// The replacement; `${1}`/`${2}` keep a key name, a header, a URL's
    /// user and host, or quotes around the marker.
    replacement: String,
}

/// Where a key name may start: the text's start or a character that cannot
/// be part of a name.
const START: &str = r"(?:^|[^\p{L}\p{N}_.\-])";
/// The parts a key name may have before the word that says it is secret:
/// `DB_`, `aws.`, `X-Api-`.
const PARTS: &str = r"(?:[A-Za-z0-9]+[_.\-])*";
/// Names whose value is always secret.
const STRONG: &str = r"(?:password|passwd|passwort|passphrase|parola|şifre|sifre|contraseña|contrasena|mot[ _\-]?de[ _\-]?passe|secret|client[_\-]?secret|secret[_\-]?(?:access[_\-]?)?key|access[_\-]?key|account[_\-]?key|shared[_\-]?access[_\-]?(?:key|signature)|api[_\-]?key|apikey|private[_\-]?key|client[_\-]?key[_\-]?data)";
/// Names that are secret when their value looks like one.
const WEAK: &str = r"(?:token|access[_\-]?token|auth[_\-]?token|refresh[_\-]?token|id[_\-]?token|session[_\-]?token|sas[_\-]?token|pass|pwd|pw|auth|sig)";
/// Between a name and its value: a closing quote, then `:` or `=`, on one line.
const SEP_ANY: &str = r#"["']?[ \t]*[:=][ \t]*"#;
const SEP_EQ: &str = r#"["']?[ \t]*=[ \t]*"#;
const SEP_COLON: &str = r#"["']?[ \t]*:[ \t]*"#;
/// The first character of a value: not a quote, a separator, a marker
/// already there (so masking twice changes nothing), or the start of a
/// reference or placeholder (`${DB_PASSWORD}`, `%PASS%`, `<password>`,
/// `********`, `/run/secrets/db`), which the model may need to see.
const FIRST: &str = r#"[^\s"'&;<>$%*{/\[]"#;

fn rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let rule = |pattern: String, replacement: String| Rule {
            pattern: Regex::new(&pattern).expect("a valid mask pattern"),
            replacement,
        };
        let keep = |marker: &str| format!("${{1}}{marker}");
        let quoted = |marker: &str| format!("${{1}}${{2}}{marker}${{3}}");
        vec![
            // A private key block, end line included.
            rule(
                r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?s:.*?)-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----".into(),
                KEY.into(),
            ),
            // A private key cut short: the header, any `Proc-Type:` lines,
            // then base64 lines up to the first blank line. Lines may be
            // real or written `\n`, as in a service-account JSON file.
            rule(
                r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:(?:\r?\n|\\n)[A-Za-z][A-Za-z\-]*: [^\r\n\\]*)*(?:(?:\r?\n|\\n){1,2}[A-Za-z0-9+/=]+(?:(?:\r?\n|\\n)[A-Za-z0-9+/=]+)*)?".into(),
                KEY.into(),
            ),
            rule(r"(?-u:\b)(?:AKIA|ASIA)[0-9A-Z]{16}(?-u:\b)".into(), TOKEN.into()),
            rule(r"(?-u:\b)gh[pousr]_[A-Za-z0-9]{36,255}(?-u:\b)".into(), TOKEN.into()),
            rule(r"(?-u:\b)github_pat_[A-Za-z0-9_]{22,255}(?-u:\b)".into(), TOKEN.into()),
            rule(r"(?-u:\b)glpat-[A-Za-z0-9_\-]{20,}".into(), TOKEN.into()),
            rule(r"(?-u:\b)xox[abprs]-[A-Za-z0-9\-]{10,}".into(), TOKEN.into()),
            rule(r"(?-u:\b)xapp-[0-9]-[A-Za-z0-9\-]{10,}".into(), TOKEN.into()),
            // Chat webhooks: the address is the secret.
            rule(r"https://hooks\.slack\.com/(?:services|workflows)/[A-Za-z0-9/_\-]+".into(), TOKEN.into()),
            rule(r"https://(?:[a-z]+\.)?discord(?:app)?\.com/api/webhooks/[0-9]+/[A-Za-z0-9_\-]+".into(), TOKEN.into()),
            // Google OAuth, SendGrid, Stripe webhook, DigitalOcean and
            // Shopify tokens.
            rule(r"(?-u:\b)ya29\.[A-Za-z0-9_\-]{20,}".into(), TOKEN.into()),
            rule(r"(?-u:\b)SG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}".into(), TOKEN.into()),
            rule(r"(?-u:\b)whsec_[A-Za-z0-9]{16,}".into(), TOKEN.into()),
            rule(r"(?-u:\b)do[opr]_v1_[a-f0-9]{40,}".into(), TOKEN.into()),
            rule(r"(?-u:\b)shp(?:at|ss|ca|pa)_[A-Fa-f0-9]{32}".into(), TOKEN.into()),
            // OpenAI, Anthropic and OpenRouter keys.
            rule(r"(?-u:\b)sk-(?:ant-|proj-|svcacct-|or-)?[A-Za-z0-9_\-]{20,}".into(), TOKEN.into()),
            rule(r"(?-u:\b)AIza[0-9A-Za-z_\-]{35}".into(), TOKEN.into()),
            rule(r"(?-u:\b)[rs]k_(?:live|test)_[0-9A-Za-z]{16,}".into(), TOKEN.into()),
            // Groq, Hugging Face, npm and PyPI.
            rule(r"(?-u:\b)gsk_[A-Za-z0-9]{40,}".into(), TOKEN.into()),
            rule(r"(?-u:\b)hf_[A-Za-z0-9]{30,}".into(), TOKEN.into()),
            rule(r"(?-u:\b)npm_[A-Za-z0-9]{36}".into(), TOKEN.into()),
            rule(r"(?-u:\b)pypi-[A-Za-z0-9_\-]{50,}".into(), TOKEN.into()),
            // A JWT: header, payload and signature.
            rule(
                r"(?-u:\b)eyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}".into(),
                TOKEN.into(),
            ),
            rule(
                format!(r"(?i)({START}bearer[ \t]+)[A-Za-z0-9._~+/\-]{{16,}}=*"),
                keep(TOKEN),
            ),
            // Basic credentials in a header or in JSON (a HAR file).
            rule(
                r#"(?i)(authorization["']?[ \t]*:[ \t]*["']?[ \t]*basic[ \t]+)[A-Za-z0-9+/]{8,}={0,2}"#.into(),
                keep(TOKEN),
            ),
            // Other schemes of an Authorization header, which the Bearer and
            // Basic rules do not know.
            rule(
                r#"(?i)((?:proxy-)?authorization["']?[ \t]*:[ \t]*["']?[ \t]*(?:token|apikey|api-key|digest|negotiate|ntlm|hmac|sso-key|aws4-hmac-sha256)[ \t]+)[^\s"']{8,}"#.into(),
                keep(TOKEN),
            ),
            // A header kept as name and value, as a HAR file keeps it.
            rule(
                r#"(?i)("name"[ \t]*:[ \t]*"(?:authorization|proxy-authorization|cookie|set-cookie|x-[a-z0-9\-]*(?:token|key|secret|auth)[a-z0-9\-]*)"[ \t]*,[ \t]*"value"[ \t]*:[ \t]*")[^"\r\n\[][^"\r\n]*(")"#.into(),
                format!("${{1}}{TOKEN}${{2}}"),
            ),
            rule(
                format!(r#"(?i)({START}(?:set-)?cookie["']?[ \t]*:[ \t]*["']?)[^\s\["'][^\r\n"']*"#),
                keep(COOKIE),
            ),
            // X-Auth-Token, X-Api-Key, X-Amz-Security-Token and the like.
            rule(
                format!(r#"(?i)({START}x-[a-z0-9\-]*(?:token|key|secret|auth|signature)[a-z0-9\-]*["']?[ \t]*:[ \t]*["']?)[^\s"'\[][^\s"']{{7,}}"#),
                keep(TOKEN),
            ),
            // scheme://user:password@host, up to the last @ before the host.
            rule(
                format!(r"(?i)({START}[a-z][a-z0-9+.\-]*://[^\s:/@]+:)[^\s/]+(@)"),
                format!("${{1}}{PASSWORD}${{2}}"),
            ),
            // The same where the password itself holds a slash.
            rule(
                format!(r"(?i)({START}[a-z][a-z0-9+.\-]*://[^\s:/@]+:)[^\s@]*/[^\s@]*(@)"),
                format!("${{1}}{PASSWORD}${{2}}"),
            ),
            // Command lines: --password x, --token=x, and any long flag whose
            // name says pass, pwd, token, secret, cookie, auth, key or
            // credential (--http-password, --proxy-password, --api-token),
            // except one that turns something off (--no-auth); then
            // curl -u user:pass.
            rule(
                // (No look-ahead in this regex engine: the optional prefix
                // simply cannot begin with "no-".)
                r#"(?i)((?:^|\s)--(?:password|passwd|pass|token|api-key|apikey|secret|client-secret|(?:(?:[a-mo-z0-9]|n[a-np-z0-9\-]|no[a-z0-9])[a-z0-9\-]*)?(?:pass|pwd|token|secret|cookie|auth|api-?key|credential)[a-z0-9\-]*)(?:=|[ \t]+))(?:"[^"\r\n\[][^"\r\n]*"|'[^'\r\n\[][^'\r\n]*'|[^\s"'\[\-][^\s"']*)"#.into(),
                keep(PASSWORD),
            ),
            // impacket and its kin: domain/user:password@host, no scheme.
            rule(
                r"(?i)((?:^|\s)[a-z0-9.\-]+/[a-z0-9.\-_$]+:)[^\s@/\[][^\s@/]*(@[a-z0-9.\-\[\]:]+)".into(),
                format!("${{1}}{PASSWORD}${{2}}"),
            ),
            rule(
                r"(?i)((?:^|\s)(?:-u|--user)[ \t]+[^\s:]+:)[^\s\[][^\s]*".into(),
                keep(PASSWORD),
            ),
            rule(
                r#"(?i)(ConvertTo-SecureString[ \t]+(?:-String[ \t]+)?)(["'])[^"'\r\n\[][^"'\r\n]*(["'])"#.into(),
                quoted(PASSWORD),
            ),
            // Named secrets: a quoted value, with spaces if it has them.
            rule(
                format!(r#"(?i)({START}{PARTS}{STRONG}{SEP_ANY})(["'])[^"'\r\n\[][^"'\r\n]{{0,511}}(["'])"#),
                quoted(PASSWORD),
            ),
            rule(
                format!(r#"(?i)({START}{PARTS}{WEAK}{SEP_ANY})(["'])[^"'\r\n\[][^"'\r\n]{{5,511}}(["'])"#),
                quoted(TOKEN),
            ),
            // KEY=value: up to a space or a separator.
            rule(
                format!(r#"(?i)({START}{PARTS}{STRONG}{SEP_EQ}){FIRST}[^\s"'&;<>]{{3,}}"#),
                keep(PASSWORD),
            ),
            rule(
                format!(r#"(?i)({START}{PARTS}{WEAK}{SEP_EQ}){FIRST}[^\s"'&;<>]{{5,}}"#),
                keep(TOKEN),
            ),
            // key: value (YAML, INI): the rest of the line, up to a comment.
            rule(
                format!(r#"(?i)({START}{PARTS}{STRONG}{SEP_COLON}){FIRST}[^\r\n#]{{3,}}"#),
                keep(PASSWORD),
            ),
            // token: value only when the value looks like a token, so prose
            // such as "token: expired" is left alone.
            rule(
                format!(r#"(?i)({START}{PARTS}{WEAK}{SEP_COLON})[A-Za-z0-9._~+/=\-]{{20,}}"#),
                keep(TOKEN),
            ),
        ]
    })
}

/// The text with its secrets masked, and how many were.
pub fn mask_text(text: &str) -> (String, usize) {
    let mut out = text.to_string();
    let mut count = 0;
    for rule in rules() {
        let replaced = rule.pattern.replace_all(&out, |caps: &Captures| {
            count += 1;
            let mut masked = String::new();
            caps.expand(&rule.replacement, &mut masked);
            masked
        });
        if let std::borrow::Cow::Owned(masked) = replaced {
            out = masked;
        }
    }
    (out, count)
}

/// The user's exclusions as patterns, built once for every text of a call.
struct Exclusions(Vec<Regex>);

impl Exclusions {
    /// Terms are trimmed; too short, too long and repeated ones are dropped,
    /// and so is one the marker itself contains ("masked", "exclusion"),
    /// which would mask the marker again on the next pass.
    fn new(terms: &[String]) -> Self {
        let mut seen = HashSet::new();
        let patterns = terms
            .iter()
            .map(|term| term.trim())
            .filter(|term| (MIN_TERM_CHARS..=MAX_TERM_CHARS).contains(&term.chars().count()))
            .filter(|term| seen.insert(term.to_lowercase()))
            .take(MAX_TERMS)
            .map(term_pattern)
            .filter(|pattern| !pattern.is_match(EXCLUDED))
            .collect();
        Self(patterns)
    }

    /// Every match of every term is found in the original text, and matches
    /// that overlap become one marker: a longer term always wins over a
    /// shorter one inside it, and two terms that overlap leave nothing of
    /// either behind.
    fn mask(&self, text: &str) -> (String, usize) {
        let mut spans: Vec<(usize, usize)> = self
            .0
            .iter()
            .flat_map(|pattern| {
                pattern
                    .find_iter(text)
                    .map(|found| (found.start(), found.end()))
            })
            .collect();
        if spans.is_empty() {
            return (text.to_string(), 0);
        }
        spans.sort_unstable();
        let mut out = String::with_capacity(text.len());
        let mut count = 0;
        let mut cursor = 0;
        for (start, end) in spans {
            if start < cursor {
                // Inside the marker just written: it covers this one too.
                cursor = cursor.max(end);
                continue;
            }
            out.push_str(&text[cursor..start]);
            out.push_str(EXCLUDED);
            count += 1;
            cursor = end;
        }
        out.push_str(&text[cursor..]);
        (out, count)
    }
}

/// A term as a pattern: its literal text in any case. Either path separator
/// stands for either, repeated or not, so `C:\Clients\Acme` also finds
/// `c:/clients/acme` and the JSON-escaped `C:\\Clients\\Acme`. Turkish dotted
/// and dotless i stand for each other too, which case folding does not do.
fn term_pattern(term: &str) -> Regex {
    let mut pattern = String::from("(?i)");
    for c in term.chars() {
        match c {
            '\\' | '/' => pattern.push_str(r"[\\/]+"),
            'i' | 'I' | 'İ' | 'ı' => pattern.push_str("[iIİı]"),
            _ => pattern.push_str(&regex::escape(c.encode_utf8(&mut [0; 4]))),
        }
    }
    // An escaped literal of at most 256 characters always compiles. Were one
    // ever not to, the panic ends the call (every caller masks on a blocking
    // task) rather than letting the value leave unmasked.
    Regex::new(&pattern).expect("an escaped exclusion compiles")
}

/// The text with every excluded value masked, and how many were.
#[cfg(test)]
pub fn mask_terms(text: &str, terms: &[String]) -> (String, usize) {
    Exclusions::new(terms).mask(text)
}

/// Secrets first, then exclusions (see the module notes for why).
fn mask_all(text: &str, exclusions: &Exclusions) -> (String, usize) {
    let (text, secrets) = mask_text(text);
    let (text, excluded) = exclusions.mask(&text);
    (text, secrets + excluded)
}

/// A text as it would leave, and how many secrets and excluded values were
/// masked in it: what the consent card shows before an
/// investigation's summary goes.
#[derive(Debug, serde::Serialize, PartialEq, Eq)]
pub struct MaskPreview {
    pub text: String,
    pub masked: usize,
}

/// The largest text the preview takes; a summary is far smaller.
pub const MAX_PREVIEW_BYTES: usize = 1024 * 1024;

/// The masked form of a text with no exclusions.
#[cfg(test)]
pub fn preview(text: &str) -> Result<MaskPreview, &'static str> {
    preview_with(text, &[])
}

/// The masked form of a text, `terms` being the user's exclusions, for the
/// page to show before it is sent.
pub fn preview_with(text: &str, terms: &[String]) -> Result<MaskPreview, &'static str> {
    if text.len() > MAX_PREVIEW_BYTES {
        return Err("too_large");
    }
    let (text, masked) = mask_all(text, &Exclusions::new(terms));
    Ok(MaskPreview { text, masked })
}

/// A conversation as it may leave.
pub struct MaskedTurn {
    pub messages: Vec<ChatMessage>,
    /// How many secrets and excluded values were masked in all.
    pub masked: usize,
    /// The last user message as it leaves, for the page to keep, so the
    /// next turns send it exactly the same.
    pub last_user: Option<String>,
}

/// `mask_messages_with` with no exclusions.
#[cfg(test)]
pub fn mask_messages(messages: &[ChatMessage]) -> MaskedTurn {
    mask_messages_with(messages, &[])
}

/// An answer's content blocks, as an adapter that takes blocks echoes them.
fn has_blocks(message: &ChatMessage) -> bool {
    matches!(&message.blocks, Some(serde_json::Value::Array(blocks)) if !blocks.is_empty())
}

/// Mask what may leave: user messages, and answers kept without blocks;
/// secrets first, then `terms`, the user's exclusions. A message marked
/// `sent`, and the text kept beside a Claude answer's blocks, have their
/// secrets masked again but not the exclusions (see the module notes); the
/// blocks themselves go out unchanged.
pub fn mask_messages_with(messages: &[ChatMessage], terms: &[String]) -> MaskedTurn {
    let exclusions = Exclusions::new(terms);
    let mut total = 0;
    let out: Vec<ChatMessage> = messages
        .iter()
        .map(|message| {
            if message.role != "user" && message.role != "assistant" {
                return message.clone();
            }
            let (content, count) = if message.sent || has_blocks(message) {
                mask_text(&message.content)
            } else {
                mask_all(&message.content, &exclusions)
            };
            total += count;
            ChatMessage {
                content,
                ..message.clone()
            }
        })
        .collect();
    let last_user = out
        .iter()
        .rev()
        .find(|message| message.role == "user")
        .map(|message| message.content.clone());
    MaskedTurn {
        messages: out,
        masked: total,
        last_user,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn masked(text: &str) -> String {
        mask_text(text).0
    }

    fn message(role: &str, content: &str) -> ChatMessage {
        ChatMessage {
            role: role.into(),
            content: content.into(),
            blocks: None,
            sent: false,
        }
    }

    #[test]
    fn tokens_and_keys_are_masked() {
        for secret in [
            "AKIAABCDEFGHIJKLMNOP",
            "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
            "glpat-abcdefghijklmnopqrst",
            "xoxb-1234567890-abcdefghij",
            "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
            "sk-proj-abcdefghijklmnopqrstuvwx",
            "sk-or-v1-abcdefghijklmnopqrstuvwxyz",
            "AIzaSyA1234567890abcdefghijklmnopqrstuv",
            "sk_live_abcdefghijklmnop1234",
            "gsk_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF",
            "hf_abcdefghijklmnopqrstuvwxyz012345",
            "npm_abcdefghijklmnopqrstuvwxyz0123456789",
            "pypi-AgEIcHlwaS5vcmcCJGFiY2RlZmdoLWlqa2wtbW5vcC1xcnN0LXV2d3h5ejAxMjM0",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijklmnop",
        ] {
            let (text, count) = mask_text(&format!("key is {secret} here"));
            assert_eq!(text, format!("key is {TOKEN} here"), "{secret}");
            assert_eq!(count, 1, "{secret}");
        }
    }

    #[test]
    fn a_private_key_block_goes_whole() {
        let key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\nAAAA==\n-----END OPENSSH PRIVATE KEY-----";
        assert_eq!(
            masked(&format!("is this ok?\n{key}\nthanks")),
            format!("is this ok?\n{KEY}\nthanks")
        );
        // Cut short: the header and its base64 lines, not the question after.
        let cut = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234\nabcd==\n\nWhat is this?";
        assert_eq!(masked(cut), format!("{KEY}\n\nWhat is this?"));
        // Cut short inside a service-account JSON file, lines written \n.
        let json = r#"{"private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nBKcwggSjAgEAAoIBAQC7", "x": 1}"#;
        assert_eq!(
            masked(json),
            format!(r#"{{"private_key": "{KEY}", "x": 1}}"#)
        );
    }

    #[test]
    fn named_secrets_are_masked_whatever_their_prefix() {
        for (text, out) in [
            ("DB_PASSWORD=hunter22", format!("DB_PASSWORD={PASSWORD}")),
            (
                "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG",
                format!("aws_secret_access_key = {PASSWORD}"),
            ),
            ("JWT_SECRET=abc123xyz", format!("JWT_SECRET={PASSWORD}")),
            (
                "VT_API_KEY=0123456789abcdef",
                format!("VT_API_KEY={PASSWORD}"),
            ),
            ("NPM_TOKEN=abcdef123456", format!("NPM_TOKEN={TOKEN}")),
            (
                r#"{"SecretAccessKey": "wJalrXUtnFEMI"}"#,
                format!(r#"{{"SecretAccessKey": "{PASSWORD}"}}"#),
            ),
            (
                "Server=db;Uid=sa;Pwd=Secret123;",
                format!("Server=db;Uid=sa;Pwd={TOKEN};"),
            ),
            (
                "AccountName=x;AccountKey=abc+def/ghi==;EndpointSuffix=core",
                format!("AccountName=x;AccountKey={PASSWORD};EndpointSuffix=core"),
            ),
            (
                "https://x.blob.core.windows.net/c?sv=2022&sig=abcd%2Fefgh123",
                format!("https://x.blob.core.windows.net/c?sv=2022&sig={TOKEN}"),
            ),
            ("Passwort: geheim123", format!("Passwort: {PASSWORD}")),
            ("contraseña=secreta1", format!("contraseña={PASSWORD}")),
            (
                "db:\n  şifre: gizli1234",
                format!("db:\n  şifre: {PASSWORD}"),
            ),
        ] {
            assert_eq!(masked(text), out, "{text}");
        }
    }

    #[test]
    fn a_recognised_secret_goes_whole() {
        assert_eq!(
            masked(r#"password="my secret phrase""#),
            format!(r#"password="{PASSWORD}""#)
        );
        assert_eq!(
            masked("passphrase: correct horse battery staple"),
            format!("passphrase: {PASSWORD}")
        );
        assert_eq!(
            masked("postgres://admin:p@ssw0rd@db:5432/app"),
            format!("postgres://admin:{PASSWORD}@db:5432/app")
        );
        assert_eq!(
            masked(r#"$p = ConvertTo-SecureString "P@ss w0rd" -AsPlainText -Force"#),
            format!(r#"$p = ConvertTo-SecureString "{PASSWORD}" -AsPlainText -Force"#)
        );
        assert_eq!(
            masked("mysql --password=hunter22 -h db"),
            format!("mysql --password={PASSWORD} -h db")
        );
        assert_eq!(
            masked("curl -u admin:hunter22 https://x"),
            format!("curl -u admin:{PASSWORD} https://x")
        );
    }

    #[test]
    fn secret_flags_by_their_name_and_tool_credentials_are_masked() {
        // Any long flag whose name says pass, token, secret, cookie, auth or
        // key takes its value with it, as a tool run's command line keeps it.
        assert_eq!(
            masked("wget --http-password hunter22 https://x"),
            format!("wget --http-password {PASSWORD} https://x")
        );
        assert_eq!(
            masked("curl --proxy-password=hunter22 https://x"),
            format!("curl --proxy-password={PASSWORD} https://x")
        );
        assert_eq!(
            masked("tool --api-token abc123def --verbose"),
            format!("tool --api-token {PASSWORD} --verbose")
        );
        assert_eq!(
            masked(r#"curl --cookie "session=abc123; theme=dark" https://x"#),
            format!(r#"curl --cookie {PASSWORD} https://x"#)
        );
        // impacket's domain/user:password@host, with no scheme.
        assert_eq!(
            masked("secretsdump.py corp.local/admin:Passw0rd!@10.0.0.5"),
            format!("secretsdump.py corp.local/admin:{PASSWORD}@10.0.0.5")
        );
        // A flag that turns something off has no value to take.
        assert_eq!(
            masked("curl --no-auth https://x"),
            "curl --no-auth https://x"
        );
    }

    #[test]
    fn headers_are_masked() {
        assert_eq!(
            masked("curl -H 'Authorization: Bearer abcdefghijklmnop1234'"),
            format!("curl -H 'Authorization: Bearer {TOKEN}'")
        );
        assert_eq!(
            masked(r#"{"name": "Authorization", "value": "Basic dXNlcjpwYXNzd29yZA=="}"#),
            format!(r#"{{"name": "Authorization", "value": "{TOKEN}"}}"#)
        );
        assert_eq!(
            masked(r#""Authorization": "Basic dXNlcjpwYXNzd29yZA==""#),
            format!(r#""Authorization": "Basic {TOKEN}""#)
        );
        assert_eq!(
            masked("Cookie: session=abc123; theme=dark"),
            format!("Cookie: {COOKIE}")
        );
        assert_eq!(
            masked("X-Auth-Token: abcdef123456"),
            format!("X-Auth-Token: {TOKEN}")
        );
        assert_eq!(
            masked("client-key-data: LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVk"),
            format!("client-key-data: {PASSWORD}")
        );
        assert_eq!(
            masked("token: abcdefghijklmnopqrstuvwxyz012345"),
            format!("token: {TOKEN}")
        );
        assert_eq!(
            masked(r#"{"auths": {"r.io": {"auth": "dXNlcjpwYXNz"}}}"#),
            format!(r#"{{"auths": {{"r.io": {{"auth": "{TOKEN}"}}}}}}"#)
        );
    }

    #[test]
    fn ordinary_security_talk_is_left_alone() {
        for text in [
            "The password policy requires 12 characters.",
            "Basic authentication is weak over plain HTTP.",
            "The token expired yesterday; token: expired",
            "sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            "id 6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
            "pip install scikit-learn; sk-learn is not a key",
            "-----BEGIN CERTIFICATE-----",
            "https://example.com/path?q=1",
            "secret:\n  secretName: db-creds",
            "password: ${DB_PASSWORD}",
            "password=********",
            "PWD=/home/kali",
            "PASSWORD_FILE=/run/secrets/db",
            "nmap -p 80,443 -sV 10.0.0.5",
            "Şifre politikası en az 12 karakter istiyor.",
        ] {
            assert_eq!(mask_text(text), (text.to_string(), 0), "{text}");
        }
    }

    #[test]
    fn masking_twice_changes_nothing() {
        for text in [
            "password=hunter22 and Bearer abcdefghijklmnop1234 and ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            "Cookie: a=b; c=d",
            "X-Api-Key: abcdef123456",
            r#"password="my secret phrase" and "token": "abcdef123456""#,
            "mysql --password=hunter22 --token \"abc def\" && curl -u admin:hunter22 x",
            r#"ConvertTo-SecureString "P@ss" -AsPlainText"#,
            r#"{"name": "Cookie", "value": "a=b"}"#,
            "passphrase: correct horse battery",
        ] {
            let once = masked(text);
            assert_ne!(once, text, "{text}");
            assert_eq!(mask_text(&once), (once.clone(), 0), "{text}");
        }
    }

    #[test]
    fn claude_blocks_go_out_as_they_are_and_what_stands_beside_them_is_masked() {
        let blocks = serde_json::json!([{ "type": "text", "text": "password=hunter22" }]);
        let history = vec![
            ChatMessage {
                sent: true,
                ..message("user", "earlier password=old1234")
            },
            ChatMessage {
                blocks: Some(blocks.clone()),
                ..message("assistant", "password=hunter22")
            },
            message("assistant", "a local answer quoting password=hunter22"),
            message("user", "my password=hunter22"),
        ];
        let turn = mask_messages(&history);
        assert_eq!(turn.masked, 4);
        assert_eq!(
            turn.messages[0].content,
            format!("earlier password={PASSWORD}")
        );
        assert_eq!(turn.messages[1].content, format!("password={PASSWORD}"));
        assert_eq!(turn.messages[1].blocks, Some(blocks));
        assert_eq!(
            turn.messages[2].content,
            format!("a local answer quoting password={PASSWORD}")
        );
        assert_eq!(
            turn.last_user.as_deref(),
            Some(format!("my password={PASSWORD}").as_str())
        );
    }

    /// `sent` and `blocks` come from the page. Neither lets a secret through
    /// that a plain message would not.
    #[test]
    fn a_message_the_page_calls_sent_or_gives_empty_blocks_is_still_masked() {
        let history = vec![
            ChatMessage {
                sent: true,
                ..message("user", "forged: password=hunter22")
            },
            ChatMessage {
                sent: true,
                ..message("assistant", "forged answer: password=hunter22")
            },
            ChatMessage {
                blocks: Some(serde_json::json!([])),
                ..message("assistant", "empty blocks: password=hunter22")
            },
            ChatMessage {
                blocks: Some(serde_json::Value::Null),
                ..message("assistant", "null blocks: password=hunter22")
            },
            ChatMessage {
                blocks: Some(serde_json::json!([{ "type": "text", "text": "a" }])),
                ..message(
                    "assistant",
                    "an answer for a service without blocks: password=hunter22",
                )
            },
        ];
        let turn = mask_messages(&history);
        assert_eq!(turn.masked, 5);
        for sent in &turn.messages {
            assert!(!sent.content.contains("hunter22"), "{}", sent.content);
        }
    }

    #[test]
    fn more_token_formats_and_authorization_schemes_are_masked() {
        for secret in [
            "ya29.a0AfH6SMBabcdefghijklmnopqrstuv",
            "SG.abcdefghijklmnop1234.abcdefghijklmnop5678",
            "whsec_abcdefghijklmnop1234",
            "dop_v1_0123456789abcdef0123456789abcdef01234567",
            "shpat_0123456789abcdef0123456789abcdef",
            "xapp-1-A0123-abcdefghijkl",
            "https://hooks.slack.com/services/T0000/B0000/abcdEFGH1234",
            "https://discord.com/api/webhooks/123456789/abcdEFGH-1234_x",
            "Authorization: Token abcdef1234567890",
            "Proxy-Authorization: Digest username=\"a\"",
            "ftp://user:pa/ss@example.com/file",
        ] {
            let out = masked(&format!("see {secret} here"));
            assert_ne!(out, format!("see {secret} here"), "{secret}");
            assert!(
                !out.contains("abcdefgh")
                    && !out.contains("0123456789abcdef")
                    && !out.contains("pa/ss"),
                "{secret} -> {out}"
            );
            assert_eq!(mask_text(&out).1, 0, "idempotent: {out}");
        }
    }

    #[test]
    fn the_preview_is_what_would_leave() {
        let text = "İnceleme: ev\npassword=hunter22";
        assert_eq!(
            preview(text),
            Ok(MaskPreview {
                text: format!("İnceleme: ev\npassword={PASSWORD}"),
                masked: 1
            })
        );
        assert_eq!(
            preview(&"x".repeat(MAX_PREVIEW_BYTES + 1)),
            Err("too_large")
        );
    }

    fn terms(list: &[&str]) -> Vec<String> {
        list.iter().map(|term| term.to_string()).collect()
    }

    #[test]
    fn an_excluded_value_is_masked_in_any_case() {
        assert_eq!(
            mask_terms("Acme Corp, ACME CORP and acme corp", &terms(&["Acme Corp"])),
            (format!("{EXCLUDED}, {EXCLUDED} and {EXCLUDED}"), 3)
        );
    }

    #[test]
    fn turkish_text_around_an_excluded_value_stays() {
        assert_eq!(
            mask_terms("Acme Corp'un sunucusu çöktü", &terms(&["Acme Corp"])),
            (format!("{EXCLUDED}'un sunucusu çöktü"), 1)
        );
        // Dotted and dotless i stand for each other, in either case.
        assert_eq!(
            mask_terms(
                "ISTANBUL OFİSİ ve istanbul ofisi'nde",
                &terms(&["İstanbul Ofisi"])
            ),
            (format!("{EXCLUDED} ve {EXCLUDED}'nde"), 2)
        );
    }

    #[test]
    fn a_path_is_masked_whichever_separator_it_is_written_with() {
        let path = terms(&[r"C:\Clients\Acme"]);
        for text in [
            r"C:\Clients\Acme\report.pdf",
            "c:/clients/acme/report.pdf",
            r#"{"path": "C:\\Clients\\Acme\\report.pdf"}"#,
        ] {
            let (out, count) = mask_terms(text, &path);
            assert_eq!(count, 1, "{text}");
            assert!(!out.to_lowercase().contains("acme"), "{out}");
            assert!(out.contains("report.pdf"), "{out}");
        }
        assert_eq!(
            mask_terms(r"\srv\acme\logs", &terms(&["/srv/acme"])),
            (format!(r"{EXCLUDED}\logs"), 1)
        );
    }

    #[test]
    fn the_longest_term_wins_and_overlaps_leave_nothing() {
        for list in [["Acme", "Acme Corp"], ["Acme Corp", "Acme"]] {
            assert_eq!(
                mask_terms("Acme Corp sunucusu", &terms(&list)),
                (format!("{EXCLUDED} sunucusu"), 1)
            );
        }
        assert_eq!(
            mask_terms("Acme Corp Ltd here", &terms(&["Acme Co", "Corp Ltd"])),
            (format!("{EXCLUDED} here"), 1)
        );
    }

    #[test]
    fn masking_exclusions_twice_changes_nothing() {
        let list = terms(&["Acme Corp", r"C:\Clients\Acme", "acme.internal", "İzmir"]);
        let text = r"Acme Corp, C:/Clients/Acme\x, db.acme.internal, İZMİR";
        let (once, count) = mask_terms(text, &list);
        assert_eq!(count, 4, "{once}");
        assert_eq!(mask_terms(&once, &list), (once.clone(), 0));
    }

    #[test]
    fn short_long_and_marker_like_terms_are_ignored() {
        let text = "a masked exclusion in the text, [masked exclusion]";
        let ignored = terms(&[
            "",
            "  ",
            "a",
            " b ",
            "masked",
            "Exclusion",
            "SK",
            "[masked exclusion]",
        ]);
        assert_eq!(mask_terms(text, &ignored), (text.to_string(), 0));
        let long = "x".repeat(MAX_TERM_CHARS + 1);
        assert_eq!(
            mask_terms(&long, std::slice::from_ref(&long)),
            (long.clone(), 0)
        );
        // Trimmed before it is measured or matched.
        assert_eq!(
            mask_terms("ab cd", &terms(&["  ab  "])),
            (format!("{EXCLUDED} cd"), 1)
        );
    }

    #[test]
    fn secrets_are_masked_before_exclusions_so_neither_leaves() {
        let acme = terms(&["Acme"]);
        assert_eq!(
            mask_all("ACME_DB_PASSWORD=hunter22", &Exclusions::new(&acme)),
            (format!("{EXCLUDED}_DB_PASSWORD={PASSWORD}"), 2)
        );
        assert_eq!(
            mask_all("curl -u acme:hunter22 https://x", &Exclusions::new(&acme)),
            (format!("curl -u {EXCLUDED}:{PASSWORD} https://x"), 2)
        );
    }

    #[test]
    fn exclusions_reach_the_messages_secrets_do_and_no_others() {
        let blocks = serde_json::json!([{ "type": "text", "text": "Acme Corp" }]);
        let history = vec![
            ChatMessage {
                sent: true,
                ..message("user", "earlier about Acme Corp")
            },
            ChatMessage {
                blocks: Some(blocks.clone()),
                ..message("assistant", "Acme Corp")
            },
            message("assistant", "a local answer about acme corp"),
            message("user", "Acme Corp'un password=hunter22"),
        ];
        let turn = mask_messages_with(&history, &terms(&["Acme Corp"]));
        assert_eq!(turn.masked, 3);
        assert_eq!(turn.messages[0].content, "earlier about Acme Corp");
        assert_eq!(turn.messages[1].content, "Acme Corp");
        assert_eq!(turn.messages[1].blocks, Some(blocks));
        assert_eq!(
            turn.messages[2].content,
            format!("a local answer about {EXCLUDED}")
        );
        assert_eq!(
            turn.last_user.as_deref(),
            Some(format!("{EXCLUDED}'un password={PASSWORD}").as_str())
        );
    }

    #[test]
    fn the_preview_masks_exclusions_too() {
        assert_eq!(
            preview_with(
                "İnceleme: Acme Corp\npassword=hunter22",
                &terms(&["Acme Corp"])
            ),
            Ok(MaskPreview {
                text: format!("İnceleme: {EXCLUDED}\npassword={PASSWORD}"),
                masked: 2
            })
        );
        assert_eq!(
            preview_with(&"x".repeat(MAX_PREVIEW_BYTES + 1), &terms(&["x1"])),
            Err("too_large")
        );
    }

    #[test]
    fn a_long_turkish_conversation_masks_in_reasonable_time() {
        // About 450 KB; the test build is unoptimised, so the bound is loose.
        let text = "Şifre politikası ve güvenlik taraması üzerine notlar. ".repeat(8_000);
        let started = std::time::Instant::now();
        let (out, count) = mask_text(&text);
        assert_eq!(count, 0);
        assert_eq!(out.len(), text.len());
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
    }
}
