import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Crosshair, FilePlus2, FolderPlus, X } from "lucide-react";
import { Field } from "@/components/ui/Field";
import type { AuthorizationScope, Engagement, Target } from "@/domain/lab";
import { evaluateTarget } from "@/domain/lab/scope";
import { getDb } from "@/lib/db/database";
import { useT } from "@/lib/i18n";
import { createId } from "@/lib/id";
import type { InvestigationFile } from "@/lib/investigationFiles";
import { now } from "@/lib/time";
import { useInvestigationFiles } from "@/state/investigationFiles";
import { useUi } from "@/state/ui";
import { FileAnalysis } from "./FileAnalysis";
import { FileCard } from "./FileCard";
import { LabDetail, LabSplit } from "./LabDetail";
import { fileKindIcon, fileKindLabelKey } from "./fileKinds";
import { toastAddOutcomes } from "./fileOutcomes";
import { LabViewHeader } from "./LabViewHeader";
import { DecisionBadge, type LabViewProps } from "./labViews";
import { formatBytes } from "./toolLabels";
import { useEngagementFolder } from "./useEngagementFolder";

/**
 * Hedefler ve dosyalar (spec 2026-10-07 §5.3): the investigation's
 * files and targets on the left, the selected one's card on the right. A
 * file is added with the native picker or by dropping it on the window; Rust
 * copies it into the investigation's folder. A target is checked against the
 * scope as it is typed and added, and a tool never runs against one outside
 * it. The selection is in the URL (`?item=file:<id>` or `target:<id>`), and
 * `?add=file` opens a new file investigation on its first step.
 */
export function LabTargets({ engagement, scope, targets }: LabViewProps) {
  const { t } = useT();
  if (!engagement) return <p className="lab-empty-note">{t("lab.empty")}</p>;
  return <TargetsAndFiles engagement={engagement} scope={scope} targets={targets} />;
}

const NO_FILES: readonly InvestigationFile[] = [];

function TargetsAndFiles({
  engagement,
  scope,
  targets,
}: {
  engagement: Engagement;
  scope?: AuthorizationScope;
  targets: Target[];
}) {
  const { t, locale } = useT();
  const toast = useUi((s) => s.toast);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const folder = useEngagementFolder(engagement);
  const files = useInvestigationFiles((s) => s.byEngagement[engagement.id] ?? NO_FILES);
  const loadState = useInvestigationFiles((s) => s.loadState[engagement.id]);
  const [draftTarget, setDraftTarget] = useState("");
  const [picking, setPicking] = useState(false);
  const addFilesRef = useRef<HTMLButtonElement>(null);

  // A new file investigation opens on adding its file; once there is one,
  // the step is done.
  const firstStep = params.get("add") === "file" && files.length === 0;
  const [itemKind, itemId] = (params.get("item") ?? "").split(":", 2);
  const selectedFile = itemKind === "file" ? files.find((f) => f.id === itemId) : undefined;
  const selectedTarget = itemKind === "target" ? targets.find((tg) => tg.id === itemId) : undefined;
  const canAddFiles = folder.native && !!folder.info;

  useEffect(() => {
    void useInvestigationFiles.getState().load(engagement.id);
  }, [engagement.id]);

  // A new file investigation lands here with the add-file step in focus.
  useEffect(() => {
    if (firstStep && canAddFiles) addFilesRef.current?.focus();
  }, [firstStep, canAddFiles]);

  // The URL and investigation as they are now, for a pick that finishes after
  // the user moved on: a large file takes a while to copy and hash.
  const latest = useRef({ params, engagementId: engagement.id });
  useEffect(() => {
    latest.current = { params, engagementId: engagement.id };
  });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const select = (kind: "file" | "target", id: string) => {
    const next = new URLSearchParams(latest.current.params);
    next.set("item", `${kind}:${id}`);
    next.delete("add");
    setParams(next);
  };
  const close = () => {
    const next = new URLSearchParams(latest.current.params);
    next.delete("item");
    setParams(next);
  };

  const addFiles = async () => {
    if (picking) return;
    const engagementId = engagement.id;
    setPicking(true);
    try {
      const outcomes = await useInvestigationFiles
        .getState()
        .pick(engagementId, t("lab.files.addTitle"));
      // Still on this investigation: open what was copied. Moved on: the
      // toast offers to.
      const stillHere = mounted.current && latest.current.engagementId === engagementId;
      const show = (file: InvestigationFile) => {
        const query = new URLSearchParams({
          e: engagementId,
          view: "targets",
          item: `file:${file.id}`,
        });
        navigate(`/lab?${query}`);
      };
      // Moved on meanwhile: the toast names the investigation the files went to.
      toastAddOutcomes(
        outcomes,
        toast,
        t,
        stillHere ? undefined : show,
        stillHere ? undefined : engagement.title,
      );
      const shown = outcomes.find((o) => o.outcome !== "failed");
      if (shown && stillHere) select("file", shown.file.id);
    } catch (error) {
      toast({
        kind: "danger",
        messageKey: error === "no_engagement_folder" ? "lab.files.needFolderToast" : "lab.files.pickFailed",
      });
    } finally {
      if (mounted.current) setPicking(false);
    }
  };

  const liveDecision = draftTarget.trim() ? evaluateTarget(draftTarget, scope) : null;

  const addTarget = () => {
    if (!draftTarget.trim()) return;
    const dec = evaluateTarget(draftTarget, scope);
    const t0 = now();
    getDb().collection("targets").put({
      id: createId("tgt"),
      engagementId: engagement.id,
      raw: draftTarget.trim(),
      normalized: dec.target.normalized,
      kind: dec.target.kind,
      scopeState: dec.allowed ? "in_scope" : "out_of_scope",
      notes: dec.reason,
      demo: false,
      createdAt: t0,
      updatedAt: t0,
    });
    setDraftTarget("");
  };

  return (
    <div className="lab-view-stack">
      <LabViewHeader icon={Crosshair} title={t("lab.view.targets")} purpose={t("lab.purpose.targets")} />
      <LabSplit
        detail={
          selectedFile ? (
            <LabDetail title={t("lab.insp.title.file")} subtitle={selectedFile.name} onClose={close}>
              <FileCard
                file={selectedFile}
                folderPath={folder.info?.exists ? folder.info.path : null}
              />
              <FileAnalysis key={selectedFile.id} file={selectedFile} />
            </LabDetail>
          ) : selectedTarget ? (
            <LabDetail title={t("lab.insp.title.target")} subtitle={selectedTarget.raw} onClose={close}>
              <TargetCard target={selectedTarget} scope={scope} />
            </LabDetail>
          ) : null
        }
      >
        <div className="lab-tf">
          <section
            className={firstStep ? "lab-card lab-tf__add is-first-step" : "lab-card lab-tf__add"}
            aria-labelledby="lab-tf-add"
          >
            <h3 id="lab-tf-add" className="lab-card-title">
              {t("lab.files.addOrTarget")}
            </h3>
            {firstStep && <p className="lab-tf__first">{t("lab.files.firstStep")}</p>}
            {!folder.native ? (
              <p className="lab-tf__note">{t("lab.files.desktopOnly")}</p>
            ) : folder.info === null ? (
              <p className="lab-tf__note">
                {t("lab.files.needFolder")}{" "}
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={folder.busy}
                  onClick={() => void folder.create()}
                >
                  <FolderPlus size={13} aria-hidden /> {t("lab.folder.create")}
                </button>
              </p>
            ) : (
              folder.info && (
                <div className="lab-tf__file-add">
                  {/* aria-disabled, not disabled: a disabled button would drop
                      the focus it just took. */}
                  <button
                    ref={addFilesRef}
                    type="button"
                    className="btn btn--primary"
                    data-guide="lab-add-files"
                    aria-disabled={picking || undefined}
                    onClick={() => void addFiles()}
                  >
                    <FilePlus2 size={14} aria-hidden /> {t("lab.files.add")}
                  </button>
                  <span className="lab-tf__hint">{t("lab.files.dropHint")}</span>
                </div>
              )
            )}
            <div className="lab-add-row" style={{ alignItems: "flex-end" }}>
              <Field label={t("lab.addTarget")} style={{ flex: 1 }}>
                {(id) => (
                  <input
                    id={id}
                    className="input"
                    data-guide="lab-add-target"
                    value={draftTarget}
                    placeholder={t("lab.targetPlaceholder")}
                    onChange={(e) => setDraftTarget(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addTarget();
                    }}
                  />
                )}
              </Field>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={addTarget}
                disabled={!draftTarget.trim()}
              >
                <Crosshair size={14} aria-hidden /> {t("lab.addTarget")}
              </button>
            </div>
            {liveDecision && (
              <div className="lab-live" data-testid="lab-live-decision">
                <span className="lab-normalized">
                  {t("lab.normalized")}: <code>{liveDecision.target.normalized}</code>{" "}
                  ({liveDecision.target.kind}, {liveDecision.target.location})
                </span>
                <DecisionBadge decision={liveDecision} />
              </div>
            )}
          </section>

          <section className="lab-card" aria-labelledby="lab-tf-files">
            <h3 id="lab-tf-files" className="lab-card-title">
              {t("lab.files.title")}
              <span className="lab-count">{files.length}</span>
            </h3>
            {loadState === "failed" ? (
              <p className="lab-targets-empty">{t("lab.files.loadFailed")}</p>
            ) : files.length === 0 ? (
              <p className="lab-targets-empty">{t("lab.files.empty")}</p>
            ) : (
              <ul className="lab-tf__files">
                {files.map((f) => {
                  const Icon = fileKindIcon(f.kind);
                  return (
                    <li key={f.id}>
                      <button
                        type="button"
                        className="lab-tf__file"
                        aria-current={f.id === selectedFile?.id ? "true" : undefined}
                        onClick={() => select("file", f.id)}
                      >
                        <Icon size={15} aria-hidden className="lab-tf__file-icon" />
                        <span className="lab-tf__file-name truncate">{f.name}</span>
                        <span className="lab-tf__file-meta">
                          {t(fileKindLabelKey(f.kind))} · {formatBytes(f.bytes, locale)}
                          {f.missing && (
                            <span className="lab-tf__file-missing">
                              {" · "}
                              {t("lab.files.missingShort")}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="lab-card" aria-labelledby="lab-scope-targets">
            <h3 id="lab-scope-targets" className="lab-card-title">
              {t("lab.targets")}
              <span className="lab-count">{targets.length}</span>
            </h3>
            {targets.length === 0 ? (
              <p className="lab-targets-empty">{t("lab.targets.empty")}</p>
            ) : (
              <ul className="lab-targets">
                {targets.map((tg) => {
                  const dec = evaluateTarget(tg.raw, scope);
                  return (
                    <li
                      key={tg.id}
                      className="lab-target"
                      aria-current={tg.id === selectedTarget?.id ? "true" : undefined}
                    >
                      <button
                        type="button"
                        className="lab-target__select"
                        onClick={() => select("target", tg.id)}
                      >
                        <code className="lab-target-raw">{tg.raw}</code>
                        <span className="lab-target-norm truncate">{tg.normalized}</span>
                      </button>
                      <DecisionBadge decision={dec} />
                      <button
                        type="button"
                        className="btn btn--ghost btn--icon btn--sm"
                        aria-label={t("lab.targets.remove", { target: tg.raw })}
                        title={t("lab.targets.removeShort")}
                        onClick={() => getDb().collection("targets").remove(tg.id)}
                      >
                        <X size={14} aria-hidden />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </LabSplit>
    </div>
  );
}

/** A target inside its LabDetail: what it reads as, and the scope's say. */
function TargetCard({ target, scope }: { target: Target; scope?: AuthorizationScope }) {
  const { t } = useT();
  const decision = evaluateTarget(target.raw, scope);
  return (
    <div className="lab-fcard">
      <dl className="lab-fcard__facts">
        <div>
          <dt>{t("lab.normalized")}</dt>
          <dd>
            <code>{decision.target.normalized}</code>
          </dd>
        </div>
      </dl>
      <DecisionBadge decision={decision} />
      <p className="lab-fcard__note">{t("lab.files.targetHint")}</p>
    </div>
  );
}
