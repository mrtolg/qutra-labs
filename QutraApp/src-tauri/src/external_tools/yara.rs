//! YARA's `--print-strings --print-meta --print-tags` output as facts.
//! A match line is `rule [tags] [meta] path`, followed by one
//! `0xoffset:$id: text` line per matching string. A match is a lead, not
//! proof; no match is a result, not an error.

use super::{stderr_error, ParseContext};
use crate::{
    analysis::{clean_text, Fact, Group},
    tool_supervisor::RunLogs,
};

struct Hit {
    rule: String,
    tags: Vec<String>,
    description: Option<String>,
    strings: Vec<String>,
}

pub fn parse(logs: &RunLogs, ctx: &ParseContext) -> Result<Vec<Fact>, String> {
    let mut facts = Vec::new();
    if let Some(name) = &ctx.rules_name {
        facts.push(Fact::new(
            Group::Summary,
            "yara.rulesFile",
            clean_text(name),
        ));
    }
    if logs.exit_code != Some(0) {
        // A scan that failed counts nothing: its reason is on stderr, if it
        // gave one.
        facts.extend(stderr_error("yara.error", &logs.stderr, ctx, |_| false).ok());
        return Ok(facts);
    }
    let mut hits: Vec<Hit> = Vec::new();
    for line in logs.stdout.lines() {
        if let Some(found) = string_match(line) {
            if let Some(hit) = hits.last_mut() {
                hit.strings.push(found);
            }
        } else if let Some(hit) = rule_line(line) {
            hits.push(hit);
        }
    }
    facts.push(Fact::new(Group::Summary, "yara.count", hits.len()));
    if hits.is_empty() {
        return Ok(facts);
    }
    let rules = hits
        .iter()
        .map(|hit| {
            let mut parts = vec![hit.rule.clone()];
            if !hit.tags.is_empty() {
                parts.push(hit.tags.join(", "));
            }
            if let Some(description) = &hit.description {
                parts.push(description.clone());
            }
            parts.join(" · ")
        })
        .collect();
    facts.push(
        Fact::new(Group::Interesting, "yara.matches", hits.len())
            .hint("yaraMatch")
            .items(rules),
    );
    let strings: Vec<String> = hits
        .iter()
        .flat_map(|hit| {
            hit.strings
                .iter()
                .map(move |text| format!("{} {text}", hit.rule))
        })
        .collect();
    if !strings.is_empty() {
        facts.push(Fact::new(Group::Detail, "yara.strings", strings.len()).items(strings));
    }
    Ok(facts)
}

/// `0x1f4:$id: text`
fn string_match(line: &str) -> Option<String> {
    let (offset, rest) = line.strip_prefix("0x")?.split_once(':')?;
    if offset.is_empty() || !offset.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let (id, text) = rest.split_once(':')?;
    id.starts_with('$')
        .then(|| clean_text(&format!("{id} @0x{offset} = {}", text.trim_start())))
}

/// `rule [tags] [meta] path`
fn rule_line(line: &str) -> Option<Hit> {
    let (rule, rest) = line.split_once(' ')?;
    if rule.is_empty() || !rule.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
        return None;
    }
    let (tags, rest) = take_bracketed(rest.trim_start())?;
    let (meta, _path) = take_bracketed(rest).unwrap_or(("", rest));
    Some(Hit {
        rule: rule.to_string(),
        tags: tags
            .split(',')
            .map(str::trim)
            .filter(|tag| !tag.is_empty())
            .map(str::to_string)
            .collect(),
        description: description(meta),
        strings: Vec::new(),
    })
}

/// The text inside a leading `[...]` (a `]` inside quotes does not end it)
/// and what follows it.
fn take_bracketed(text: &str) -> Option<(&str, &str)> {
    let inner = text.strip_prefix('[')?;
    let (mut quoted, mut escaped) = (false, false);
    for (index, c) in inner.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match c {
            '\\' if quoted => escaped = true,
            '"' => quoted = !quoted,
            ']' if !quoted => return Some((&inner[..index], inner[index + 1..].trim_start())),
            _ => {}
        }
    }
    None
}

fn description(meta: &str) -> Option<String> {
    const KEY: &str = "description=\"";
    // The key of its own: first in the meta text, or after a comma and maybe
    // spaces. `short_description="x"` is another key, and text inside a value
    // is no key at all.
    let start = meta.match_indices(KEY).map(|(at, _)| at).find(|&at| {
        let before = meta[..at].trim_end_matches(' ');
        before.is_empty() || before.ends_with(',')
    })? + KEY.len();
    let (mut out, mut escaped) = (String::new(), false);
    for c in meta[start..].chars() {
        match (escaped, c) {
            (true, c) => {
                out.push(c);
                escaped = false;
            }
            (false, '\\') => escaped = true,
            (false, '"') => break,
            (false, c) => out.push(c),
        }
    }
    Some(clean_text(&out)).filter(|text| !text.is_empty())
}

#[cfg(test)]
mod tests {
    use super::super::testing::{ctx, fact, killed, logs};
    use super::*;

    fn with_rules() -> ParseContext {
        ParseContext {
            input_path: r"C:\Users\test\Documents\Qutra Labs\case\files\sample.exe.sample".into(),
            input_name: "sample.exe.sample".into(),
            rules_path: Some(r"C:\Users\test\Documents\Qutra Labs\case\files\rules.yar".into()),
            rules_name: Some("rules.yar".into()),
        }
    }

    const PATH: &str = r"C:\Users\test\Documents\Qutra Labs\case\files\sample.exe.sample";

    #[test]
    fn matching_rules_and_their_strings_are_listed() {
        let out = format!(
            "SuspiciousPacker [packer,upx] [author=\"Qutra test\",description=\"UPX-packed sample\"] {PATH}\n\
             0x1f4:$upx0: UPX0\n0x210:$upx1: UPX1\nOtherRule [] [] {PATH}\n"
        );
        let facts = parse(&logs(&out, "", 0), &with_rules()).unwrap();
        assert_eq!(fact(&facts, "yara.rulesFile").unwrap().value, "rules.yar");
        assert_eq!(fact(&facts, "yara.count").unwrap().value, 2);
        let matches = fact(&facts, "yara.matches").unwrap();
        assert_eq!(
            (matches.group, matches.hint, matches.value.clone()),
            (Group::Interesting, Some("yaraMatch"), 2.into())
        );
        assert_eq!(
            matches.items,
            [
                "SuspiciousPacker · packer, upx · UPX-packed sample",
                "OtherRule"
            ]
        );
        let strings = fact(&facts, "yara.strings").unwrap();
        assert_eq!(strings.group, Group::Detail);
        assert_eq!(
            strings.items,
            [
                "SuspiciousPacker $upx0 @0x1f4 = UPX0",
                "SuspiciousPacker $upx1 @0x210 = UPX1"
            ]
        );
        assert!(!format!("{facts:?}").contains("Users"));
    }

    #[test]
    fn no_match_is_a_result_and_a_failed_scan_is_an_error() {
        let none = parse(&logs("", "", 0), &with_rules()).unwrap();
        assert_eq!(fact(&none, "yara.count").unwrap().value, 0);
        assert!(fact(&none, "yara.matches").is_none());

        let failed = parse(
            &logs(
                "",
                "C:\\Users\\test\\Documents\\Qutra Labs\\case\\files\\rules.yar(3): error: syntax error\n",
                1,
            ),
            &with_rules(),
        )
        .unwrap();
        assert!(fact(&failed, "yara.count").is_none());
        assert_eq!(
            fact(&failed, "yara.error").unwrap().value,
            "rules.yar(3): error: syntax error"
        );
        // Lines that are neither a match nor a string are ignored.
        assert_eq!(
            parse(&logs("running 1 test\n", "", 0), &ctx())
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn cut_or_odd_output_is_read_as_far_as_it_goes_and_never_panics() {
        // YARA escapes quotes and backslashes in a meta text; a `]` inside the
        // quotes is part of the text.
        let packer = format!(r#"Packer [upx] [description="say \"hi\" ] there"] {PATH}"#);
        let out = format!("{packer}\n0x1f4:$a: UPX0\nOther [] [] {PATH}\n");
        let facts = parse(&logs(&out, "", 0), &with_rules()).unwrap();
        assert_eq!(
            fact(&facts, "yara.matches").unwrap().items,
            ["Packer · upx · say \"hi\" ] there", "Other"]
        );
        assert_eq!(
            fact(&facts, "yara.strings").unwrap().items,
            ["Packer $a @0x1f4 = UPX0"]
        );

        // A scan stopped part-way has no exit code and counts nothing; one
        // that finished but whose output was cut counts what is whole.
        for end in (0..=out.len()).filter(|end| out.is_char_boundary(*end)) {
            let stopped = parse(&killed(&out[..end], ""), &with_rules()).unwrap();
            assert!(fact(&stopped, "yara.count").is_none(), "cut at byte {end}");
            let cut = parse(&logs(&out[..end], "", 0), &with_rules()).unwrap();
            let count = fact(&cut, "yara.count").unwrap().value.as_u64().unwrap();
            assert!(count <= 2, "cut at byte {end}");
            assert!(!format!("{cut:?}").contains("Users"), "cut at byte {end}");
        }

        // Lines that only look like YARA's: no match, no panic.
        for odd in [
            "0x:$a: x",
            "0xZZ:$a: x",
            "0x1f4:a: x",
            "0x1f4:$a",
            "0x1f4:$a: a string before any rule",
            "Rule [tags",
            "Règle [é] [description=\"é\"] x",
            "[] [] x",
            " ",
            "\u{0}",
        ] {
            let facts = parse(&logs(odd, "", 0), &with_rules()).unwrap();
            assert_eq!(fact(&facts, "yara.count").unwrap().value, 0, "{odd:?}");
        }

        // Of a failed scan's complaint only the first line is kept.
        let failed = parse(&logs("", "\n  \nerror: a\nerror: b\n", 2), &with_rules()).unwrap();
        assert_eq!(fact(&failed, "yara.error").unwrap().value, "error: a");
    }

    /// What YARA 4.5.5 writes to standard error on Windows, as captured: in
    /// the C runtime's default locale, one byte for each letter from U+0080
    /// to U+00FF (ü is 0xFC, ö is 0xF6) and `?` for any letter above it (Ş,
    /// ş). Standard output is UTF-8; this stream is not.
    fn c_locale(text: &str) -> Vec<u8> {
        text.chars()
            .map(|c| match c {
                c if c.is_ascii() => c as u8,
                'ü' => 0xFC,
                'ö' => 0xF6,
                _ => b'?',
            })
            .collect()
    }

    fn turkish_folders() -> ParseContext {
        let folder = r"C:\Users\kullanici\Masaüstü\Şüpheli\vaka\files";
        ParseContext {
            input_path: format!(r"{folder}\yok ö.sample"),
            input_name: "yok ö.sample".into(),
            rules_path: Some(format!(r"{folder}\kurallar şifre.yar")),
            rules_name: Some("kurallar şifre.yar".into()),
        }
    }

    #[test]
    fn an_error_in_the_c_locale_never_carries_the_users_folders() {
        let ctx = turkish_folders();
        let input = ctx.input_path.clone();
        let rules = ctx.rules_path.clone().unwrap();
        for (complaint, want) in [
            (
                format!("error scanning {input}: could not open file"),
                "error scanning [path]: could not open file",
            ),
            (
                format!("error: could not open file: {rules}"),
                "error: could not open file: [path]",
            ),
            (
                format!(r#"error: rule "x" in {rules}(12): syntax error"#),
                r#"error: rule "x" in [path](12): syntax error"#,
            ),
        ] {
            // The bytes YARA writes, read as the supervisor reads them.
            let bytes = c_locale(&format!("{complaint}\r\n"));
            let stderr = String::from_utf8_lossy(&bytes).into_owned();
            assert!(
                stderr.contains('\u{fffd}') && !stderr.contains(&input) && !stderr.contains(&rules),
                "the letters of the folders must be lost, as they are: {stderr:?}"
            );

            let facts = parse(&logs("", &stderr, 1), &ctx).unwrap();
            let error = fact(&facts, "yara.error").unwrap();
            assert_eq!(error.value, want);
            let text = error.value.as_str().unwrap();
            assert!(!text.contains("Users") && !text.contains('\\'), "{text}");
            assert!(
                text.contains("(12)") || !complaint.contains("(12)"),
                "{text}"
            );
            // The name of the rules file still comes from the context.
            assert_eq!(
                fact(&facts, "yara.rulesFile").unwrap().value,
                "kurallar şifre.yar"
            );
        }
    }

    #[test]
    fn a_complaint_that_names_no_path_is_kept_as_it_is() {
        let facts = parse(
            &logs("", "error: syntax error, unexpected identifier\r\n", 1),
            &with_rules(),
        )
        .unwrap();
        assert_eq!(
            fact(&facts, "yara.error").unwrap().value,
            "error: syntax error, unexpected identifier"
        );
    }

    #[test]
    fn a_description_is_found_only_as_a_key_of_its_own() {
        // `short_description` is another key.
        assert_eq!(
            description(r#"short_description="x",description="y""#),
            Some("y".into())
        );
        assert_eq!(description(r#"short_description="x""#), None);
        assert_eq!(description(r#"author="a",long_description="x""#), None);
        // At the start, or after a comma with spaces.
        assert_eq!(description(r#"description="a""#), Some("a".into()));
        assert_eq!(
            description(r#"author="z",   description="b""#),
            Some("b".into())
        );
        // Text inside another key's value is no key.
        assert_eq!(description(r#"author="description=",x=1"#), None);

        let line = format!(r#"Rule [] [short_description="x",description="y"] {PATH}"#);
        let facts = parse(&logs(&line, "", 0), &with_rules()).unwrap();
        assert_eq!(fact(&facts, "yara.matches").unwrap().items, ["Rule · y"]);
    }

    #[test]
    fn the_examples_of_a_match_keep_the_shared_cap() {
        let mut out = String::new();
        for n in 0..25 {
            out.push_str(&format!(
                "Rule{n} [] [] {PATH}\n0x{:x}:$a: text {n}\n",
                16 + n
            ));
        }
        let facts = parse(&logs(&out, "", 0), &with_rules()).unwrap();
        for key in ["yara.matches", "yara.strings"] {
            let found = fact(&facts, key).unwrap();
            assert_eq!(found.value, 25, "{key}");
            assert_eq!(found.items.len(), crate::analysis::MAX_ITEMS, "{key}");
        }
        assert_eq!(
            fact(&facts, "yara.strings").unwrap().items[0],
            "Rule0 $a @0x10 = text 0"
        );
    }
}
