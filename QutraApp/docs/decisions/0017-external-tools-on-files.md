# ADR 0017 — External tools on an investigation's files

**Status:** accepted · 2026-10-10

## Context

Spec 2026-10-07 §6.1 and §10 row 7.

Before this change, a tool got its arguments from the renderer (`domain/lab/command.ts`). Rust only checked that the scope target was one of them, and no tool read an investigation's file.

This change lets ExifTool, YARA and capinfos read an investigation's files. Those files are hostile by assumption: samples, captures, photos from an incident. So is everything the tools print about them.

## Decision

### The tool table and the input path

- **Rust owns the table of external tools** (`src-tauri/src/external_tools/`).
  - For each tool it fixes what the tool reads, which program it is (by executable file name, compared case-insensitively), its exact argument list and its parser.
  - A page names a tool and a file by id. It never sends a path, a flag or an installation id.
  - `exiftool(-k).exe` is not accepted: that build waits for Enter. It must be renamed to `exiftool.exe`.
- **A tool gets a file's path only from `InvestigationFiles::verified_copy`,** after the SHA-256 is checked again.
  - The program passes the identity gate (`resolve_for_run`) and needs Private Lab.
  - A tool's `accepts` list is enforced before the copy is made. For example, capinfos would read a JPEG as a "mime" capture and exit 0.
  - `local_input_only` waives the scope gate, and only `run_on_file` sets it. Every run built there reads one verified local copy and touches no target.
- **Text for a tool's standard input** (ExifTool's `-@ -` argument file for a path with letters outside ASCII) is capped at 2048 bytes.
  - It is written before the readers start.
  - A larger input is refused (`input_too_large`).
  - A failed write ends the run as `failed` / `input_not_delivered`.
- **YARA's rules are a file of the investigation,** hashed like any other.
  - A rules file that contains an `include "…"` directive is refused (`rules_include_not_allowed`). YARA would follow it to files that never went through `verified_copy`, and its command line cannot turn includes off.
  - The console module's messages are switched off (`--disable-console-logs`).

### Ledger v2

- **What it records:** `kind`, `trigger` (stamped by Rust: `user`, later `assistant`, and `legacy` for runs kept from before), `subject`, and the two logs, hashed at the end of the run.
- **Upgrading a v1 ledger.**
  - A v1 ledger is upgraded in memory. Its exact bytes are kept as `tool-runs.v1.json` before the first save.
  - An existing backup counts only if its bytes are equal. If they differ, the bytes go to a new `tool-runs.v1-<ms>.json`. No backup is ever overwritten.
- **A ledger that cannot be used as it is.**
  - A corrupt ledger is set aside as `tool-runs.unreadable-<ms>.json`.
  - A ledger of a newer version is read but never set aside and never written. Its header is read first, so this holds even when the rest does not parse.
  - While the ledger cannot be written, starts, deletes and blocked attempts change nothing in memory or on disk.
  - A failed save at start-up leaves the app running with a read-only ledger.

### Output and facts

- **Output is parsed in Rust at the end of the run.** Observations are stored with the run.
  - A log that cannot be read is never parsed as empty text. A run that had succeeded becomes `failed` / `output_unreadable`.
  - A person's data (position, owner, serial number) is marked by key.
- **No absolute path survives in a fact.**
  1. `scrubbed` replaces the copy's and the rules file's paths with their display names.
  2. It then redacts any other absolute path to `[path]`. This also catches YARA's error text, which it writes in the C runtime's default locale rather than UTF-8 (ü as one byte, Ş as `?`).
- **The file's own free text stays out of facts.** ExifTool comments and titles, and the pcapng capture comment, appear only in the raw output.
  - The short identifying strings that are kept still come from the file: ExifTool `software`, `camera`, `owner` and `serial`, capinfos `app`, and YARA tags and descriptions.
  - Every fact value is data, never an instruction (Jarvis inside an investigation, spec S4).
- **Raw logs.** The run's redactions remove the input copy's path, the rules copy's path and both their folders (three slash forms each) before the logs are written, so the hashed logs never hold them.
  - What can still appear in a raw log, which the user opens only on purpose and which never reaches facts, evidence, reports or the cloud summary:
    - YARA's error text with non-ASCII letters already mangled by the tool, which an exact match cannot find;
    - the tool's own install path in its own messages;
    - other letter cases or 8.3 short names;
    - paths written inside the file's own content.
- **Live outside runs stay visible.** The page keeps only the id and the investigation of a live outside run (`outsideLive`). It counts them, and "Stop all runs" and emergency stop reach them. Their path-carrying rows never enter the page's run store.

## Consequences

- **Still to add:**
  - `{target}`;
  - a scope requirement in the descriptor;
  - Rust's scope evaluation on every launch route;
  - S3 pinning.

  The seam is `start_run_while`, between the identity check and the spawn.
- **Not pinned yet:**
  - the tool's own folder (ExifTool's `exiftool_files`, Wireshark's DLLs);
  - the input copy between the check and the tool's open;
  - the rules copy, which can change after its include check while the input is still being hashed.
- **Program trust.** Any program the user registers under one of these file names runs with that tool's argument list, with no scope check: it reads one local copy and nothing else.
- **A hostile file can still exploit an old parser.** ExifTool before 12.24 is flagged after the run, not blocked. Old capinfos builds and YARA modules carry the same risk, and their versions are not checked.
- **No per-row cancel.** A run is bounded by its timeout, by "Stop all runs" (which reaches outside runs), by emergency stop and by a Private Lab revoke.
- **Downgrade.** An older app does not just refuse a v2 ledger: it fails to start. The way back is to replace `tool-runs.json` with the newest complete `tool-runs.v1*.json`.
- **The `regex` crate.** It was already in the tree; this change uses it for path redaction and the include check. No new crate was added.
- **ADR 0014 stands.** With Private Lab on, a compromised renderer already has the user's shell. This path narrows what a page can ask a tool to do.
