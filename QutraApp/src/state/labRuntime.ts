import { create } from "zustand";
import { getBridge } from "@/lib/bridge";
import { getDb, sameDocument } from "@/lib/db/database";
import { isTauriRuntime } from "@/lib/runtime";
import type {
  NativeToolInstallation,
  NativeToolRun,
} from "@/lib/bridge/types";
import type { Artifact, ToolInstallation, ToolRun } from "@/domain/lab";

/* ============================================================
   Shared Lab runtime.

   A single owner of the native tool-supervisor subscription and its
   installation/run state. The workbench Bottom Panel (live output), the Runs
   view, the Run Inspector and the Tool Library all read from here, so there is
   exactly one event subscription and one mirror of native records into the
   document store — never a per-component duplicate.
   ============================================================ */

export interface LabLogLine {
  at: number;
  stream: "stdout" | "stderr";
  text: string;
}

/** Per-run captured line cap — bounds memory so the Output panel never grows
    without limit even under a chatty tool. */
const MAX_LOG_LINES = 2000;

export interface OutsideLiveRun {
  id: string;
  engagementId?: string;
}

interface LabRuntimeState {
  available: boolean;
  ready: boolean;
  generation: number;
  installations: NativeToolInstallation[];
  runs: NativeToolRun[];
  /**
   * The runs of outside programs (ExifTool, YARA, capinfos) that are live in
   * Rust, by id and investigation only. `runs` leaves them out because their
   * command lines hold a copy's path; what counts and stops runs needs just
   * this much.
   */
  outsideLive: OutsideLiveRun[];
  logs: Record<string, LabLogLine[]>;
  clearedLogs: Record<string, boolean>;
  selectedRunId: string | null;
  error: string;
  /**
   * The last read of installations and runs failed. Kept apart from `error`,
   * which launch failures share, so Home can tell "none" from "unknown".
   */
  readFailed: boolean;
  subscribed: boolean;

  refresh(): Promise<void>;
  ensureSubscribed(): void;
  /**
   * Drop the native subscription and every native-derived record held in
   * memory. Called when Private Lab consent is withdrawn, so revoking takes
   * effect immediately instead of leaving a live event stream and a populated
   * tool list behind until the next restart.
   *
   * Invalidates the current generation first. In-flight `refresh()` and a
   * late `listen()` must not repopulate state or the persisted mirror after
   * that, and a mirror write still queued is discarded.
   */
  revoke(): void;
  selectRun(id: string | null): void;
  clearLog(runId: string): void;
  setError(error: string): void;
}

let unlisten: (() => void) | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
/** Reads are numbered as they start. One that lands after a later read was
    applied is stale: it changes neither the state nor the mirror. */
let readsStarted = 0;
let readApplied = 0;

/* ---------- Mirror into the document store (data contracts §8)

   The store keeps durable summaries: lifecycle transitions, final summaries
   and artifacts. Output moves a live run's tail, byte counters, artifact
   sizes and updatedAt many times a second; those stay in runtime state and
   reach the store with the run's next transition. Each refresh is diffed
   against the store and costs at most one write per collection, none when
   nothing changed. The mirror never deletes: a failed read is not an empty
   snapshot, and saved history never says what is running now. */

const LIVE_RUN_STATES = new Set<string>([
  "queued",
  "starting",
  "running",
  "cancelling",
]);

function installationDocument(item: NativeToolInstallation): ToolInstallation {
  return {
    id: item.id,
    displayName: item.displayName,
    runner: item.runner,
    path: item.canonicalPath,
    sha256: item.sha256,
    sizeBytes: item.sizeBytes,
    modifiedAt: item.modifiedAt ?? undefined,
    version: item.version,
    publisher: item.publisher,
    signatureState: item.signatureState,
    category: item.category,
    riskTier: item.riskTier,
    docUrl: item.docUrl,
    iconEmoji: "",
    tags: item.tags,
    workingDir: item.workingDir,
    enabled: item.enabled,
    lastVerifiedAt: item.lastVerifiedAt,
    changedSinceVerify: item.changedSinceVerify,
    demo: false,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function runDocument(item: NativeToolRun): ToolRun {
  return {
    id: item.id,
    profileId: item.profileId,
    installationId: item.installationId,
    engagementId: item.engagementId ?? undefined,
    scopeId: item.scopeId ?? undefined,
    scopeRevision: item.scopeRevision ?? undefined,
    targetId: item.targetId ?? undefined,
    target: item.target ?? undefined,
    state: item.state,
    argv: item.argv,
    commandPreview: item.commandPreview,
    pid: item.pid ?? undefined,
    startedAt: item.startedAt ?? undefined,
    endedAt: item.endedAt ?? undefined,
    exitCode: item.exitCode ?? undefined,
    terminationReason: item.terminationReason,
    workingDir: item.workingDir,
    artifactDir: item.artifactDir,
    stdoutTail: item.stdoutTail,
    stderrTail: item.stderrTail,
    bytesOut: item.bytesOut,
    truncated: item.truncated,
    blockedReason: item.blockedReason,
    kind: item.kind,
    trigger: item.trigger,
    subject: item.subject,
    descriptorId: item.descriptorId,
    outputs: item.outputs,
    demo: false,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/** A table keyed by run id, without these runs. */
function omitRuns<T>(table: Record<string, T>, ids: ReadonlySet<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(table).filter(([id]) => !ids.has(id)));
}

function artifactDocuments(item: NativeToolRun): Artifact[] {
  return item.artifacts.map((artifact) => ({
    id: `${item.id}-${artifact.kind}`,
    runId: item.id,
    engagementId: item.engagementId ?? undefined,
    name: `${item.id} ${artifact.kind}`,
    kind:
      artifact.kind === "stdout" || artifact.kind === "stderr"
        ? artifact.kind
        : "file",
    path: artifact.path,
    sha256: "",
    sizeBytes: artifact.sizeBytes,
    mime: "text/plain",
    demo: false,
    createdAt: item.endedAt ?? item.createdAt,
  }));
}

/** A live run without the fields its output moves. */
function runLifecycle(run: ToolRun): Partial<ToolRun> {
  return {
    ...run,
    stdoutTail: undefined,
    stderrTail: undefined,
    bytesOut: undefined,
    truncated: undefined,
    updatedAt: undefined,
  };
}

function runChanged(existing: ToolRun, next: ToolRun): boolean {
  if (!LIVE_RUN_STATES.has(next.state)) return !sameDocument(existing, next);
  return !sameDocument(runLifecycle(existing), runLifecycle(next));
}

async function mirrorSnapshot(
  installations: NativeToolInstallation[],
  runs: NativeToolRun[],
  shouldCommit: () => boolean,
): Promise<void> {
  const db = getDb();
  const liveRunIds = new Set(
    runs.filter((run) => LIVE_RUN_STATES.has(run.state)).map((run) => run.id),
  );
  const artifactChanged = (existing: Artifact, next: Artifact) =>
    next.runId !== undefined && liveRunIds.has(next.runId)
      ? !sameDocument(
          { ...existing, sizeBytes: undefined },
          { ...next, sizeBytes: undefined },
        )
      : !sameDocument(existing, next);
  await Promise.all([
    db
      .collection("toolInstallations")
      .upsertManyDurable(installations.map(installationDocument), {
        shouldCommit,
      }),
    db.collection("toolRuns").upsertManyDurable(runs.map(runDocument), {
      changed: runChanged,
      shouldCommit,
    }),
    db
      .collection("artifacts")
      .upsertManyDurable(runs.flatMap(artifactDocuments), {
        changed: artifactChanged,
        shouldCommit,
      }),
  ]);
}

export const useLabRuntime = create<LabRuntimeState>((set, get) => ({
  // The router imports this store before main.tsx preloads TauriBridge. Runtime
  // detection is synchronous and side-effect free, so native bridge creation
  // remains deferred until refresh/ensureSubscribed runs after desktop boot.
  available: isTauriRuntime(),
  ready: false,
  generation: 0,
  installations: [],
  runs: [],
  outsideLive: [],
  logs: {},
  clearedLogs: {},
  selectedRunId: null,
  error: "",
  readFailed: false,
  subscribed: false,

  refresh: async () => {
    const mine = get().generation;
    const read = ++readsStarted;
    const supervisor = getBridge().toolSupervisor;
    if (!supervisor.available()) {
      if (get().generation !== mine) return;
      set({ available: false, ready: true });
      return;
    }
    const current = () => get().generation === mine && read > readApplied;
    try {
      const [installations, listed] = await Promise.all([
        supervisor.listInstallations(),
        supervisor.listRuns(),
      ]);
      if (!current()) return;
      readApplied = read;
      // A run made from a descriptor (ExifTool, YARA, capinfos) belongs to its
      // file's Önerilen analiz. Its argument list, command line and output
      // tails name the verified copy's path, so none of the old run lists, the
      // Output panel, the save-as-evidence action or the mirror below ever
      // receives one. A live one is still counted and stoppable: its id and
      // investigation go to `outsideLive`, and no more.
      const described = new Set(listed.filter((r) => r.descriptorId).map((r) => r.id));
      const runs = described.size > 0 ? listed.filter((r) => !described.has(r.id)) : listed;
      const outsideLive = listed
        .filter((r) => described.has(r.id) && LIVE_RUN_STATES.has(r.state))
        .map((r): OutsideLiveRun => ({ id: r.id, engagementId: r.engagementId ?? undefined }));
      const selected = get().selectedRunId;
      const selectedRunId = runs.some((r) => r.id === selected)
        ? selected
        : (runs[0]?.id ?? null);
      set({
        installations,
        runs,
        outsideLive,
        selectedRunId,
        ready: true,
        available: true,
        readFailed: false,
        ...(described.size > 0
          ? {
              logs: omitRuns(get().logs, described),
              clearedLogs: omitRuns(get().clearedLogs, described),
            }
          : {}),
      });
      // The store follows the state. A failed write leaves the live view as
      // it is; the next refresh diffs against what did commit.
      await mirrorSnapshot(
        installations,
        runs,
        () => get().generation === mine,
      ).catch((caught: unknown) => {
        console.error("[Qutra Labs] Lab mirror write failed:", caught);
      });
    } catch (caught) {
      if (!current()) return;
      readApplied = read;
      set({ error: String(caught), ready: true, readFailed: true });
    }
  },

  ensureSubscribed: () => {
    if (get().subscribed) return;
    const supervisor = getBridge().toolSupervisor;
    if (!supervisor.available()) {
      set({ available: false, ready: true });
      return;
    }
    const mine = get().generation;
    set({ subscribed: true });
    void get().refresh();
    void supervisor
      .onEvent((event) => {
        if (get().generation !== mine) return;
        // Capture stdout/stderr chunks with their real timestamp + stream so
        // the Output panel shows genuine per-line provenance, not fabricated
        // timestamps. State changes trigger a (debounced) run refresh.
        if (
          (event.kind === "stdout" || event.kind === "stderr") &&
          event.chunk
        ) {
          const stream = event.kind;
          const lines = event.chunk.split(/\r?\n/).filter((l) => l.length > 0);
          if (lines.length > 0) {
            const prev = get().logs[event.runId] ?? [];
            const appended = [
              ...prev,
              ...lines.map((text) => ({ at: event.at, stream, text })),
            ];
            const trimmed =
              appended.length > MAX_LOG_LINES
                ? appended.slice(appended.length - MAX_LOG_LINES)
                : appended;
            set({
              logs: { ...get().logs, [event.runId]: trimmed },
              clearedLogs: {
                ...get().clearedLogs,
                [event.runId]: false,
              },
            });
          }
        }
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
          if (get().generation !== mine) return;
          void get().refresh();
        }, 120);
      })
      .then((cleanup) => {
        if (get().generation !== mine) {
          cleanup();
          return;
        }
        unlisten?.();
        unlisten = cleanup;
      });
  },

  revoke: () => {
    set({ generation: get().generation + 1 });
    unlisten?.();
    unlisten = undefined;
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
    set({
      subscribed: false,
      ready: false,
      installations: [],
      runs: [],
      outsideLive: [],
      logs: {},
      clearedLogs: {},
      selectedRunId: null,
      error: "",
      readFailed: false,
    });
  },

  selectRun: (id) => set({ selectedRunId: id }),
  clearLog: (runId) =>
    set({
      logs: { ...get().logs, [runId]: [] },
      clearedLogs: { ...get().clearedLogs, [runId]: true },
    }),
  setError: (error) => set({ error }),
}));

/** Test/teardown seam. Same generation bump as `revoke()`. */
export function disposeLabRuntime(): void {
  useLabRuntime.getState().revoke();
}
