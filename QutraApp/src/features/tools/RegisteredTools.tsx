import { Link, useSearchParams } from "react-router-dom";
import { Plus, Shield } from "lucide-react";
import { useCollection } from "@/lib/db/database";
import { useT } from "@/lib/i18n";
import { ToolLabPanel } from "@/features/lab/ToolLabPanel";
import { useLabEngagement } from "@/features/lab/useLabEngagement";

/**
 * Tools › Registered tools (spec 2026-10-07 §5.1): the registered programs,
 * run against one investigation's targets and scope — the one named by `?e`,
 * else the one worked on last — and the line above says which one. With no
 * investigation there is nothing to run against, and a run would belong to
 * no investigation's Runs, so only the way to start one shows.
 */
export function RegisteredTools() {
  const { t } = useT();
  const [params] = useSearchParams();
  const scopes = useCollection("authorizationScopes");
  const { current, engTargets } = useLabEngagement(params.get("e"));
  if (!current) {
    return (
      <p className="lab-tools-for" data-testid="tools-investigation">
        <Shield size={14} aria-hidden />
        {t("tools.registered.none")}{" "}
        <Link to="/lab?new=1">
          <Plus size={13} aria-hidden /> {t("lab.newEngagement")}
        </Link>
      </p>
    );
  }
  const scope = current.scopeId ? scopes.find((s) => s.id === current.scopeId) : undefined;
  return (
    <>
      <p className="lab-tools-for" data-testid="tools-investigation">
        <Shield size={14} aria-hidden />
        {t("tools.registered.for")}{" "}
        <Link to={`/lab?e=${encodeURIComponent(current.id)}`}>{current.title}</Link>
      </p>
      <ToolLabPanel engagement={current} scope={scope} targets={engTargets} />
    </>
  );
}
