//! Which models the engine can run, and from where.
//!
//! Two places are read: the app's own models folder (any `.gguf` the user
//! puts there, and the text-only copies the app prepares), and Ollama's
//! model store, read-only. Ollama does not need to run: its manifests name
//! the blob that holds each model, and the engine loads that blob in place.
//! Nothing here writes, moves or deletes inside Ollama's store.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use super::gguf::{self, Summary};

/// The model layer's media type in an Ollama manifest.
const OLLAMA_MODEL_LAYER: &str = "application/vnd.ollama.image.model";
const OLLAMA_DEFAULT_REGISTRY: &str = "registry.ollama.ai";
const OLLAMA_DEFAULT_NAMESPACE: &str = "library";
/// A manifest is a few hundred bytes; past this it is not one.
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_MANIFESTS: usize = 512;
/// A sidecar that says which Ollama model a prepared copy came from.
pub const PREPARED_SUFFIX: &str = ".qutra.json";
pub const PARTIAL_SUFFIX: &str = ".partial";

/// The architectures the pinned llama.cpp build loads (`LLM_ARCH_NAMES` in
/// src/llama-arch.cpp at commit f2918cabb, build b11541). Updated with the
/// pin, never guessed.
pub const SUPPORTED_ARCHITECTURES: &[&str] = &[
    "llama",
    "llama4",
    "deci",
    "falcon",
    "grok",
    "gpt2",
    "gptj",
    "gptneox",
    "mpt",
    "baichuan",
    "starcoder",
    "refact",
    "bloom",
    "stablelm",
    "qwen",
    "qwen2",
    "qwen2moe",
    "qwen2vl",
    "qwen3",
    "qwen3moe",
    "qwen3next",
    "qwen3vl",
    "qwen3vlmoe",
    "qwen35",
    "qwen35moe",
    "qwen4exp",
    "phi2",
    "phi3",
    "phimoe",
    "plamo",
    "plamo2",
    "plamo3",
    "codeshell",
    "orion",
    "internlm2",
    "minicpm",
    "minicpm3",
    "gemma",
    "gemma2",
    "gemma3",
    "gemma3n",
    "gemma4",
    "starcoder2",
    "mamba",
    "mamba2",
    "jamba",
    "falcon-h1",
    "xverse",
    "command-r",
    "cohere2",
    "cohere2moe",
    "dbrx",
    "olmo",
    "olmo2",
    "olmoe",
    "openelm",
    "arctic",
    "deepseek",
    "deepseek2",
    "deepseek32",
    "deepseek4",
    "chatglm",
    "glm4",
    "glm4moe",
    "glm-dsa",
    "bitnet",
    "jais",
    "jais2",
    "nemotron",
    "nemotron_h",
    "nemotron_h_moe",
    "exaone",
    "exaone4",
    "exaone-moe",
    "rwkv6",
    "rwkv6qwen2",
    "rwkv7",
    "arwkv7",
    "granite",
    "granitemoe",
    "granitehybrid",
    "graniteswitch",
    "granite_swa",
    "chameleon",
    "plm",
    "bailingmoe",
    "bailingmoe2",
    "bailingmoe3",
    "dots1",
    "arcee",
    "afmoe",
    "ernie4_5",
    "ernie4_5-moe",
    "hunyuan-moe",
    "hunyuan-dense",
    "smollm3",
    "gpt-oss",
    "lfm2",
    "lfm2moe",
    "seed_oss",
    "grovemoe",
    "apertus",
    "minimax-m2",
    "minimax-m3",
    "mistral3",
    "mistral4",
    "mimo2",
    "step35",
    "kimi-linear",
    "kimi-k3",
    "glm5-next",
    "nanbeige",
    "maincoder",
    "mellum",
    "llada",
    "llada-moe",
    "dream",
    "smallthinker",
    "pangu-embedded",
    "talkie",
];

/// How the engine can use a model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ModelState {
    /// Loads as it is.
    Ready,
    /// Vision layers share its file: a text-only copy must be prepared once.
    NeedsPrepare {
        #[serde(rename = "writeBytes")]
        write_bytes: u64,
    },
    /// The pinned engine does not know this architecture.
    Unsupported {
        #[serde(rename = "unsupportedArchitecture")]
        architecture: String,
    },
    /// The file could not be read as a model.
    Unreadable { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelSource {
    Ollama,
    Folder,
}

/// One model, as the page sees it. Paths stay in Rust.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModel {
    pub id: String,
    pub name: String,
    pub source: ModelSource,
    pub size_bytes: u64,
    pub architecture: Option<String>,
    /// The model's chat template names tools. `None` when it has none and
    /// the engine falls back to a generic one.
    pub tools: Option<bool>,
    #[serde(flatten)]
    pub state: ModelState,
    /// A prepared copy of an Ollama model exists in the app's folder.
    pub prepared: bool,
    #[serde(skip)]
    pub path: PathBuf,
    /// The Ollama blob a prepared copy is made from.
    #[serde(skip)]
    pub source_blob: Option<PathBuf>,
    #[serde(skip)]
    pub prepared_path: Option<PathBuf>,
}

/// What a prepared copy's sidecar records.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreparedRecord {
    pub ollama_name: String,
    pub source_digest: String,
    pub prepared_at_ms: u64,
}

/// Where to look.
#[derive(Debug, Clone)]
pub struct ModelRoots {
    pub app_models: PathBuf,
    pub ollama: Option<PathBuf>,
}

/// Ollama's store: `OLLAMA_MODELS`, else `~/.ollama/models`.
pub fn default_ollama_root() -> Option<PathBuf> {
    if let Some(custom) = std::env::var_os("OLLAMA_MODELS").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(custom));
    }
    std::env::var_os("USERPROFILE")
        .filter(|v| !v.is_empty())
        .map(|home| PathBuf::from(home).join(".ollama").join("models"))
}

/// The name Ollama shows for a manifest at `<registry>/<namespace>/<model>/<tag>`.
pub fn ollama_name(registry: &str, namespace: &str, model: &str, tag: &str) -> String {
    if registry == OLLAMA_DEFAULT_REGISTRY && namespace == OLLAMA_DEFAULT_NAMESPACE {
        format!("{model}:{tag}")
    } else if registry == OLLAMA_DEFAULT_REGISTRY {
        format!("{namespace}/{model}:{tag}")
    } else {
        format!("{registry}/{namespace}/{model}:{tag}")
    }
}

/// A file name for a prepared copy of an Ollama model: its name with every
/// character outside `[A-Za-z0-9._-]` made a dash.
pub fn prepared_file_name(ollama_name: &str) -> String {
    let stem: String = ollama_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    format!("{}.gguf", stem.trim_matches('.'))
}

#[derive(Deserialize)]
struct Manifest {
    #[serde(default)]
    layers: Vec<Layer>,
}

#[derive(Deserialize)]
struct Layer {
    #[serde(rename = "mediaType", default)]
    media_type: String,
    #[serde(default)]
    digest: String,
    #[serde(default)]
    size: u64,
}

/// `sha256:<64 hex>` to the blob's file name, or nothing for anything else.
fn blob_name(digest: &str) -> Option<String> {
    let hex = digest.strip_prefix("sha256:")?;
    (hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| format!("sha256-{}", hex.to_ascii_lowercase()))
}

/// One Ollama model found in its store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OllamaEntry {
    pub name: String,
    pub blob: PathBuf,
    pub digest: String,
    pub size: u64,
}

fn dirs(path: &Path) -> Vec<(String, PathBuf)> {
    let Ok(read) = std::fs::read_dir(path) else {
        return Vec::new();
    };
    let mut out: Vec<(String, PathBuf)> = read
        .filter_map(Result::ok)
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| Some((e.file_name().into_string().ok()?, e.path())))
        .collect();
    out.sort();
    out
}

/// Read Ollama's manifests. A manifest that is not what it should be is
/// skipped, never followed: blobs are looked up only by digest, inside
/// `blobs`, so a manifest cannot point the engine at another file.
pub fn scan_ollama(root: &Path) -> Vec<OllamaEntry> {
    let manifests = root.join("manifests");
    let blobs = root.join("blobs");
    let mut out = Vec::new();
    for (registry, registry_dir) in dirs(&manifests) {
        for (namespace, namespace_dir) in dirs(&registry_dir) {
            for (model, model_dir) in dirs(&namespace_dir) {
                let Ok(tags) = std::fs::read_dir(&model_dir) else {
                    continue;
                };
                let mut tags: Vec<_> = tags.filter_map(Result::ok).collect();
                tags.sort_by_key(|e| e.file_name());
                for tag in tags {
                    if out.len() >= MAX_MANIFESTS {
                        return out;
                    }
                    let Ok(kind) = tag.file_type() else { continue };
                    let Ok(tag_name) = tag.file_name().into_string() else {
                        continue;
                    };
                    if !kind.is_file()
                        || tag.metadata().map(|m| m.len()).unwrap_or(u64::MAX) > MAX_MANIFEST_BYTES
                    {
                        continue;
                    }
                    let Ok(text) = std::fs::read_to_string(tag.path()) else {
                        continue;
                    };
                    let Ok(manifest) = serde_json::from_str::<Manifest>(&text) else {
                        continue;
                    };
                    let Some(layer) = manifest
                        .layers
                        .iter()
                        .find(|l| l.media_type == OLLAMA_MODEL_LAYER)
                    else {
                        continue;
                    };
                    let Some(file) = blob_name(&layer.digest) else {
                        continue;
                    };
                    let blob = blobs.join(file);
                    let Ok(meta) = std::fs::symlink_metadata(&blob) else {
                        continue;
                    };
                    if !meta.is_file() {
                        continue;
                    }
                    out.push(OllamaEntry {
                        name: ollama_name(&registry, &namespace, &model, &tag_name),
                        blob,
                        digest: layer.digest.clone(),
                        size: if layer.size > 0 {
                            layer.size
                        } else {
                            meta.len()
                        },
                    });
                }
            }
        }
    }
    out
}

/// Headers are read once per file version: a 26B model's header holds a
/// quarter-million-token vocabulary.
type CachedSummary = (u64, Option<SystemTime>, Result<Summary, &'static str>);

#[derive(Default)]
pub struct SummaryCache {
    entries: Mutex<HashMap<PathBuf, CachedSummary>>,
}

impl SummaryCache {
    pub fn summary(&self, path: &Path) -> Result<Summary, &'static str> {
        let meta = std::fs::metadata(path).map_err(|_| "io")?;
        let key = (meta.len(), meta.modified().ok());
        if let Ok(entries) = self.entries.lock() {
            if let Some((len, modified, cached)) = entries.get(path) {
                if (*len, *modified) == key {
                    return cached.clone();
                }
            }
        }
        let fresh = gguf::read_header(path)
            .and_then(|h| h.summary())
            .map_err(|e| e.code());
        if let Ok(mut entries) = self.entries.lock() {
            entries.insert(path.to_path_buf(), (key.0, key.1, fresh.clone()));
        }
        fresh
    }
}

/// `from_ollama`: a copy can be written from Ollama's file, so a file the
/// compatibility rules would change is offered for preparing. A copy that
/// still needs them (made by an older version of the app) is offered again.
fn state_for(
    summary: &Result<Summary, &'static str>,
    prepared: bool,
    from_ollama: bool,
) -> ModelState {
    match summary {
        Err(reason) => ModelState::Unreadable {
            reason: (*reason).into(),
        },
        Ok(s) => {
            let arch = s.architecture.clone().unwrap_or_default();
            if !SUPPORTED_ARCHITECTURES.contains(&arch.as_str()) {
                ModelState::Unsupported { architecture: arch }
            } else if (s.tower_tensors > 0 && !prepared) || (from_ollama && !s.compat.is_empty()) {
                ModelState::NeedsPrepare {
                    write_bytes: s.text_bytes,
                }
            } else {
                ModelState::Ready
            }
        }
    }
}

fn tools_for(summary: &Result<Summary, &'static str>) -> Option<bool> {
    match summary {
        Ok(s) if s.has_template => Some(s.template_tools),
        _ => None,
    }
}

/// A `.gguf` file in the app's folder, and its sidecar when it is a
/// prepared copy.
fn folder_files(dir: &Path) -> Vec<(PathBuf, Option<PreparedRecord>)> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<_> = read
        .filter_map(Result::ok)
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("gguf"))
        })
        .map(|p| {
            let sidecar = PathBuf::from(format!("{}{PREPARED_SUFFIX}", p.display()));
            let record = std::fs::read_to_string(sidecar)
                .ok()
                .and_then(|text| serde_json::from_str::<PreparedRecord>(&text).ok());
            (p, record)
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Every model the engine could be asked for, Ollama's first.
pub fn discover(roots: &ModelRoots, cache: &SummaryCache) -> Vec<LocalModel> {
    let files = folder_files(&roots.app_models);
    let mut prepared: HashMap<String, (PathBuf, PreparedRecord)> = HashMap::new();
    let mut models = Vec::new();

    let mut folder = Vec::new();
    for (path, record) in files {
        match record {
            Some(record) => {
                prepared.insert(record.ollama_name.clone(), (path, record));
            }
            None => folder.push(path),
        }
    }

    let mut ollama_models = Vec::new();
    if let Some(root) = &roots.ollama {
        for entry in scan_ollama(root) {
            let copy = prepared
                .get(&entry.name)
                .filter(|(_, record)| record.source_digest == entry.digest)
                .map(|(path, _)| path.clone());
            if copy.is_some() {
                prepared.remove(&entry.name);
            }
            let read_from = copy.clone().unwrap_or_else(|| entry.blob.clone());
            let summary = cache.summary(&read_from);
            ollama_models.push(LocalModel {
                id: entry.name.clone(),
                name: entry.name,
                source: ModelSource::Ollama,
                size_bytes: entry.size,
                architecture: summary.as_ref().ok().and_then(|s| s.architecture.clone()),
                tools: tools_for(&summary),
                state: state_for(&summary, copy.is_some(), true),
                prepared: copy.is_some(),
                path: read_from,
                source_blob: Some(entry.blob),
                prepared_path: copy,
            });
        }
    }

    // A copy whose Ollama model is gone or changed is still the user's
    // file: it stays listed so it can be used or deleted.
    folder.extend(prepared.into_values().map(|(path, _)| path));
    folder.sort();
    for path in folder {
        let summary = cache.summary(&path);
        let name = path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        models.push(LocalModel {
            id: name.clone(),
            name,
            source: ModelSource::Folder,
            size_bytes: std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
            architecture: summary.as_ref().ok().and_then(|s| s.architecture.clone()),
            tools: tools_for(&summary),
            state: state_for(&summary, false, false),
            prepared: false,
            path,
            source_blob: None,
            prepared_path: None,
        });
    }

    ollama_models.extend(models);
    ollama_models
}

#[cfg(test)]
pub mod tests {
    use super::super::gguf::fixture::{write, Value};
    use super::*;

    pub const GEMMA_DIGEST: &str =
        "sha256:7121486771cbfe218851513210c40b35dbdee93ab1ef43fe36283c883980f0df";
    pub const QWEN_DIGEST: &str =
        "sha256:2bada8a7450677000f678be90653b85d364de7db25eb5ea54136ada5f3933730";

    pub fn manifest(digest: &str, size: u64) -> String {
        format!(
            r#"{{"schemaVersion":2,"config":{{"mediaType":"application/vnd.docker.container.image.v1+json","digest":"sha256:{z}","size":474}},
            "layers":[{{"mediaType":"application/vnd.ollama.image.model","digest":"{digest}","size":{size}}},
                      {{"mediaType":"application/vnd.ollama.image.license","digest":"sha256:{z}","size":10}}]}}"#,
            z = "0".repeat(64)
        )
    }

    /// An Ollama store shaped like a real one: a Gemma 4 whose vision
    /// layers share its blob, and a text-only Qwen 2.5.
    pub fn ollama_store(root: &Path) {
        let lib = root.join("manifests/registry.ollama.ai/library");
        std::fs::create_dir_all(lib.join("gemma4")).unwrap();
        std::fs::create_dir_all(lib.join("qwen2.5")).unwrap();
        std::fs::create_dir_all(root.join("blobs")).unwrap();
        std::fs::write(lib.join("gemma4/26b"), manifest(GEMMA_DIGEST, 0)).unwrap();
        std::fs::write(lib.join("qwen2.5/7b"), manifest(QWEN_DIGEST, 0)).unwrap();
        write(
            &root.join(format!("blobs/sha256-{}", &GEMMA_DIGEST[7..])),
            &[
                ("general.architecture", Value::Str("gemma4")),
                ("tokenizer.ggml.model", Value::Str("llama")),
                (
                    "tokenizer.ggml.tokens",
                    Value::Strings(vec!["<pad>", "<0x0A>"]),
                ),
                ("tokenizer.ggml.token_type", Value::I32s(vec![3, 1])),
            ],
            &[("token_embd.weight", 64), ("v.blk.0.w", 32)],
        );
        write(
            &root.join(format!("blobs/sha256-{}", &QWEN_DIGEST[7..])),
            &[
                ("general.architecture", Value::Str("qwen2")),
                ("tokenizer.chat_template", Value::Str("{%- if tools %}")),
            ],
            &[("token_embd.weight", 64)],
        );
    }

    #[test]
    fn ollama_names_read_the_way_ollama_prints_them() {
        assert_eq!(
            ollama_name("registry.ollama.ai", "library", "gemma4", "26b"),
            "gemma4:26b"
        );
        assert_eq!(
            ollama_name(
                "registry.ollama.ai",
                "huihui_ai",
                "qwen3-abliterated",
                "14b"
            ),
            "huihui_ai/qwen3-abliterated:14b"
        );
        assert_eq!(
            ollama_name("hf.co", "bartowski", "m", "Q4"),
            "hf.co/bartowski/m:Q4"
        );
        assert_eq!(prepared_file_name("gemma4:26b"), "gemma4-26b.gguf");
        assert_eq!(prepared_file_name("a/b:c"), "a-b-c.gguf");
        assert_eq!(prepared_file_name("..\\x:y"), "-x-y.gguf");
    }

    #[test]
    fn the_store_is_read_through_its_manifests_and_blobs_only() {
        let dir = tempfile::tempdir().unwrap();
        ollama_store(dir.path());
        // A manifest that names something outside `blobs` is not followed.
        let evil = dir.path().join("manifests/registry.ollama.ai/library/evil");
        std::fs::create_dir_all(&evil).unwrap();
        std::fs::write(evil.join("latest"), manifest("sha256:../../secret", 0)).unwrap();
        // A digest whose blob is missing is skipped.
        let ghost = dir
            .path()
            .join("manifests/registry.ollama.ai/library/ghost");
        std::fs::create_dir_all(&ghost).unwrap();
        std::fs::write(
            ghost.join("1b"),
            manifest(&format!("sha256:{}", "a".repeat(64)), 0),
        )
        .unwrap();

        let found = scan_ollama(dir.path());
        let names: Vec<_> = found.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["gemma4:26b", "qwen2.5:7b"]);
        assert!(found[0].blob.starts_with(dir.path().join("blobs")));
        assert!(found[0].size > 0);
    }

    /// Ollama's cloud models (`glm-4.6:cloud`, `gpt-oss:120b-cloud`) are
    /// stubs: the remote host sits in the manifest's config and there is no
    /// model layer, so nothing on this computer could answer. They are never
    /// listed, so no picker can offer one as a local model.
    #[test]
    fn a_cloud_model_in_ollamas_store_is_never_listed_as_local() {
        let store = tempfile::tempdir().unwrap();
        let app = tempfile::tempdir().unwrap();
        ollama_store(store.path());
        let cloud = store
            .path()
            .join("manifests/registry.ollama.ai/library/glm-4.6");
        std::fs::create_dir_all(&cloud).unwrap();
        std::fs::write(
            cloud.join("cloud"),
            format!(
                r#"{{"schemaVersion":2,"config":{{"mediaType":"application/vnd.docker.container.image.v1+json","digest":"sha256:{z}","size":380}},
                "layers":[{{"mediaType":"application/vnd.ollama.image.license","digest":"sha256:{z}","size":10}}]}}"#,
                z = "1".repeat(64)
            ),
        )
        .unwrap();

        let roots = ModelRoots {
            app_models: app.path().to_path_buf(),
            ollama: Some(store.path().to_path_buf()),
        };
        let ids: Vec<_> = discover(&roots, &SummaryCache::default())
            .into_iter()
            .map(|m| m.id)
            .collect();
        assert_eq!(ids, ["gemma4:26b", "qwen2.5:7b"]);
    }

    #[test]
    fn discovery_says_which_models_load_as_they_are_and_which_need_a_copy() {
        let store = tempfile::tempdir().unwrap();
        let app = tempfile::tempdir().unwrap();
        ollama_store(store.path());
        write(
            &app.path().join("Mystery.gguf"),
            &[("general.architecture", Value::Str("not-a-real-arch"))],
            &[("token_embd.weight", 8)],
        );
        std::fs::write(app.path().join("broken.gguf"), b"nope").unwrap();
        std::fs::write(app.path().join("half.gguf.partial"), b"GGUF").unwrap();

        let roots = ModelRoots {
            app_models: app.path().to_path_buf(),
            ollama: Some(store.path().to_path_buf()),
        };
        let models = discover(&roots, &SummaryCache::default());
        let by_id: HashMap<_, _> = models.iter().map(|m| (m.id.as_str(), m)).collect();
        assert_eq!(models.len(), 4, "{:?}", by_id.keys());

        let gemma = by_id["gemma4:26b"];
        assert_eq!(gemma.source, ModelSource::Ollama);
        assert_eq!(gemma.state, ModelState::NeedsPrepare { write_bytes: 64 });
        assert!(!gemma.prepared);
        let qwen = by_id["qwen2.5:7b"];
        assert_eq!(qwen.state, ModelState::Ready);
        assert_eq!(qwen.tools, Some(true));
        assert_eq!(
            by_id["Mystery"].state,
            ModelState::Unsupported {
                architecture: "not-a-real-arch".into()
            }
        );
        assert!(matches!(
            by_id["broken"].state,
            ModelState::Unreadable { .. }
        ));
        let wire = serde_json::to_value(gemma).unwrap();
        assert_eq!(wire["state"], "needs_prepare");
        assert_eq!(wire["writeBytes"], 64);
        assert!(wire.get("path").is_none(), "{wire}");
    }

    #[test]
    fn a_prepared_copy_stands_in_for_its_ollama_model_only_while_the_digest_matches() {
        let store = tempfile::tempdir().unwrap();
        let app = tempfile::tempdir().unwrap();
        ollama_store(store.path());
        let copy = app.path().join("gemma4-26b.gguf");
        write(
            &copy,
            &[("general.architecture", Value::Str("gemma4"))],
            &[("token_embd.weight", 64)],
        );
        let record = |digest: &str| PreparedRecord {
            ollama_name: "gemma4:26b".into(),
            source_digest: digest.into(),
            prepared_at_ms: 1,
        };
        let sidecar = app.path().join("gemma4-26b.gguf.qutra.json");
        std::fs::write(
            &sidecar,
            serde_json::to_string(&record(GEMMA_DIGEST)).unwrap(),
        )
        .unwrap();
        let roots = ModelRoots {
            app_models: app.path().to_path_buf(),
            ollama: Some(store.path().to_path_buf()),
        };
        let cache = SummaryCache::default();
        let models = discover(&roots, &cache);
        assert_eq!(models.len(), 2, "the copy is not listed twice");
        let gemma = models.iter().find(|m| m.id == "gemma4:26b").unwrap();
        assert_eq!(gemma.state, ModelState::Ready);
        assert!(gemma.prepared);
        assert_eq!(gemma.path, copy);

        // Ollama pulled a new version: the old copy no longer stands in.
        let other = format!("sha256:{}", "b".repeat(64));
        std::fs::write(&sidecar, serde_json::to_string(&record(&other)).unwrap()).unwrap();
        let gemma = discover(&roots, &cache)
            .into_iter()
            .find(|m| m.id == "gemma4:26b")
            .unwrap();
        assert!(!gemma.prepared);
        assert!(matches!(gemma.state, ModelState::NeedsPrepare { .. }));
    }

    #[test]
    fn the_expected_model_architectures_are_in_the_pinned_list() {
        for arch in ["gemma4", "qwen2", "qwen3", "qwen35", "llama"] {
            assert!(SUPPORTED_ARCHITECTURES.contains(&arch), "{arch}");
        }
    }
}
