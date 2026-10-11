import { z } from "zod";
import { labCollectionSchemas } from "./lab";
import { findingCollectionSchemas } from "./findings";
import {
  ConversationFolderSchema,
  ConversationSchema,
  JarvisMemorySchema,
} from "./conversations";
import {
  DEFAULT_ASSISTANT_BASE_URL,
  DEFAULT_ASSISTANT_MODEL,
} from "./localAssistant";

/* ============================================================
   Qutra Labs domain schemas.
   Zod validates every record at the storage boundary; the same
   schemas type the whole application.
   ============================================================ */

const ts = z.number().int().nonnegative();

export const WorkspaceHealth = z.enum([
  "ready",
  "needs_handoff",
  "missing_folder",
  "permission_required",
]);
export type WorkspaceHealth = z.infer<typeof WorkspaceHealth>;

export const GitStateSchema = z.object({
  connected: z.boolean(),
  branch: z.string().optional(),
  dirtyFiles: z.number().int().nonnegative().default(0),
  ahead: z.number().int().nonnegative().default(0),
  behind: z.number().int().nonnegative().default(0),
  lastCommits: z
    .array(
      z.object({
        hash: z.string(),
        message: z.string(),
        author: z.string(),
        at: ts,
        additions: z.number().int().nonnegative().default(0),
        deletions: z.number().int().nonnegative().default(0),
      }),
    )
    .default([]),
});
export type GitState = z.infer<typeof GitStateSchema>;

export const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  color: z.string(),
  icon: z.string().default("folder"),
  purpose: z.string().default(""),
  type: z.enum(["software", "research", "design", "writing", "other"]),
  status: z.enum(["active", "paused", "archived"]),
  favorite: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
  localPath: z.string().optional(),
  git: GitStateSchema.optional(),
  defaultCommands: z.array(z.string()).default([]),
  environmentLabels: z.array(z.string()).default([]),
  ignoredPaths: z.array(z.string()).default([]),
  browserCollections: z.array(z.string()).default([]),
  restoreBehavior: z
    .enum(["ask", "restore_all", "restore_selected"])
    .default("ask"),
  health: WorkspaceHealth.default("ready"),
  resumeSnapshotId: z.string().optional(),
  demo: z.boolean().default(false),
  createdAt: ts,
  updatedAt: ts,
  lastActivityAt: ts,
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const InterruptionSchema = z.object({
  id: z.string(),
  at: ts,
  reason: z.string(),
  minutes: z.number().nonnegative().default(0),
  returnedAt: ts.optional(),
});
export type Interruption = z.infer<typeof InterruptionSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string().min(1),
  intendedOutcome: z.string().default(""),
  status: z.enum(["planned", "active", "paused", "completed", "abandoned"]),
  startedAt: ts.optional(),
  endedAt: ts.optional(),
  pausedAt: ts.optional(),
  pausedTotalMs: z.number().nonnegative().default(0),
  plannedMinutes: z.number().int().positive().optional(),
  linkedTaskIds: z.array(z.string()).default([]),
  resourceIds: z.array(z.string()).default([]),
  distractionTracking: z.boolean().default(false),
  autoSnapshot: z.enum(["off", "on_end", "every_30m"]).default("on_end"),
  interruptions: z.array(InterruptionSchema).default([]),
  review: z
    .object({
      outcomeAchieved: z.enum(["yes", "partial", "no"]),
      completedWork: z.string().default(""),
      unresolved: z.string().default(""),
      learned: z.string().default(""),
      nextAction: z.string().default(""),
      snapshotId: z.string().optional(),
    })
    .optional(),
  demo: z.boolean().default(false),
  createdAt: ts,
  updatedAt: ts,
});
export type Session = z.infer<typeof SessionSchema>;

export const SnapshotItemKind = z.enum([
  "app",
  "browser_tab",
  "file",
  "terminal",
  "git",
  "task",
  "resource",
]);
export type SnapshotItemKind = z.infer<typeof SnapshotItemKind>;

export const SnapshotProvenance = z.enum([
  "native_observed",
  "saved_resource",
  "workspace_metadata",
  "simulated",
  "legacy_unknown",
]);
export type SnapshotProvenance = z.infer<typeof SnapshotProvenance>;

export const SnapshotItemSchema = z.object({
  id: z.string(),
  kind: SnapshotItemKind,
  title: z.string(),
  detail: z.string().default(""),
  /** app path, url, file path, cwd… — what restore needs */
  target: z.string().default(""),
  windowBounds: z
    .object({
      monitor: z.number().int().nonnegative(),
      x: z.number(),
      y: z.number(),
      w: z.number(),
      h: z.number(),
    })
    .optional(),
  selected: z.boolean().default(true),
  sensitive: z.boolean().default(false),
  /** How this candidate was obtained; legacy imports may omit the field. */
  provenance: SnapshotProvenance.optional(),
});
export type SnapshotItem = z.infer<typeof SnapshotItemSchema>;

export const SnapshotSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  sessionId: z.string().optional(),
  name: z.string().min(1),
  handoff: z.string().default(""),
  items: z.array(SnapshotItemSchema).default([]),
  monitors: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        width: z.number(),
        height: z.number(),
        scale: z.number(),
      }),
    )
    .default([]),
  appVersion: z.string().default("0.1.0"),
  demo: z.boolean().default(false),
  createdAt: ts,
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const RestoreItemState = z.enum([
  "queued",
  "launching",
  "waiting",
  "repositioning",
  "restored",
  "skipped",
  "permission_required",
  "failed",
]);
export type RestoreItemState = z.infer<typeof RestoreItemState>;

export const RestoreItemResultSchema = z.object({
  itemId: z.string(),
  state: RestoreItemState,
  reason: z.string().optional(),
  finishedAt: ts.optional(),
});
export type RestoreItemResult = z.infer<typeof RestoreItemResultSchema>;

export const RestoreRunSchema = z.object({
  id: z.string(),
  snapshotId: z.string(),
  workspaceId: z.string(),
  startedAt: ts,
  finishedAt: ts.optional(),
  status: z.enum(["running", "completed", "partial", "cancelled", "failed"]),
  simulated: z.boolean().default(true),
  items: z.array(RestoreItemResultSchema).default([]),
  demo: z.boolean().default(false),
});
export type RestoreRun = z.infer<typeof RestoreRunSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  description: z.string().default(""),
  workspaceId: z.string().optional(),
  status: z.enum(["backlog", "todo", "in_progress", "done", "archived"]),
  priority: z.enum(["urgent", "high", "medium", "low", "none"]).default("none"),
  dueAt: ts.optional(),
  estimateMinutes: z.number().int().positive().optional(),
  tags: z.array(z.string()).default([]),
  parentId: z.string().optional(),
  blockedByIds: z.array(z.string()).default([]),
  recurrence: z.enum(["none", "daily", "weekly", "monthly"]).default("none"),
  carriedOverCount: z.number().int().nonnegative().default(0),
  evidence: z
    .object({
      sessionId: z.string().optional(),
      commitHash: z.string().optional(),
    })
    .optional(),
  demo: z.boolean().default(false),
  createdAt: ts,
  updatedAt: ts,
  completedAt: ts.optional(),
});
export type Task = z.infer<typeof TaskSchema>;

export const ResourceSchema = z.object({
  id: z.string(),
  kind: z.enum(["url", "file", "folder", "command"]),
  title: z.string().min(1),
  target: z.string(),
  workspaceId: z.string().optional(),
  tags: z.array(z.string()).default([]),
  lastOpenedAt: ts.optional(),
  demo: z.boolean().default(false),
  createdAt: ts,
});
export type Resource = z.infer<typeof ResourceSchema>;

export const ActivityEventType = z.enum([
  "session_started",
  "session_ended",
  "snapshot_saved",
  "restore_run",
  "task_completed",
  "task_created",
  "decision_recorded",
  "commit",
  "automation_run",
  "privacy_paused",
  "privacy_resumed",
  "permission_changed",
  "workspace_opened",
  "app_activity",
]);
export type ActivityEventType = z.infer<typeof ActivityEventType>;

export const ActivityEventSchema = z.object({
  id: z.string(),
  type: ActivityEventType,
  at: ts,
  workspaceId: z.string().optional(),
  refId: z.string().optional(),
  label: z.string(),
  detail: z.string().default(""),
  minutes: z.number().nonnegative().default(0),
  demo: z.boolean().default(false),
});
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

export const AutomationTrigger = z.enum([
  "session_started",
  "session_ended",
  "workspace_opened",
  "snapshot_saved",
  "restore_completed",
  "task_changed",
  "schedule",
  "file_changed",
  "branch_changed",
  "manual",
]);
export type AutomationTrigger = z.infer<typeof AutomationTrigger>;

export const AutomationActionSchema = z.object({
  type: z.enum([
    "open_resource",
    "start_timer",
    "create_task",
    "capture_snapshot",
    "notify",
    "run_command",
    "apply_tag",
    "export_report",
    "webhook",
  ]),
  param: z.string().default(""),
});
export type AutomationAction = z.infer<typeof AutomationActionSchema>;

export const AutomationSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  trigger: AutomationTrigger,
  conditions: z
    .array(
      z.object({
        field: z.enum([
          "workspace",
          "tag",
          "time_window",
          "day",
          "branch",
          "status",
        ]),
        value: z.string(),
      }),
    )
    .default([]),
  actions: z.array(AutomationActionSchema).min(1),
  enabled: z.boolean().default(true),
  requiresConfirmation: z.boolean().default(false),
  rateLimitPerHour: z.number().int().positive().default(12),
  retryPolicy: z.enum(["none", "once", "three_times"]).default("none"),
  lastRunAt: ts.optional(),
  nextRunAt: ts.optional(),
  demo: z.boolean().default(false),
  createdAt: ts,
  updatedAt: ts,
});
export type Automation = z.infer<typeof AutomationSchema>;

export const AutomationRunSchema = z.object({
  id: z.string(),
  automationId: z.string(),
  at: ts,
  status: z.enum([
    "success",
    "failed",
    "partial",
    "blocked",
    "skipped",
    "dry_run",
  ]),
  detail: z.string().default(""),
  demo: z.boolean().default(false),
});
export type AutomationRun = z.infer<typeof AutomationRunSchema>;

export const PermissionKey = z.enum([
  "file_access",
  "git_inspection",
  "window_metadata",
  "global_shortcuts",
  "notifications",
  "browser_integration",
  "ai_provider",
]);
export type PermissionKey = z.infer<typeof PermissionKey>;

export const PermissionGrantSchema = z.object({
  id: z.string(), // equals key
  key: PermissionKey,
  state: z.enum(["granted", "denied", "not_asked"]),
  updatedAt: ts,
});
export type PermissionGrant = z.infer<typeof PermissionGrantSchema>;

export const ExclusionRuleSchema = z.object({
  id: z.string(),
  kind: z.enum(["app", "path", "domain", "pattern"]),
  value: z.string().min(1),
  note: z.string().default(""),
  demo: z.boolean().default(false),
  createdAt: ts,
});
export type ExclusionRule = z.infer<typeof ExclusionRuleSchema>;

export const AiProviderConfigSchema = z.object({
  id: z.string(),
  provider: z.enum(["none", "anthropic", "openai", "local"]).default("none"),
  model: z.string().default(""),
  /** Only metadata. The credential itself lives in the OS secret store. */
  hasCredential: z.boolean().default(false),
  redactPaths: z.boolean().default(true),
  redactSecrets: z.boolean().default(true),
  disabledWorkspaceIds: z.array(z.string()).default([]),
  updatedAt: ts,
});
export type AiProviderConfig = z.infer<typeof AiProviderConfigSchema>;

export const PreferencesSchema = z.object({
  locale: z.enum(["en", "tr", "de", "es", "fr", "it"]).default("en"),
  /* Regional formats (Settings › Language & region). "auto" follows the
     language; "system" is the computer's time zone. A value a newer version
     adds reads as the default instead of resetting every preference. */
  dateFormat: z.enum(["auto", "dmy", "mdy", "ymd"]).catch("auto"),
  hourCycle: z.enum(["auto", "h23", "h12"]).catch("auto"),
  numberFormat: z.enum(["auto", "dot", "comma", "space"]).catch("auto"),
  timeZone: z.string().max(64).catch("system"),
  // "light"/"dark" are legacy values (mapped to Qutra Labs) kept for
  // back-compat. Retired decorative/glass theme ids are accepted then
  // normalized by resolveTheme. "windows" (retired window effects) reads as flat.
  theme: z
    .enum([
      "system",
      "light",
      "dark",
      "contextos",
      "windows",
      "highContrast",
      // legacy (still readable from stored prefs)
      "contextRose",
      "carbonSignal",
      "forestTerminal",
      "oceanPulse",
      "solarEmber",
      "acrylicClear",
      "liquidGlass",
    ])
    .default("system"),
  themeMode: z.enum(["light", "dark", "system", "schedule"]).default("system"),
  themeScheduleLightAt: z.string().default("07:00"),
  themeScheduleDarkAt: z.string().default("19:00"),
  density: z.enum(["comfortable", "compact"]).default("comfortable"),
  reduceMotion: z.boolean().default(false),
  highContrast: z.boolean().default(false),
  colorBlindCharts: z.boolean().default(false),
  // Appearance (pack × mode). `material` and `reduceTransparency` belonged to
  // the retired window effects: still parsed so older stored values load,
  // never read, and never rewritten.
  packId: z.enum(["hud", "contextos", "catppuccin", "highContrast"]).default("hud"),
  material: z.enum(["none", "mica", "acrylic", "liquidGlass"]).default("none"),
  reduceTransparency: z.boolean().default(false),
  catppuccinDarkFlavor: z.enum(["frappe", "macchiato", "mocha"]).default("mocha"),
  // Settings › Shortcuts: shortcut id → binding ("Ctrl+Shift+T") or null for
  // none. Only changes from the defaults in lib/shortcuts are stored. A bad
  // value resets the bindings alone, never the other preferences.
  shortcutBindings: z.record(z.string(), z.string().nullable()).default({}).catch({}),
  startOnLogin: z.boolean().default(false),
  sidebarCollapsed: z.boolean().default(false),
  onboardingDone: z.boolean().default(false),
  /* ---- Workbench shell layout (persisted) ---- */
  // Active top-level mode in the Mode Rail.
  workbenchMode: z
    .enum(["home", "work", "knowledge", "automate", "lab", "system", "core"])
    .transform(() => "core" as const)
    .default("core"),
  // Last visited route per mode, so switching modes restores where you were.
  workbenchModeRoutes: z.record(z.string(), z.string()).default({}),
  // Open work contexts. Labels and icons are derived at render time so locale
  // changes never leave stale translated text in persisted preferences.
  workbenchTabs: z
    .array(
      z.object({
        route: z.string().min(1).max(2048),
        pinned: z.boolean().default(false),
        openedAt: ts,
      }),
    )
    .max(24)
    .default([]),
  // Recently closed workbench routes (most-recent-first) for reopen via
  // Ctrl+Shift+T. Routes only — labels are derived at render time.
  workbenchRecentlyClosed: z.array(z.string().min(1).max(2048)).max(24).default([]),
  // Context sidebar size (clamped on read).
  contextSidebarWidth: z.number().default(240),
  /* The one context panel: open state, last segment, one width for
     every surface. The segment falls back to Project if a stored value is
     unknown, so a renamed segment can never make preferences unreadable. */
  contextPanelOpen: z.boolean().default(false),
  contextPanelSegment: z
    .enum(["project", "files", "repo", "runs"])
    .catch("project")
    .default("project"),
  contextPanelWidth: z.number().default(360),
  activityTrackingEnabled: z.boolean().default(false),
  ignoreLikelySecrets: z.boolean().default(true),
  viewSettings: z.record(z.string(), z.string()).default({}),
  favorites: z.array(z.string()).default([]),
  // Overview home customization: persisted section order + visibility.
  overviewLayout: z
    .array(z.object({ id: z.string(), hidden: z.boolean().default(false) }))
    .default([]),
  // Collapsible sidebar group open/closed state, keyed by group id.
  navGroupsCollapsed: z.array(z.string()).default([]),
  // Private Cyber Lab is disabled by default; only an explicit local opt-in
  // reveals the Tools destination. A hidden menu is not a security boundary —
  // real tool implementations live outside the public repo (ADR 0007).
  privateToolsEnabled: z.boolean().default(false),
  /* When each permission in Settings › Permissions last changed (epoch ms),
     keyed by permission id. Only a record for the page to show; it decides
     nothing. Private Lab's own grant time comes from Rust. */
  permissionChangedAt: z.record(z.string(), z.number()).catch({}).default({}),
  /* A tool registered with no bundled logo gets its official logo fetched
     once from its documentation site (Rust `tool_logos.rs`). Only on the
     user's own step — registering, or "Find logos" — and never while off. */
  toolLogoFetch: z.boolean().default(true),
  // Local Assistant Lab (ADR 0010 / §3.14). Disabled by default: while
  // false no request of any kind is made — not even a health probe. The
  // live origin is one of {11434, 11435}, chosen in Rust; this stored URL
  // is not trusted as an endpoint.
  localAssistantEnabled: z.boolean().default(false),
  ollamaBaseUrl: z.string().default(DEFAULT_ASSISTANT_BASE_URL),
  ollamaModel: z.string().default(DEFAULT_ASSISTANT_MODEL),
  // Small on purpose for the first release; 262k is explicitly out of scope.
  ollamaContextTokens: z.union([z.literal(4096), z.literal(8192)]).default(4096),
  /* Attach a short read-only summary of the active project to assistant turns.
     Default on: the assistant itself is already opt-in, the
     destination is the loopback broker, and the exact block is shown in the UI
     before it is sent — so this is disclosed rather than surprising. One click
     turns it off. */
  assistantContextEnabled: z.boolean().default(true),
  /* Let the agent read project context without asking each time. Default OFF:
     the agent loop is a boundary the user crossed deliberately (ADR 0012), so
     nothing about it is on by default. This can ONLY ever weaken the gate for
     the read-only `read_context` tool -- the broker refuses to let it affect
     `terminal_run` or `launch_tool`, which always require a per-call approval. */
  assistantAutoApproveReads: z.boolean().default(false),
  /* Turns the assistant from an answerer into an agent that can *propose*
     `terminal_run` / `launch_tool` / `read_context` calls at all (ADR 0012).
     Default OFF: a user who enabled the assistant under ADR 0010's "may read
     and answer, and may do nothing else" promise must not wake up to an
     agent with no deliberate action on their part -- this is the boundary
     they have to cross on purpose. Sent to the broker as `agentToolsEnabled`
     on the start payload; the broker advertises tool schemas for a turn only
     when this is true *and* Private Lab consent is granted, so this
     preference alone is never enough to unlock anything. */
  assistantAgentToolsEnabled: z.boolean().default(false),
  /* Provenance for `assistantAgentToolsEnabled`. Whole-profile import can set
     that boolean with no question asked, and older profiles record none, so a
     stored true cannot prove consent. Epoch below AGENT_CONSENT_EPOCH with G
     true is migrated to G false + awaiting confirmation — metadata, not a
     grant. Import/restore must not copy a current epoch to skip the question. */
  assistantAgentConsentEpoch: z.number().int().nonnegative().default(0),
  assistantAgentAwaitingConfirmation: z.boolean().default(false),
  /* Private Lab prompt declined: proposals stay permitted (G saved) but unavailable while P is
     off. Do not re-ask the Private Lab question on every assistant message. */
  assistantPrivateLabPromptDismissed: z.boolean().default(false),
  // The assistant transcript lived here as `localAssistantHistory` until
  // schema v14 moved it into the `conversations` collection.
  /* Cloud connections (spec 2026-10-07 §7): only the choices. The
     keys and the addresses they may be sent to are kept by Rust in Credential
     Manager, never here. `aiModels` maps a connection (`targetKey`) to the
     model chosen for it. */
  // .catch: a preset a newer version adds must not reset every preference.
  aiOpenAiPreset: z.enum(["openai", "gemini", "openrouter", "groq", "custom"]).catch("openai"),
  aiModels: z.record(z.string(), z.string()).default({ anthropic: "claude-opus-5-5" }),
  /* The connection Jarvis talks through: the local model, Claude,
     or the OpenAI-compatible service chosen above. */
  aiProvider: z.enum(["ollama", "anthropic", "openai_compat"]).catch("ollama"),
  /* Jarvis's own settings: the history panel, memory and
     personalization. Memory entries are the `jarvisMemories` collection. */
  jarvisHistoryOpen: z.boolean().catch(true).default(true),
  jarvisMemoryEnabled: z.boolean().catch(true).default(true),
  jarvisAboutYou: z.string().max(1500).catch("").default(""),
  jarvisInstructions: z.string().max(1500).catch("").default(""),
  jarvisResponseStyle: z.enum(["balanced", "concise", "detailed"]).catch("balanced").default("balanced"),
  /* How the assistant addresses the user in its greeting ("Mert Bey",
     "efendim"). Free text, kept as typed (a space inside it is the user's);
     whoever reads it trims it. Empty means a greeting without a name. */
  addressAs: z.string().max(40).catch("").default(""),
  /* The "Beni takip et" companion: a small bubble inside the app that knows
     the page and walks through it. Off until the user turns it on. It reads
     nothing outside Qutra Labs, so a stored true carries no consent to
     check. `companionHidden` lists the pages (their companion keys) where
     it stays out of the way. */
  companionEnabled: z.boolean().catch(false).default(false),
  companionHidden: z.array(z.string().min(1).max(40)).max(24).catch([]).default([]),
  /* Reading answers aloud with the voices Windows has installed. Off until
     asked for. The voice is kept by name (the list changes between machines);
     a name that is gone falls back to the best match for the language. The
     rate is the speech rate multiplier, 0.5 to 2. */
  voiceReadAloud: z.boolean().catch(false).default(false),
  voiceName: z.string().max(200).catch("").default(""),
  voiceRate: z.number().min(0.5).max(2).catch(1).default(1),
});
export type Preferences = z.infer<typeof PreferencesSchema>;

/* ---------- Collection registry ---------- */

export const collectionSchemas = {
  workspaces: WorkspaceSchema,
  sessions: SessionSchema,
  snapshots: SnapshotSchema,
  restoreRuns: RestoreRunSchema,
  tasks: TaskSchema,
  resources: ResourceSchema,
  events: ActivityEventSchema,
  automations: AutomationSchema,
  automationRuns: AutomationRunSchema,
  permissions: PermissionGrantSchema,
  exclusions: ExclusionRuleSchema,
  aiProviders: AiProviderConfigSchema,
  // Saved assistant conversations, their folders and Jarvis's memory.
  conversations: ConversationSchema,
  conversationFolders: ConversationFolderSchema,
  jarvisMemories: JarvisMemorySchema,
  // Authorized Security Laboratory object families.
  ...labCollectionSchemas,
  // Normalized findings, evidence, remediation and reports.
  ...findingCollectionSchemas,
} as const;

export type CollectionName = keyof typeof collectionSchemas;
export type CollectionRecord<N extends CollectionName> = z.infer<
  (typeof collectionSchemas)[N]
>;
