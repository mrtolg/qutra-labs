# Investigation workspace: design

- **Date:** 2026-10-07.
- **Status:** approved 2026-10-07.
- **Scope:** this is the umbrella design. Each roadmap milestone (§10) gets its own implementation plan before any code is written.

## 1. Goal

Qutra becomes a local-first, AI-assisted security workspace. Its main object is the **investigation**, which runs through these steps:

> Target → Tools → Observations → Evidence → Findings → Report

Tools come to the target: when the user looks at a file or a host, the matching analyses are offered right there. Jarvis is an assistant that understands the investigation. It runs registered tools only with per-call approval and inside the scope, and its interpretation is never evidence.

## 2. Decisions (binding)

| # | Decision |
|---|---|
| D1 | **The investigation grows out of today's engagement.** Its scope, targets, scans, findings, evidence, report and folder carry over unchanged. Files, observations and AI notes are added. Existing records are kept. |
| D2 | **Name.** Turkish "inceleme" ("Yeni inceleme", "Son incelemeler"); English "Investigation". It replaces "güvenlik çalışması" in every locale. The run noun stays "tarama". |
| D3 | **One top bar stays.** There is no left sidebar. Inside an investigation, the left column lists its targets and files; that column is content, not navigation. |
| D4 | **Top-bar areas (option A).** Ana Sayfa · İncelemeler · Araçlar · Jarvis · Terminal. Eğitim is added in phase 2. |
| D5 | **Investigation screen** (approved mockup). Left: targets and files. Centre: the selected item, its "Önerilen analiz" and the scan output in three layers (summary → interesting → raw). Right: a Jarvis panel, toggled with Ctrl+B. The scope strip sits at the top. |
| D6 | **Evidence rule.** A finding without evidence is allowed, but it shows "Taslak · kanıt yok" and cannot be confirmed or exported in a report. An imported file becomes evidence automatically. Jarvis proposes a finding only by citing existing evidence, and the user accepts it. |
| D7 | **Analysis engine.** Built-in Rust analyzers (read-only, in process) plus registered external tools. A missing tool shows "Kur". The Linux sandbox waits for phase 2 or later. |
| D8 | **Cloud AI.** Two connections ship together: Anthropic (Claude) and OpenAI-compatible (OpenAI, Gemini, OpenRouter, Groq and local servers). Keys are kept in Windows Credential Manager and only Rust reads them. |
| D9 | **Data egress.** Cloud starts off in every investigation. The first cloud turn shows a card with the exact payload; the user allows it once per investigation and can revoke it. Raw output and files leave only when attached. Secrets are masked. Each answer shows "gönderildi: <provider> · <size>". |
| D10 | **Ollama bridge.** Cloud is the default. Investigations that must stay local use Qutra's own engine (bundled llama.cpp), which runs only while an answer is generated and stops after an idle period. Ollama becomes optional. |
| D11 | **Refusal fallback on.** When Claude declines, the request moves to a fallback model, and the answer names the model that served it. |
| D12 | **Training v1 is file-based** (.qlab: artifacts, objectives, local checks). Container labs come later. |

## 3. Today: facts the design builds on

Paths are under `QutraApp\`. These were verified in source on 2026-10-06/07.

- **Investigation (engagement).**
  - `engagements` (`src\domain\lab.ts:30-49`) has title, purpose, status, scopeId and folderPath, among others.
  - The folders are Rust-made under `Documents\Qutra Labs\<name>` (`src-tauri\src\engagement_folders.rs`).
  - The folder writer accepts only `.md/.json/.txt/.csv` files of at most 8 MiB.
- **Persistence.**
  - Documents live in one SQLite `records(collection,id,data,updated_at)` table, loaded into memory at boot (`src\lib\db\sqliteAdapter.ts`, `src-tauri\migrations\0001_initial.sql`).
  - The TS schema is at v14 (`src\lib\db\migrations.ts:11`).
- **Rust-owned stores.** Rust keeps its own JSON stores under `<appData>\lab\`:
  - `tool-runs.json` (a different version is refused at load),
  - `tool-registry.json`,
  - `tool-launches.json`,
  - `engagement-folders.json`.
- **Tool runs.**
  - `NativeToolRun` (`src-tauri\src\tool_supervisor.rs:93-127`) holds argv, state, exit code, log paths and tails.
  - Run logs are `stdout.log`/`stderr.log`, redacted and capped, and **never hashed**.
  - The record does not say **who triggered** a run or who approved it.
- **Inputs.**
  - Nothing takes a file as an analysis input.
  - The `artifacts` collection only mirrors run-log copies, and its sha256 is always empty.
- **Evidence and findings.**
  - Evidence comes from run output (a 32 KiB copy with its hash), from a log path (no hash) or from text.
  - `Finding.sourceRunId` is never set.
  - Imports (SARIF, Nmap) create no evidence.
- **Scope.**
  - Rust trusts the renderer's attestation and never evaluates the allow/exclude lists itself (`tool_supervisor.rs:1230-1269`).
  - The GUI and interactive launch routes and the assistant's `launch_tool`/`terminal_run` have no scope check at all.
- **Secrets.** `secure_get` returns stored secret values to the renderer (`src-tauri\src\secure.rs:84-91`), which contradicts ADR 0005.
- **Tool identity.** The exe is hashed, then spawned by path, so it is not pinned in between (`tool_registry.rs:391-413`, `tool_supervisor.rs:676`).
- **Assistant.**
  - It reaches the model only through Rust, and only Ollama on `127.0.0.1:11434/11435` (`src-tauri\src\assistant\ollama.rs`).
  - It has no provider abstraction. `AiProviderConfigSchema` (`src\domain\types.ts:394-405`) is unused.
  - It offers 3 tools, each side-effecting one behind an approval card.
  - Its audit log is held in memory only.
  - Conversations keep 50 messages.
- **Navigation.** Home · Work (Terminal, Tools) · Assistant · Lab, with 8 Lab sections (`src\app\surfaces.ts`, `SubNav.tsx`).
- **Build budget.** gzip 194 013 of 204 800 bytes, so only about 10 KB of headroom (gate of 027b00e).

## 4. Data model

### 4.1 Investigation
- It keeps the `engagements` collection and type names in code; only the UI noun changes, so nothing is renamed on disk.
- New optional fields:
  - `kind`: file | web | host | pcap | forensics | lab. Missing means "Genel".
  - `cloudConsent?`: { provider, grantedAt }.
  - `labRef?`: { labId, version }, added in phase 2.

### 4.2 Files (new)
- **Rust store.** Rust owns `<appData>\lab\investigation-files.json`, mapping id → { engagementId, relPath, name, bytes, sha256, sha1, md5, kind, addedAt, source: picked|dropped|lab|derived, parentId?, derivedFromRunId? }.
- **Renderer mirror.** The renderer mirrors it into an `investigationFiles` collection for display.
- **Adding a file.**
  - The file is copied into `<investigation folder>\files\` under a sanitized name and set read-only.
  - Executables (PE/ELF/script) get a `.sample` suffix so a double-click cannot run them.
- **Paths stay in Rust.**
  - Rust opens the picker and handles window drag-drop itself, then issues single-use tokens; the renderer never sends a path.
  - Tools receive a path only from Rust, after the file's sha256 is re-checked.
- **No folder yet.** An investigation without a folder asks for one first, using the existing "Klasör oluştur" flow.

### 4.3 Tool runs (extended)
- `tool-runs.json` moves to v2 with these new fields:
  - `kind`: builtin | external;
  - `subject`: { fileId } | { targetId };
  - `trigger`: { by: user|assistant, approvalId?, conversationId? };
  - `outputs[]`: { name, relPath, sha256, bytes }, with the logs hashed when the run ends.
- **v1 records.** The loader upgrades them in memory and keeps `tool-runs.v1.json` as a backup on first save. The upgrade is lossless.

### 4.4 Observations (new)
- **Shape.** `observations` collection: { id, engagementId, runId, subject, key, label, value, group: summary|interesting|detail, hint? }.
- **Who writes them.** Built-in analyzers return observations in the command result, and the renderer saves them. External output is parsed in TS, following the existing `parsers/` pattern.

### 4.5 Evidence
- **New kind `observation`.** Fields: { runId, observationIds[], rawRef: { relPath, sha256 } }.
- **Hashing.** The content is hashed at capture.
- **Deleting a run's logs.**
  - If evidence points at those logs, the user is warned and must confirm.
  - Evidence keeps its captured copy, so it stays valid.
- **Imports.** An imported SARIF/Nmap file is saved as `file` evidence with its hash.

### 4.6 Findings
- **Draft status.** "Taslak · kanıt yok" is derived (`evidenceIds` is empty); it is not a new status.
- **What a draft cannot do.** Confirming it and including it in a report are both blocked until evidence exists.
- **Provenance.** `sourceRunId` is set when a finding is created from a run or an observation, which gives the chain Finding → Evidence → Run → raw output.

### 4.7 AI notes (new)
- **Shape.** `aiNotes`: { id, engagementId, subject?, text, provider, model, at, conversationId }.
- **Rules.** They are never evidence. A report includes them only under "Yapay zekâ değerlendirmesi" when the user opts in.

### 4.8 Migration
- **Schema.** TS schema v15 adds the optional fields and the new collections. No existing row is rewritten.
- **Tests.** A migration test runs on a copy of v14 data, and the Rust loader test runs on a v1 `tool-runs.json`.

## 5. Screens

### 5.1 Top bar and sub-bars
- **Ana Sayfa:** Genel bakış · Projeler · Dosyalar · GitHub.
  - Genel bakış shows the "Yeni inceleme" type tiles (Dosya · Web uygulaması · Sunucu/Ağ · PCAP · Adli inceleme), "Son incelemeler" (5 + Tümü, which opens the switcher's list of every investigation), running scans, and resume project.
- **İncelemeler:** investigation chip and switcher · Özet · Hedefler ve dosyalar · Taramalar · Kanıtlar · Bulgular · Rapor.
  - Until the Files milestone adds files, the targets section is called "Hedefler".
  - The İçe aktar action sits at the right end of the sub-bar.
  - Rapor is a view, holding the preview, the export button and the saved reports.
  - Today's Kapsam becomes the strip at the top of every investigation view. Clicking the strip opens today's Kapsam editor as its own view; it no longer has a sub-tab.
  - Yol haritası is folded into Özet's next-steps block.
- **Araçlar:** Araç kutusu (today's Work › Tools launcher) · Kayıtlı araçlar (today's Lab › Araçlar) · Katalog · Akışlar · Örnek veriler (today's Kılavuzlar tabs; the shipped Turkish names "Akışlar" and "Örnek veriler" are kept).
- **Jarvis:** conversations, as today.
- **Terminal:** today's Work › Terminal.
- **Shortcuts.** Ctrl+1…4 are re-mapped to the new areas in order. Ctrl+B toggles the Jarvis panel inside an investigation.

### 5.2 New investigation
- A type tile opens the existing name/note/folder dialog with the type preselected.
- For Dosya, PCAP and Adli inceleme, the "add a file" step follows at once.
- There is no Lab ortamı tile until phase 2, so the screen has no dead controls.

### 5.3 Investigation view (Hedefler ve dosyalar)
- **Left.** Targets and files with kind and size, plus "Dosya ya da hedef ekle".
- **Centre.**
  - Header: name, type, size, SHA-256.
  - "Önerilen analiz" with a state per step: bitti · sırada · isteğe bağlı · Kur.
  - "Önerilenleri çalıştır".
  - Run output in three layers: **Özet** (counts), **İlginç** (flagged observations), **Ham çıktıyı göster**.
  - Actions "Kanıt olarak sabitle" and "Bulgu oluştur".
- **Right.** The Jarvis panel (§7.6), which reuses the existing context panel.
- **Scope strip.** It says what scoped tools can reach, by the gate's own rules (`scopeReach` beside `evaluateTarget`).
  - It names the allowed items, adds the local and private addresses that need no entry, and says "geri kalan her şey engelli".
  - Until the scope is confirmed, the listed items show as waiting. An expired scope reaches nothing.
  - An earlier review dropped "Ağ hedefi yok · yalnız dosyalar" for file investigations. Such an investigation can still scan local addresses, so the line claimed a block the gate does not make.

### 5.4 Copy
- **Noun change in six locales.** The noun changes in all six locales (tr "inceleme", en "investigation"); the other four get their natural equivalent.
- **Tests that must stay green.** The existing `turkishCopy` tests (no English words, no developer words, no "çalışma alan") must pass.

## 6. Analysis engine

### 6.1 Typed registry
Each tool is described by one descriptor:
- id and name
- category
- `accepts`: FileKind[] or TargetKind[]
- `risk`: read_only | network | intrusive
- `execution`: builtin | external
- `parser?`
- `catalogId?`
- `installUrl?`

Where descriptors come from:
- **Built-in:** Rust is the source of truth and serves them through a command.
- **External:** curated in `toolCatalog.ts` for the first parsed tools: ExifTool (`-json`), YARA, Nmap (`-oX`), capinfos/tshark.
- **Registered installations** keep using the existing catalog binding.

### 6.2 Built-in analyzers (Rust)
- **Analyzers:**
  - identify (magic bytes)
  - hashes (MD5, SHA-1, SHA-256)
  - strings (ASCII and UTF-16LE, minimum length 4, capped)
  - image metadata (EXIF/GPS, PNG text)
  - PE header (machine, timestamp, sections, imports summary, signature present)
  - entropy (per file and per section)
  - embedded signatures (known magic numbers at offsets)
- **Safety limits:**
  - They are read-only and run on a worker thread with a size cap and a time budget.
  - Panics are caught, and the artifact is never executed.
- **Output.** Each run is recorded as a `kind: builtin` run with `observations` and a raw text output.
- **New crates.** sha1, md-5, an EXIF reader and a PE reader are chosen per milestone after a licence and size check.

### 6.3 Suggestions and chains
- **Suggestions.** A rule table maps a FileKind or TargetKind to ordered steps: built-in steps first, then the external tools that accept the kind.
- **Chains.** A chain is a recipe of ordered steps with simple conditions on observations (e.g. `kind == pe`). The renderer runtime runs it sequentially and shows it as a step timeline. The first two chains are "Bilinmeyen dosya" and "Fotoğraf".
- **Launch rules.** User-started built-in steps need no approval. External steps follow the normal launch rules (consent, identity, scope).

### 6.4 Security fixes carried by this work

| # | Fix |
|---|---|
| S1 | **Rust evaluates scope itself** from the persisted `authorizationScopes` record in SQLite. This covers every launch route and every assistant tool call. TS and Rust share a JSON file of test vectors. |
| S2 | **The renderer can no longer read secrets.** `secure_get` is removed from it, and the renderer only sees `{present, last4}`. The GitHub token stays read inside Rust. ADR 0005 is enforced. |
| S3 | **The tool file is pinned.** A deny-write/deny-delete handle is held from the hash check until the process has started. |
| S4 | **Tool output is treated as untrusted when it goes to the model.** It is wrapped as untrusted data, and observations are summarized. Raw output goes only when attached. Side effects are never auto-approved. `terminal_run` is not offered inside an investigation. |
| S5 | **Built-in parser robustness.** Size caps, time budgets and `catch_unwind` (§6.2). |
| S6 | **.qlab import safety** (phase 2): zip-slip guard, size and count caps, schema validation and sha256 checks; nothing runs automatically. |

## 7. Jarvis

### 7.1 Provider layer (Rust)
- **Trait.** `Provider { list_models, stream_chat }`, with three adapters:
  - `anthropic`;
  - `openai_compat`;
  - `ollama` (the existing one, now optional).
- **Transport.** Every call goes from Rust over reqwest with rustls; the dependency is already present. The renderer CSP is unchanged.
- **Events.** Streaming reuses the `assistant://stream` events.

### 7.2 Anthropic adapter
No official Rust SDK exists, so the adapter uses raw HTTPS with the documented shapes.

**Request:**
- `POST https://api.anthropic.com/v1/messages` with the headers `x-api-key`, `anthropic-version: 2023-06-01` and `anthropic-beta: server-side-fallback-2026-07-01`, and the body field `fallbacks: "default"` (D11).
- The answer names the model that served it.

**Model and thinking:**
- **Default model.** `claude-opus-5-5`. The picker lists models from `GET /v1/models`.
- **Thinking.** Thinking is always on with this model: omit `thinking`, or send `{type:"adaptive", display:"summarized"}` so the UI can show progress.
- **Effort is set explicitly.** `medium` for chat and `high` for "analyse this investigation".
- **Parameters not sent.** No `temperature`, `top_p` or `top_k`.

**Tools:**
- Use `tool_choice: auto` with `disable_parallel_tool_use: true`, so approvals come one at a time.
- Tools use `strict: true` schemas.
- Every tool input is validated in Rust before the approval card.

**Stream:** SSE events `message_start`, `content_block_start`, `content_block_delta` (`text_delta`, `input_json_delta`, `thinking_delta`), `content_block_stop`, `message_delta` (stop_reason, usage), `message_stop`, `ping` and `error`.

**Stop reasons:**

| Stop reason | Handling |
|---|---|
| end_turn | done |
| tool_use | approval loop; results return as `tool_result` (`is_error` on reject or failure) |
| max_tokens | "yanıt kesildi · devam et" |
| refusal | category in plain words; this is after the fallback chain |

**History must be append-only:**
- Assistant `content` blocks, thinking blocks included, are stored and echoed unchanged.
- History is never edited, because an edited history is rejected once thinking blocks are bound to it.
- Cloud conversations do not use the 50-message trim. When a conversation grows long, the user starts a new one, or server-side compaction is evaluated in that milestone.

**Caching:**
- Request order is tools → system → messages, with a deterministic tool order.
- The investigation snapshot is a cached block.
- Later changes are appended as mid-conversation `system` messages.
- Hits are verified via `usage.cache_read_input_tokens`.

**Errors → UI states:**

| Code | UI state |
|---|---|
| 401 | key invalid |
| 402 | billing |
| 403 / 404 | no access to this model |
| 413 | request too large |
| 429 | rate limited; countdown from `retry-after`, at most 2 automatic retries |
| 500 / 529 | backoff, at most 2 retries, then "servis yoğun" |
| network or timeout | "bağlantı yok" |
| 400 | treated as a bug: "istek geçersiz" plus a diagnostics hint |

**Cost line:**
- Tokens (input, output, cache) × a dated price table kept in one Rust constant.
- Opus 5.5: $4 input, $20 output, $0.20 cache read per MTok.
- Unknown models show tokens only.

### 7.3 OpenAI-compatible adapter
- **Endpoint.** `POST {base}/chat/completions` with SSE `data:` chunks ending in `[DONE]`, and `tools`/`tool_calls`.
- **Presets.** OpenAI, Gemini (OpenAI endpoint), OpenRouter, Groq, and the local engine.
- **Key.** Optional for local servers.

### 7.4 Keys
- **Storage.** keyring entries: `ai.anthropic.key` and `ai.openai_compat.<preset>.key`.
- **Commands.** `ai_key_set`, `ai_key_has` (returns `{present,last4}`) and `ai_key_delete`. There is no getter.

### 7.5 Per-investigation consent (D9)
- **Consent card.** The first cloud turn in an investigation renders the exact context block that will be sent, with its size; the user allows it, and the allowance is saved in `cloudConsent`.
- **Revoking.** Consent can be revoked from the strip or Settings.
- **Masking.** Rust masks secrets before sending: private keys, cloud and GitHub tokens, JWTs, bearer headers and `password=` pairs.
- **Attachments.** Raw outputs and files are sent only when attached to a message.
- **The "gönderildi" line.** Extended from today's per-answer "sent to" line.

### 7.6 Assistant in an investigation
- **Context snapshot** (deterministic): name and kind, scope summary, targets and files (name, kind, sha256 prefix), runs (tool, subject, state, observation summary) and findings (title, severity, evidence count).
- **Tools offered:**
  - `use_tool {toolId, subjectId, profileId?}`
  - `read_observations {runId}`
  - `propose_finding {title, severity, evidenceIds[], assessment}`; the cited evidence must exist, the user accepts the draft, and the assessment is saved as an AI note.
  - `read_context`
- **Before a side effect runs**, every step must pass:
  1. Rust checks that the tool accepts the subject kind (S1, consent, identity).
  2. The approval card is shown.
  3. The run is recorded with `trigger {by: assistant, approvalId, conversationId}`.
- **Next steps.** "Sırada ne var?" answers carry run buttons that start the same approved path.

### 7.7 Local engine (D10)
- **What ships.** llama.cpp `llama-server.exe` (MIT), as a Tauri sidecar (`externalBin`) in CPU and Vulkan builds.
- **Starting.** It starts on demand on `127.0.0.1:<free port>` with a random `--api-key` and `--jinja`, using the user-chosen GGUF (picked through the Rust picker and a token). It runs inside a Job Object with kill-on-close.
- **Stopping.** It stops after 5 idle minutes (configurable) and when the app exits.
- **Connection.** The OpenAI-compatible adapter talks to it.
- **Models and size.** No model is bundled. The installer grows by about 30–80 MB; this is measured in that milestone.

### 7.8 ADRs
- **ADR 0015, cloud AI providers and data egress.** It supersedes ADR 0004's local-only rule and meets ADR 0012:347's requirement.
- **ADR 0016, local inference sidecar.**
- **ADR 0005 is updated** to record that write-only is now enforced.

## 8. Training (phase 2)

### 8.1 The .qlab package
- **Format.** A zip containing `manifest.json`, `guide.md` and `files/…`.
  - The manifest holds the schema, id, title, category, difficulty, summary, `objectives[{id, text, check}]` and `files[{path, sha256}]`.
- **Objective checks:**
  - `observation` (key plus a hashed expected value);
  - `finding` (evidence required);
  - `answer` (sha256 of the normalized answer).

  Answers are stored only as hashes.
- **Import.**
  - Rust validates the package (S6), creates an investigation (kind from the manifest) and copies the files.
  - The objectives panel appears, and objectives are checked locally.

### 8.2 Starter labs
- photo metadata
- hidden file
- suspicious .exe (with a bundled YARA rule)
- PCAP plaintext password (adds a built-in PCAP summary analyzer)
- auth-log brute force

### 8.3 Navigation
The **Eğitim** top-bar area appears with the first training milestone.

## 9. Release (proposal only; decided in phase 5)

**Before publishing:**
- Scan the whole history for secrets (e.g. gitleaks).
- Choose a licence and write a README.

**Method.** Publish a fresh-history export: a new repository whose single first commit is the cleaned tree. Do not rewrite this history.

**Publishing is a manual step.**

## 10. Roadmap

Each milestone:
- takes 2–3 days and ends in something visible in the installed app;
- is done when the full gate passes and the installed build has been checked.

| # | Milestone | Visible result | Depends on |
|---|---|---|---|
| 1 | Name and layout | "İnceleme" copy; the A top bar; the "Yeni inceleme" home; one Araçlar area; the scope strip | — |
| 2 | Files | Add or drop a file; type, size and SHA-256 card; left list | 1 |
| 3 | Jarvis cloud | Claude and OpenAI-compatible keys and settings; error states; S2 | — |
| 4 | Built-in analyzers | "Önerilen analiz", "Önerilenleri çalıştır", three-layer output | 2 |
| 5 | Evidence and provenance | Pin an observation, the draft rule, the provenance chain; import creates evidence | 4 |
| 6 | Cloud privacy | Consent card, masking, "gönderildi" line; ADR 0015 | 3 |
| 7 | External tools and security | ExifTool/YARA/Nmap/PCAP parsed; S1, S3; run trigger | 4 |
| 8 | Jarvis in an investigation | Panel, "Sırada ne var?", run button with approval, AI notes; S4 | 5, 6, 7 |
| 9 | Chains | "Bilinmeyen dosya" and "Fotoğraf" timelines | 7 |
| 10 | Local engine | Local answers without Ollama; ADR 0016 | 3 |
| 11 | Training: format | .qlab import, objectives panel, Eğitim area; S6 | 5 |
| 12 | Training: labs | 4–6 starter labs | 11 |

After the milestones come debugging, then a security-focused design pass, then release (§9).

## 11. Risks

- **Bundle budget.** There are about 10 KB of gzip headroom. The new views must be lazy-loaded routes, or the budget must be raised with explicit sign-off (milestone 1 decides).
- **Defender.** It may quarantine malware samples inside investigation folders. Any exclusion is the user's choice; the `.sample` suffix only prevents accidental runs.
- **Claude refusals.** Claude may decline some security requests. Mitigations: the fallback chain (D11) and the local engine.
- **Vulkan build.** It may fail on some drivers, so a CPU fallback is required.
- **New crates.** Each one gets a licence and size review in its milestone.
- **Two scope implementations.** TS (preview) and Rust (enforcement) must stay in sync, so they share test vectors.
- **Bound thinking blocks.** Cloud conversations must stay append-only (§7.2).

## 12. Testing

- **Every milestone:**
  - unit tests (vitest), Rust tests and e2e;
  - `npm run gate`, then install and a CDP check of the installed build.
- **Fixtures and invariants:**
  - small fixtures: a JPEG with EXIF and GPS, a tiny PE, a small PCAP;
  - adapters tested against recorded SSE fixtures, never with live calls;
  - a test that no key command returns a secret;
  - the scope vectors run in both TS and Rust;
  - migration tests on v14 and v1 copies.
