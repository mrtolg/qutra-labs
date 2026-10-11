//! GGUF headers (format: github.com/ggml-org/ggml/blob/master/docs/gguf.md).
//!
//! The engine reads a model's header before it loads the model: which
//! architecture it is, whether it carries a chat template, and whether
//! vision or audio layers share its file. It also writes a text-only copy of
//! an Ollama model whose vision layers share the file, because upstream
//! llama.cpp refuses such a file ("wrong number of tensors"). A model file is
//! input like any other, so every count and length here is bounded.

use std::fs::File;
use std::io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use super::compat;

const MAGIC: &[u8; 4] = b"GGUF";
const MAX_KV: u64 = 4096;
const MAX_TENSORS: u64 = 65_536;
const MAX_STRING: u64 = 16 << 20;
const MAX_ARRAY: u64 = 16 << 20;
const MAX_DIMS: u32 = 8;
/// The most bytes the header (keys, values and tensor table) may take. Real
/// headers, tokenizer included, are a few megabytes.
const MAX_HEADER: u64 = 256 << 20;
const DEFAULT_ALIGNMENT: u64 = 32;
/// The largest alignment read. A text-only copy pads its header to the
/// alignment, so a huge value would make it write that much padding.
const MAX_ALIGNMENT: u64 = 64 << 10;

const T_BOOL: u32 = 7;
pub(super) const T_STRING: u32 = 8;
pub(super) const T_ARRAY: u32 = 9;
const T_I32: u32 = 5;

/// Token types, as llama.cpp reads them.
const TOKEN_USER_DEFINED: i32 = 4;
const TOKEN_BYTE: i32 = 6;

/// First name segments of the layers that are not the language model:
/// the vision tower, its projector, and an audio tower.
const TOWER_PREFIXES: [&str; 3] = ["v", "mm", "a"];

pub(super) fn scalar_size(ty: u32) -> Option<u64> {
    match ty {
        0 | 1 | 7 => Some(1),
        2 | 3 => Some(2),
        4..=6 => Some(4),
        10..=12 => Some(8),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GgufError {
    NotGguf,
    UnsupportedVersion,
    Truncated,
    TooLarge,
    BadType,
    /// The tensors do not sit in the file the way their header says.
    Layout,
    Cancelled,
    Io,
}

impl GgufError {
    pub fn code(self) -> &'static str {
        match self {
            Self::NotGguf => "not_gguf",
            Self::UnsupportedVersion => "gguf_version",
            Self::Truncated => "gguf_truncated",
            Self::TooLarge => "gguf_too_large",
            Self::BadType => "gguf_bad_type",
            Self::Layout => "gguf_layout",
            Self::Cancelled => "cancelled",
            Self::Io => "io",
        }
    }
}

impl From<io::Error> for GgufError {
    fn from(err: io::Error) -> Self {
        if err.kind() == io::ErrorKind::UnexpectedEof {
            GgufError::Truncated
        } else {
            GgufError::Io
        }
    }
}

/// One key and its value, kept as the bytes the file holds, so a copy
/// writes back exactly what it read.
#[derive(Debug, Clone, PartialEq)]
pub struct Kv {
    pub key: String,
    pub ty: u32,
    pub raw: Vec<u8>,
}

impl Kv {
    pub fn string(key: &str, value: &str) -> Self {
        let mut raw = (value.len() as u64).to_le_bytes().to_vec();
        raw.extend_from_slice(value.as_bytes());
        Self {
            key: key.into(),
            ty: T_STRING,
            raw,
        }
    }

    pub fn bool(key: &str, value: bool) -> Self {
        Self {
            key: key.into(),
            ty: T_BOOL,
            raw: vec![u8::from(value)],
        }
    }

    fn as_str(&self) -> Option<&str> {
        if self.ty != T_STRING || self.raw.len() < 8 {
            return None;
        }
        std::str::from_utf8(&self.raw[8..]).ok()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TensorInfo {
    pub name: String,
    pub dims: Vec<u64>,
    pub ty: u32,
    pub offset: u64,
}

impl TensorInfo {
    fn is_tower(&self) -> bool {
        let first = self.name.split('.').next().unwrap_or_default();
        TOWER_PREFIXES.contains(&first)
    }
}

#[derive(Debug, Clone)]
pub struct Header {
    pub kvs: Vec<Kv>,
    pub tensors: Vec<TensorInfo>,
    pub alignment: u64,
    pub data_start: u64,
    pub file_len: u64,
}

/// What the engine needs to know about a model file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Summary {
    pub architecture: Option<String>,
    pub has_template: bool,
    /// The chat template names tools, so tool calls can be offered.
    pub template_tools: bool,
    /// Vision or audio layers in the same file as the language model.
    pub tower_tensors: usize,
    pub text_tensors: usize,
    /// Bytes a text-only copy writes.
    pub text_bytes: u64,
    /// The compatibility rules that would change this file (`compat`).
    /// Empty once a copy has been written with them applied.
    pub compat: Vec<&'static str>,
}

struct Counted<R> {
    inner: R,
    pos: u64,
    /// Bytes the header may take in all.
    limit: u64,
}

impl<R: Read> Counted<R> {
    /// Refuses, before anything is allocated for it, a read that would take
    /// the header past its limit.
    fn room_for(&self, n: u64) -> Result<(), GgufError> {
        if self.pos.saturating_add(n) > self.limit {
            return Err(GgufError::TooLarge);
        }
        Ok(())
    }

    fn exact(&mut self, buf: &mut [u8]) -> Result<(), GgufError> {
        self.room_for(buf.len() as u64)?;
        self.inner.read_exact(buf)?;
        self.pos += buf.len() as u64;
        Ok(())
    }

    fn u32(&mut self) -> Result<u32, GgufError> {
        let mut b = [0; 4];
        self.exact(&mut b)?;
        Ok(u32::from_le_bytes(b))
    }

    fn u64(&mut self) -> Result<u64, GgufError> {
        let mut b = [0; 8];
        self.exact(&mut b)?;
        Ok(u64::from_le_bytes(b))
    }

    fn string(&mut self) -> Result<String, GgufError> {
        let n = self.u64()?;
        if n > MAX_STRING {
            return Err(GgufError::TooLarge);
        }
        self.room_for(n)?;
        let mut b = vec![0; n as usize];
        self.exact(&mut b)?;
        String::from_utf8(b).map_err(|_| GgufError::BadType)
    }

    /// Copy `n` bytes into `out`.
    fn copy(&mut self, n: u64, out: &mut Vec<u8>) -> Result<(), GgufError> {
        self.room_for(n)?;
        let start = out.len();
        let got = (&mut self.inner).take(n).read_to_end(out)?;
        if got as u64 != n {
            out.truncate(start);
            return Err(GgufError::Truncated);
        }
        self.pos += n;
        Ok(())
    }

    fn value(&mut self, ty: u32, out: &mut Vec<u8>, depth: u8) -> Result<(), GgufError> {
        match ty {
            T_STRING => {
                let n = self.u64()?;
                if n > MAX_STRING {
                    return Err(GgufError::TooLarge);
                }
                out.extend_from_slice(&n.to_le_bytes());
                self.copy(n, out)
            }
            T_ARRAY => {
                if depth > 1 {
                    return Err(GgufError::BadType);
                }
                let et = self.u32()?;
                let n = self.u64()?;
                if n > MAX_ARRAY {
                    return Err(GgufError::TooLarge);
                }
                out.extend_from_slice(&et.to_le_bytes());
                out.extend_from_slice(&n.to_le_bytes());
                match scalar_size(et) {
                    Some(size) => self.copy(n * size, out),
                    None if et == T_STRING || et == T_ARRAY => {
                        for _ in 0..n {
                            self.value(et, out, depth + 1)?;
                        }
                        Ok(())
                    }
                    None => Err(GgufError::BadType),
                }
            }
            other => match scalar_size(other) {
                Some(size) => self.copy(size, out),
                None => Err(GgufError::BadType),
            },
        }
    }
}

/// Read a whole header: every key and every tensor's place.
pub fn read_header(path: &Path) -> Result<Header, GgufError> {
    read_header_within(path, MAX_HEADER)
}

fn read_header_within(path: &Path, max_header: u64) -> Result<Header, GgufError> {
    let file = File::open(path)?;
    let file_len = file.metadata()?.len();
    let mut r = Counted {
        inner: BufReader::with_capacity(1 << 20, file),
        pos: 0,
        limit: max_header,
    };
    let mut magic = [0; 4];
    r.exact(&mut magic).map_err(|_| GgufError::NotGguf)?;
    if &magic != MAGIC {
        return Err(GgufError::NotGguf);
    }
    let version = r.u32()?;
    if !(2..=3).contains(&version) {
        return Err(GgufError::UnsupportedVersion);
    }
    let n_tensors = r.u64()?;
    let n_kv = r.u64()?;
    if n_tensors > MAX_TENSORS || n_kv > MAX_KV {
        return Err(GgufError::TooLarge);
    }
    let mut kvs = Vec::with_capacity(n_kv as usize);
    for _ in 0..n_kv {
        let key = r.string()?;
        let ty = r.u32()?;
        let mut raw = Vec::new();
        r.value(ty, &mut raw, 0)?;
        kvs.push(Kv { key, ty, raw });
    }
    let mut tensors = Vec::with_capacity(n_tensors as usize);
    for _ in 0..n_tensors {
        let name = r.string()?;
        let n_dims = r.u32()?;
        if n_dims > MAX_DIMS {
            return Err(GgufError::TooLarge);
        }
        let mut dims = Vec::with_capacity(n_dims as usize);
        for _ in 0..n_dims {
            dims.push(r.u64()?);
        }
        let ty = r.u32()?;
        let offset = r.u64()?;
        tensors.push(TensorInfo {
            name,
            dims,
            ty,
            offset,
        });
    }
    let alignment = kvs
        .iter()
        .find(|kv| kv.key == "general.alignment" && kv.ty == 4 && kv.raw.len() == 4)
        .map(|kv| {
            u64::from(u32::from_le_bytes([
                kv.raw[0], kv.raw[1], kv.raw[2], kv.raw[3],
            ]))
        })
        .filter(|a| a.is_power_of_two())
        .unwrap_or(DEFAULT_ALIGNMENT);
    if alignment > MAX_ALIGNMENT {
        return Err(GgufError::TooLarge);
    }
    let data_start = r.pos.div_ceil(alignment) * alignment;
    if data_start > file_len {
        return Err(GgufError::Truncated);
    }
    Ok(Header {
        kvs,
        tensors,
        alignment,
        data_start,
        file_len,
    })
}

impl Header {
    pub fn get(&self, key: &str) -> Option<&Kv> {
        self.kvs.iter().find(|kv| kv.key == key)
    }

    pub fn str_value(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Kv::as_str)
    }

    /// How many bytes each tensor occupies, padding included, from where
    /// the next one starts. Fails when the offsets go backwards or run past
    /// the end of the file.
    fn spans(&self) -> Result<Vec<u64>, GgufError> {
        let data_len = self.file_len - self.data_start;
        let mut spans = Vec::with_capacity(self.tensors.len());
        for (i, tensor) in self.tensors.iter().enumerate() {
            let next = self.tensors.get(i + 1).map_or(data_len, |next| next.offset);
            if next < tensor.offset || next > data_len {
                return Err(GgufError::Layout);
            }
            spans.push(next - tensor.offset);
        }
        Ok(spans)
    }

    pub fn summary(&self) -> Result<Summary, GgufError> {
        let spans = self.spans()?;
        let template = self.str_value("tokenizer.chat_template");
        let mut text_bytes = 0;
        let mut tower = 0;
        let mut kept = 0;
        for (tensor, span) in self.tensors.iter().zip(&spans) {
            if tensor.is_tower() {
                tower += 1;
            } else if compat::dropped_by(&self.kvs, tensor).is_none() {
                kept += 1;
                text_bytes += span;
            }
        }
        Ok(Summary {
            architecture: self.str_value("general.architecture").map(str::to_string),
            has_template: template.is_some(),
            template_tools: template.is_some_and(|t| t.contains("tool")),
            tower_tensors: tower,
            text_tensors: kept,
            text_bytes,
            compat: compat::pending(&self.kvs, &self.tensors),
        })
    }
}

/// A text-only copy: the new header, and which byte ranges of the source
/// follow it, in order.
#[derive(Debug, Clone)]
pub struct TextOnlyPlan {
    pub header: Vec<u8>,
    pub copies: Vec<(u64, u64)>,
    pub total_bytes: u64,
}

fn put_string(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(&(s.len() as u64).to_le_bytes());
    out.extend_from_slice(s.as_bytes());
}

fn set_kv(kvs: &mut Vec<Kv>, kv: Kv) {
    match kvs.iter_mut().find(|existing| existing.key == kv.key) {
        Some(existing) => *existing = kv,
        None => kvs.push(kv),
    }
}

fn string_array(kv: &Kv) -> Option<Vec<String>> {
    if kv.ty != T_ARRAY || kv.raw.len() < 12 {
        return None;
    }
    let et = u32::from_le_bytes(kv.raw[0..4].try_into().ok()?);
    if et != T_STRING {
        return None;
    }
    let n = u64::from_le_bytes(kv.raw[4..12].try_into().ok()?);
    let mut at = 12usize;
    let mut out = Vec::with_capacity(n as usize);
    for _ in 0..n {
        let len = u64::from_le_bytes(kv.raw.get(at..at + 8)?.try_into().ok()?) as usize;
        at += 8;
        out.push(String::from_utf8_lossy(kv.raw.get(at..at + len)?).into_owned());
        at += len;
    }
    Some(out)
}

/// The control-looking markers Gemma 4 must print as text: its tool-call
/// parser reads them from the answer. Ollama's file types them as control
/// tokens, which llama.cpp would hide.
const GEMMA4_TEXT_MARKERS: [&str; 7] = [
    "<|tool_call>",
    "<tool_call|>",
    "<|tool_response>",
    "<tool_response|>",
    "<|\"|>",
    "<|channel>",
    "<channel|>",
];

fn is_byte_token(token: &str) -> bool {
    let b = token.as_bytes();
    b.len() == 6
        && b.starts_with(b"<0x")
        && b[5] == b'>'
        && b[3..5]
            .iter()
            .all(|c| c.is_ascii_digit() || (b'A'..=b'F').contains(c))
}

/// Ollama writes Gemma 4's tokenizer as a "llama" tokenizer; llama.cpp
/// reads it as its own "gemma4" one, with byte tokens and text markers
/// typed differently and no chat template (Ollama keeps that elsewhere).
/// These are the differences measured against ggml-org's own conversion of
/// the same model (2026-10-10); the tokens and merges are identical.
fn fix_gemma4_tokenizer(kvs: &mut Vec<Kv>, template: Option<&str>) {
    let tokens = kvs
        .iter()
        .find(|kv| kv.key == "tokenizer.ggml.tokens")
        .and_then(string_array);
    if let (Some(tokens), Some(types)) = (
        tokens,
        kvs.iter_mut()
            .find(|kv| kv.key == "tokenizer.ggml.token_type" && kv.ty == T_ARRAY),
    ) {
        let et = types
            .raw
            .get(0..4)
            .map(|b| u32::from_le_bytes(b.try_into().unwrap()));
        let n = types
            .raw
            .get(4..12)
            .map(|b| u64::from_le_bytes(b.try_into().unwrap()) as usize);
        if et == Some(T_I32) && n == Some(tokens.len()) && types.raw.len() == 12 + 4 * tokens.len()
        {
            for (i, token) in tokens.iter().enumerate() {
                let kind = if is_byte_token(token) {
                    TOKEN_BYTE
                } else if GEMMA4_TEXT_MARKERS.contains(&token.as_str()) {
                    TOKEN_USER_DEFINED
                } else {
                    continue;
                };
                let at = 12 + 4 * i;
                types.raw[at..at + 4].copy_from_slice(&kind.to_le_bytes());
            }
        }
    }
    kvs.retain(|kv| kv.key != "tokenizer.ggml.pre" && kv.key != "tokenizer.ggml.eos_token_ids");
    set_kv(kvs, Kv::string("tokenizer.ggml.model", "gemma4"));
    set_kv(kvs, Kv::bool("tokenizer.ggml.add_bos_token", true));
    set_kv(kvs, Kv::bool("tokenizer.ggml.add_space_prefix", false));
    if let Some(template) = template {
        if !kvs.iter().any(|kv| kv.key == "tokenizer.chat_template") {
            kvs.push(Kv::string("tokenizer.chat_template", template));
        }
    }
}

/// Whether this header is Ollama's way of writing a Gemma 4 model.
pub fn is_ollama_gemma4(header: &Header) -> bool {
    header.str_value("general.architecture") == Some("gemma4")
        && header.str_value("tokenizer.ggml.model") == Some("llama")
}

/// Plan a copy that keeps the language model and drops the vision and
/// audio layers, with the `compat` rules applied. `template` fills a missing Gemma 4 chat template.
pub fn plan_text_only(header: &Header, template: Option<&str>) -> Result<TextOnlyPlan, GgufError> {
    let spans = header.spans()?;
    let arch = header
        .str_value("general.architecture")
        .unwrap_or_default()
        .to_string();
    let mut kvs = header.kvs.clone();
    let vision = format!("{arch}.vision.");
    let audio = format!("{arch}.audio.");
    kvs.retain(|kv| !kv.key.starts_with(&vision) && !kv.key.starts_with(&audio));
    if is_ollama_gemma4(header) {
        fix_gemma4_tokenizer(&mut kvs, template);
    }
    compat::fix_kvs(&mut kvs);

    let kept: Vec<(&TensorInfo, u64)> = header
        .tensors
        .iter()
        .zip(spans)
        .filter(|(tensor, _)| {
            !tensor.is_tower() && compat::dropped_by(&header.kvs, tensor).is_none()
        })
        .collect();

    let mut out = Vec::new();
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&3u32.to_le_bytes());
    out.extend_from_slice(&(kept.len() as u64).to_le_bytes());
    out.extend_from_slice(&(kvs.len() as u64).to_le_bytes());
    for kv in &kvs {
        put_string(&mut out, &kv.key);
        out.extend_from_slice(&kv.ty.to_le_bytes());
        out.extend_from_slice(&kv.raw);
    }
    let mut offset = 0u64;
    let mut copies = Vec::with_capacity(kept.len());
    for (tensor, span) in &kept {
        if !offset.is_multiple_of(header.alignment) {
            return Err(GgufError::Layout);
        }
        put_string(&mut out, &tensor.name);
        out.extend_from_slice(&(tensor.dims.len() as u32).to_le_bytes());
        for dim in &tensor.dims {
            out.extend_from_slice(&dim.to_le_bytes());
        }
        out.extend_from_slice(&tensor.ty.to_le_bytes());
        out.extend_from_slice(&offset.to_le_bytes());
        copies.push((header.data_start + tensor.offset, *span));
        offset += span;
    }
    let padded = (out.len() as u64).div_ceil(header.alignment) * header.alignment;
    out.resize(padded as usize, 0);
    Ok(TextOnlyPlan {
        total_bytes: padded + offset,
        header: out,
        copies,
    })
}

/// Write a planned copy. `progress` hears bytes written so far; `cancel`
/// is read between chunks. The caller writes to a temporary name and
/// renames it when this returns `Ok`.
pub fn write_plan(
    source: &Path,
    target: &Path,
    plan: &TextOnlyPlan,
    progress: &dyn Fn(u64),
    cancel: &AtomicBool,
) -> Result<(), GgufError> {
    const CHUNK: usize = 8 << 20;
    let mut src = File::open(source)?;
    let file = File::create(target)?;
    let mut out = BufWriter::with_capacity(CHUNK, file);
    out.write_all(&plan.header)?;
    let mut written = plan.header.len() as u64;
    let mut buf = vec![0u8; CHUNK];
    for &(at, len) in &plan.copies {
        src.seek(SeekFrom::Start(at))?;
        let mut left = len;
        while left > 0 {
            if cancel.load(Ordering::Relaxed) {
                return Err(GgufError::Cancelled);
            }
            let n = left.min(CHUNK as u64) as usize;
            src.read_exact(&mut buf[..n])?;
            out.write_all(&buf[..n])?;
            left -= n as u64;
            written += n as u64;
            progress(written);
        }
    }
    let file = out.into_inner().map_err(|_| GgufError::Io)?;
    file.sync_all()?;
    Ok(())
}

#[cfg(test)]
pub mod fixture {
    //! Small GGUF files for tests, written the way the format says.
    use super::*;

    pub enum Value<'a> {
        Str(&'a str),
        U32(u32),
        Bool(bool),
        Strings(Vec<&'a str>),
        I32s(Vec<i32>),
    }

    pub fn write(path: &Path, kvs: &[(&str, Value)], tensors: &[(&str, usize)]) {
        let align = 32u64;
        let mut out = Vec::new();
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&3u32.to_le_bytes());
        out.extend_from_slice(&(tensors.len() as u64).to_le_bytes());
        out.extend_from_slice(&(kvs.len() as u64).to_le_bytes());
        for (key, value) in kvs {
            put_string(&mut out, key);
            match value {
                Value::Str(s) => {
                    out.extend_from_slice(&T_STRING.to_le_bytes());
                    put_string(&mut out, s);
                }
                Value::U32(v) => {
                    out.extend_from_slice(&4u32.to_le_bytes());
                    out.extend_from_slice(&v.to_le_bytes());
                }
                Value::Bool(v) => {
                    out.extend_from_slice(&T_BOOL.to_le_bytes());
                    out.push(u8::from(*v));
                }
                Value::Strings(items) => {
                    out.extend_from_slice(&T_ARRAY.to_le_bytes());
                    out.extend_from_slice(&T_STRING.to_le_bytes());
                    out.extend_from_slice(&(items.len() as u64).to_le_bytes());
                    for s in items {
                        put_string(&mut out, s);
                    }
                }
                Value::I32s(items) => {
                    out.extend_from_slice(&T_ARRAY.to_le_bytes());
                    out.extend_from_slice(&T_I32.to_le_bytes());
                    out.extend_from_slice(&(items.len() as u64).to_le_bytes());
                    for v in items {
                        out.extend_from_slice(&v.to_le_bytes());
                    }
                }
            }
        }
        let mut offset = 0u64;
        for (name, size) in tensors {
            put_string(&mut out, name);
            out.extend_from_slice(&1u32.to_le_bytes());
            out.extend_from_slice(&(*size as u64).to_le_bytes());
            out.extend_from_slice(&0u32.to_le_bytes());
            out.extend_from_slice(&offset.to_le_bytes());
            offset += (*size as u64).div_ceil(align) * align;
        }
        let padded = (out.len() as u64).div_ceil(align) * align;
        out.resize(padded as usize, 0);
        for (i, (_, size)) in tensors.iter().enumerate() {
            let fill = (i as u8).wrapping_add(1);
            let start = out.len();
            out.resize(start + size, fill);
            let padded = (out.len() as u64).div_ceil(align) * align;
            out.resize(padded as usize, 0);
        }
        std::fs::write(path, out).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::fixture::{write, Value};
    use super::*;

    fn ollama_gemma4(path: &Path) {
        let tokens = vec!["<pad>", "<|tool_call>", "<0x0A>", "hello", "<turn|>"];
        write(
            path,
            &[
                ("general.architecture", Value::Str("gemma4")),
                ("gemma4.block_count", Value::U32(1)),
                ("gemma4.vision.block_count", Value::U32(2)),
                ("tokenizer.ggml.model", Value::Str("llama")),
                ("tokenizer.ggml.pre", Value::Str("gemma4")),
                ("tokenizer.ggml.add_bos_token", Value::Bool(false)),
                ("tokenizer.ggml.tokens", Value::Strings(tokens)),
                (
                    "tokenizer.ggml.token_type",
                    Value::I32s(vec![3, 3, 1, 1, 3]),
                ),
            ],
            &[
                ("token_embd.weight", 40),
                ("blk.0.attn_q.weight", 70),
                ("v.blk.0.attn.weight", 33),
                ("mm.input_projection.weight", 16),
                ("output_norm.weight", 8),
            ],
        );
    }

    #[test]
    fn a_header_says_what_the_model_is_and_what_shares_its_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("m.gguf");
        ollama_gemma4(&path);
        let header = read_header(&path).unwrap();
        let summary = header.summary().unwrap();
        assert_eq!(summary.architecture.as_deref(), Some("gemma4"));
        assert_eq!(summary.tower_tensors, 2);
        assert_eq!(summary.text_tensors, 3);
        assert!(!summary.has_template);
        assert_eq!(summary.text_bytes, 64 + 96 + 32);
        assert!(is_ollama_gemma4(&header));
    }

    #[test]
    fn what_is_not_a_model_file_is_refused_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.gguf");
        std::fs::write(&path, b"MZ\x90\x00 not a model").unwrap();
        assert_eq!(read_header(&path).unwrap_err(), GgufError::NotGguf);
        std::fs::write(&path, b"GGUF\x03\x00\x00\x00\x01").unwrap();
        assert_eq!(read_header(&path).unwrap_err(), GgufError::Truncated);
        let mut huge = b"GGUF\x03\x00\x00\x00".to_vec();
        huge.extend_from_slice(&0u64.to_le_bytes());
        huge.extend_from_slice(&(MAX_KV + 1).to_le_bytes());
        std::fs::write(&path, huge).unwrap();
        assert_eq!(read_header(&path).unwrap_err(), GgufError::TooLarge);
    }

    #[test]
    fn a_header_has_a_size_limit_and_an_alignment_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("m.gguf");
        ollama_gemma4(&path);
        // The same file is fine under the real limit and refused under a
        // limit smaller than its header, before its strings are allocated.
        assert!(read_header(&path).is_ok());
        assert_eq!(
            read_header_within(&path, 64).unwrap_err(),
            GgufError::TooLarge
        );
        // An alignment that would pad a copy's header by gigabytes.
        let huge = dir.path().join("huge.gguf");
        write(
            &huge,
            &[
                ("general.architecture", Value::Str("gemma4")),
                ("general.alignment", Value::U32(1 << 30)),
            ],
            &[("token_embd.weight", 8)],
        );
        assert_eq!(read_header(&huge).unwrap_err(), GgufError::TooLarge);
        let sane = dir.path().join("sane.gguf");
        write(
            &sane,
            &[
                ("general.architecture", Value::Str("gemma4")),
                ("general.alignment", Value::U32(32)),
            ],
            &[("token_embd.weight", 8)],
        );
        assert_eq!(read_header(&sane).unwrap().alignment, 32);
    }

    #[test]
    fn a_text_only_copy_keeps_the_language_model_byte_for_byte() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("src.gguf");
        let target = dir.path().join("out.gguf.partial");
        ollama_gemma4(&source);
        let header = read_header(&source).unwrap();
        let plan = plan_text_only(&header, Some("{{ messages }} tools")).unwrap();
        let written = std::sync::Mutex::new(0u64);
        write_plan(
            &source,
            &target,
            &plan,
            &|n| *written.lock().unwrap() = n,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(*written.lock().unwrap(), plan.total_bytes);
        assert_eq!(std::fs::metadata(&target).unwrap().len(), plan.total_bytes);

        let copy = read_header(&target).unwrap();
        let names: Vec<_> = copy.tensors.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "token_embd.weight",
                "blk.0.attn_q.weight",
                "output_norm.weight"
            ]
        );
        // Offsets are rebuilt and every tensor's bytes are the source's.
        let src = std::fs::read(&source).unwrap();
        let out = std::fs::read(&target).unwrap();
        for (old, new) in header
            .tensors
            .iter()
            .filter(|t| !t.is_tower())
            .zip(&copy.tensors)
        {
            assert_eq!(new.offset % 32, 0);
            let size = old.dims[0] as usize;
            let a = (header.data_start + old.offset) as usize;
            let b = (copy.data_start + new.offset) as usize;
            assert_eq!(src[a..a + size], out[b..b + size], "{}", old.name);
        }
        assert!(copy.get("gemma4.vision.block_count").is_none());
        assert_eq!(copy.str_value("tokenizer.ggml.model"), Some("gemma4"));
        assert!(copy.get("tokenizer.ggml.pre").is_none());
        let summary = copy.summary().unwrap();
        assert!(summary.has_template && summary.template_tools);
        assert_eq!(summary.tower_tensors, 0);
    }

    #[test]
    fn gemma4_byte_tokens_and_tool_markers_get_the_types_llama_cpp_reads() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("src.gguf");
        let target = dir.path().join("out.gguf");
        ollama_gemma4(&source);
        let plan = plan_text_only(&read_header(&source).unwrap(), None).unwrap();
        write_plan(&source, &target, &plan, &|_| {}, &AtomicBool::new(false)).unwrap();
        let copy = read_header(&target).unwrap();
        let types = copy.get("tokenizer.ggml.token_type").unwrap();
        let read =
            |i: usize| i32::from_le_bytes(types.raw[12 + 4 * i..16 + 4 * i].try_into().unwrap());
        assert_eq!(
            (0..5).map(read).collect::<Vec<_>>(),
            vec![3, TOKEN_USER_DEFINED, TOKEN_BYTE, 1, 3]
        );
        assert_eq!(
            copy.get("tokenizer.ggml.add_bos_token").unwrap().raw,
            vec![1]
        );
        assert_eq!(
            copy.get("tokenizer.ggml.add_space_prefix").unwrap().raw,
            vec![0]
        );
        // No template was given, so none is invented.
        assert!(copy.get("tokenizer.chat_template").is_none());
    }

    #[test]
    fn a_cancelled_copy_stops_between_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("src.gguf");
        ollama_gemma4(&source);
        let plan = plan_text_only(&read_header(&source).unwrap(), None).unwrap();
        let err = write_plan(
            &source,
            &dir.path().join("out.partial"),
            &plan,
            &|_| {},
            &AtomicBool::new(true),
        )
        .unwrap_err();
        assert_eq!(err, GgufError::Cancelled);
    }

    #[test]
    fn a_model_without_towers_copies_to_the_same_tensors() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("q.gguf");
        write(
            &source,
            &[
                ("general.architecture", Value::Str("qwen2")),
                ("tokenizer.chat_template", Value::Str("{% if tools %}")),
            ],
            &[("token_embd.weight", 10), ("output.weight", 50)],
        );
        let header = read_header(&source).unwrap();
        let summary = header.summary().unwrap();
        assert_eq!(summary.tower_tensors, 0);
        assert!(summary.template_tools);
        assert!(!is_ollama_gemma4(&header));
    }

    /// Ollama's Qwen 3.5: three rope sections, vision layers and
    /// multi-token-prediction layers in the same file.
    fn ollama_qwen35(path: &Path) {
        write(
            path,
            &[
                ("general.architecture", Value::Str("qwen35")),
                ("qwen35.block_count", Value::U32(1)),
                (
                    "qwen35.rope.dimension_sections",
                    Value::I32s(vec![11, 11, 10]),
                ),
                ("qwen35.vision.block_count", Value::U32(2)),
            ],
            &[
                ("token_embd.weight", 64),
                ("blk.0.attn_q.weight", 96),
                ("mtp.fc.weight", 32),
                ("v.blk.0.w", 32),
                ("output.weight", 48),
            ],
        );
    }

    #[test]
    fn a_header_that_the_compat_rules_would_change_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("m.gguf");
        ollama_qwen35(&path);
        let summary = read_header(&path).unwrap().summary().unwrap();
        assert_eq!(summary.compat, vec!["rope_sections_pad", "mtp_unused"]);
        assert_eq!(summary.tower_tensors, 1);
        assert_eq!(summary.text_tensors, 3);
        assert_eq!(
            summary.text_bytes,
            64 + 96 + 64,
            "the mtp and vision layers are not written"
        );
    }

    #[test]
    fn a_copy_of_a_qwen35_has_four_rope_sections_and_no_mtp_layers() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("src.gguf");
        let target = dir.path().join("out.gguf");
        ollama_qwen35(&source);
        let header = read_header(&source).unwrap();
        let plan = plan_text_only(&header, None).unwrap();
        assert_eq!(plan.total_bytes, plan.header.len() as u64 + 64 + 96 + 64);
        write_plan(&source, &target, &plan, &|_| {}, &AtomicBool::new(false)).unwrap();

        let copy = read_header(&target).unwrap();
        let sections = copy.get("qwen35.rope.dimension_sections").unwrap();
        assert_eq!(sections.ty, T_ARRAY);
        let mut want = T_I32.to_le_bytes().to_vec();
        want.extend_from_slice(&4u64.to_le_bytes());
        for v in [11i32, 11, 10, 0] {
            want.extend_from_slice(&v.to_le_bytes());
        }
        assert_eq!(sections.raw, want);
        let kept = ["token_embd.weight", "blk.0.attn_q.weight", "output.weight"];
        let names: Vec<_> = copy.tensors.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, kept);
        // The tensors that stay are the source's bytes.
        let src = std::fs::read(&source).unwrap();
        let out = std::fs::read(&target).unwrap();
        for name in kept {
            let old = header.tensors.iter().find(|t| t.name == name).unwrap();
            let new = copy.tensors.iter().find(|t| t.name == name).unwrap();
            let size = old.dims[0] as usize;
            let a = (header.data_start + old.offset) as usize;
            let b = (copy.data_start + new.offset) as usize;
            assert_eq!(src[a..a + size], out[b..b + size], "{name}");
        }
        // Nothing is left for the rules to do.
        assert!(copy.summary().unwrap().compat.is_empty());
        // The source file was only read.
        assert_eq!(read_header(&source).unwrap().kvs, header.kvs);
    }

    #[test]
    fn byte_tokens_are_exactly_two_upper_hex_digits() {
        assert!(is_byte_token("<0x0A>"));
        assert!(is_byte_token("<0xFF>"));
        assert!(!is_byte_token("<0x0a>"));
        assert!(!is_byte_token("<0x0AB>"));
        assert!(!is_byte_token("0x0A"));
    }
}
