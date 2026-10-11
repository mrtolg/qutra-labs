//! ExifTool's `-json -G1 -n` output as facts. Only tags a reader
//! looks for become facts, and the file's own free text (comments, titles)
//! stays out of them: it stays in the raw output, which is hashed. What
//! names a person (position, owner, serial number) is marked by its key, and
//! the page keeps those values out of titles and summaries.

use serde_json::{Map, Value};

use super::{scrubbed, stderr_error, ParseContext};
use crate::{
    analysis::{clean_text, Fact, Group},
    tool_supervisor::RunLogs,
};

/// ExifTool before 12.24 let a crafted file run code (CVE-2021-22204).
const FIRST_SAFE_VERSION: f64 = 12.24;
const MAX_VALUES: usize = 5;

type Tags = Map<String, Value>;

pub fn parse(logs: &RunLogs, ctx: &ParseContext) -> Result<Vec<Fact>, String> {
    let stdout = logs.stdout.trim();
    if stdout.is_empty() {
        // Nothing on stdout: ExifTool said why on the other stream.
        return stderr_error("exiftool.error", &logs.stderr, ctx, |_| false)
            .map(|error| vec![error]);
    }
    let parsed: Value =
        serde_json::from_str(stdout).map_err(|_| "output_unreadable".to_string())?;
    let tags = parsed
        .as_array()
        .and_then(|files| files.first())
        .and_then(Value::as_object)
        .ok_or_else(|| "output_unreadable".to_string())?;

    let mut facts = Vec::new();
    if let Some(kind) = first(tags, &["FileType"]) {
        let kind = match first(tags, &["MIMEType"]) {
            Some(mime) => format!("{kind} · {mime}"),
            None => kind,
        };
        facts.push(Fact::new(Group::Summary, "exiftool.type", kind));
    }
    if let Some(camera) = camera(tags) {
        facts.push(Fact::new(Group::Summary, "exiftool.camera", camera));
    }
    for (key, names) in [
        (
            "exiftool.taken",
            &["DateTimeOriginal", "CreateDate", "DateCreated"][..],
        ),
        ("exiftool.modified", &["ModifyDate"][..]),
    ] {
        // The first candidate that is a date: a zero or junk DateTimeOriginal
        // does not hide a CreateDate that is one.
        if let Some(when) = values(tags, names).iter().find_map(|raw| date(raw)) {
            facts.push(Fact::new(Group::Summary, key, when));
        }
    }
    let software = first(
        tags,
        &["Software", "CreatorTool", "Producer", "Application"],
    )
    .or_else(|| tags.get("PDF:Creator").and_then(show));
    if let Some(software) = software {
        facts.push(Fact::new(Group::Summary, "exiftool.software", software));
    }
    let count = tags
        .keys()
        .filter(|key| *key != "SourceFile" && !key.starts_with("ExifTool:"))
        .count();
    facts.push(Fact::new(Group::Summary, "exiftool.tags", count));
    if let Some(error) = first(tags, &["Error"]) {
        facts.push(Fact::new(
            Group::Summary,
            "exiftool.error",
            scrubbed(&error, ctx),
        ));
    }

    if let Some(position) = position(tags) {
        facts.push(Fact::new(Group::Interesting, "exiftool.gps", position).hint("gpsLocation"));
    }
    let owner = owners(tags);
    if !owner.is_empty() {
        facts.push(
            Fact::new(Group::Interesting, "exiftool.owner", owner.join(" · ")).hint("identifying"),
        );
    }
    let serial = values(
        tags,
        &[
            "SerialNumber",
            "BodySerialNumber",
            "InternalSerialNumber",
            "CameraSerialNumber",
            "LensSerialNumber",
        ],
    );
    if !serial.is_empty() {
        facts.push(
            Fact::new(Group::Interesting, "exiftool.serial", serial.join(", ")).hint("identifying"),
        );
    }
    if let Some(warning) = first(tags, &["Warning"]) {
        facts.push(
            Fact::new(
                Group::Interesting,
                "exiftool.warning",
                scrubbed(&warning, ctx),
            )
            .hint("toolWarning"),
        );
    }
    let version = tags.get("ExifTool:ExifToolVersion").and_then(|value| {
        value
            .as_f64()
            .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
    });
    // ExifTool numbers its versions with two decimals, and JSON drops a
    // trailing zero (13.10 arrives as 13.1).
    if let Some(old) = version.filter(|version| *version < FIRST_SAFE_VERSION) {
        facts.push(
            Fact::new(Group::Interesting, "exiftool.outdated", format!("{old:.2}")).hint("oldTool"),
        );
    }

    let mut groups: Vec<String> = tags
        .keys()
        .filter_map(|key| key.split_once(':').map(|(group, _)| group.to_string()))
        .filter(|group| group != "ExifTool")
        .collect();
    groups.sort();
    groups.dedup();
    if !groups.is_empty() {
        facts.push(Fact::new(Group::Detail, "exiftool.groups", groups.len()).items(groups));
    }
    if let Some(version) = version {
        facts.push(Fact::new(
            Group::Detail,
            "exiftool.version",
            format!("{version:.2}"),
        ));
    }
    Ok(facts)
}

/// A tag's value as short text; objects and nothing give none.
fn show(value: &Value) -> Option<String> {
    let text = match value {
        Value::String(text) => clean_text(text),
        Value::Number(number) => number.to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Array(list) => {
            clean_text(&list.iter().filter_map(show).collect::<Vec<_>>().join(", "))
        }
        _ => return None,
    };
    (!text.is_empty()).then_some(text)
}

/// The values of the tags called `names`, in any group, in the order of
/// `names`, without repeats.
fn values(tags: &Tags, names: &[&str]) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for name in names {
        for (key, value) in tags {
            if key.rsplit(':').next().unwrap_or(key) == *name {
                if let Some(text) = show(value) {
                    if !found.contains(&text) {
                        found.push(text);
                    }
                }
            }
        }
    }
    found.truncate(MAX_VALUES);
    found
}

fn first(tags: &Tags, names: &[&str]) -> Option<String> {
    values(tags, names).into_iter().next()
}

fn camera(tags: &Tags) -> Option<String> {
    match (first(tags, &["Make"]), first(tags, &["Model"])) {
        (Some(make), Some(model)) if !model.to_lowercase().starts_with(&make.to_lowercase()) => {
            Some(format!("{make} {model}"))
        }
        (_, Some(model)) => Some(model),
        (make, None) => make,
    }
}

fn owners(tags: &Tags) -> Vec<String> {
    let mut found = values(
        tags,
        &[
            "Artist",
            "OwnerName",
            "CameraOwnerName",
            "Author",
            "Creator",
            "LastModifiedBy",
            "Company",
            "Copyright",
        ],
    );
    // In a PDF "Creator" names the program, not a person.
    if let Some(program) = tags.get("PDF:Creator").and_then(show) {
        found.retain(|value| *value != program);
    }
    found
}

/// "2023:05:12 14:03:11" as "2023-05-12 14:03:11". Only a date is a date: four
/// digits for the year, then digits and the marks a date and time are written
/// with. XMP dates are free strings, and a sentence in one is the file's own
/// text, which stays out of the facts. A zero date is none.
fn date(raw: &str) -> Option<String> {
    let year = raw.get(..4)?;
    if year == "0000" || !year.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if !raw
        .bytes()
        .all(|b| b.is_ascii_digit() || b" :-.,+/TZ".contains(&b))
    {
        return None;
    }
    // Only ASCII is left, so every cut below is on a character boundary.
    let bytes = raw.as_bytes();
    if bytes.len() >= 10 && bytes[4] == b':' && bytes[7] == b':' {
        return Some(format!(
            "{}-{}-{}{}",
            &raw[..4],
            &raw[5..7],
            &raw[8..10],
            &raw[10..]
        ));
    }
    Some(raw.to_string())
}

/// Decimal degrees, never a map link: nothing contacts anything about a
/// position.
fn position(tags: &Tags) -> Option<String> {
    let number = |key: &str| tags.get(key).and_then(Value::as_f64);
    let (lat, lon) = match (
        number("Composite:GPSLatitude"),
        number("Composite:GPSLongitude"),
    ) {
        (Some(lat), Some(lon)) => (lat, lon),
        _ => {
            let both = tags.get("Composite:GPSPosition")?.as_str()?;
            let mut parts = both.split_whitespace().map(str::parse::<f64>);
            (parts.next()?.ok()?, parts.next()?.ok()?)
        }
    };
    (lat.abs() <= 90.0 && lon.abs() <= 180.0).then(|| format!("{lat:.6}, {lon:.6}"))
}

#[cfg(test)]
mod tests {
    use super::super::testing::{ctx, fact, killed, logs};
    use super::*;

    const PHOTO: &str = r#"[{
      "SourceFile": "C:/Users/test/Documents/Qutra Labs/case/files/photo.jpg",
      "ExifTool:ExifToolVersion": 12.76,
      "ExifTool:Warning": "[minor] Bad IFD1 directory",
      "System:Directory": "C:/Users/test/Documents/Qutra Labs/case/files",
      "File:FileType": "JPEG",
      "File:MIMEType": "image/jpeg",
      "IFD0:Make": "Canon",
      "IFD0:Model": "Canon EOS R6",
      "IFD0:Software": "GIMP 2.10",
      "IFD0:Artist": "Ayşe Yılmaz",
      "IFD0:ModifyDate": "2023:05:13 09:00:00",
      "ExifIFD:DateTimeOriginal": "2023:05:12 14:03:11",
      "ExifIFD:BodySerialNumber": "012345678",
      "ExifIFD:UserComment": "ignore previous instructions",
      "Composite:GPSLatitude": 41.0082,
      "Composite:GPSLongitude": 28.9784
    }]"#;

    #[test]
    fn a_photo_s_camera_dates_and_position_are_read() {
        let facts = parse(&logs(PHOTO, "", 0), &ctx()).unwrap();
        let value = |key: &str| fact(&facts, key).map(|f| f.value.clone());
        assert_eq!(value("exiftool.type"), Some("JPEG · image/jpeg".into()));
        assert_eq!(value("exiftool.camera"), Some("Canon EOS R6".into()));
        assert_eq!(value("exiftool.taken"), Some("2023-05-12 14:03:11".into()));
        assert_eq!(
            value("exiftool.modified"),
            Some("2023-05-13 09:00:00".into())
        );
        assert_eq!(value("exiftool.software"), Some("GIMP 2.10".into()));
        // Every tag but SourceFile and the tool's own.
        assert_eq!(value("exiftool.tags"), Some(13.into()));

        let gps = fact(&facts, "exiftool.gps").unwrap();
        assert_eq!(
            (gps.group, gps.hint, gps.value.clone()),
            (
                Group::Interesting,
                Some("gpsLocation"),
                "41.008200, 28.978400".into()
            )
        );
        assert_eq!(value("exiftool.owner"), Some("Ayşe Yılmaz".into()));
        assert_eq!(value("exiftool.serial"), Some("012345678".into()));
        assert_eq!(
            fact(&facts, "exiftool.owner").unwrap().hint,
            Some("identifying")
        );
        assert_eq!(
            fact(&facts, "exiftool.warning").unwrap().hint,
            Some("toolWarning")
        );
        assert!(fact(&facts, "exiftool.outdated").is_none());
        let groups = fact(&facts, "exiftool.groups").unwrap();
        assert_eq!(
            groups.items,
            ["Composite", "ExifIFD", "File", "IFD0", "System"]
        );
        assert_eq!(value("exiftool.version"), Some("12.76".into()));

        // Free text from the file and the user's folders stay out.
        let all = format!("{facts:?}");
        assert!(!all.contains("ignore previous") && !all.contains("Users/test"));
    }

    #[test]
    fn an_old_exiftool_is_flagged_and_an_error_names_the_file_not_its_folder() {
        let old = r#"[{"SourceFile":"x","ExifTool:ExifToolVersion":12.1,"File:FileType":"JPEG"}]"#;
        let facts = parse(&logs(old, "", 0), &ctx()).unwrap();
        let outdated = fact(&facts, "exiftool.outdated").unwrap();
        assert_eq!(
            (outdated.group, outdated.hint),
            (Group::Interesting, Some("oldTool"))
        );
        // JSON drops a trailing zero: this is ExifTool 12.10.
        assert_eq!(outdated.value, "12.10");

        let facts = parse(
            &logs(
                "",
                "Error: File not found - C:/Users/test/Documents/Qutra Labs/case/files/photo.jpg\n",
                1,
            ),
            &ctx(),
        )
        .unwrap();
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].value, "Error: File not found - photo.jpg");
    }

    #[test]
    fn output_that_is_not_json_is_unreadable() {
        assert_eq!(
            parse(&logs("{ nope", "", 0), &ctx()).err(),
            Some("output_unreadable".into())
        );
        assert_eq!(
            parse(&logs("", "", 0), &ctx()).err(),
            Some("output_unreadable".into())
        );
        assert_eq!(
            parse(&logs("[]", "", 0), &ctx()).err(),
            Some("output_unreadable".into())
        );
    }

    #[test]
    fn cut_output_is_unreadable_and_tags_of_odd_shape_are_harmless() {
        // A run stopped at the output limit leaves JSON that stops short: no
        // facts from half a document.
        for end in (0..PHOTO.len()).filter(|end| PHOTO.is_char_boundary(*end)) {
            assert_eq!(
                parse(&killed(&PHOTO[..end], ""), &ctx()).err(),
                Some("output_unreadable".into()),
                "cut at byte {end}"
            );
        }
        assert!(parse(&killed(PHOTO, ""), &ctx()).is_ok());

        // Valid JSON that is not a list of files.
        for not_a_file in ["[1]", "[null]", "[[]]", "{}", "\"x\"", "42"] {
            assert_eq!(
                parse(&logs(not_a_file, "", 0), &ctx()).err(),
                Some("output_unreadable".into()),
                "{not_a_file}"
            );
        }

        // Tags whose values have other shapes: a date with a letter that is
        // not ASCII, a zero date, a version that is no number, a position out
        // of range, a list, a list inside a list, an object, a null.
        let odd = r#"[{
          "File:FileType": {"a": 1},
          "IFD0:Make": [],
          "IFD0:Model": null,
          "XMP-dc:Creator": ["Ayşe", "Mehmet"],
          "IFD0:Software": ["Photoshop", ["nested", 7], true],
          "ExifIFD:DateTimeOriginal": "2023:05:1é",
          "IFD0:ModifyDate": "0000:00:00 00:00:00",
          "ExifTool:ExifToolVersion": "abc",
          "Composite:GPSLatitude": 123.0,
          "Composite:GPSLongitude": 28.9
        }]"#;
        let facts = parse(&logs(odd, "", 0), &ctx()).unwrap();
        let value = |key: &str| fact(&facts, key).map(|f| f.value.clone());
        assert_eq!(
            value("exiftool.software"),
            Some("Photoshop, nested, 7, true".into())
        );
        assert_eq!(value("exiftool.owner"), Some("Ayşe, Mehmet".into()));
        assert_eq!(value("exiftool.tags"), Some(9.into()));
        for absent in [
            "exiftool.type",
            "exiftool.camera",
            "exiftool.taken",
            "exiftool.modified",
            "exiftool.gps",
            "exiftool.version",
            "exiftool.outdated",
        ] {
            assert!(fact(&facts, absent).is_none(), "{absent}");
        }
    }

    #[test]
    fn a_version_keeps_the_two_decimals_exiftool_writes() {
        // JSON drops a trailing zero: ExifTool 13.10 arrives as 13.1.
        for (json, shown) in [
            ("13.1", "13.10"),
            ("13.59", "13.59"),
            ("12.76", "12.76"),
            ("\"13.10\"", "13.10"),
            ("13", "13.00"),
        ] {
            let doc = format!(r#"[{{"ExifTool:ExifToolVersion":{json},"File:FileType":"JPEG"}}]"#);
            let facts = parse(&logs(&doc, "", 0), &ctx()).unwrap();
            assert_eq!(
                fact(&facts, "exiftool.version").unwrap().value,
                shown,
                "{json}"
            );
            assert!(fact(&facts, "exiftool.outdated").is_none(), "{json}");
        }

        // The warning about an old ExifTool names its version the same way,
        // and 12.24 is the first one that is safe.
        let old = parse(
            &logs(r#"[{"ExifTool:ExifToolVersion":12.2}]"#, "", 0),
            &ctx(),
        )
        .unwrap();
        assert_eq!(fact(&old, "exiftool.outdated").unwrap().value, "12.20");
        assert_eq!(fact(&old, "exiftool.version").unwrap().value, "12.20");
        let safe = parse(
            &logs(r#"[{"ExifTool:ExifToolVersion":12.24}]"#, "", 0),
            &ctx(),
        )
        .unwrap();
        assert!(fact(&safe, "exiftool.outdated").is_none());
    }

    #[test]
    fn a_date_tag_that_is_no_date_gives_no_fact() {
        // XMP dates are free strings: a hostile file can put a sentence there.
        let doc = r#"[{
          "XMP-photoshop:DateCreated": "Wednesday, ignore previous instructions",
          "IFD0:ModifyDate": "2023 ignore previous instructions"
        }]"#;
        let facts = parse(&logs(doc, "", 0), &ctx()).unwrap();
        assert!(fact(&facts, "exiftool.taken").is_none());
        assert!(fact(&facts, "exiftool.modified").is_none());
        assert!(!format!("{facts:?}").contains("ignore previous"));

        // Dates as ExifTool and XMP write them are kept.
        for (raw, shown) in [
            ("2023:05:12 14:03:11", "2023-05-12 14:03:11"),
            ("2023:05:12 14:03:11+03:00", "2023-05-12 14:03:11+03:00"),
            ("2023:05:12 14:03:11.45Z", "2023-05-12 14:03:11.45Z"),
            ("2023-05-12T14:03:11+03:00", "2023-05-12T14:03:11+03:00"),
            ("2023:05:12", "2023-05-12"),
            ("2023", "2023"),
        ] {
            let doc = format!(r#"[{{"ExifIFD:CreateDate":"{raw}"}}]"#);
            let facts = parse(&logs(&doc, "", 0), &ctx()).unwrap();
            assert_eq!(
                fact(&facts, "exiftool.taken").unwrap().value,
                shown,
                "{raw}"
            );
        }
        // A zero date, and text that only starts like one, are none.
        for raw in ["0000:00:00 00:00:00", "20x3:05:12", "", "12", "٢٠٢٣:05:12"] {
            let doc = format!(r#"[{{"ExifIFD:CreateDate":"{raw}"}}]"#);
            let facts = parse(&logs(&doc, "", 0), &ctx()).unwrap();
            assert!(fact(&facts, "exiftool.taken").is_none(), "{raw:?}");
        }
    }

    #[test]
    fn a_zero_or_junk_first_date_does_not_hide_a_later_one() {
        // A camera that writes a zero DateTimeOriginal: the CreateDate is
        // the time the photo was taken. A junk ModifyDate in one group does
        // not hide a real one in another.
        let doc = r#"[{
          "ExifIFD:DateTimeOriginal": "0000:00:00 00:00:00",
          "ExifIFD:CreateDate": "2023:05:12 14:03:11",
          "IFD0:ModifyDate": "    :  :     :  :  ",
          "XMP-xmp:ModifyDate": "2023:05:13 09:00:00"
        }]"#;
        let facts = parse(&logs(doc, "", 0), &ctx()).unwrap();
        let value = |key: &str| fact(&facts, key).map(|f| f.value.clone());
        assert_eq!(value("exiftool.taken"), Some("2023-05-12 14:03:11".into()));
        assert_eq!(
            value("exiftool.modified"),
            Some("2023-05-13 09:00:00".into())
        );

        // A real first candidate still wins over a later one.
        let doc = r#"[{
          "ExifIFD:DateTimeOriginal": "2023:05:10 08:00:00",
          "ExifIFD:CreateDate": "2023:05:12 14:03:11"
        }]"#;
        let facts = parse(&logs(doc, "", 0), &ctx()).unwrap();
        assert_eq!(
            fact(&facts, "exiftool.taken").unwrap().value,
            "2023-05-10 08:00:00"
        );
    }
}
