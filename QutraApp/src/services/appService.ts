import { getDb } from "@/lib/db/database";
import { getBridge } from "@/lib/bridge";
import { createId } from "@/lib/id";
import { now } from "@/lib/time";
import { recordDiagnosticError } from "@/lib/diagnostics";
import type { EngagementKind } from "@/domain/lab";
import {
  conditionsMatch,
  isRateLimited,
} from "@/domain/automations";
import type {
  ActivityEvent,
  ActivityEventType,
  Automation,
  RestoreItemResult,
  RestoreRun,
  Session,
  Snapshot,
  SnapshotItem,
  Task,
} from "@/domain/types";

/* ============================================================
   Application service layer: multi-collection workflows.
   Every meaningful action records an ActivityEvent, which in
   turn can fire automations (visible, rate-limited, safe).
   ============================================================ */

/** Always logged so users can audit enabling/disabling capture itself. */
const PRIVACY_AUDIT_TYPES: ReadonlySet<ActivityEventType> = new Set([
  "privacy_paused",
  "privacy_resumed",
  "permission_changed",
]);

/**
 * Record an activity event and optionally fire automations.
 * When `activityTrackingEnabled` is false, activity is dropped entirely
 * (no row, no automation). Privacy/permission audit types are exempt so
 * the kill switch itself remains auditable.
 */
export function recordEvent(
  type: ActivityEventType,
  label: string,
  opts: Partial<Pick<ActivityEvent, "workspaceId" | "refId" | "detail" | "minutes">> = {},
): ActivityEvent | undefined {
  const db = getDb();
  const trackingOn = db.prefs.get().activityTrackingEnabled;
  if (!trackingOn && !PRIVACY_AUDIT_TYPES.has(type)) {
    return undefined;
  }
  const event: ActivityEvent = {
    id: createId("ev"),
    type,
    at: now(),
    label,
    detail: opts.detail ?? "",
    minutes: opts.minutes ?? 0,
    workspaceId: opts.workspaceId,
    refId: opts.refId,
    demo: false,
  };
  db.collection("events").put(event);
  if (trackingOn) {
    void fireAutomations(type, event).catch((error) => {
      recordDiagnosticError(error, "automation-trigger");
    });
  }
  return event;
}

/* ---------- Automations ---------- */

const TRIGGER_MAP: Partial<Record<ActivityEventType, Automation["trigger"]>> = {
  session_started: "session_started",
  session_ended: "session_ended",
  workspace_opened: "workspace_opened",
  snapshot_saved: "snapshot_saved",
  restore_run: "restore_completed",
  task_completed: "task_changed",
  task_created: "task_changed",
};

async function fireAutomations(
  type: ActivityEventType,
  event: ActivityEvent,
): Promise<void> {
  const trigger = TRIGGER_MAP[type];
  if (!trigger) return;
  const db = getDb();
  const automations = db.collection("automations").getAll();
  const runs = db.collection("automationRuns").getAll();
  const workspace = event.workspaceId
    ? db.collection("workspaces").get(event.workspaceId)
    : undefined;

  for (const automation of automations) {
    if (!automation.enabled || automation.trigger !== trigger) continue;
    const match = conditionsMatch(automation, {
      workspace,
      branch: workspace?.git?.branch,
    });
    if (!match.ok) continue;
    if (isRateLimited(automation, runs)) {
      await db.collection("automationRuns").putDurable({
        id: createId("ar"),
        automationId: automation.id,
        at: now(),
        status: "skipped",
        detail: "rate_limited",
        demo: false,
      });
      continue;
    }
    await executeAutomation(automation, event);
  }
}

export type AutomationActionStatus =
  | "succeeded"
  | "failed"
  | "skipped"
  | "blocked";

export interface AutomationActionResult {
  type: Automation["actions"][number]["type"];
  status: AutomationActionStatus;
  detail: string;
}

export interface AutomationExecutionResult {
  ok: boolean;
  status: "success" | "failed" | "partial" | "blocked" | "skipped";
  detail: string;
  actions: AutomationActionResult[];
}

export async function executeAutomation(
  automation: Automation,
  event?: ActivityEvent,
  options: { confirmed?: boolean } = {},
): Promise<AutomationExecutionResult> {
  const db = getDb();
  const actions: AutomationActionResult[] = [];
  const addResult = (
    type: AutomationActionResult["type"],
    status: AutomationActionStatus,
    detail: string,
  ) => actions.push({ type, status, detail });

  if (automation.requiresConfirmation && !options.confirmed) {
    for (const action of automation.actions) {
      addResult(action.type, "blocked", "confirmation_required");
    }
  } else {
    for (const action of automation.actions) {
      try {
        switch (action.type) {
          case "create_task": {
            await db.collection("tasks").putDurable({
              id: createId("task"),
              title: action.param || "Automation task",
              description: `Created by automation "${automation.name}"`,
              workspaceId: event?.workspaceId,
              status: "todo",
              priority: "none",
              tags: ["automation"],
              blockedByIds: [],
              recurrence: "none",
              carriedOverCount: 0,
              demo: false,
              createdAt: now(),
              updatedAt: now(),
            });
            addResult(
              action.type,
              "succeeded",
              action.param || "Automation task",
            );
            break;
          }
          case "notify": {
            const nativeResult = await getBridge().notify(
              "Qutra Labs",
              action.param,
            );
            addResult(
              action.type,
              nativeResult.simulated
                ? "blocked"
                : nativeResult.ok
                  ? "succeeded"
                  : "failed",
              nativeResult.simulated
                ? "browser_mode"
                : nativeResult.ok
                  ? action.param
                  : "notification_failed",
            );
            break;
          }
          case "apply_tag": {
            if (!event?.workspaceId) {
              addResult(action.type, "skipped", "no_workspace_context");
              break;
            }
            const workspace = db
              .collection("workspaces")
              .get(event.workspaceId);
            if (!workspace) {
              addResult(action.type, "failed", "workspace_not_found");
              break;
            }
            if (!workspace.tags.includes(action.param)) {
              await db.collection("workspaces").patchDurable(workspace.id, {
                tags: [...workspace.tags, action.param],
                updatedAt: now(),
              });
            }
            addResult(action.type, "succeeded", action.param);
            break;
          }
          case "open_resource": {
            const resource = db.collection("resources").get(action.param);
            if (!resource || resource.kind !== "url") {
              addResult(action.type, "failed", "resource_not_found");
              break;
            }
            const nativeResult = await getBridge().openUrl(resource.target);
            addResult(
              action.type,
              nativeResult.simulated
                ? "blocked"
                : nativeResult.ok
                  ? "succeeded"
                  : "failed",
              nativeResult.simulated
                ? "browser_mode"
                : nativeResult.ok
                  ? resource.title
                  : "open_failed",
            );
            break;
          }
          case "run_command":
          case "webhook":
          case "export_report":
          case "capture_snapshot":
          case "start_timer":
            addResult(action.type, "blocked", "not_implemented");
            break;
        }
      } catch {
        addResult(action.type, "failed", "execution_failed");
      }
    }
  }

  const succeeded = actions.filter(
    (action) => action.status === "succeeded",
  ).length;
  const hasFailed = actions.some((action) => action.status === "failed");
  const hasBlocked = actions.some((action) => action.status === "blocked");
  const hasSkipped = actions.some((action) => action.status === "skipped");
  const status: AutomationExecutionResult["status"] = hasFailed
    ? succeeded > 0
      ? "partial"
      : "failed"
    : hasBlocked
      ? succeeded > 0
        ? "partial"
        : "blocked"
      : hasSkipped
        ? succeeded > 0
          ? "partial"
          : "skipped"
        : "success";
  const detail = actions
    .map((action) => `${action.type}:${action.status} (${action.detail})`)
    .join(" · ");
  const run = {
    id: createId("ar"),
    automationId: automation.id,
    at: now(),
    status,
    detail,
    demo: false,
  };
  await db.collection("automationRuns").putDurable(run);
  await db.collection("automations").patchDurable(automation.id, {
    lastRunAt: run.at,
  });
  recordAutomationEvent(automation, run.status);
  return {
    ok: status === "success",
    status,
    detail,
    actions,
  };
}

function recordAutomationEvent(automation: Automation, status: string) {
  // Goes through recordEvent so the activity kill switch applies.
  recordEvent("automation_run", automation.name, {
    detail: status,
    workspaceId: automation.conditions.find((c) => c.field === "workspace")
      ?.value,
    refId: automation.id,
  });
}

/* ---------- Sessions ---------- */

export function startSession(input: {
  workspaceId: string;
  title: string;
  intendedOutcome?: string;
  plannedMinutes?: number;
  linkedTaskIds?: string[];
  resourceIds?: string[];
  distractionTracking?: boolean;
  autoSnapshot?: Session["autoSnapshot"];
}): Session {
  const db = getDb();
  const session: Session = {
    id: createId("sess"),
    workspaceId: input.workspaceId,
    title: input.title,
    intendedOutcome: input.intendedOutcome ?? "",
    status: "active",
    startedAt: now(),
    pausedTotalMs: 0,
    plannedMinutes: input.plannedMinutes,
    linkedTaskIds: input.linkedTaskIds ?? [],
    resourceIds: input.resourceIds ?? [],
    distractionTracking: input.distractionTracking ?? false,
    autoSnapshot: input.autoSnapshot ?? "on_end",
    interruptions: [],
    demo: false,
    createdAt: now(),
    updatedAt: now(),
  };
  db.collection("sessions").put(session);
  db.collection("workspaces").patch(input.workspaceId, {
    lastActivityAt: now(),
    updatedAt: now(),
  });
  recordEvent("session_started", session.title, {
    workspaceId: session.workspaceId,
    refId: session.id,
    detail: session.intendedOutcome,
  });
  return session;
}

export function getActiveSession(): Session | undefined {
  return getDb()
    .collection("sessions")
    .getAll()
    .find((s) => s.status === "active" || s.status === "paused");
}

export function pauseSession(id: string): void {
  getDb().collection("sessions").patch(id, {
    status: "paused",
    pausedAt: now(),
    updatedAt: now(),
  });
}

export function resumeSession(id: string): void {
  const db = getDb();
  const s = db.collection("sessions").get(id);
  if (!s) return;
  const pausedMs = s.pausedAt ? now() - s.pausedAt : 0;
  db.collection("sessions").patch(id, {
    status: "active",
    pausedAt: undefined,
    pausedTotalMs: s.pausedTotalMs + pausedMs,
    updatedAt: now(),
  });
}

export function endSession(
  id: string,
  review: NonNullable<Session["review"]>,
): Session | undefined {
  const db = getDb();
  const s = db.collection("sessions").get(id);
  if (!s) return undefined;
  const pausedExtra =
    s.status === "paused" && s.pausedAt ? now() - s.pausedAt : 0;
  const updated = db.collection("sessions").patch(id, {
    status: "completed",
    endedAt: now(),
    pausedAt: undefined,
    pausedTotalMs: s.pausedTotalMs + pausedExtra,
    review,
    updatedAt: now(),
  });
  const minutes = updated?.startedAt
    ? Math.round(
        ((updated.endedAt ?? now()) -
          updated.startedAt -
          updated.pausedTotalMs) /
          60_000,
      )
    : 0;
  db.collection("workspaces").patch(s.workspaceId, {
    lastActivityAt: now(),
    updatedAt: now(),
    health: review.unresolved ? "needs_handoff" : "ready",
  });
  recordEvent("session_ended", s.title, {
    workspaceId: s.workspaceId,
    refId: s.id,
    detail: review.completedWork,
    minutes,
  });
  return updated;
}

export function logInterruption(sessionId: string, reason: string): void {
  const db = getDb();
  const s = db.collection("sessions").get(sessionId);
  if (!s) return;
  db.collection("sessions").patch(sessionId, {
    interruptions: [
      ...s.interruptions,
      { id: createId("int"), at: now(), reason, minutes: 0 },
    ],
    updatedAt: now(),
  });
}

export function returnFromInterruption(sessionId: string): void {
  const db = getDb();
  const s = db.collection("sessions").get(sessionId);
  if (!s) return;
  const last = s.interruptions[s.interruptions.length - 1];
  if (!last || last.returnedAt) return;
  const minutes = Math.round((now() - last.at) / 60_000);
  db.collection("sessions").patch(sessionId, {
    interruptions: s.interruptions.map((i) =>
      i.id === last.id ? { ...i, returnedAt: now(), minutes } : i,
    ),
    updatedAt: now(),
  });
}

/* ---------- Snapshot capture ---------- */

export interface CaptureCandidate extends SnapshotItem {
  excludedBy?: string;
}

/** Build capture candidates from the bridge + current context. */
export async function buildCaptureCandidates(
  workspaceId: string,
): Promise<{ candidates: CaptureCandidate[]; excluded: CaptureCandidate[] }> {
  const db = getDb();
  const bridge = getBridge();
  const ws = db.collection("workspaces").get(workspaceId);
  const exclusions = db.collection("exclusions").getAll();
  const candidates: CaptureCandidate[] = [];
  const excluded: CaptureCandidate[] = [];

  const apps = await bridge.listRunningApps();
  const appsAreSimulated = bridge.capabilities().runningApps.simulated;
  for (const app of apps) {
    const item: CaptureCandidate = {
      id: createId("si"),
      kind: "app",
      title: app.name,
      detail: app.windowTitle,
      target: app.executable,
      windowBounds: app.bounds,
      selected: !appsAreSimulated,
      sensitive: false,
      provenance: appsAreSimulated ? "simulated" : "native_observed",
    };
    const rule = exclusions.find(
      (r) =>
        r.kind === "app" &&
        app.name.toLowerCase().includes(r.value.toLowerCase()),
    );
    if (rule) {
      item.excludedBy = rule.value;
      excluded.push(item);
    } else {
      candidates.push(item);
    }
  }

  // Browser tabs from workspace resources (browser integration is
  // permission-gated; resources stand in as saved tab collections).
  const resources = db
    .collection("resources")
    .getAll()
    .filter((r) => r.workspaceId === workspaceId && r.kind === "url");
  for (const res of resources.slice(0, 6)) {
    let detail = res.target;
    try {
      detail = new URL(res.target).hostname || res.target;
    } catch {
      // Keep malformed legacy resource values visible without crashing capture.
    }
    candidates.push({
      id: createId("si"),
      kind: "browser_tab",
      title: res.title,
      detail,
      target: res.target,
      selected: true,
      sensitive: false,
      provenance: "saved_resource",
    });
  }

  // Git state
  if (ws?.git?.connected) {
    candidates.push({
      id: createId("si"),
      kind: "git",
      title: ws.git.branch ?? "repository",
      detail: `${ws.git.dirtyFiles} changed · ${ws.git.ahead} ahead`,
      target: ws.localPath ?? "",
      selected: true,
      sensitive: false,
      provenance: "workspace_metadata",
    });
  }

  // Terminal context
  if (ws?.localPath) {
    candidates.push({
      id: createId("si"),
      kind: "terminal",
      title: "Windows Terminal",
      detail: `cwd: ${ws.localPath}`,
      target: "wt.exe",
      selected: true,
      sensitive: false,
      provenance: "workspace_metadata",
    });
  }

  return { candidates, excluded };
}

export async function captureSnapshot(input: {
  workspaceId: string;
  sessionId?: string;
  name: string;
  handoff: string;
  items: SnapshotItem[];
  setAsResume: boolean;
}): Promise<Snapshot> {
  const db = getDb();
  const bridge = getBridge();
  const monitors = await bridge.listMonitors();
  const snapshot: Snapshot = {
    id: createId("snap"),
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    name: input.name,
    handoff: input.handoff,
    items: input.items.filter((i) => i.selected),
    monitors,
    appVersion: "0.1.0",
    demo: false,
    createdAt: now(),
  };
  db.collection("snapshots").put(snapshot);
  if (input.setAsResume) {
    db.collection("workspaces").patch(input.workspaceId, {
      resumeSnapshotId: snapshot.id,
      health: "ready",
      updatedAt: now(),
    });
  }
  recordEvent("snapshot_saved", snapshot.name, {
    workspaceId: snapshot.workspaceId,
    refId: snapshot.id,
    detail: `${snapshot.items.length} items`,
  });
  return snapshot;
}

/* ---------- Restore ---------- */

export function createRestoreRun(snapshot: Snapshot, items: SnapshotItem[]): RestoreRun {
  const db = getDb();
  const run: RestoreRun = {
    id: createId("rr"),
    snapshotId: snapshot.id,
    workspaceId: snapshot.workspaceId,
    startedAt: now(),
    status: "running",
    simulated: getBridge().mode === "browser",
    items: items.map((i) => ({ itemId: i.id, state: "queued" as const })),
    demo: false,
  };
  db.collection("restoreRuns").put(run);
  return run;
}

export function finishRestoreRun(
  runId: string,
  status: RestoreRun["status"],
  items: RestoreItemResult[],
): void {
  const db = getDb();
  const run = db.collection("restoreRuns").get(runId);
  if (!run) return;
  db.collection("restoreRuns").patch(runId, {
    status,
    finishedAt: now(),
    items,
  });
  const failed = items.filter(
    (i) => i.state === "failed" || i.state === "permission_required",
  ).length;
  recordEvent("restore_run", `Restore ${status}`, {
    workspaceId: run.workspaceId,
    refId: runId,
    detail: failed > 0 ? `${failed} failed/permission` : "all restored",
  });
}

/* ---------- Tasks ---------- */

export function completeTask(taskId: string, evidence?: Task["evidence"]): void {
  const db = getDb();
  const task = db.collection("tasks").get(taskId);
  if (!task) return;
  db.collection("tasks").patch(taskId, {
    status: "done",
    completedAt: now(),
    updatedAt: now(),
    evidence: evidence ?? task.evidence,
  });
  recordEvent("task_completed", task.title, {
    workspaceId: task.workspaceId,
    refId: task.id,
  });
}

/**
 * Capture a thought straight into the project backlog. With the standalone
 * inbox retired, this is the single capture path: text in, task out, so a
 * capture is never stranded in a surface the product no longer has.
 */
export function addTask(input: {
  title: string;
  workspaceId?: string;
  description?: string;
}): Task {
  const db = getDb();
  const stamp = now();
  const task: Task = {
    id: createId("task"),
    title: input.title,
    description: input.description ?? "",
    workspaceId: input.workspaceId,
    status: "backlog",
    priority: "none",
    tags: [],
    blockedByIds: [],
    recurrence: "none",
    carriedOverCount: 0,
    demo: false,
    createdAt: stamp,
    updatedAt: stamp,
  };
  db.collection("tasks").put(task);
  recordEvent("task_created", task.title, {
    workspaceId: task.workspaceId,
    refId: task.id,
  });
  return task;
}

/** A new, empty engagement (an investigation in the UI) with its own (empty)
 *  authorization scope, and the kind chosen for it, if any. Shared by the Lab
 *  page and the command palette so both create the same record. */
export function createEngagement(title: string, kind?: EngagementKind): string {
  const db = getDb();
  const id = createId("eng");
  const scopeId = createId("sc");
  const t0 = now();
  db.collection("authorizationScopes").put({
    id: scopeId,
    engagementId: id,
    ownerLabel: "",
    description: "",
    allowedTargets: [],
    excludedTargets: [],
    authorizationRef: "",
    testerAck: false,
    revision: 1,
    notes: "",
    demo: false,
    createdAt: t0,
    updatedAt: t0,
  });
  db.collection("engagements").put({
    id,
    title,
    purpose: "training_lab",
    ...(kind ? { kind } : {}),
    status: "planned",
    clientLabel: "",
    contacts: [],
    notes: "",
    tags: [],
    scopeId,
    demo: false,
    createdAt: t0,
    updatedAt: t0,
  });
  return id;
}
