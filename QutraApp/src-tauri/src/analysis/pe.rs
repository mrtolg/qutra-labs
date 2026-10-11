//! A Windows program's header (§6.2 "PE header"): what it runs on, when it
//! says it was built, its sections with their entropy, what it imports,
//! whether a signature is attached and what is appended after it. Every
//! read is bounds-checked; the program never runs. An attached signature
//! is not verified: building its chain could fetch URLs the sample names.

use std::{
    fs::File,
    io::{self, Read},
    time::{SystemTime, UNIX_EPOCH},
};

use super::{clean_text, entropy, scan::Budget, Fact, Group, Report, Subject};

/// How much of a program is read into memory.
const CAP: u64 = 64 * 1024 * 1024;
const MAX_SECTIONS: usize = 96;
const MAX_DLLS: usize = 256;
const MAX_FUNCTIONS: usize = 4096;
const MAX_NAME: usize = 256;
const LISTED_PER_DLL: usize = 64;
const HIGH_ENTROPY: f64 = 7.2;
const MIN_PACKED_BYTES: u32 = 512;
const MIN_OVERLAY: u64 = 512;

/// Imports that write into other programs or download files: rare in
/// ordinary programs.
const RISKY: &[&str] = &[
    "VirtualAllocEx",
    "WriteProcessMemory",
    "CreateRemoteThread",
    "CreateRemoteThreadEx",
    "NtUnmapViewOfSection",
    "ZwUnmapViewOfSection",
    "NtWriteVirtualMemory",
    "RtlCreateUserThread",
    "URLDownloadToFileA",
    "URLDownloadToFileW",
];
/// Imports common in ordinary programs too (Go's runtime takes
/// SetThreadContext, games watch keys): counted only beside a risky one.
const RISKY_BESIDE: &[&str] = &[
    "SetThreadContext",
    "QueueUserAPC",
    "WinExec",
    "SetWindowsHookExA",
    "SetWindowsHookExW",
    "GetAsyncKeyState",
];
/// A debug directory entry of this type marks a reproducible build, whose
/// timestamp is a hash, not a date.
const DEBUG_TYPE_REPRO: u32 = 16;

const EXECUTE: u32 = 0x2000_0000;
const READ: u32 = 0x4000_0000;
const WRITE: u32 = 0x8000_0000;
const IMAGE_DLL: u16 = 0x2000;

struct Bytes<'a>(&'a [u8]);

impl Bytes<'_> {
    fn u16(&self, at: usize) -> Option<u16> {
        let b = self.0.get(at..at.checked_add(2)?)?;
        Some(u16::from_le_bytes([b[0], b[1]]))
    }

    fn u32(&self, at: usize) -> Option<u32> {
        let b = self.0.get(at..at.checked_add(4)?)?;
        Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn u64(&self, at: usize) -> Option<u64> {
        let b = self.0.get(at..at.checked_add(8)?)?;
        Some(u64::from_le_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ]))
    }

    /// A NUL-terminated name of at most `MAX_NAME` bytes.
    fn name(&self, at: usize) -> Option<String> {
        let rest = self.0.get(at..)?;
        let end = rest.iter().take(MAX_NAME).position(|&b| b == 0)?;
        Some(clean_text(&String::from_utf8_lossy(&rest[..end])))
    }
}

struct Section {
    name: String,
    virtual_address: u32,
    virtual_size: u32,
    raw_size: u32,
    raw_pointer: u32,
    characteristics: u32,
    entropy: f64,
}

impl Section {
    fn flags(&self) -> String {
        let flag = |bit: u32, letter: char| {
            if self.characteristics & bit != 0 {
                letter
            } else {
                '-'
            }
        };
        [flag(READ, 'R'), flag(WRITE, 'W'), flag(EXECUTE, 'X')]
            .iter()
            .collect()
    }

    fn holds(&self, rva: u32) -> bool {
        rva.checked_sub(self.virtual_address)
            .is_some_and(|delta| delta < self.virtual_size.max(self.raw_size))
    }
}

struct Pe {
    machine: u16,
    timestamp: u32,
    characteristics: u16,
    plus: bool,
    entry: u32,
    subsystem: u16,
    size_of_headers: u32,
    imports: u32,
    certificate: (u32, u32),
    /// The debug directory, where a reproducible build says it is one.
    debug: (u32, u32),
    /// The COFF symbol table unstripped MinGW and GNU programs keep at the
    /// end: its file offset and number of 18-byte symbols.
    symbols: (u32, u32),
    sections: Vec<Section>,
    /// The time budget ran out before every section was measured.
    cut_short: bool,
}

impl Pe {
    /// Where an RVA's bytes are in the file, when they are in it.
    fn offset(&self, rva: u32) -> Option<usize> {
        if rva < self.size_of_headers {
            return Some(rva as usize);
        }
        self.sections.iter().find_map(|section| {
            let delta = rva.checked_sub(section.virtual_address)?;
            (delta < section.raw_size).then(|| section.raw_pointer as usize + delta as usize)
        })
    }
}

fn parse(data: &[u8], budget: &Budget) -> Result<Pe, &'static str> {
    let b = Bytes(data);
    if data.get(..2) != Some(b"MZ".as_slice()) {
        return Err("notPe");
    }
    let pe = b.u32(0x3C).ok_or("truncated")? as usize;
    if data.get(pe..pe.checked_add(4).ok_or("notPe")?) != Some(b"PE\0\0".as_slice()) {
        return Err("notPe");
    }
    let coff = pe + 4;
    let machine = b.u16(coff).ok_or("truncated")?;
    let count = b.u16(coff + 2).ok_or("truncated")? as usize;
    let timestamp = b.u32(coff + 4).ok_or("truncated")?;
    let symbols = (
        b.u32(coff + 8).ok_or("truncated")?,
        b.u32(coff + 12).ok_or("truncated")?,
    );
    let optional_size = b.u16(coff + 16).ok_or("truncated")? as usize;
    let characteristics = b.u16(coff + 18).ok_or("truncated")?;
    let opt = coff + 20;
    let plus = match b.u16(opt).ok_or("truncated")? {
        0x10b => false,
        0x20b => true,
        _ => return Err("badOptional"),
    };
    let entry = b.u32(opt + 16).ok_or("badOptional")?;
    let size_of_headers = b.u32(opt + 60).ok_or("badOptional")?;
    let subsystem = b.u16(opt + 68).ok_or("badOptional")?;
    let (count_at, dirs_at) = if plus {
        (opt + 108, opt + 112)
    } else {
        (opt + 92, opt + 96)
    };
    let directories = b.u32(count_at).unwrap_or(0) as usize;
    let directory = |index: usize| -> (u32, u32) {
        if index >= directories {
            return (0, 0);
        }
        let at = dirs_at + index * 8;
        (b.u32(at).unwrap_or(0), b.u32(at + 4).unwrap_or(0))
    };
    let table = opt + optional_size;
    let mut sections = Vec::new();
    let mut cut_short = false;
    for index in 0..count.min(MAX_SECTIONS) {
        // Sections may overlap the whole file; measuring each is the slow part.
        if budget.expired() {
            cut_short = true;
            break;
        }
        let at = table + index * 40;
        let Some(header) = data.get(at..at + 40) else {
            break;
        };
        let h = Bytes(header);
        let end = header[..8].iter().position(|&c| c == 0).unwrap_or(8);
        let raw_size = h.u32(16).unwrap_or(0);
        let raw_pointer = h.u32(20).unwrap_or(0);
        let raw = data
            .get(raw_pointer as usize..)
            .map(|rest| &rest[..rest.len().min(raw_size as usize)])
            .unwrap_or(&[]);
        sections.push(Section {
            name: clean_text(&String::from_utf8_lossy(&header[..end])),
            virtual_size: h.u32(8).unwrap_or(0),
            virtual_address: h.u32(12).unwrap_or(0),
            raw_size,
            raw_pointer,
            characteristics: h.u32(36).unwrap_or(0),
            entropy: entropy::of(raw),
        });
    }
    Ok(Pe {
        machine,
        timestamp,
        characteristics,
        plus,
        entry,
        subsystem,
        size_of_headers,
        imports: directory(1).0,
        certificate: directory(4),
        debug: directory(6),
        symbols,
        sections,
        cut_short,
    })
}

/// Whether the debug directory marks a reproducible build.
fn reproducible(pe: &Pe, data: &[u8]) -> bool {
    let b = Bytes(data);
    let Some(start) = pe.offset(pe.debug.0).filter(|_| pe.debug.0 != 0) else {
        return false;
    };
    (0..(pe.debug.1 as usize / 28).min(32))
        .any(|n| b.u32(start + n * 28 + 12) == Some(DEBUG_TYPE_REPRO))
}

/// Where the program's own bytes end: its last section, or the COFF symbol
/// and string tables after it.
fn image_end(pe: &Pe, data: &[u8]) -> u64 {
    let sections = pe
        .sections
        .iter()
        .map(|s| u64::from(s.raw_pointer) + u64::from(s.raw_size))
        .max()
        .unwrap_or(0);
    let (pointer, count) = pe.symbols;
    if pointer == 0 || count == 0 {
        return sections;
    }
    let strings_at = u64::from(pointer) + 18 * u64::from(count);
    let strings = usize::try_from(strings_at)
        .ok()
        .and_then(|at| Bytes(data).u32(at))
        .map_or(0, u64::from);
    sections.max(strings_at + strings)
}

/// Each DLL the program imports, with the functions it takes from it.
fn imports(pe: &Pe, data: &[u8]) -> Vec<(String, Vec<String>)> {
    let b = Bytes(data);
    let mut dlls = Vec::new();
    if pe.imports == 0 {
        return dlls;
    }
    let Some(mut at) = pe.offset(pe.imports) else {
        return dlls;
    };
    let width = if pe.plus { 8 } else { 4 };
    let by_ordinal = if pe.plus { 1u64 << 63 } else { 1u64 << 31 };
    let mut functions = 0usize;
    for _ in 0..MAX_DLLS {
        let (Some(original), Some(name), Some(first)) = (b.u32(at), b.u32(at + 12), b.u32(at + 16))
        else {
            break;
        };
        if original == 0 && name == 0 && first == 0 {
            break;
        }
        let dll = pe
            .offset(name)
            .and_then(|offset| b.name(offset))
            .unwrap_or_else(|| "?".into());
        let mut names = Vec::new();
        let thunks = if original != 0 { original } else { first };
        if let Some(mut thunk) = pe.offset(thunks) {
            while functions < MAX_FUNCTIONS {
                let value = if pe.plus {
                    b.u64(thunk)
                } else {
                    b.u32(thunk).map(u64::from)
                };
                let Some(value) = value.filter(|&value| value != 0) else {
                    break;
                };
                names.push(if value & by_ordinal != 0 {
                    format!("#{}", value & 0xFFFF)
                } else {
                    pe.offset(value as u32)
                        .and_then(|offset| b.name(offset + 2))
                        .unwrap_or_else(|| "?".into())
                });
                functions += 1;
                thunk += width;
            }
        }
        dlls.push((dll, names));
        at += 20;
    }
    dlls
}

fn machine(code: u16) -> String {
    match code {
        0x14c => "x86".into(),
        0x8664 => "x64".into(),
        0xaa64 => "ARM64".into(),
        0x1c0 | 0x1c4 => "ARM".into(),
        0x200 => "IA-64".into(),
        other => format!("0x{other:04X}"),
    }
}

fn subsystem(code: u16) -> String {
    match code {
        1 => "native".into(),
        2 => "Windows GUI".into(),
        3 => "Windows console".into(),
        9 => "Windows CE".into(),
        10 => "EFI application".into(),
        11 => "EFI boot driver".into(),
        12 => "EFI runtime driver".into(),
        16 => "Windows boot application".into(),
        other => other.to_string(),
    }
}

/// Seconds since 1970 as a UTC date, without a date library.
fn utc(seconds: u32) -> String {
    let days = i64::from(seconds) / 86_400;
    let rest = i64::from(seconds) % 86_400;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02} UTC",
        rest / 3600,
        rest % 3600 / 60
    )
}

pub fn analyze(subject: &Subject, budget: &Budget) -> io::Result<Report> {
    let size = std::fs::metadata(subject.path)?.len();
    let mut data = Vec::new();
    File::open(subject.path)?.take(CAP).read_to_end(&mut data)?;
    let pe = match parse(&data, budget) {
        Ok(pe) => pe,
        Err(reason) => {
            return Ok(Report {
                facts: vec![Fact::new(Group::Summary, "pe.invalid", reason)],
                body: format!("Not a readable PE header: {reason}\n"),
                limited: size > CAP,
            })
        }
    };
    let limited = size > CAP || pe.cut_short;
    // A reproducible build's timestamp is a hash; Go writes none at all.
    let dated = pe.timestamp != 0 && !reproducible(&pe, &data);
    let dlls = imports(&pe, &data);
    let functions: usize = dlls.iter().map(|(_, names)| names.len()).sum();
    let signed = pe.certificate.0 != 0 && pe.certificate.1 != 0;
    let section_lines: Vec<String> = pe
        .sections
        .iter()
        .map(|s| {
            format!(
                "{} · {} B · {:.2} · {}",
                s.name,
                s.raw_size,
                s.entropy,
                s.flags()
            )
        })
        .collect();

    let mut facts = vec![Fact::new(Group::Summary, "pe.machine", machine(pe.machine))];
    if dated {
        facts.push(Fact::new(Group::Summary, "pe.compiled", utc(pe.timestamp)));
    }
    facts.extend([
        Fact::new(Group::Summary, "pe.subsystem", subsystem(pe.subsystem)),
        Fact::new(Group::Summary, "pe.sections", pe.sections.len()).items(section_lines.clone()),
        Fact::new(Group::Summary, "pe.imports", functions),
        Fact::new(
            Group::Summary,
            "pe.signed",
            if signed { "yes" } else { "no" },
        ),
        Fact::new(Group::Detail, "pe.dlls", dlls.len())
            .items(dlls.iter().map(|(dll, _)| dll.clone()).collect()),
        Fact::new(Group::Detail, "pe.entry", format!("0x{:08X}", pe.entry)),
    ]);

    let packed: Vec<String> = pe
        .sections
        .iter()
        .filter(|s| s.entropy >= HIGH_ENTROPY && s.raw_size >= MIN_PACKED_BYTES)
        .map(|s| format!("{} · {:.2}", s.name, s.entropy))
        .collect();
    if !packed.is_empty() {
        facts.push(
            Fact::new(Group::Interesting, "pe.packedSections", packed.len())
                .hint("packed")
                .items(packed),
        );
    }
    let writable_code: Vec<String> = pe
        .sections
        .iter()
        .filter(|s| s.characteristics & (WRITE | EXECUTE) == WRITE | EXECUTE)
        .map(|s| s.name.clone())
        .collect();
    if !writable_code.is_empty() {
        facts.push(
            Fact::new(Group::Interesting, "pe.writableCode", writable_code.len())
                .hint("writableCode")
                .items(writable_code),
        );
    }
    if pe.entry != 0 {
        let home = pe.sections.iter().find(|s| s.holds(pe.entry));
        if !home.is_some_and(|s| s.characteristics & EXECUTE != 0) {
            let place = home.map_or_else(|| "—".to_string(), |s| s.name.clone());
            facts
                .push(Fact::new(Group::Interesting, "pe.entryOutside", place).hint("entryOutside"));
        }
    }
    let imported: Vec<&String> = dlls.iter().flat_map(|(_, names)| names.iter()).collect();
    if imported.iter().any(|name| RISKY.contains(&name.as_str())) {
        let risky: Vec<String> = imported
            .iter()
            .filter(|name| RISKY.contains(&name.as_str()) || RISKY_BESIDE.contains(&name.as_str()))
            .map(|name| (*name).clone())
            .collect();
        facts.push(
            Fact::new(Group::Interesting, "pe.riskyImports", risky.len())
                .hint("riskyImports")
                .items(risky),
        );
    }
    // No import directory at all, not one this reader could not follow.
    if pe.imports == 0 && pe.characteristics & IMAGE_DLL == 0 {
        facts.push(Fact::new(Group::Interesting, "pe.noImports", 0).hint("noImports"));
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if dated && u64::from(pe.timestamp) > now + 86_400 {
        facts.push(Fact::new(Group::Interesting, "pe.oddDate", utc(pe.timestamp)).hint("oddDate"));
    }
    let end = image_end(&pe, &data);
    let certificate = if signed && u64::from(pe.certificate.0) >= end {
        u64::from(pe.certificate.1)
    } else {
        0
    };
    let overlay = size.saturating_sub(end).saturating_sub(certificate);
    if !pe.sections.is_empty() && overlay >= MIN_OVERLAY {
        facts.push(Fact::new(Group::Interesting, "pe.overlay", overlay).hint("overlay"));
    }

    let built = match (pe.timestamp, dated) {
        (0, _) => "no date".to_string(),
        (_, false) => "a reproducible build (the timestamp is a hash)".to_string(),
        (seconds, true) => utc(seconds),
    };
    let mut body = format!(
        "Machine: {}\nBuilt: {}\nSubsystem: {}\nFormat: {}\nEntry point: 0x{:08X}\n",
        machine(pe.machine),
        built,
        subsystem(pe.subsystem),
        if pe.plus { "PE32+" } else { "PE32" },
        pe.entry
    );
    body.push_str(&format!(
        "\nSections ({}): name · raw size · entropy · flags\n",
        pe.sections.len()
    ));
    for line in &section_lines {
        body.push_str(&format!("  {line}\n"));
    }
    body.push_str(&format!(
        "\nImports: {} functions from {} libraries\n",
        functions,
        dlls.len()
    ));
    for (dll, names) in &dlls {
        body.push_str(&format!("  {dll} ({})\n", names.len()));
        for name in names.iter().take(LISTED_PER_DLL) {
            body.push_str(&format!("    {name}\n"));
        }
    }
    body.push_str(&match signed {
        true => format!(
            "\nSignature: attached at 0x{:08X}, {} bytes (not verified)\n",
            pe.certificate.0, pe.certificate.1
        ),
        false => "\nSignature: none attached\n".into(),
    });
    body.push_str(&format!("Appended after the program: {overlay} bytes\n"));
    Ok(Report {
        facts,
        body,
        limited,
    })
}

#[cfg(test)]
mod tests {
    use super::super::testing::{budget, sample, subject};
    use super::*;

    fn put16(f: &mut [u8], at: usize, v: u16) {
        f[at..at + 2].copy_from_slice(&v.to_le_bytes());
    }

    fn put32(f: &mut [u8], at: usize, v: u32) {
        f[at..at + 4].copy_from_slice(&v.to_le_bytes());
    }

    fn put64(f: &mut [u8], at: usize, v: u64) {
        f[at..at + 8].copy_from_slice(&v.to_le_bytes());
    }

    #[allow(clippy::too_many_arguments)]
    fn section(
        f: &mut [u8],
        at: usize,
        name: &[u8],
        vsize: u32,
        va: u32,
        rsize: u32,
        rptr: u32,
        flags: u32,
    ) {
        f[at..at + name.len()].copy_from_slice(name);
        put32(f, at + 8, vsize);
        put32(f, at + 12, va);
        put32(f, at + 16, rsize);
        put32(f, at + 20, rptr);
        put32(f, at + 36, flags);
    }

    struct Shape {
        entry: u32,
        timestamp: u32,
        with_imports: bool,
        text_bytes: Vec<u8>,
    }

    /// A small PE32+: .text (RWX) at 0x200, .rdata at 0x400 holding the
    /// imports of KERNEL32.dll, a signature, then 600 appended bytes.
    fn program(shape: Shape) -> Vec<u8> {
        let mut f = vec![0u8; 0x600];
        f[..2].copy_from_slice(b"MZ");
        put32(&mut f, 0x3C, 0x80);
        f[0x80..0x84].copy_from_slice(b"PE\0\0");
        let coff = 0x84;
        put16(&mut f, coff, 0x8664);
        put16(&mut f, coff + 2, 2);
        put32(&mut f, coff + 4, shape.timestamp);
        put16(&mut f, coff + 16, 240);
        put16(&mut f, coff + 18, 0x0022);
        let opt = coff + 20;
        put16(&mut f, opt, 0x20b);
        put32(&mut f, opt + 16, shape.entry);
        put32(&mut f, opt + 60, 0x200);
        put16(&mut f, opt + 68, 3);
        put32(&mut f, opt + 108, 16);
        let dirs = opt + 112;
        if shape.with_imports {
            put32(&mut f, dirs + 8, 0x2000);
            put32(&mut f, dirs + 12, 40);
        }
        put32(&mut f, dirs + 32, 0x600);
        put32(&mut f, dirs + 36, 0x20);
        let table = opt + 240;
        section(
            &mut f,
            table,
            b".text",
            0x100,
            0x1000,
            0x200,
            0x200,
            0xE000_0020,
        );
        section(
            &mut f,
            table + 40,
            b".rdata",
            0x200,
            0x2000,
            0x200,
            0x400,
            0x4000_0040,
        );
        f[0x200..0x200 + shape.text_bytes.len()].copy_from_slice(&shape.text_bytes);
        // .rdata: one import descriptor, its thunks, the names, the DLL.
        put32(&mut f, 0x400, 0x2040);
        put32(&mut f, 0x400 + 12, 0x2100);
        put32(&mut f, 0x400 + 16, 0x2040);
        let names: [&[u8]; 4] = [
            b"VirtualAllocEx",
            b"WriteProcessMemory",
            b"CreateRemoteThread",
            b"ExitProcess",
        ];
        for (n, name) in names.iter().enumerate() {
            let rva = 0x2080 + 0x20 * n as u64;
            put64(&mut f, 0x440 + 8 * n, rva);
            let at = 0x400 + (rva as usize - 0x2000) + 2;
            f[at..at + name.len()].copy_from_slice(name);
        }
        f[0x500..0x50C].copy_from_slice(b"KERNEL32.dll");
        f.extend([0x11u8; 0x20]);
        f.extend([0x5Au8; 600]);
        f
    }

    fn plain() -> Shape {
        Shape {
            entry: 0x1010,
            timestamp: 1_620_000_000,
            with_imports: true,
            text_bytes: Vec::new(),
        }
    }

    fn fact<'a>(report: &'a Report, key: &str) -> Option<&'a Fact> {
        report.facts.iter().find(|fact| fact.key == key)
    }

    #[test]
    fn a_program_s_header_sections_and_imports_are_read() {
        let file = sample(&program(plain()));
        let report = analyze(&subject(&file, "pe", Some("exe")), &budget()).unwrap();
        assert_eq!(fact(&report, "pe.machine").unwrap().value, "x64");
        assert_eq!(
            fact(&report, "pe.compiled").unwrap().value,
            "2021-05-03 00:00 UTC"
        );
        assert_eq!(
            fact(&report, "pe.subsystem").unwrap().value,
            "Windows console"
        );
        assert_eq!(fact(&report, "pe.sections").unwrap().value, 2);
        assert_eq!(fact(&report, "pe.imports").unwrap().value, 4);
        assert_eq!(fact(&report, "pe.signed").unwrap().value, "yes");
        assert_eq!(
            fact(&report, "pe.dlls").unwrap().items,
            vec!["KERNEL32.dll"]
        );
        assert!(report.body.contains("    ExitProcess\n"));
        assert!(report.body.contains(".text · 512 B · 0.00 · RWX"));
        // Clean so far: nothing about the entry point, the date or packing.
        for key in [
            "pe.entryOutside",
            "pe.oddDate",
            "pe.packedSections",
            "pe.noImports",
        ] {
            assert!(fact(&report, key).is_none(), "{key}");
        }
    }

    #[test]
    fn what_a_dropper_looks_like_stands_out() {
        let file = sample(&program(plain()));
        let report = analyze(&subject(&file, "pe", None), &budget()).unwrap();
        let risky = fact(&report, "pe.riskyImports").unwrap();
        assert_eq!(
            risky.items,
            vec!["VirtualAllocEx", "WriteProcessMemory", "CreateRemoteThread"]
        );
        assert_eq!(
            fact(&report, "pe.writableCode").unwrap().items,
            vec![".text"]
        );
        assert_eq!(fact(&report, "pe.overlay").unwrap().value, 600);

        let packed = Shape {
            entry: 0x2010,
            // Year 2097.
            timestamp: 0xF000_0000,
            with_imports: false,
            text_bytes: (0..2).flat_map(|_| 0u8..=255).collect(),
        };
        let file = sample(&program(packed));
        let report = analyze(&subject(&file, "pe", None), &budget()).unwrap();
        assert_eq!(fact(&report, "pe.entryOutside").unwrap().value, ".rdata");
        assert_eq!(
            fact(&report, "pe.packedSections").unwrap().items,
            vec![".text · 8.00"]
        );
        assert!(fact(&report, "pe.noImports").is_some());
        assert!(fact(&report, "pe.oddDate").is_some());
    }

    /// Put `name` in place of the `n`th imported function's name.
    fn rename(f: &mut [u8], n: usize, name: &[u8]) {
        let at = 0x482 + 0x20 * n;
        f[at..at + 0x1E].fill(0);
        f[at..at + name.len()].copy_from_slice(name);
    }

    #[test]
    fn ordinary_programs_are_not_called_suspicious() {
        // Go's runtime imports SetThreadContext; games watch keys. Alone,
        // these are not risky.
        let mut weak = program(plain());
        for (n, name) in [
            &b"SetThreadContext"[..],
            b"GetAsyncKeyState",
            b"ExitProcess",
            b"Sleep",
        ]
        .iter()
        .enumerate()
        {
            rename(&mut weak, n, name);
        }
        let file = sample(&weak);
        let report = analyze(&subject(&file, "pe", None), &budget()).unwrap();
        assert!(fact(&report, "pe.riskyImports").is_none());

        // Beside a risky import they are listed with it.
        let mut strong = program(plain());
        rename(&mut strong, 1, b"SetThreadContext");
        let file = sample(&strong);
        let report = analyze(&subject(&file, "pe", None), &budget()).unwrap();
        assert_eq!(
            fact(&report, "pe.riskyImports").unwrap().items,
            vec!["VirtualAllocEx", "SetThreadContext", "CreateRemoteThread"]
        );

        // Go writes no date; a reproducible build writes a hash.
        let mut undated = program(Shape {
            timestamp: 0,
            ..plain()
        });
        let file = sample(&undated);
        let report = analyze(&subject(&file, "pe", None), &budget()).unwrap();
        assert!(fact(&report, "pe.oddDate").is_none());
        assert!(fact(&report, "pe.compiled").is_none());
        put32(&mut undated, 0x88, 0xF000_0000);
        // Debug directory (entry 6) at RVA 0x2180: one REPRO (type 16) entry.
        put32(&mut undated, 0x108 + 48, 0x2180);
        put32(&mut undated, 0x108 + 52, 28);
        put32(&mut undated, 0x580 + 12, 16);
        let file = sample(&undated);
        let report = analyze(&subject(&file, "pe", None), &budget()).unwrap();
        assert!(fact(&report, "pe.oddDate").is_none());
        assert!(report.body.contains("reproducible build"));

        // An unstripped MinGW program keeps its symbols at the end: they
        // are its own, not appended data.
        let mut symbols = program(plain());
        put32(&mut symbols, 0x8C, 0x620);
        put32(&mut symbols, 0x90, 10);
        let strings_at = 0x620 + 18 * 10;
        let size = (symbols.len() - strings_at) as u32;
        put32(&mut symbols, strings_at, size);
        let file = sample(&symbols);
        let report = analyze(&subject(&file, "pe", None), &budget()).unwrap();
        assert!(fact(&report, "pe.overlay").is_none());
    }

    #[test]
    fn a_broken_header_is_said_not_panicked_over() {
        let invalid = |bytes: &[u8]| {
            let file = sample(bytes);
            let report = analyze(&subject(&file, "pe", None), &budget()).unwrap();
            fact(&report, "pe.invalid").map(|f| f.value.clone())
        };
        assert_eq!(invalid(b"MZ"), Some("truncated".into()));
        let mut far = vec![0u8; 0x100];
        far[..2].copy_from_slice(b"MZ");
        put32(&mut far, 0x3C, 0xFFFF_FFF0);
        assert_eq!(invalid(&far), Some("notPe".into()));
        // 65,535 sections claimed, none there: read what is there, no more.
        let mut many = program(plain());
        put16(&mut many, 0x86, 0xFFFF);
        assert_eq!(invalid(&many), None);
        assert_eq!(utc(0), "1970-01-01 00:00 UTC");
    }
}
