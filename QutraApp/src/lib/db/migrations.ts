import type { StorageAdapter } from "./storage";
import { conversationFromLegacyHistory } from "@/domain/conversations";
import { createId } from "@/lib/id";

/**
 * Versioned migrations for the browser/demo store.
 * Mirrors the SQL migration set in src-tauri/migrations.
 * Each migration receives the raw adapter and upgrades stored documents.
 */

export const CURRENT_SCHEMA_VERSION = 15;
export const RETIRED_ARCHIVE_KEY = "retired_scope_archive_v12";
export const RETIRED_COLLECTIONS = [
  "notes",
  "snippets",
  "clipboard",
  "inbox",
  "errors",
  "pages",
  "links",
  "savedViews",
] as const;

const CORE_ROUTE_SEGMENTS = new Set([
  "overview",
  "workspaces",
  "files",
  "tools",
  "lab",
  "terminal",
  "github",
  "jarvis",
  "settings",
]);

const RETIRED_PREFERENCE_KEYS = [
  "quickCaptureShortcut",
  "clipboardEnabled",
  "clipboardRetentionDays",
  "clipboardMaxItems",
  "clipboardPausedUntil",
  "labAcademyProgress",
  "labAcademySkillRatings",
  "labAcademySprintProgress",
  "labAcademyRubricScores",
] as const;

function isCoreRoute(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("/")) return false;
  const segment = value.split(/[?#/]/).filter(Boolean)[0];
  return !!segment && CORE_ROUTE_SEGMENTS.has(segment);
}

function redactArchiveString(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED]")
    .replace(
      /\b(password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi,
      "$1=[REDACTED]",
    );
}

function sanitizeArchiveValue(value: unknown, key = ""): unknown {
  if (/password|passwd|pwd|secret|token|credential|api.?key/i.test(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") return redactArchiveString(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeArchiveValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
        childKey,
        sanitizeArchiveValue(child, childKey),
      ]),
    );
  }
  return value;
}

function parseJson(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function normalizeCoreData(storage: StorageAdapter): void {
  const preferences = parseJson(storage.read("preferences"));
  if (preferences && typeof preferences === "object") {
    const next = { ...(preferences as Record<string, unknown>) };
    const retiredPreferences: Record<string, unknown> = {};
    for (const key of RETIRED_PREFERENCE_KEYS) {
      if (key in next) retiredPreferences[key] = next[key];
      delete next[key];
    }
    next.workbenchMode = "core";
    next.workbenchModeRoutes = {};
    next.workbenchTabs = Array.isArray(next.workbenchTabs)
      ? next.workbenchTabs.filter(
          (tab) =>
            !!tab &&
            typeof tab === "object" &&
            isCoreRoute((tab as Record<string, unknown>).route),
        )
      : [];
    next.workbenchRecentlyClosed = Array.isArray(next.workbenchRecentlyClosed)
      ? next.workbenchRecentlyClosed.filter(isCoreRoute)
      : [];
    storage.write("preferences", JSON.stringify(next));

    if (
      Object.keys(retiredPreferences).length > 0 &&
      !storage.read(RETIRED_ARCHIVE_KEY)
    ) {
      storage.write(
        RETIRED_ARCHIVE_KEY,
        JSON.stringify({
          format: "contextos-retired-modules",
          version: 12,
          archivedAt: new Date().toISOString(),
          collections: {},
          preferences: sanitizeArchiveValue(retiredPreferences),
        }),
      );
    }
  }

  const snapshots = parseJson(storage.read("snapshots"));
  if (Array.isArray(snapshots)) {
    for (const snapshot of snapshots) {
      if (!snapshot || typeof snapshot !== "object") continue;
      const row = snapshot as Record<string, unknown>;
      if (Array.isArray(row.items)) {
        row.items = row.items.filter(
          (item) =>
            !item ||
            typeof item !== "object" ||
            (item as Record<string, unknown>).kind !== "note",
        );
      }
    }
    storage.write("snapshots", JSON.stringify(snapshots));
  }

  const tasks = parseJson(storage.read("tasks"));
  if (Array.isArray(tasks)) {
    for (const task of tasks) {
      if (!task || typeof task !== "object") continue;
      const evidence = (task as Record<string, unknown>).evidence;
      if (evidence && typeof evidence === "object") {
        delete (evidence as Record<string, unknown>).noteId;
      }
    }
    storage.write("tasks", JSON.stringify(tasks));
  }

  const permissions = parseJson(storage.read("permissions"));
  if (Array.isArray(permissions)) {
    storage.write(
      "permissions",
      JSON.stringify(
        permissions.filter(
          (item) =>
            !item ||
            typeof item !== "object" ||
            (item as Record<string, unknown>).key !== "clipboard_history",
        ),
      ),
    );
  }

  const automations = parseJson(storage.read("automations"));
  if (Array.isArray(automations)) {
    for (const automation of automations) {
      if (!automation || typeof automation !== "object") continue;
      const row = automation as Record<string, unknown>;
      if (!Array.isArray(row.actions)) continue;
      row.actions = row.actions.map((action) => {
        if (
          action &&
          typeof action === "object" &&
          (action as Record<string, unknown>).type === "create_note"
        ) {
          return { ...action, type: "create_task" };
        }
        return action;
      });
    }
    storage.write("automations", JSON.stringify(automations));
  }

  const events = parseJson(storage.read("events"));
  if (Array.isArray(events)) {
    for (const event of events) {
      if (!event || typeof event !== "object") continue;
      const row = event as Record<string, unknown>;
      if (["note_created", "error_captured", "error_solved"].includes(String(row.type))) {
        row.type = "decision_recorded";
      }
    }
    storage.write("events", JSON.stringify(events));
  }
}

function archiveRetiredCollections(storage: StorageAdapter): void {
  const collections: Record<string, unknown> = {};
  let hasData = false;
  for (const name of RETIRED_COLLECTIONS) {
    const parsed = parseJson(storage.read(name));
    if (Array.isArray(parsed) && parsed.length > 0) {
      collections[name] = sanitizeArchiveValue(parsed);
      hasData = true;
    }
  }

  const existing = parseJson(storage.read(RETIRED_ARCHIVE_KEY));
  if (hasData && !existing) {
    storage.write(
      RETIRED_ARCHIVE_KEY,
      JSON.stringify({
        format: "contextos-retired-modules",
        version: 12,
        archivedAt: new Date().toISOString(),
        collections,
        preferences: {},
      }),
    );
  } else if (
    hasData &&
    existing &&
    typeof existing === "object" &&
    !Array.isArray(existing)
  ) {
    const archive = existing as Record<string, unknown>;
    archive.collections = {
      ...((archive.collections as Record<string, unknown>) ?? {}),
      ...collections,
    };
    storage.write(RETIRED_ARCHIVE_KEY, JSON.stringify(archive));
  }

  for (const name of RETIRED_COLLECTIONS) storage.remove(name);
}

/**
 * The pre-conversation transcript (`preferences.localAssistantHistory`)
 * becomes one conversation. The conversation, the preferences without the
 * legacy field and the version marker are one batch, so a crash leaves
 * either the old shape (migrated again on the next boot) or the new one —
 * never the history twice, never neither.
 */
function moveLegacyHistoryToConversation(storage: StorageAdapter): void {
  const preferences = parseJson(storage.read("preferences"));
  if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) {
    return;
  }
  const { localAssistantHistory, ...rest } = preferences as Record<string, unknown>;
  if (localAssistantHistory === undefined) return;

  const changes: Record<string, string> = { preferences: JSON.stringify(rest) };
  // A retry on a later boot must not lower a newer stored version.
  const meta = parseJson(storage.read("meta")) as { schemaVersion?: unknown } | undefined;
  const stored = typeof meta?.schemaVersion === "number" ? meta.schemaVersion : 0;
  if (stored < 14) {
    changes.meta = JSON.stringify({ schemaVersion: 14, migratedAt: Date.now() });
  }
  const conversation = conversationFromLegacyHistory(
    localAssistantHistory,
    Date.now(),
    createId,
  );
  if (conversation) {
    const existing = parseJson(storage.read("conversations"));
    changes.conversations = JSON.stringify([
      ...(Array.isArray(existing) ? existing : []),
      conversation,
    ]);
  }
  storage.writeBatch(changes);
}

type Migration = {
  to: number;
  description: string;
  run: (storage: StorageAdapter) => void;
  /** Run on every boot while its input is still present, whatever the
      stored version says: its batch can roll back after the separate
      version write has committed. Must be a no-op once done. */
  untilDone?: boolean;
};

export const migrations: Migration[] = [
  {
    to: 1,
    description: "initial schema",
    run: () => {
      /* fresh install — collections are created lazily */
    },
  },
  {
    to: 2,
    description: "add carriedOverCount to tasks",
    run: (storage) => {
      const raw = storage.read("tasks");
      if (!raw) return;
      try {
        const rows = JSON.parse(raw) as Record<string, unknown>[];
        for (const row of rows) {
          if (row && typeof row === "object" && !("carriedOverCount" in row)) {
            (row as Record<string, unknown>).carriedOverCount = 0;
          }
        }
        storage.write("tasks", JSON.stringify(rows));
      } catch {
        /* leave data untouched; zod boundary will drop invalid rows */
      }
    },
  },
  {
    to: 3,
    description: "add object-link graph collection",
    run: () => {
      /* The `links` collection is created lazily on first write; no
         existing document needs transforming. Bumping the version records
         that this schema now expects a typed relationship graph. */
    },
  },
  {
    to: 4,
    description: "add knowledge pages collection",
    run: () => {
      /* The `pages` collection (block-editor documents) is created lazily on
         first write; no existing document needs transforming. */
    },
  },
  {
    to: 5,
    description: "add security laboratory collections",
    run: () => {
      /* Engagements, scopes, assets, targets, services, tool definitions/
         installations/profiles, runs and artifacts are created lazily on
         first write; no existing document needs transforming. */
    },
  },
  {
    to: 6,
    description: "add findings/evidence/remediation/report collections",
    run: () => {
      /* Findings, evidence, remediations, risk acceptances and reports are
         created lazily on first write; no existing document needs transforming. */
    },
  },
  {
    to: 7,
    description: "workbench shell layout preferences",
    run: () => {
      /* The workbench mode, per-mode last route and panel sizes are additive
         Preferences fields with zod defaults, so old stored preferences upgrade
         transparently. No collection or document needs transforming. */
    },
  },
  {
    to: 8,
    description: "normalize evidence relationships and provenance",
    run: (storage) => {
      const rawFindings = storage.read("findings");
      const rawEvidence = storage.read("evidence");
      if (!rawFindings || !rawEvidence) return;
      try {
        const findings = JSON.parse(rawFindings) as Record<string, unknown>[];
        const evidence = JSON.parse(rawEvidence) as Record<string, unknown>[];
        if (!Array.isArray(findings) || !Array.isArray(evidence)) return;

        const findingIds = new Set(
          findings
            .map((item) => item.id)
            .filter((id): id is string => typeof id === "string"),
        );
        const evidenceIds = new Set(
          evidence
            .map((item) => item.id)
            .filter((id): id is string => typeof id === "string"),
        );
        const ownerByEvidence = new Map<string, string>();

        for (const item of evidence) {
          if (
            typeof item.id === "string" &&
            typeof item.findingId === "string" &&
            findingIds.has(item.findingId)
          ) {
            ownerByEvidence.set(item.id, item.findingId);
          }
        }
        for (const finding of findings) {
          if (typeof finding.id !== "string") continue;
          const ids = Array.isArray(finding.evidenceIds)
            ? finding.evidenceIds
            : [];
          for (const id of ids) {
            if (
              typeof id === "string" &&
              evidenceIds.has(id) &&
              !ownerByEvidence.has(id)
            ) {
              ownerByEvidence.set(id, finding.id);
            }
          }
        }

        for (const item of evidence) {
          if (typeof item.id !== "string") continue;
          const owner = ownerByEvidence.get(item.id);
          if (owner) item.findingId = owner;
          else delete item.findingId;

          if (!item.runId && typeof item.source === "string") {
            const match = /^run:([^\s(]+)/.exec(item.source);
            if (match) item.runId = match[1];
          }
        }
        for (const finding of findings) {
          if (typeof finding.id !== "string") continue;
          finding.evidenceIds = evidence
            .filter(
              (item) =>
                typeof item.id === "string" &&
                ownerByEvidence.get(item.id) === finding.id,
            )
            .map((item) => item.id);
        }

        storage.write("findings", JSON.stringify(findings));
        storage.write("evidence", JSON.stringify(evidence));
      } catch {
        /* Keep malformed legacy data untouched; validation remains safe. */
      }
    },
  },
  {
    to: 9,
    description: "add persistent workbench tabs",
    run: () => {
      /* Working tabs are an additive Preferences field with a zod default.
         Labels stay derived from routes so no localized text is migrated. */
    },
  },
  {
    to: 10,
    description: "add legacy preference state",
    run: () => {
      /* Historical additive Preferences fields; retired by migration v12. */
    },
  },
  {
    to: 11,
    description: "add legacy preference state",
    run: () => {
      /* Historical additive Preferences fields; retired by migration v12. */
    },
  },
  {
    to: 12,
    description: "archive retired modules and normalize the core workbench",
    run: (storage) => {
      normalizeCoreData(storage);
      archiveRetiredCollections(storage);
    },
  },
  {
    to: 13,
    description: "default appearance pack contextos → hud",
    run: (storage) => {
      const raw = storage.read("preferences");
      if (!raw) return;
      try {
        const prefs = JSON.parse(raw) as Record<string, unknown>;
        if (prefs.packId === "contextos") {
          prefs.packId = "hud";
          storage.write("preferences", JSON.stringify(prefs));
        }
      } catch {
        /* Keep malformed legacy data untouched; validation remains safe. */
      }
    },
  },
  {
    to: 14,
    description: "move the single assistant transcript into a conversation document",
    run: moveLegacyHistoryToConversation,
    untilDone: true,
  },
  {
    to: 15,
    // Evidence may be an observation of a built-in analysis: a
    // new kind and optional fields only, so no row is rewritten.
    description: "evidence can point at a built-in analysis observation",
    run: () => {},
  },
];

export function runMigrations(storage: StorageAdapter): {
  from: number;
  to: number;
} {
  const raw = storage.read("meta");
  let from = 0;
  try {
    from = raw ? (JSON.parse(raw).schemaVersion ?? 0) : 0;
  } catch {
    from = 0;
  }
  for (const m of migrations) {
    if (m.to > from || m.untilDone) m.run(storage);
  }
  storage.write(
    "meta",
    JSON.stringify({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      migratedAt: Date.now(),
    }),
  );
  return { from, to: CURRENT_SCHEMA_VERSION };
}
