import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  FileSearch,
  Lock,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Square,
  Terminal,
  Trash2,
  Wrench,
} from "lucide-react";
import { openContextPanel } from "@/app/context/panelState";
import { EmptyState } from "@/components/ui/EmptyState";
import { EnablePrivateLabButton } from "@/components/EnablePrivateLabButton";
import { buildCommand } from "@/domain/lab/command";
import { formFor, isFixture } from "@/domain/tools/toolForms";
import { evaluateTarget } from "@/domain/lab/scope";
import type {
  AuthorizationScope,
  Engagement,
  Target,
  ToolProfile,
} from "@/domain/lab";
import { getBridge } from "@/lib/bridge";
import { Field } from "@/components/ui/Field";
import type { NativeScopeAttestation } from "@/lib/bridge/types";
import { getDb, useCollection, usePreferences } from "@/lib/db/database";
import { createId } from "@/lib/id";
import { now } from "@/lib/time";
import { useT } from "@/lib/i18n";
import { launchFailureMessage } from "@/lib/launch/launchFailureMessage";
import { useLabRuntime } from "@/state/labRuntime";
import { setInstallationBinding } from "./installationBindings";
import { profileFor, useLocateTool } from "./useLocateTool";
import { evidencePointingAtRun } from "./observationEvidence";
import { useUi } from "@/state/ui";
import { useTerminalTabs } from "@/features/terminal/terminalTabs";
import { NativeToolsUnavailable } from "./NativeToolsUnavailable";
import { LabViewHeader } from "./LabViewHeader";
import { ToolRunCard, targetValueOf } from "./ToolRunCard";
import { ToolIdentity } from "./ToolIdentity";
import { ToolProfileEditor } from "./ToolProfileEditor";
import { ToolWorkbench } from "./ToolWorkbench";
import { targetArg } from "./toolArgs";
import { runStateLabel } from "./labels";
import {
  argErrorText,
  scopeDecisionLabel,
  toolCategoryLabel,
  toolState,
  toolStateLabel,
  type ToolState,
} from "./toolLabels";

interface ToolLabPanelProps {
  engagement?: Engagement;
  scope?: AuthorizationScope;
  targets: Target[];
}

/** Lists longer than this get a search box. */
const SEARCH_FROM = 7;
const ACTIVE_STATES = ["queued", "starting", "running", "cancelling"];
const STATE_DOT: Record<ToolState, string> = {
  ready: "dot--success",
  changed: "dot--danger",
  disabled: "dot--muted",
};

export function ToolLabPanel({ engagement, scope, targets }: ToolLabPanelProps) {
  const { t, locale } = useT();
  const bridge = getBridge();
  const supervisor = bridge.toolSupervisor;
  const navigate = useNavigate();
  const openToolTab = useTerminalTabs((state) => state.openToolTab);
  const prefs = usePreferences();
  const consented = prefs.privateToolsEnabled;
  const runtime = useLabRuntime();
  // The runtime store says so once it has read the supervisor; the bridge
  // knows it before that first read.
  const nativeAvailable = runtime.available || supervisor.available();
  const installations = runtime.installations;
  const runs = runtime.runs;
  const selectedRunId = runtime.selectedRunId ?? "";
  const profiles = useCollection("toolProfiles");
  const bindings = useCollection("installationBindings");
  const evidence = useCollection("evidence");
  const toast = useUi((state) => state.toast);
  const db = getDb();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedInstallationId = searchParams.get("tool") ?? "";

  const [selectedInstallationId, setSelectedInstallationId] = useState("");
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [profileDraft, setProfileDraft] = useState<ToolProfile | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const locator = useLocateTool({
    engagement,
    onError: setError,
    onRegistered: (saved, profile) => {
      setSelectedInstallationId(saved.id);
      setSelectedProfileId(profile.id);
    },
  });

  const refresh = runtime.refresh;
  const ensureSubscribed = runtime.ensureSubscribed;

  // Subscribing is itself part of the private surface, so it waits for consent
  // as well as for a native runtime. Without the consent term, reaching
  // `/lab?view=tools` directly — by deep link, restored tab or refresh — opened
  // a live supervisor subscription and a usable tool library for a user who had
  // never opted in. The native commands now reject that too (ADR 0007); this
  // keeps the UI from asking for something it knows will be refused.
  useEffect(() => {
    if (nativeAvailable && consented) ensureSubscribed();
  }, [ensureSubscribed, nativeAvailable, consented]);

  useEffect(() => {
    setSelectedInstallationId((current) =>
      installations.some((item) => item.id === requestedInstallationId)
        ? requestedInstallationId
        : installations.some((item) => item.id === current)
        ? current
        : (installations[0]?.id ?? ""),
    );
  }, [installations, requestedInstallationId]);

  const selectedInstallation = installations.find(
    (item) => item.id === selectedInstallationId,
  );
  const installationProfiles = useMemo(
    () =>
      profiles.filter(
        (profile) => profile.installationId === selectedInstallationId,
      ),
    [profiles, selectedInstallationId],
  );

  useEffect(() => {
    const next =
      installationProfiles.find((profile) => profile.id === selectedProfileId) ??
      installationProfiles[0];
    setSelectedProfileId(next?.id ?? "");
    setProfileDraft(next ? { ...next, args: next.args.map((arg) => ({ ...arg })) } : null);
  }, [installationProfiles, selectedProfileId]);

  const visibleInstallations = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(locale);
    if (!needle) return installations;
    return installations.filter((item) =>
      [item.displayName, item.publisher, ...item.tags].some((value) =>
        value.toLocaleLowerCase(locale).includes(needle),
      ),
    );
  }, [installations, locale, query]);
  // The test program that checks the run path is listed apart, so it never
  // passes for an investigation tool.
  const listGroups = useMemo(
    () =>
      [
        {
          key: "tools",
          label: t("lab.wb.toolsGroup"),
          items: visibleInstallations.filter((item) => !isFixture(item)),
        },
        {
          key: "fixtures",
          label: t("lab.wb.fixtureGroup"),
          items: visibleInstallations.filter(isFixture),
        },
      ].filter((group) => group.items.length > 0),
    [visibleInstallations, t],
  );

  const selectedRun = runs.find((run) => run.id === selectedRunId);
  const activeRuns = runs.filter((run) => ACTIVE_STATES.includes(run.state));
  // A live run of an outside program is not in `runs`; the stop covers it.
  const anythingLive = activeRuns.length > 0 || runtime.outsideLive.length > 0;
  const toolRuns = runs
    .filter((run) => run.installationId === selectedInstallationId)
    .sort((a, b) => b.createdAt - a.createdAt);
  const builtCommand =
    profileDraft && selectedInstallation
      ? buildCommand(profileDraft, {
          executableLabel: selectedInstallation.displayName,
        })
      : null;

  const selectTool = (id: string) => {
    setSelectedInstallationId(id);
    const next = new URLSearchParams(searchParams);
    next.set("tool", id);
    setSearchParams(next, { replace: true });
  };

  const showRunOutput = (runId: string) => {
    runtime.selectRun(runId);
    openContextPanel("runs");
  };

  // Runs belong to the investigation, which lives in its own area.
  const openAllRuns = () =>
    navigate(
      engagement ? `/lab?e=${encodeURIComponent(engagement.id)}&view=runs` : "/lab?view=runs",
    );

  const saveProfile = (draft: ToolProfile | null = profileDraft) => {
    if (!draft) return;
    const saved = {
      ...draft,
      name: draft.name.trim() || selectedInstallation?.displayName || t("lab.tools.profile"),
      updatedAt: now(),
    };
    db.collection("toolProfiles").put(saved);
    setProfileDraft(saved);
  };

  const createProfile = () => {
    if (!selectedInstallation) return;
    const created = profileFor(selectedInstallation, engagement, {
      name: t("lab.tools.defaultProfileName", { name: selectedInstallation.displayName }),
      target: t("lab.tools.run.targetArgName"),
    });
    db.collection("toolProfiles").put(created);
    setSelectedProfileId(created.id);
  };

  const duplicateProfile = () => {
    if (!profileDraft) return;
    const timestamp = now();
    const duplicate: ToolProfile = {
      ...profileDraft,
      id: createId("profile"),
      name: t("lab.tools.profileCopyName", { name: profileDraft.name }),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    db.collection("toolProfiles").put(duplicate);
    setSelectedProfileId(duplicate.id);
  };

  const removeProfile = () => {
    if (!profileDraft) return;
    db.collection("toolProfiles").remove(profileDraft.id);
    setProfileDraft(null);
    setSelectedProfileId("");
  };

  /** A scope-bound setting with nowhere to name its target gets one, kept
      at once so the next run already has it. */
  const addTargetField = () => {
    if (!profileDraft) return;
    saveProfile({
      ...profileDraft,
      args: [
        ...profileDraft.args,
        targetArg(t("lab.tools.run.targetArgName"), profileDraft.args.length),
      ],
    });
  };

  /** The scope gate shared by every launch route: a target-bearing tool
      that requires an authorization scope must clear the same check whether
      it is about to run supervised (batch), open detached (gui), or open in
      a terminal tab (interactive). Centralized so a future tightening of the
      rule can't land in one route and silently miss the others. Returns the
      attestation to persist alongside a batch run, or `null` when the
      profile doesn't require scope at all. */
  const scopeGate = (
    targetValue: string,
  ):
    | { ok: true; attestation: NativeScopeAttestation | null }
    | { ok: false; error: string } => {
    if (!profileDraft?.requiresScope) return { ok: true, attestation: null };
    if (!targetValue || !scope) {
      return { ok: false, error: t("lab.tools.scopeRequired") };
    }
    const decision = evaluateTarget(targetValue, scope);
    if (!decision.allowed) {
      return {
        ok: false,
        error: `${t("lab.tools.scopeBlocked")}: ${scopeDecisionLabel(t, decision.reason)}`,
      };
    }
    return {
      ok: true,
      attestation: {
        scopeId: scope.id,
        scopeRevision: scope.revision,
        target: targetValue,
        allowed: decision.allowed,
        reason: decision.reason,
        decidedAt: now(),
        expiresAt: scope.expiresAt,
      },
    };
  };

  const valueErrors = () =>
    profileDraft && builtCommand
      ? builtCommand.errors.map((item) => argErrorText(t, item, profileDraft.args)).join("; ")
      : "";

  const runProfile = async () => {
    if (!profileDraft || !selectedInstallation || !builtCommand) return;
    if (builtCommand.errors.length > 0) {
      setError(valueErrors());
      return;
    }
    const targetValue = targetValueOf(profileDraft);
    const targetRecord = targetValue
      ? targets.find(
          (target) =>
            target.raw === targetValue || target.normalized === targetValue,
        )
      : undefined;
    const gate = scopeGate(targetValue);
    if (!gate.ok) {
      setError(gate.error);
      return;
    }
    const scopeAttestation = gate.attestation ?? undefined;

    saveProfile();
    setBusy("run");
    setError("");
    try {
      // As they went into argv: an untrimmed value would not be found.
      const redactions = buildCommand(profileDraft).sensitive.filter((value) => value.length >= 3);
      const started = await supervisor.start({
        installationId: selectedInstallation.id,
        profileId: profileDraft.id,
        requestId: createId("request"),
        engagementId: engagement?.id,
        targetId: targetRecord?.id,
        argv: builtCommand.argv,
        workingDir: profileDraft.workingDir || selectedInstallation.workingDir,
        environment: [],
        redactions,
        scope: scopeAttestation,
        requiresScope: profileDraft.requiresScope,
        timeoutSec: profileDraft.timeoutSec,
        outputLimitBytes: 1024 * 1024,
        concurrencyClass:
          profileDraft.concurrencyClass === "exclusive" ? "exclusive" : "default",
      });
      showRunOutput(started.id);
      await refresh();
    } catch (caught) {
      setError(launchFailureMessage(t, String(caught), selectedInstallation.displayName));
      await refresh();
    } finally {
      setBusy("");
    }
  };

  /** The single entry point for running a tool profile: routes by
      `launchKind` to a detached GUI process, an interactive terminal tab,
      or the existing supervised batch run. */
  const launch = async () => {
    if (!profileDraft || !selectedInstallation || !builtCommand) return;
    if (builtCommand.errors.length > 0) {
      setError(valueErrors());
      return;
    }
    // Same scope gate the batch path applies, for every launch kind: a
    // target-bearing tool never launches unscoped just because it opens as
    // a GUI app or a terminal tab instead of a supervised run.
    const gate = scopeGate(targetValueOf(profileDraft));
    if (!gate.ok) {
      setError(gate.error);
      return;
    }
    setError("");

    const launchKind = profileDraft.launchKind;
    if (launchKind === "batch") {
      await runProfile();
      return;
    }

    // gui and interactive both persist the draft first, same as batch does
    // via runProfile: otherwise unsaved edits would launch correctly once
    // but silently vanish from the saved profile.
    saveProfile();
    setBusy("run");
    try {
      if (launchKind === "gui") {
        const result = await supervisor.launchDetached(
          selectedInstallation.id,
          builtCommand.argv,
        );
        if (!result.ok) {
          setError(
            launchFailureMessage(t, result.reason, selectedInstallation.displayName),
          );
          return;
        }
        // The panel unmounts on navigation to /terminal for the interactive
        // route, so a local "notice" state would never paint (it's gone
        // before React commits it). A toast lives in the global store and
        // survives the route change either way.
        toast({
          kind: "success",
          messageKey: "lab.tools.launchedGui",
          params: { name: selectedInstallation.displayName },
        });
        return;
      }
      if (launchKind === "interactive") {
        // The renderer never names a path -- or a working directory -- on
        // this route: both are resolved server-side through the same
        // identity gate the batch and gui routes use (see terminal_open_tool
        // / resolve_launchable). A profile-level `workingDir` override does
        // not apply here; the registry's validated directory always wins.
        openToolTab({
          installationId: selectedInstallation.id,
          args: builtCommand.argv,
          title: selectedInstallation.displayName,
        });
        toast({
          // "info", not "success": this is an in-progress claim ("Opening...
          // "), not a completion claim -- the PTY itself is created later
          // when the terminal tab mounts, and can still fail.
          kind: "info",
          messageKey: "lab.tools.launchedInteractive",
          params: { name: selectedInstallation.displayName },
        });
        navigate("/terminal");
        return;
      }
      // Exhaustiveness guard, not a reachable runtime path for any value the
      // current ToolProfile["launchKind"] type allows: if a fourth kind is
      // ever added without a branch above, this line stops compiling instead
      // of silently falling through to the terminal route. It also fails
      // closed for a stored profile whose kind predates this type (e.g. an
      // old or hand-edited local record), reusing the existing
      // "launchUnavailable" copy rather than inventing a new user-facing
      // string for a case that shouldn't occur.
      const exhaustive: never = launchKind;
      setError(t("lab.tools.launchUnavailable"));
      void exhaustive;
    } catch (caught) {
      setError(String(caught));
    } finally {
      setBusy("");
    }
  };

  const reverify = async (acceptChangedIdentity: boolean) => {
    if (!selectedInstallation) return;
    setBusy("verify");
    setError("");
    try {
      await supervisor.reverify(selectedInstallation.id, acceptChangedIdentity);
      await refresh();
    } catch (caught) {
      setError(String(caught));
    } finally {
      setBusy("");
    }
  };

  const toggleEnabled = async () => {
    if (!selectedInstallation) return;
    setBusy("toggle");
    try {
      await supervisor.setEnabled(
        selectedInstallation.id,
        !selectedInstallation.enabled,
      );
      await refresh();
    } catch (caught) {
      setError(String(caught));
    } finally {
      setBusy("");
    }
  };

  const removeInstallation = async () => {
    if (!selectedInstallation) return;
    setBusy("remove");
    try {
      await supervisor.remove(selectedInstallation.id);
      setInstallationBinding(db, selectedInstallation.id, "");
      setSelectedInstallationId("");
      await refresh();
    } catch (caught) {
      setError(String(caught));
    } finally {
      setBusy("");
    }
  };

  const deleteSelectedArtifacts = async () => {
    if (!selectedRun || selectedRun.artifacts.length === 0) return;
    const pointing = evidencePointingAtRun(evidence, selectedRun.id).length;
    const message =
      pointing > 0
        ? t("lab.tools.deleteArtifactsEvidence", { count: pointing })
        : t("lab.tools.deleteArtifactsConfirm");
    if (!window.confirm(message)) return;
    setBusy("delete-artifacts");
    setError("");
    try {
      await supervisor.deleteArtifacts(selectedRun.id);
      await refresh();
    } catch (caught) {
      setError(String(caught));
    } finally {
      setBusy("");
    }
  };

  const emergencyStop = async () => {
    setBusy("emergency-stop");
    setError("");
    try {
      await supervisor.emergencyStop();
      await refresh();
    } catch (caught) {
      setError(String(caught));
    } finally {
      setBusy("");
    }
  };

  const cancelRun = async (runId: string) => {
    setBusy("cancel-run");
    setError("");
    try {
      await supervisor.cancel(runId);
      await refresh();
    } catch (caught) {
      setError(String(caught));
    } finally {
      setBusy("");
    }
  };

  const cancelSelectedRun = async () => {
    if (selectedRun) await cancelRun(selectedRun.id);
  };

  // Consent is checked before runtime availability: whether the user has opted
  // into the private lab is a question about permission, not about which build
  // they are running, and answering it first keeps this surface saying the same
  // thing as Tools and Terminal.
  if (!consented) {
    return (
      <section className="lab-native-unavailable" data-testid="native-tools-consent-required">
        <Lock size={22} aria-hidden />
        <div>
          <h2>{t("tools.enableTitle")}</h2>
          <p>{t("tools.enableBody")}</p>
          <p className="callout callout--warning" style={{ fontSize: "var(--fs-13)" }}>
            <ShieldAlert size={14} aria-hidden /> {t("tools.enableWarning")}
          </p>
          <EnablePrivateLabButton />
        </div>
      </section>
    );
  }

  if (!nativeAvailable) {
    return <NativeToolsUnavailable />;
  }

  const selectedState = selectedInstallation ? toolState(selectedInstallation) : null;
  const selectedRunHere = selectedRun?.installationId === selectedInstallationId;

  return (
    <div className="lab-tools-shell">
      <LabViewHeader
        icon={Wrench}
        title={t("tools.view.registered")}
        purpose={t("lab.purpose.tools")}
        action={
          <div className="lab-tools-actions">
            {anythingLive && (
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => void emergencyStop()}
                disabled={busy === "emergency-stop"}
              >
                <Ban size={14} aria-hidden /> {t("lab.tools.emergencyStop")}
              </button>
            )}
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void locator.locate()}
              disabled={locator.busy === "pick"}
            >
              <Plus size={14} aria-hidden /> {t("lab.tools.addTool")}
            </button>
          </div>
        }
      />

      {error && (
        <div className="lab-tool-error" role="alert">
          <AlertTriangle size={15} aria-hidden />
          <p>{error}</p>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setError("")}
          >
            {t("action.close")}
          </button>
        </div>
      )}

      {installations.length === 0 ? (
        <EmptyState
          icon={Wrench}
          title={t("lab.tools.empty")}
          hint={t("lab.tools.emptyHint")}
          action={
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void locator.locate()}
            >
              <Plus size={14} aria-hidden /> {t("lab.tools.addTool")}
            </button>
          }
        />
      ) : (
        <div className="lab-tool-workbench">
          <aside className="lab-tool-list" aria-label={t("lab.tools.library")}>
            {installations.length >= SEARCH_FROM && (
              <Field label={t("lab.tools.search")} className="lab-tool-search">
                {(id) => (
                  <div className="lab-tool-search__box">
                    <Search size={14} aria-hidden />
                    <input
                      id={id}
                      className="input input--sm"
                      type="search"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </div>
                )}
              </Field>
            )}
            {listGroups.map((group) => (
              <div className="wb-list-group" key={group.key}>
                {listGroups.length > 1 && (
                  <h3 className="wb-list-group__title">
                    {group.label} <span>{group.items.length}</span>
                  </h3>
                )}
                <ul className="lab-tool-rows">
                  {group.items.map((installation) => {
                    const state = toolState(installation);
                    const selected = installation.id === selectedInstallationId;
                    return (
                      <li key={installation.id}>
                        <button
                          type="button"
                          className={`lab-tool-row${selected ? " is-active" : ""}`}
                          aria-current={selected ? "true" : undefined}
                          onClick={() => selectTool(installation.id)}
                        >
                          <span className={`dot ${STATE_DOT[state]}`} aria-hidden />
                          <span className="lab-tool-row-main">
                            <strong>{installation.displayName}</strong>
                            <small>
                              {toolStateLabel(t, state)} ·{" "}
                              {isFixture(installation)
                                ? t("lab.wb.fixtureBadge")
                                : toolCategoryLabel(t, installation.category)}
                            </small>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
            {visibleInstallations.length === 0 && (
              <p className="lab-tool-nomatch">{t("lab.tools.noMatch")}</p>
            )}
          </aside>

          {selectedInstallation && selectedState && (
            <ToolWorkbench
              key={selectedInstallation.id}
              installation={selectedInstallation}
              state={selectedState}
              form={formFor(selectedInstallation)}
              fixture={isFixture(selectedInstallation)}
              engagement={engagement}
              scope={scope}
              targets={targets}
              runs={toolRuns}
              busy={busy}
              onReverify={(accept) => void reverify(accept)}
              onToggleEnabled={() => void toggleEnabled()}
              onShowOutput={showRunOutput}
              onCancelRun={(runId) => void cancelRun(runId)}
              onRunStarted={() => void refresh()}
              genericRun={
                <ToolRunCard
                  installation={selectedInstallation}
                  profiles={installationProfiles}
                  selectedProfileId={selectedProfileId}
                  onSelectProfile={setSelectedProfileId}
                  draft={profileDraft}
                  onDraftChange={setProfileDraft}
                  built={builtCommand}
                  scope={scope}
                  targets={targets}
                  busy={busy === "run"}
                  onLaunch={() => void launch()}
                  onAddTargetField={addTargetField}
                  onCreateProfile={createProfile}
                />
              }
              identity={
                <ToolIdentity
                  installation={selectedInstallation}
                  catalogId={
                    bindings.find(
                      (binding) => binding.installationId === selectedInstallation.id,
                    )?.catalogId ?? ""
                  }
                  onBind={(catalogId) =>
                    setInstallationBinding(db, selectedInstallation.id, catalogId)
                  }
                  busy={busy}
                  onReverify={(accept) => void reverify(accept)}
                  onToggleEnabled={() => void toggleEnabled()}
                  onRemove={() => void removeInstallation()}
                />
              }
              profileEditor={
                profileDraft ? (
                  <ToolProfileEditor
                    draft={profileDraft}
                    onDraftChange={setProfileDraft}
                    onSave={() => saveProfile()}
                    onNewProfile={createProfile}
                    onDuplicate={duplicateProfile}
                    onDelete={removeProfile}
                  />
                ) : null
              }
            />
          )}
        </div>
      )}

      {selectedInstallation && (
        <section className="lab-runs" aria-labelledby="lab-tool-runs-title">
          <div className="lab-runs-head">
            <div>
              <h2 id="lab-tool-runs-title">
                {t("lab.tools.toolRuns", { name: selectedInstallation.displayName })}
              </h2>
              <p>{t("lab.tools.toolRunsHint")}</p>
            </div>
            <div className="lab-tools-actions">
              <button
                type="button"
                className="btn btn--icon"
                title={t("lab.tools.refresh")}
                aria-label={t("lab.tools.refresh")}
                onClick={() => void refresh()}
              >
                <RefreshCw size={14} aria-hidden />
              </button>
              <button type="button" className="btn btn--sm" onClick={openAllRuns}>
                {t("lab.tools.allRuns")} <ArrowRight size={13} aria-hidden />
              </button>
            </div>
          </div>
          {toolRuns.length === 0 ? (
            <p className="lab-runs-empty">{t("lab.tools.noRuns")}</p>
          ) : (
            <div className="lab-run-grid">
              <ul className="lab-run-list">
                {toolRuns.map((run) => (
                  <li key={run.id}>
                    <button
                      type="button"
                      className={`lab-run-row${run.id === selectedRunId ? " is-active" : ""}`}
                      onClick={() => showRunOutput(run.id)}
                    >
                      <span className={`lab-run-state state-${run.state}`}>
                        {runStateLabel(t, run.state)}
                      </span>
                      <span className="lab-run-command">{run.commandPreview}</span>
                      <time>{new Date(run.createdAt).toLocaleTimeString(locale)}</time>
                    </button>
                  </li>
                ))}
              </ul>
              {selectedRun && selectedRunHere && (
                <div className="lab-run-output">
                  <header>
                    <div>
                      <strong>{selectedRun.commandPreview}</strong>
                      <span>
                        PID {selectedRun.pid ?? "—"} · {selectedRun.bytesOut + selectedRun.bytesErr} B
                        {selectedRun.truncated ? ` · ${t("lab.tools.truncated")}` : ""}
                      </span>
                    </div>
                    {ACTIVE_STATES.includes(selectedRun.state) && (
                      <button
                        type="button"
                        className="btn btn--danger btn--sm"
                        onClick={() => void cancelSelectedRun()}
                        disabled={busy === "cancel-run"}
                      >
                        <Square size={12} aria-hidden /> {t("lab.tools.stop")}
                      </button>
                    )}
                  </header>
                  <div className="lab-output-handoff">
                    <Terminal size={15} aria-hidden />
                    <span>{t("panel.outputOwnedHint")}</span>
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={() => showRunOutput(selectedRun.id)}
                    >
                      {t("panel.showOutput")}
                    </button>
                  </div>
                  {selectedRun.artifacts.length > 0 && (
                    <div className="lab-run-artifacts">
                      {selectedRun.artifacts.map((artifact) => (
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          key={artifact.path}
                          onClick={() => void bridge.openPath(artifact.path)}
                          title={artifact.path}
                        >
                          <FileSearch size={13} aria-hidden />
                          {artifact.kind} · {artifact.sizeBytes} B
                        </button>
                      ))}
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => void deleteSelectedArtifacts()}
                        disabled={busy === "delete-artifacts"}
                      >
                        <Trash2 size={13} aria-hidden />
                        {t("lab.tools.deleteArtifacts")}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {locator.dialog}
    </div>
  );
}
