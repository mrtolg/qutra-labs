import { z } from "zod";

/* ============================================================
   Normalized findings, evidence, remediation and reports.
   Findings are produced by the parser framework from tool output
   or entered by hand; every finding carries a stable fingerprint
   so reimport can compute new/unchanged/changed/resolved/reopened.
   ============================================================ */

const ts = z.number().int().nonnegative();

export const Severity = z.enum(["info", "low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof Severity>;

export const Confidence = z.enum(["low", "medium", "high"]);
export type Confidence = z.infer<typeof Confidence>;

export const FindingStatus = z.enum([
  "new",
  "confirmed",
  "in_progress",
  "mitigated",
  "verified",
  "reopened",
  "false_positive",
  "risk_accepted",
  "out_of_scope",
  "duplicate",
]);
export type FindingStatus = z.infer<typeof FindingStatus>;

export const FindingHistorySchema = z.object({
  at: ts,
  from: FindingStatus.optional(),
  to: FindingStatus,
  note: z.string().default(""),
});

export const FindingSchema = z.object({
  id: z.string(),
  engagementId: z.string().optional(),
  title: z.string().min(1),
  description: z.string().default(""),
  severity: Severity.default("info"),
  confidence: Confidence.default("medium"),
  status: FindingStatus.default("new"),
  affectedTargets: z.array(z.string()).default([]),
  affectedAssets: z.array(z.string()).default([]),
  sourceTool: z.string().default(""),
  sourceRunId: z.string().optional(),
  ruleId: z.string().default(""),
  location: z.string().default(""),
  /** Stable dedupe/reimport key. */
  fingerprint: z.string(),
  firstSeen: ts,
  lastSeen: ts,
  cvssVector: z.string().default(""),
  cvssScore: z.number().min(0).max(10).optional(),
  cvssVersion: z.string().default(""),
  cwe: z.array(z.string()).default([]),
  cve: z.array(z.string()).default([]),
  attack: z.array(z.string()).default([]),
  reproduction: z.string().default(""),
  impact: z.string().default(""),
  remediation: z.string().default(""),
  references: z.array(z.string()).default([]),
  evidenceIds: z.array(z.string()).default([]),
  assignee: z.string().default(""),
  dueAt: ts.optional(),
  tags: z.array(z.string()).default([]),
  duplicateOfId: z.string().optional(),
  falsePositiveReason: z.string().default(""),
  riskAcceptanceId: z.string().optional(),
  importBatchId: z.string().optional(),
  parserVersion: z.string().default(""),
  history: z.array(FindingHistorySchema).default([]),
  demo: z.boolean().default(false),
  createdAt: ts,
  updatedAt: ts,
});
export type Finding = z.infer<typeof FindingSchema>;

export const EvidenceSchema = z.object({
  id: z.string(),
  /** Canonical link to the finding this evidence substantiates (one-to-many).
      Finding.evidenceIds is a derived mirror kept in sync with this field. */
  findingId: z.string().optional(),
  engagementId: z.string().optional(),
  /** Provenance links used for real relationships (not the free-text `source`). */
  runId: z.string().optional(),
  targetId: z.string().optional(),
  /** The investigation file a built-in analysis read. */
  fileId: z.string().optional(),
  kind: z.enum([
    "screenshot",
    "file",
    "text",
    "output",
    "artifact",
    "mail_attachment",
    "link",
    "note_ref",
    "observation",
  ]).default("text"),
  /** For `observation`: the pinned observations, `<run id>:<n>`. */
  observationIds: z.array(z.string()).optional(),
  /** For `observation`: the run's raw output, under `<appData>\lab`, and its
      SHA-256 when it was written, so the chain can be checked again. */
  rawRef: z.object({ relPath: z.string(), sha256: z.string() }).optional(),
  title: z.string().min(1),
  content: z.string().default(""),
  path: z.string().default(""),
  sha256: z.string().default(""),
  capturedAt: ts,
  source: z.string().default(""),
  sensitivity: z.enum(["normal", "sensitive"]).default("normal"),
  includeInReport: z.boolean().default(true),
  demo: z.boolean().default(false),
  createdAt: ts,
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const RemediationSchema = z.object({
  id: z.string(),
  findingId: z.string(),
  title: z.string().min(1),
  description: z.string().default(""),
  status: z.enum(["open", "in_progress", "done"]).default("open"),
  taskId: z.string().optional(),
  dueAt: ts.optional(),
  demo: z.boolean().default(false),
  createdAt: ts,
  updatedAt: ts,
});
export type Remediation = z.infer<typeof RemediationSchema>;

export const RiskAcceptanceSchema = z.object({
  id: z.string(),
  findingId: z.string(),
  reason: z.string().default(""),
  acceptedBy: z.string().default(""),
  until: ts.optional(),
  demo: z.boolean().default(false),
  createdAt: ts,
});
export type RiskAcceptance = z.infer<typeof RiskAcceptanceSchema>;

/** Max UTF-16 units retained on a Report row for re-download / audit. */
export const REPORT_BODY_LIMIT = 256 * 1024;

export const ReportSchema = z.object({
  id: z.string(),
  engagementId: z.string(),
  title: z.string().min(1),
  format: z.enum(["markdown", "html"]).default("markdown"),
  includedFindingIds: z.array(z.string()).default([]),
  executiveSummary: z.string().default(""),
  /** Bounded Markdown (or HTML) body for local re-download; may be truncated. */
  body: z.string().default(""),
  generatedAt: ts.optional(),
  sha256: z.string().default(""),
  demo: z.boolean().default(false),
  createdAt: ts,
  updatedAt: ts,
});
export type Report = z.infer<typeof ReportSchema>;

export const findingCollectionSchemas = {
  findings: FindingSchema,
  evidence: EvidenceSchema,
  remediations: RemediationSchema,
  riskAcceptances: RiskAcceptanceSchema,
  reports: ReportSchema,
} as const;
