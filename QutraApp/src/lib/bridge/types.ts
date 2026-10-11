import type { SnapshotItem } from "@/domain/types";
import type { Observation } from "@/lib/analysis";
import type { TerminalController } from "./terminal";

/* ============================================================
   DesktopBridge — the trust boundary between product logic and
   OS integrations. The browser implementation is deterministic
   and honest: capabilities report `simulated: true`, and the UI
   never presents simulated behavior as a real native success.
   ============================================================ */

export interface Capability {
  available: boolean;
  simulated: boolean;
  /** Why it is unavailable, when it is. */
  reason?: "browser_mode" | "permission_denied" | "not_implemented";
}

export interface BridgeCapabilities {
  runningApps: Capability;
  windowBounds: Capability;
  launchApp: Capability;
  openUrl: Capability;
  openPath: Capability;
  pickPath: Capability;
  readClipboard: Capability;
  writeClipboard: Capability;
  gitInspection: Capability;
  globalShortcuts: Capability;
  notifications: Capability;
  secureStore: Capability;
  toolSupervisor: Capability;
  terminal: Capability;
}

export type NativeSignatureState =
  | "valid"
  | "invalid"
  | "unsigned"
  | "unavailable";

export interface NativeToolCandidate {
  canonicalPath: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  modifiedAt?: number;
  version: string;
  publisher: string;
  signatureState: NativeSignatureState;
}

export interface NativeToolInstallation {
  id: string;
  displayName: string;
  runner: "executable";
  canonicalPath: string;
  sha256: string;
  sizeBytes: number;
  modifiedAt?: number;
  version: string;
  publisher: string;
  signatureState: NativeSignatureState;
  category: "local" | "network" | "web" | "code" | "dfir";
  riskTier: "info" | "low" | "medium" | "high";
  docUrl: string;
  tags: string[];
  workingDir: string;
  enabled: boolean;
  changedSinceVerify: boolean;
  createdAt: number;
  updatedAt: number;
  lastVerifiedAt: number;
  /** Read when the list was made, never stored: the file is no longer where
      it was registered. Absent on a record Rust did not just list. */
  fileMissing?: boolean;
}

/** A program the scan of this computer found. Either Rust already holds the
    file (`registeredId`), or it is held for review and registers by the
    `located` token like a picked file. No path is ever sent back. */
export interface NativeDetectedTool {
  catalogId: string;
  source: string;
  fileName: string;
  canonicalPath: string;
  registeredId: string | null;
  located: NativeLocatedCandidate | null;
}

/** What native Locate returns: the picked file's facts for review, the
    folder Rust chose as its working directory, and an opaque single-use
    token. Only the token can register it. */
export interface NativeLocatedCandidate {
  token: string;
  candidate: NativeToolCandidate;
  workingDir: string;
}

/** Registration names the located candidate by token. There is deliberately
    no path and no working directory here; Rust refuses either field. */
export interface RegisterNativeToolRequest {
  candidateToken: string;
  displayName: string;
  category: NativeToolInstallation["category"];
  riskTier: NativeToolInstallation["riskTier"];
  docUrl: string;
  tags: string[];
  confirmed: boolean;
}

export interface NativeEnvironmentInput {
  key: string;
  value: string;
  sensitive?: boolean;
}

export interface NativeScopeAttestation {
  scopeId: string;
  scopeRevision: number;
  target: string;
  allowed: boolean;
  reason: string;
  decidedAt: number;
  expiresAt?: number;
}

export interface StartNativeToolRunRequest {
  installationId: string;
  profileId: string;
  requestId: string;
  engagementId?: string;
  targetId?: string;
  argv: string[];
  workingDir: string;
  environment: NativeEnvironmentInput[];
  redactions: string[];
  scope?: NativeScopeAttestation;
  requiresScope: boolean;
  timeoutSec: number;
  outputLimitBytes: number;
  concurrencyClass: "default" | "exclusive";
}

export interface NativeRunArtifact {
  kind: string;
  path: string;
  sizeBytes: number;
  truncated: boolean;
}

export interface NativeRunTrigger {
  by: "user" | "assistant" | "legacy";
  approvalId?: string;
  conversationId?: string;
}

export interface NativeRunSubject {
  fileId?: string;
  fileSha256?: string;
  rulesFileId?: string;
  rulesSha256?: string;
}

export interface NativeRunOutput {
  name: string;
  relPath: string;
  sha256: string;
  bytes: number;
}

export interface NativeToolRun {
  id: string;
  requestId: string;
  profileId: string;
  installationId: string;
  engagementId?: string;
  scopeId?: string;
  scopeRevision?: number;
  targetId?: string;
  target?: string;
  state:
    | "queued"
    | "starting"
    | "running"
    | "cancelling"
    | "succeeded"
    | "failed"
    | "timed_out"
    | "cancelled"
    | "blocked"
    | "orphaned";
  argv: string[];
  commandPreview: string;
  pid?: number;
  startedAt?: number;
  endedAt?: number;
  exitCode?: number;
  terminationReason: string;
  workingDir: string;
  artifactDir: string;
  stdoutTail: string;
  stderrTail: string;
  bytesOut: number;
  bytesErr: number;
  truncated: boolean;
  blockedReason: string;
  artifacts: NativeRunArtifact[];
  /** `external`: a program the user registered (Rust ledger v2). */
  kind: "external";
  /** Who started it; `legacy` for a run kept before triggers were recorded. */
  trigger: NativeRunTrigger;
  /** What a descriptor run read. */
  subject?: NativeRunSubject;
  /** The descriptor a run was built from (`external_tools`). */
  descriptorId?: string;
  /** The run's logs, hashed when it ended. */
  outputs: NativeRunOutput[];
  /** What the descriptor's parser found. */
  observations: Observation[];
  createdAt: number;
  updatedAt: number;
}

export interface NativeToolRunEvent {
  runId: string;
  kind:
    | "queued"
    | "started"
    | "stdout"
    | "stderr"
    | "output_truncated"
    | "artifact"
    | "finished"
    | "failed"
    | "cancelled"
    | "timed_out"
    | "blocked";
  at: number;
  stream?: "stdout" | "stderr";
  chunk?: string;
  state?: string;
  pid?: number;
  exitCode?: number;
  reason?: string;
  artifact?: NativeRunArtifact;
}

export interface NativeToolSupervisor {
  available(): boolean;
  /**
   * Read the **native-owned** Private Lab consent state (see ADR 0007).
   *
   * This is the authorization of record. The `privateToolsEnabled` preference
   * is a renderer-side mirror that drives the UI; it cannot authorize anything
   * on its own, because everything in the document store is reachable from the
   * webview. Every native tool command is gated on this value in Rust.
   */
  consentGranted(): Promise<boolean>;
  /**
   * Ask Rust to show the native grant dialog. The locale selects the words;
   * the renderer does not supply them. `true` means consent is granted.
   */
  requestGrant(locale: string): Promise<boolean>;
  /** Revoke Private Lab. No dialog: turning it off is the safe direction. */
  revoke(): Promise<void>;
  /**
   * Open the native file picker (Rust opens it; the renderer supplies only its
   * translated wording) and inspect the chosen executable. Resolves to null
   * when the user cancels.
   */
  locateCandidate(
    title: string,
    filterName: string,
  ): Promise<NativeLocatedCandidate | null>;
  /**
   * Look for the toolbox's programs in the usual places on this computer
   * (read only; nothing is run). Items named in `skipCatalogIds` are not
   * looked for. Each find Rust does not hold yet is held for review and
   * registers by token, through the same `register` as a picked file.
   */
  detectInstallations(skipCatalogIds: string[]): Promise<NativeDetectedTool[]>;
  register(request: RegisterNativeToolRequest): Promise<NativeToolInstallation>;
  listInstallations(): Promise<NativeToolInstallation[]>;
  reverify(
    id: string,
    acceptChangedIdentity: boolean,
  ): Promise<NativeToolInstallation>;
  setEnabled(id: string, enabled: boolean): Promise<NativeToolInstallation>;
  remove(id: string): Promise<void>;
  start(request: StartNativeToolRunRequest): Promise<NativeToolRun>;
  cancel(runId: string): Promise<void>;
  emergencyStop(): Promise<number>;
  listRuns(): Promise<NativeToolRun[]>;
  listActiveRuns(): Promise<NativeToolRun[]>;
  deleteArtifacts(runId: string): Promise<NativeToolRun>;
  onEvent(listener: (event: NativeToolRunEvent) => void): Promise<() => void>;
  /**
   * Launch a registered installation as a detached, unsupervised GUI
   * process. The caller passes only an `installationId` — never a path —
   * and the native side resolves it server-side through the same gate the
   * batch Run button uses: enabled check, stored changed-identity check,
   * and a live re-hash of the binary on disk against the stored hash, so
   * drift since the last reverify is caught at launch time rather than
   * read off a stale flag. Refuses a missing, disabled, identity-changed,
   * or path-missing installation. Not tracked by the run ledger; the
   * launched process owns its own lifetime.
   *
   * Every attempt Rust makes is recorded in its launch ledger and comes
   * back as `receipt` (data contracts §4). Each call carries a fresh operation
   * id; `ok` is true only for outcome `launched`, which means "launched
   * externally", never "succeeded".
   *
   * A refusal never throws: it resolves to `{ ok: false, reason }`, the
   * same honest-result shape `SecureStore` uses, so the caller can map a
   * known reason (e.g. `tool_disabled`, `tool_identity_changed`,
   * `elevation_required`) to translated copy instead of a raw code
   * reaching the user. `reason` is a stable code string from Rust, or
   * `"browser_mode"` in the browser stub; an unrecognized reason
   * (`spawn_failed`, `launch_record_failed`, or anything else the caller
   * does not special-case) must still fall back to a generic translated
   * message rather than being dropped. A refusal before any attempt (no
   * consent, a receipt Rust could not write) has no `receipt`.
   */
  launchDetached(
    installationId: string,
    args: string[],
  ): Promise<{ ok: boolean; reason?: string; receipt?: LaunchReceipt }>;
  /** Recent launch receipts from Rust's ledger, newest first. */
  listLaunches(limit?: number): Promise<LaunchReceipt[]>;
  /** New and updated receipts, from either launch route. */
  onLaunch(listener: (receipt: LaunchReceipt) => void): Promise<() => void>;
}

/**
 * A GUI launch as Rust recorded it (`launch_receipts.rs`). Rust is
 * the authority: the renderer displays receipts and never writes them.
 * `tracking` is always `"unmanaged"`: a launched application owns its own
 * lifetime, so a receipt is never "running" and Stop all does not apply.
 * `outcome: "unknown"` means the app stopped between the spawn and the
 * record. No arguments are kept.
 */
export interface LaunchReceipt {
  launchId: string;
  operationId: string;
  installationId: string;
  displayName: string;
  origin: "manual" | "assistant";
  requestedAt: number;
  spawnedAt: number | null;
  pid: number | null;
  outcome: "launched" | "failed" | "unknown";
  tracking: "unmanaged";
  reasonCode: string | null;
  /** False when the outcome is true but could not be written to disk. */
  recorded: boolean;
}

export interface RunningAppInfo {
  name: string;
  executable: string;
  windowTitle: string;
  bounds: { monitor: number; x: number; y: number; w: number; h: number };
  elevated: boolean;
  singleInstance: boolean;
}

export interface MonitorInfo {
  index: number;
  width: number;
  height: number;
  scale: number;
}

export type RestoreStepEvent =
  | { kind: "state"; itemId: string; state: string; reason?: string }
  | { kind: "done"; status: "completed" | "partial" | "cancelled" };

export interface DesktopBridge {
  readonly mode: "browser" | "tauri";
  capabilities(): BridgeCapabilities;
  listRunningApps(): Promise<RunningAppInfo[]>;
  listMonitors(): Promise<MonitorInfo[]>;
  /**
   * Restore snapshot items one by one. Emits per-item state transitions.
   * Returns a cancel function.
   */
  restoreItems(
    items: SnapshotItem[],
    onEvent: (e: RestoreStepEvent) => void,
  ): { cancel: () => void };
  openUrl(url: string): Promise<{ ok: boolean; simulated: boolean }>;
  openPath(path: string): Promise<{ ok: boolean; simulated: boolean }>;
  /**
   * Native file or folder picker. Returns null when cancelled or unavailable
   * (browser/demo never invents a path).
   */
  pickPath(options?: { directory?: boolean }): Promise<string | null>;
  writeClipboard(text: string): Promise<{ ok: boolean }>;
  notify(title: string, body: string): Promise<{ ok: boolean; simulated: boolean }>;
  /**
   * Tell Rust the previous renderer is gone: cancel its assistant turn and
   * close its PTYs. Browser/demo is a no-op. Crash-without-reload is not
   * covered — that gap is accepted.
   */
  abandonPreviousRenderer(): Promise<{
    cancelledTurn: boolean;
    closedSessions: number;
  }>;
  /**
   * OS-backed secret storage (Windows Credential Manager in the native build).
   * Secrets never touch SQLite, localStorage, logs or exports. In browser/demo
   * mode this is honestly unavailable — it never silently stores a secret.
   */
  secureStore: SecureStore;
  toolSupervisor: NativeToolSupervisor;
  terminal: TerminalController;
}

export interface SecureStoreResult {
  ok: boolean;
  reason?: "browser_mode" | "not_implemented" | string;
}

export interface SecureStore {
  /** True only when a real OS credential store backs this session. */
  available(): boolean;
  set(key: string, value: string): Promise<SecureStoreResult>;
  has(key: string): Promise<boolean>;
  /** Idempotent — deleting a missing key succeeds. */
  delete(key: string): Promise<SecureStoreResult>;
}
