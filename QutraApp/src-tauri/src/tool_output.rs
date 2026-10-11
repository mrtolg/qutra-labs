//! A tool's output as UTF-8, whatever the tool wrote. Most tools write UTF-8,
//! but on Windows some do not: Sysinternals Sigcheck writes UTF-16LE when its
//! output is a pipe, ExifTool writes its messages in the ANSI code page (a
//! Turkish `İ` in a folder name is one byte, 0xDD), and YARA writes its errors
//! in the C runtime's default locale (one byte for a letter from U+0080 to
//! U+00FF, `?` for any letter above it). Read as UTF-8 the first comes out
//! with a NUL after every letter and the others with replacement characters,
//! so the run's log and its parsers saw broken text.
//!
//! The decoder sits in front of the redactor: it decides once per stream,
//! from the first bytes, whether the stream is UTF-16LE, and otherwise reads
//! UTF-8 with the ANSI code page as the fallback for a chunk that is not
//! UTF-8. A character cut between two reads is held until the next one.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Utf8,
    Utf16Le,
}

#[derive(Default)]
pub struct OutputDecoder {
    mode: Option<Mode>,
    pending: Vec<u8>,
}

impl OutputDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// The UTF-8 bytes for what has arrived so far; `finished` flushes a
    /// character still cut off at the end.
    pub fn push(&mut self, bytes: &[u8], finished: bool) -> Vec<u8> {
        self.pending.extend_from_slice(bytes);
        if self.mode.is_none() {
            // Four bytes decide it: a BOM, or letters with a NUL after each.
            if self.pending.len() < 4 && !finished {
                return Vec::new();
            }
            self.mode = Some(detect(&self.pending));
            if self.mode == Some(Mode::Utf16Le) && self.pending.starts_with(&[0xFF, 0xFE]) {
                self.pending.drain(..2);
            }
        }
        match self.mode {
            Some(Mode::Utf16Le) => self.utf16(finished),
            _ => self.utf8(finished),
        }
    }

    fn utf16(&mut self, finished: bool) -> Vec<u8> {
        let mut usable = self.pending.len() & !1;
        // A high surrogate at the end waits for its pair.
        if !finished && usable >= 2 {
            let last = u16::from_le_bytes([self.pending[usable - 2], self.pending[usable - 1]]);
            if (0xD800..0xDC00).contains(&last) {
                usable -= 2;
            }
        }
        if finished {
            usable = self.pending.len();
        }
        let taken: Vec<u8> = self.pending.drain(..usable).collect();
        let units: Vec<u16> = taken
            .chunks(2)
            .map(|pair| u16::from_le_bytes([pair[0], *pair.get(1).unwrap_or(&0)]))
            .collect();
        char::decode_utf16(units)
            .map(|unit| unit.unwrap_or(char::REPLACEMENT_CHARACTER))
            .collect::<String>()
            .into_bytes()
    }

    fn utf8(&mut self, finished: bool) -> Vec<u8> {
        match std::str::from_utf8(&self.pending) {
            Ok(_) => std::mem::take(&mut self.pending),
            Err(error) if error.error_len().is_none() && !finished => {
                // Only a character cut at the end: keep its first bytes.
                let rest = self.pending.split_off(error.valid_up_to());
                std::mem::replace(&mut self.pending, rest)
            }
            Err(_) => ansi_to_utf8(&std::mem::take(&mut self.pending)).into_bytes(),
        }
    }
}

/// UTF-16LE when the stream starts with its BOM, or when its first two
/// characters are ASCII letters followed by NULs (the way Sigcheck starts).
fn detect(head: &[u8]) -> Mode {
    if head.starts_with(&[0xFF, 0xFE]) {
        return Mode::Utf16Le;
    }
    let ascii_then_nul =
        |pair: &[u8]| pair.len() == 2 && pair[0] != 0 && pair[0] < 0x80 && pair[1] == 0;
    if head.len() >= 4 && ascii_then_nul(&head[0..2]) && ascii_then_nul(&head[2..4]) {
        Mode::Utf16Le
    } else {
        Mode::Utf8
    }
}

/// Bytes in the ANSI code page (Windows-1254 on a Turkish system) as text.
#[cfg(windows)]
fn ansi_to_utf8(bytes: &[u8]) -> String {
    use windows::Win32::Globalization::{
        MultiByteToWideChar, CP_ACP, MULTI_BYTE_TO_WIDE_CHAR_FLAGS,
    };
    if bytes.is_empty() {
        return String::new();
    }
    // A byte becomes at most one UTF-16 unit in a single-byte code page and
    // never more than one per byte in a double-byte one.
    let mut wide = vec![0_u16; bytes.len()];
    let written = unsafe {
        MultiByteToWideChar(
            CP_ACP,
            MULTI_BYTE_TO_WIDE_CHAR_FLAGS(0),
            bytes,
            Some(&mut wide),
        )
    };
    if written <= 0 {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    String::from_utf16_lossy(&wide[..written as usize])
}

#[cfg(not(windows))]
fn ansi_to_utf8(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all(chunks: &[&[u8]]) -> String {
        let mut decoder = OutputDecoder::new();
        let mut out = Vec::new();
        for chunk in chunks {
            out.extend(decoder.push(chunk, false));
        }
        out.extend(decoder.push(&[], true));
        String::from_utf8(out).expect("the decoder always gives UTF-8")
    }

    fn utf16(text: &str, bom: bool) -> Vec<u8> {
        let mut bytes = if bom { vec![0xFF, 0xFE] } else { Vec::new() };
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn utf8_passes_through_and_a_cut_character_waits() {
        let text = "şehir İzmir\n".as_bytes();
        // Cut inside the two bytes of "ş".
        assert_eq!(all(&[&text[..1], &text[1..]]), "şehir İzmir\n");
        assert_eq!(all(&[b"plain ascii"]), "plain ascii");
    }

    #[test]
    fn sigcheck_utf16_with_and_without_bom() {
        let sigcheck = "Path,Verified\r\nC:\\İnceleme\\where.exe,Signed\r\n";
        assert_eq!(all(&[&utf16(sigcheck, true)]), sigcheck);
        let bytes = utf16(sigcheck, false);
        // Cut after an odd number of bytes: half a unit waits.
        assert_eq!(all(&[&bytes[..7], &bytes[7..]]), sigcheck);
    }

    #[test]
    fn a_surrogate_pair_cut_between_reads_stays_whole() {
        let bytes = utf16("ab😀c", true);
        // BOM (2) + "ab" (4) + high surrogate (2) | low surrogate ...
        assert_eq!(all(&[&bytes[..8], &bytes[8..]]), "ab😀c");
    }

    #[test]
    fn a_short_stream_is_decided_when_it_ends() {
        assert_eq!(all(&[b"ok"]), "ok");
        assert_eq!(all(&[]), "");
    }

    #[cfg(windows)]
    #[test]
    fn ansi_bytes_are_read_in_the_code_page_not_as_replacement_characters() {
        // "Invalid filename encoding for C:/X" followed by one byte that is
        // not UTF-8: whatever the code page, the text stays readable and the
        // byte becomes one character, never U+FFFD.
        let out = all(&[b"Invalid filename encoding for C:/X\xDD/a.png\n"]);
        assert!(out.starts_with("Invalid filename encoding for C:/X"));
        assert!(out.ends_with("/a.png\n"));
        assert!(!out.contains('\u{FFFD}'));
    }
}
