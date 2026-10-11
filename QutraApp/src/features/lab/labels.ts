import type { FindingStatus } from "@/domain/findings";
import type { Engagement } from "@/domain/lab";
import type { NativeToolRun } from "@/lib/bridge/types";
import type { MessageKey } from "@/lib/i18n/en";

type Translate = (key: MessageKey) => string;

const RUN_STATE_KEYS: Record<NativeToolRun["state"], MessageKey> = {
  queued: "lab.runState.queued",
  starting: "lab.runState.starting",
  running: "status.running",
  cancelling: "lab.runState.cancelling",
  succeeded: "lab.runState.succeeded",
  failed: "status.failed",
  timed_out: "lab.runState.timedOut",
  cancelled: "status.cancelled",
  blocked: "lab.runState.blocked",
  orphaned: "lab.runState.orphaned",
};

const FINDING_STATUS_KEYS: Record<FindingStatus, MessageKey> = {
  new: "lab.findingStatus.new",
  confirmed: "lab.findingStatus.confirmed",
  in_progress: "task.in_progress",
  mitigated: "lab.findingStatus.mitigated",
  verified: "lab.findingStatus.verified",
  reopened: "lab.findingStatus.reopened",
  false_positive: "lab.findingStatus.falsePositive",
  risk_accepted: "lab.findingStatus.riskAccepted",
  out_of_scope: "lab.findingStatus.outOfScope",
  duplicate: "lab.findingStatus.duplicate",
};

const ENGAGEMENT_STATUS_KEYS: Record<Engagement["status"], MessageKey> = {
  planned: "status.planned",
  active: "status.active",
  paused: "status.paused",
  completed: "status.completed",
  archived: "status.archived",
};

export const runStateLabel = (
  t: Translate,
  state: NativeToolRun["state"],
): string => t(RUN_STATE_KEYS[state]);

export const findingStatusLabel = (
  t: Translate,
  status: FindingStatus,
): string => t(FINDING_STATUS_KEYS[status]);

export const engagementStatusLabel = (
  t: Translate,
  status: Engagement["status"],
): string => t(ENGAGEMENT_STATUS_KEYS[status]);
