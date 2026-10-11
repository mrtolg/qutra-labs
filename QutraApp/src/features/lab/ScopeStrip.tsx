import { Ban, ChevronRight, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import type { AuthorizationScope, Target } from "@/domain/lab";
import { engagementScopeStatus, scopeReach, type ScopeStatus } from "@/domain/lab/scope";
import { useT } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n/en";

const META: Record<ScopeStatus, { icon: typeof ShieldCheck; cls: string }> = {
  not_configured: { icon: ShieldQuestion, cls: "is-neutral" },
  acknowledgement_required: { icon: ShieldAlert, cls: "is-warn" },
  validated: { icon: ShieldCheck, cls: "is-allowed" },
  target_out_of_scope: { icon: Ban, cls: "is-blocked" },
};

/** Allowed patterns named in full before "+n more". */
const SHOWN = 3;

const CLOSED: Record<"no_scope" | "scope_expired" | "outside_window", MessageKey> = {
  no_scope: "lab.strip.none",
  scope_expired: "lab.strip.expired",
  outside_window: "lab.strip.outsideWindow",
};

/**
 * The scope at the top of every investigation view (spec 2026-10-07 D5):
 * what tools may reach, in the gate's own terms (`scopeReach`), and the way
 * to change it. Local and private addresses need no entry, so the strip says
 * so instead of claiming that only the listed targets can be scanned.
 */
export function ScopeStrip({
  scope,
  targets,
  onOpen,
}: {
  scope?: AuthorizationScope;
  targets: Target[];
  onOpen: () => void;
}) {
  const { t } = useT();
  const status = engagementScopeStatus(scope, targets);
  const { icon: Icon, cls } = META[status.status];
  const reach = scopeReach(scope);
  const list = (items: string[]) =>
    items.slice(0, SHOWN).join(", ") +
    (items.length > SHOWN ? ` ${t("lab.strip.more", { count: items.length - SHOWN })}` : "");
  const summary =
    reach.kind === "none"
      ? t(CLOSED[reach.reason])
      : reach.kind === "listed"
        ? `${t("lab.strip.allowed", { list: list(reach.allowed) })} · ${t("lab.strip.alsoLocal")}`
        : reach.unconfirmed.length > 0
          ? t("lab.strip.needsAck", { list: list(reach.unconfirmed) })
          : t("lab.strip.localOnly");
  return (
    <button
      type="button"
      className={`lab-strip ${cls}`}
      onClick={onOpen}
      data-testid="lab-scope-strip"
    >
      <span className={`lab-scope-badge ${cls}`}>
        <Icon size={13} aria-hidden />
        {status.outOfScopeCount > 0
          ? t("lab.scopeStatus.outOfScope", { count: status.outOfScopeCount })
          : t(`lab.scopeStatus.${status.status}` as MessageKey)}
      </span>
      <span className="lab-strip__text">{summary}</span>
      <span className="lab-strip__edit">
        {t("lab.strip.edit")} <ChevronRight size={13} aria-hidden />
      </span>
    </button>
  );
}
