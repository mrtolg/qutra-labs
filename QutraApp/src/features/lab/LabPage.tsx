import { useEffect, useMemo, useRef } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { AlertTriangle, ArrowRight, Ban, FilePlus2, Plus, Shield, Square } from "lucide-react";
import type { MessageKey } from "@/lib/i18n/en";
import { useT } from "@/lib/i18n";
import { getDb, useCollection } from "@/lib/db/database";
import { getBridge } from "@/lib/bridge";
import { EmptyState } from "@/components/ui/EmptyState";
import type { FolderInfo } from "@/lib/engagementFolders";
import { EngagementKind } from "@/domain/lab";
import { engagementScopeStatus } from "@/domain/lab/scope";
import { movedLabView, resolveLabView, type LabView } from "@/domain/workbench";
import { useInvestigationFiles } from "@/state/investigationFiles";
import { useLabRuntime } from "@/state/labRuntime";
import { useUi } from "@/state/ui";
import { useLabEngagement } from "./useLabEngagement";
import { useEngagementAutosave } from "./useEngagementAutosave";
import { InvestigationList } from "./InvestigationList";
import { startsWithFile } from "./fileKinds";
import { kindIcon } from "./kindIcon";
import { openFindingsByEngagement, totalOf } from "./investigationFacts";
import { NewEngagementDialog } from "./NewEngagementDialog";
import { EngagementFolder, EngagementSwitcher, EngagementTitle } from "./EngagementHeader";
import { ScopeStrip } from "./ScopeStrip";
import { AskJarvis, CloudConsentStat } from "./AskJarvis";
import { LabTargets } from "./LabTargets";
import { LabReport } from "./LabReport";
import {
  LabOverview,
  LabScope,
  LabRuns,
  LabFindings,
  LabEvidence,
  type LabViewProps,
} from "./labViews";
import "./lab.css";

/**
 * Investigations (spec 2026-10-07 §5): a header that is the same on every
 * section, the scope strip under it, the red "Runs are blocked" bar only while
 * a target is out of scope, and the open section. The six sections are the
 * sub-tabs under the top bar; Scope opens from the strip. The section and any
 * open record live in the URL, so every section deep-links. Old links to the
 * Tools and Guides views go to the Tools area.
 */
export default function LabPage() {
  const { t, locale } = useT();
  const [params, setParams] = useSearchParams();
  const scopes = useCollection("authorizationScopes");
  const findings = useCollection("findings");
  const runtime = useLabRuntime();
  const toast = useUi((state) => state.toast);
  /** Where the focus goes after the header's cloud allowance is revoked. */
  const askJarvisRef = useRef<HTMLButtonElement | null>(null);

  const view = resolveLabView(params.get("view"));
  /** ?list=1 shows every investigation instead of one. */
  const listing = params.get("list") === "1";
  const { engagements, current, engTargets, runsState, activeRuns } = useLabEngagement(
    params.get("e"),
  );
  const scope = current?.scopeId ? scopes.find((s) => s.id === current.scopeId) : undefined;
  useEngagementAutosave(current);
  const openFindings = useMemo(
    () => (current ? totalOf(openFindingsByEngagement(findings).get(current.id)) : 0),
    [findings, current],
  );

  // Files dropped on the window go to the investigation shown here (FileDrops).
  // The list shows none of them, so a drop there has nowhere to go.
  const dragOver = useInvestigationFiles((s) => s.dragOver);
  const dropId = listing ? undefined : current?.id;
  useEffect(() => {
    if (!dropId) return;
    const { setDropTarget } = useInvestigationFiles.getState();
    setDropTarget(dropId);
    return () => setDropTarget(null);
  }, [dropId]);

  const moved = movedLabView(params);
  if (moved) return <Navigate to={moved} replace />;

  /* No effect writes ?e back into the URL: it ran with the params of the render
     that saw a new engagement and replaced a navigation made in the same tick
     (rail "New engagement" → ?e=…&view=scope lost its view). Every link here
     names the engagement instead, and the rail falls back the same way. */

  const go = (nextView: LabView, engagementId = current?.id) =>
    setParams(engagementId ? { e: engagementId, view: nextView } : { view: nextView });

  /* Starting an investigation asks for its name and folder first (?new=1, so
     Home and the palette open the same dialog; Home's tiles add ?kind=). Once
     made it opens on its Overview, which says what to do next, and a toast
     names what was made. */
  const creating = params.get("new") === "1";
  const requestedKind = EngagementKind.safeParse(params.get("kind"));
  const createEngagement = () => {
    const next = new URLSearchParams(params);
    next.set("new", "1");
    setParams(next);
  };
  const closeCreate = () => {
    const next = new URLSearchParams(params);
    next.delete("new");
    next.delete("kind");
    setParams(next);
  };
  const created = (id: string, title: string, folder: FolderInfo | null) => {
    // A file, capture or forensic investigation starts by adding its file
    // (spec 2026-10-07 §5.2); the others open on Overview.
    const kind = getDb().collection("engagements").get(id)?.kind;
    setParams(startsWithFile(kind) ? { e: id, view: "targets", add: "file" } : { e: id, view: "overview" });
    toast(
      folder
        ? {
            kind: "success",
            messageKey: "lab.create.doneWithFolder",
            params: { name: title },
            actionKey: "lab.folder.open",
            onAction: () => void getBridge().openPath(folder.path),
          }
        : { kind: "success", messageKey: "lab.create.done", params: { name: title } },
    );
  };
  const createDialog = (
    <NewEngagementDialog
      open={creating}
      kind={requestedKind.success ? requestedKind.data : undefined}
      onClose={closeCreate}
      onCreated={created}
    />
  );

  const stopAll = async () => {
    const results = await Promise.allSettled(
      activeRuns.map((r) => getBridge().toolSupervisor.cancel(r.id)),
    );
    if (results.some((r) => r.status === "rejected")) {
      toast({ kind: "danger", messageKey: "lab.stopAllFailed" });
    }
    void runtime.refresh();
  };

  if (listing) {
    return (
      <div className="page lab-page lab-page--list" data-scroll-owner="page">
        <InvestigationList onCreate={createEngagement} />
        {createDialog}
      </div>
    );
  }

  if (!current) {
    return (
      <div className="page lab-page" data-scroll-owner="page">
        <div className="lab-view-body">
          <EmptyState
            icon={Shield}
            title={t("lab.empty")}
            hint={t("lab.emptyHint")}
            action={
              <button type="button" className="btn btn--primary" data-guide="lab-new" onClick={createEngagement}>
                <Plus size={15} aria-hidden /> {t("lab.newEngagement")}
              </button>
            }
          />
        </div>
        {createDialog}
      </div>
    );
  }

  const outOfScope = engagementScopeStatus(scope, engTargets).status === "target_out_of_scope";
  const viewProps: LabViewProps = { engagement: current, scope, targets: engTargets };
  const KindIcon = kindIcon(current);

  /* The header reads like a case file: kind and name, then a
     row of readouts, each a small label over its value. The counts are the
     same facts the sections row counts. */
  return (
    <div className="page lab-page" data-scroll-owner="page">
      <header className="lab-head" data-status={current.status}>
        <div className="lab-head__top">
          <span className="lab-head__icon" aria-hidden>
            <KindIcon size={20} strokeWidth={1.7} />
          </span>
          <div className="lab-head__title">
            <EngagementTitle key={current.id} engagement={current} />
            {/* What kind of case this is, under its name: a quiet line, not
                an uppercase label over the heading. */}
            <span className="lab-eyebrow">
              {t("lab.engagement")}
              <span className="lab-eyebrow__sep" aria-hidden>
                /
              </span>
              {t(`lab.kind.${current.kind ?? "general"}` as MessageKey)}
            </span>
          </div>
          <span className="lab-head__grow" />
          <div className="lab-head__actions">
            <AskJarvis engagement={current} buttonRef={askJarvisRef} />
            <EngagementSwitcher
              engagements={engagements}
              current={current}
              onSelect={(id) => go(view, id)}
              onCreate={createEngagement}
              defaultOpen={params.get("switch") === "1"}
            />
            <button
              type="button"
              className="btn btn--secondary lab-head__create"
              data-guide="lab-new"
              onClick={createEngagement}
            >
              <Plus size={14} aria-hidden /> {t("lab.newEngagement")}
            </button>
          </div>
        </div>
        <div className="lab-head__stats" role="group" aria-label={t("lab.header.facts")}>
          <span className="lab-stat lab-readout">
            <strong>{engTargets.length}</strong> <span>{t("lab.header.targets")}</span>
          </span>
          <span
            className={runsState === "known" ? "lab-stat lab-readout" : "lab-stat lab-readout is-note"}
            data-testid="lab-active-runs"
          >
            {runsState === "known" ? (
              <>
                <strong className={activeRuns.length > 0 ? "is-live" : undefined}>
                  {activeRuns.length}
                </strong>{" "}
                <span>{t("lab.header.activeRuns")}</span>
              </>
            ) : runsState === "failed" ? (
              <>
                <AlertTriangle size={13} className="lab-stat__warn" aria-hidden />
                {t("lab.header.runsReadFailed")}
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => void runtime.refresh()}
                >
                  {t("action.retry")}
                </button>
              </>
            ) : (
              t(runsState === "reading" ? "lab.header.runsReading" : "lab.header.runsHidden")
            )}
          </span>
          <span className="lab-stat lab-readout">
            <strong className={openFindings > 0 ? "is-attn" : undefined}>{openFindings}</strong>{" "}
            <span>{t("lab.header.openFindings")}</span>
          </span>
          <span className="lab-head__sep" aria-hidden />
          <EngagementFolder engagement={current} />
          <CloudConsentStat
            key={current.id}
            engagement={current}
            onRevoked={() => askJarvisRef.current?.focus()}
          />
          <span className="lab-stat lab-stat--muted">
            {t("lab.header.lastUpdated")}{" "}
            {new Date(current.updatedAt).toLocaleString(locale, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </span>
          <span className="lab-head__grow" />
          {activeRuns.length > 0 && (
            <button
              type="button"
              className="btn btn--danger-outline btn--sm"
              onClick={() => void stopAll()}
            >
              <Square size={12} aria-hidden /> {t("lab.stopAll")}
            </button>
          )}
        </div>
      </header>

      <ScopeStrip scope={scope} targets={engTargets} onOpen={() => go("scope")} />

      {outOfScope && (
        <div className="lab-blocked" role="alert">
          <Ban size={16} aria-hidden />
          <p>
            <strong>{t("lab.blocked.title")}</strong> {t("lab.scopeStatus.blockedExplain")}
          </p>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => go("scope")}>
            {t("lab.blocked.openScope")} <ArrowRight size={13} aria-hidden />
          </button>
        </div>
      )}

      {/* The six sections are the sub-tabs under the top bar (SubNav). */}
      <div className="lab-view-body">
        {view === "overview" && <LabOverview {...viewProps} />}
        {view === "targets" && <LabTargets {...viewProps} />}
        {view === "runs" && <LabRuns {...viewProps} />}
        {view === "evidence" && <LabEvidence {...viewProps} />}
        {view === "findings" && <LabFindings {...viewProps} />}
        {view === "report" && <LabReport {...viewProps} />}
        {view === "scope" && <LabScope {...viewProps} />}
      </div>
      {dragOver && (
        <div className="lab-drop" aria-hidden>
          <p className="lab-drop__label">
            <FilePlus2 size={18} />
            {t("lab.files.dropHere", { name: current.title })}
          </p>
        </div>
      )}
      {createDialog}
    </div>
  );
}
