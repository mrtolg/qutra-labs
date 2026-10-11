import { z } from "zod";

/* ============================================================
   Authorized Security Laboratory — domain schemas.

   These model engagements, authorization scope, assets/targets,
   tool definitions/installations/profiles, runs and artifacts.
   Real tool installations, run output, evidence and reports live
   OUTSIDE the public repository (ADR 0007); these schemas describe
   the records, not the sensitive payloads.
   ============================================================ */

const ts = z.number().int().nonnegative();

/* ---------- Engagement ---------- */

export const EngagementPurpose = z.enum([
  "local_inventory",
  "personal_webapp_review",
  "training_lab",
  "source_review",
  "dependency_review",
  "pcap_analysis",
  "forensics_practice",
  "incident_notebook",
  "other",
]);
export type EngagementPurpose = z.infer<typeof EngagementPurpose>;

/** What is being investigated (spec 2026-10-07 D1). Records made before it
    have none and read as "Genel". */
export const EngagementKind = z.enum(["file", "web", "host", "pcap", "forensics"]);
export type EngagementKind = z.infer<typeof EngagementKind>;

export const EngagementSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  purpose: EngagementPurpose.default("training_lab"),
  kind: EngagementKind.optional(),
  status: z.enum(["planned", "active", "paused", "completed", "archived"]).default("planned"),
  /** The status it had when it was archived, so restoring puts it back.
      Absent on records archived before it existed. */
  statusBeforeArchive: z.enum(["planned", "active", "paused", "completed"]).optional().catch(undefined),
  clientLabel: z.string().default(""),
  startAt: ts.optional(),
  endAt: ts.optional(),
  /** The currently active AuthorizationScope, if any. */
  scopeId: z.string().optional(),
  contacts: z.array(z.string()).default([]),
  notes: z.string().default(""),
  tags: z.array(z.string()).default([]),
  /** Where the desktop app keeps this engagement's files, as last reported
      by Rust. Shown to the user only: Rust keeps the record writes go by. */
  folderPath: z.string().optional(),
  /** The user allowed this investigation's summary to go to this cloud
      connection. Never imported. */
  cloudConsent: z
    .object({ provider: z.string(), host: z.string(), grantedAt: ts })
    .optional(),
  demo: z.boolean().default(false),
  createdAt: ts,
  updatedAt: ts,
});
export type Engagement = z.infer<typeof EngagementSchema>;

/* ---------- Authorization scope ---------- */

export const AuthorizationScopeSchema = z.object({
  id: z.string(),
  engagementId: z.string(),
  ownerLabel: z.string().default(""),
  description: z.string().default(""),
  /** Normalized target patterns that are explicitly authorized. */
  allowedTargets: z.array(z.string()).default([]),
  /** Explicitly excluded targets (win over allow). */
  excludedTargets: z.array(z.string()).default([]),
  windowStart: ts.optional(),
  windowEnd: ts.optional(),
  /** Reference to the authorization evidence (doc id, ticket, etc.). */
  authorizationRef: z.string().default(""),
  testerAck: z.boolean().default(false),
  expiresAt: ts.optional(),
  notes: z.string().default(""),
  revision: z.number().int().positive().default(1),
  demo: z.boolean().default(false),
  createdAt: ts,
  updatedAt: ts,
});
export type AuthorizationScope = z.infer<typeof AuthorizationScopeSchema>;

/* ---------- Asset / Target / Service ---------- */

export const AssetSchema = z.object({
  id: z.string(),
  engagementId: z.string().optional(),
  name: z.string().min(1),
  kind: z.enum(["host", "webapp", "repo", "file", "network", "device", "service", "other"]).default("host"),
  identifier: z.string().default(""),
  owned: z.boolean().default(true),
  notes: z.string().default(""),
  tags: z.array(z.string()).default([]),
  demo: z.boolean().default(false),
  createdAt: ts,
  updatedAt: ts,
});
export type Asset = z.infer<typeof AssetSchema>;

export const TargetKind = z.enum([
  "ip",
  "cidr",
  "hostname",
  "url",
  "file",
  "port_range",
  "unknown",
]);
export type TargetKind = z.infer<typeof TargetKind>;

export const TargetScopeState = z.enum(["in_scope", "out_of_scope", "unknown"]);
export type TargetScopeState = z.infer<typeof TargetScopeState>;

export const TargetSchema = z.object({
  id: z.string(),
  engagementId: z.string().optional(),
  assetId: z.string().optional(),
  /** Exactly what the user entered. */
  raw: z.string().min(1),
  /** Canonicalized form used for scope checks. */
  normalized: z.string().default(""),
  kind: TargetKind.default("unknown"),
  scopeState: TargetScopeState.default("unknown"),
  notes: z.string().default(""),
  demo: z.boolean().default(false),
  createdAt: ts,
  updatedAt: ts,
});
export type Target = z.infer<typeof TargetSchema>;

export const ServiceSchema = z.object({
  id: z.string(),
  targetId: z.string(),
  port: z.number().int().min(0).max(65535),
  protocol: z.enum(["tcp", "udp"]).default("tcp"),
  name: z.string().default(""),
  product: z.string().default(""),
  version: z.string().default(""),
  state: z.enum(["open", "closed", "filtered"]).default("open"),
  demo: z.boolean().default(false),
  createdAt: ts,
});
export type Service = z.infer<typeof ServiceSchema>;

/* ---------- Tool definition / installation ---------- */

export const ToolRunner = z.enum(["executable", "powershell", "python", "java"]);
export type ToolRunner = z.infer<typeof ToolRunner>;

export const ToolRiskTier = z.enum(["info", "low", "medium", "high"]);
export type ToolRiskTier = z.infer<typeof ToolRiskTier>;

export const ToolDefinitionSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  category: z.enum(["local", "network", "web", "code", "dfir"]).default("local"),
  description: z.string().default(""),
  docUrl: z.string().default(""),
  riskTier: ToolRiskTier.default("low"),
  outputFormats: z.array(z.string()).default([]),
  demo: z.boolean().default(false),
  createdAt: ts,
  updatedAt: ts,
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export const ToolInstallationSchema = z.object({
  id: z.string(),
  definitionId: z.string().optional(),
  displayName: z.string().min(1),
  runner: ToolRunner.default("executable"),
  /** Canonical path to the executable/script/jar (validated natively). */
  path: z.string().min(1),
  /** Interpreter/runtime path for python/java runners. */
  interpreterPath: z.string().optional(),
  sha256: z.string().default(""),
  sizeBytes: z.number().int().nonnegative().default(0),
  modifiedAt: ts.optional(),
  version: z.string().default(""),
  publisher: z.string().default(""),
  signatureState: z
    .enum(["valid", "invalid", "unsigned", "unavailable"])
    .default("unavailable"),
  category: z.enum(["local", "network", "web", "code", "dfir"]).default("local"),
  riskTier: ToolRiskTier.default("low"),
  docUrl: z.string().default(""),
  iconEmoji: z.string().default(""),
  tags: z.array(z.string()).default([]),
  workingDir: z.string().default(""),
  enabled: z.boolean().default(true),
  lastVerifiedAt: ts.optional(),
  /** Set when a re-verify finds the binary hash changed since registration. */
  changedSinceVerify: z.boolean().default(false),
  demo: z.boolean().default(false),
  createdAt: ts,
  updatedAt: ts,
});
export type ToolInstallation = z.infer<typeof ToolInstallationSchema>;

/* ---------- Installation binding ---------- */

/** The user's confirmation that a native installation is a launcher catalog
    item (see domain/tools/launcher.ts). One per installation, so the record id
    is the installation id. It names both sides by id only; the executable and
    its hash stay in Rust's registry. */
export const InstallationBindingSchema = z.object({
  id: z.string().min(1),
  catalogId: z.string().min(1),
  installationId: z.string().min(1),
  confirmedAt: ts,
});
export type InstallationBinding = z.infer<typeof InstallationBindingSchema>;

/* ---------- Tool profile (typed arguments) ---------- */

export const ArgType = z.enum([
  "string",
  "integer",
  "boolean",
  "enum",
  "file",
  "folder",
  "target",
  "port_range",
  "duration",
]);
export type ArgType = z.infer<typeof ArgType>;

export const ArgDefSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  /** The flag emitted before the value, e.g. "-p" or "--ports". Empty = positional. */
  flag: z.string().default(""),
  type: ArgType.default("string"),
  required: z.boolean().default(false),
  default: z.string().default(""),
  enumValues: z.array(z.string()).default([]),
  repeatable: z.boolean().default(false),
  sensitive: z.boolean().default(false),
  help: z.string().default(""),
  order: z.number().int().nonnegative().default(0),
});
export type ArgDef = z.infer<typeof ArgDefSchema>;

export const ToolProfileSchema = z.object({
  id: z.string(),
  installationId: z.string(),
  engagementId: z.string().optional(),
  name: z.string().min(1),
  args: z.array(ArgDefSchema).default([]),
  /** Saved values keyed by ArgDef id. */
  values: z.record(z.string(), z.string()).default({}),
  workingDir: z.string().default(""),
  allowedEnv: z.array(z.string()).default([]),
  expectedOutputs: z.array(z.string()).default([]),
  parser: z.string().default(""),
  timeoutSec: z.number().int().positive().default(300),
  concurrencyClass: z.string().default("default"),
  /** How this tool is launched: batch = supervised run; gui = detached
      external process; interactive = a PTY terminal tab. */
  launchKind: z.enum(["gui", "interactive", "batch"]).default("batch"),
  requiresScope: z.boolean().default(true),
  favorite: z.boolean().default(false),
  demo: z.boolean().default(false),
  createdAt: ts,
  updatedAt: ts,
});
export type ToolProfile = z.infer<typeof ToolProfileSchema>;

/* ---------- Tool run ---------- */

export const RunState = z.enum([
  "draft",
  "validated",
  "queued",
  "starting",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "blocked",
  "orphaned",
]);
export type RunState = z.infer<typeof RunState>;

const RunTriggerSchema = z.object({
  by: z.enum(["user", "assistant", "legacy"]),
  approvalId: z.string().optional(),
  conversationId: z.string().optional(),
});
const RunSubjectSchema = z.object({
  fileId: z.string().optional(),
  fileSha256: z.string().optional(),
  rulesFileId: z.string().optional(),
  rulesSha256: z.string().optional(),
});
const RunOutputSchema = z.object({
  name: z.string(),
  relPath: z.string(),
  sha256: z.string(),
  bytes: z.number().int().nonnegative(),
});

export const ToolRunSchema = z.object({
  id: z.string(),
  profileId: z.string(),
  installationId: z.string(),
  engagementId: z.string().optional(),
  scopeId: z.string().optional(),
  scopeRevision: z.number().int().positive().optional(),
  targetId: z.string().optional(),
  target: z.string().optional(),
  state: RunState.default("draft"),
  /** Resolved argument array — never a shell string. */
  argv: z.array(z.string()).default([]),
  commandPreview: z.string().default(""),
  pid: z.number().int().optional(),
  startedAt: ts.optional(),
  endedAt: ts.optional(),
  exitCode: z.number().int().optional(),
  terminationReason: z.string().default(""),
  workingDir: z.string().default(""),
  artifactDir: z.string().default(""),
  stdoutTail: z.string().default(""),
  stderrTail: z.string().default(""),
  bytesOut: z.number().int().nonnegative().default(0),
  truncated: z.boolean().default(false),
  blockedReason: z.string().default(""),
  /** Rust ledger v2: where the run came from and what it read. */
  kind: z.enum(["external", "builtin"]).default("external"),
  trigger: RunTriggerSchema.optional(),
  subject: RunSubjectSchema.optional(),
  descriptorId: z.string().optional(),
  outputs: z.array(RunOutputSchema).default([]),
  demo: z.boolean().default(false),
  createdAt: ts,
  updatedAt: ts,
});
export type ToolRun = z.infer<typeof ToolRunSchema>;

/* ---------- Artifact ---------- */

export const ArtifactSchema = z.object({
  id: z.string(),
  runId: z.string().optional(),
  engagementId: z.string().optional(),
  name: z.string().min(1),
  kind: z.enum(["stdout", "stderr", "file", "report", "other"]).default("file"),
  path: z.string().default(""),
  sha256: z.string().default(""),
  sizeBytes: z.number().int().nonnegative().default(0),
  mime: z.string().default(""),
  demo: z.boolean().default(false),
  createdAt: ts,
});
export type Artifact = z.infer<typeof ArtifactSchema>;

/* ---------- Collection registry fragment ---------- */

export const labCollectionSchemas = {
  engagements: EngagementSchema,
  authorizationScopes: AuthorizationScopeSchema,
  assets: AssetSchema,
  targets: TargetSchema,
  services: ServiceSchema,
  toolDefinitions: ToolDefinitionSchema,
  toolInstallations: ToolInstallationSchema,
  toolProfiles: ToolProfileSchema,
  installationBindings: InstallationBindingSchema,
  toolRuns: ToolRunSchema,
  artifacts: ArtifactSchema,
} as const;
