import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Bot, CheckCircle2, Cloud, FlaskConical, Loader2 } from "lucide-react";
import { useT } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n/en";
import { getDb, useCollection, usePreferences } from "@/lib/db/database";
import { useUi } from "@/state/ui";
import { getBridge } from "@/lib/bridge";
import { formatDateTime, now } from "@/lib/time";
import { recordEvent } from "@/services/appService";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { grantPrivateLab } from "@/lib/enablePrivateLab";
import { revokeNativeConsent } from "@/app/workbench/consentSync";
import { setToolProposalsFromSettings } from "@/domain/assistantConsent";
import type { Preferences } from "@/domain/types";
import { readPrivateLabConsent, type PrivateLabConsentStatus } from "@/lib/privateLabConsent";
import "./settingsSections.css";

/** The permissions this page switches; each id keys `permissionChangedAt`. */
type PermissionId = "privateLab" | "localAssistant" | "toolProposals" | "autoApproveReads";

/** A change that needs a yes first: turning on what lets Jarvis act, and
    turning off Private Lab, which stops running scans. */
type Pending =
  | { id: "privateLab"; next: false; activeRuns: number }
  | { id: "toolProposals"; next: true }
  | { id: "autoApproveReads"; next: true };

/** Lab consent as Rust reports it; `unavailable` in the browser build. */
type LabState =
  | { kind: "checking" }
  | { kind: "unavailable" }
  | { kind: "unreadable" }
  | { kind: "read"; status: PrivateLabConsentStatus };

const FLASH_MS = 1600;

/**
 * Settings › Permissions, as a ledger: what each permission allows, its
 * state, when it last changed and what turning it off stops. Private Lab's
 * state is read from Rust; the Jarvis switches are the stored preferences
 * Rust receives with every request. A change flips the switch only once it
 * is saved, then confirms itself four ways: the row flashes, a toast, a
 * screen-reader announcement, and a line under the row saying what happened.
 */
export function PermissionsSection() {
  const { t, locale } = useT();
  const prefs = usePreferences();
  const toast = useUi((s) => s.toast);
  const announce = useUi((s) => s.announce);
  const openSettings = useUi((s) => s.openSettings);
  const cloudAllowed = useCollection("engagements").filter((e) => e.cloudConsent);

  const [lab, setLab] = useState<LabState>({ kind: "checking" });
  const [busy, setBusy] = useState<PermissionId | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [receipts, setReceipts] = useState<Partial<Record<PermissionId, string>>>({});
  const [flash, setFlash] = useState<PermissionId | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);

  const readLab = useCallback(async (): Promise<PrivateLabConsentStatus | null> => {
    try {
      const status = await readPrivateLabConsent();
      setLab(status ? { kind: "read", status } : { kind: "unavailable" });
      return status;
    } catch {
      setLab({ kind: "unreadable" });
      return null;
    }
  }, []);

  // Read again whenever the mirror changes: another surface may have granted
  // or revoked, and the page shows what Rust says, not the mirror.
  useEffect(() => {
    void readLab();
  }, [readLab, prefs.privateToolsEnabled]);

  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  const confirmChange = (id: PermissionId, message: string) => {
    setReceipts((current) => ({ ...current, [id]: message }));
    setFlash(id);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), FLASH_MS);
    toast({ kind: "success", message });
    announce(message);
  };

  const stamp = (id: PermissionId): Pick<Preferences, "permissionChangedAt"> => ({
    permissionChangedAt: { ...getDb().prefs.get().permissionChangedAt, [id]: now() },
  });

  /** Save a Jarvis switch; the switch flips once the change is on disk. */
  const savePreference = async (
    id: Exclude<PermissionId, "privateLab">,
    next: boolean,
    changes: Partial<Preferences>,
  ) => {
    setBusy(id);
    try {
      await getDb().prefs.setDurable({ ...changes, ...stamp(id) });
      recordEvent("permission_changed", `${id}: ${next ? "on" : "off"}`);
      confirmChange(id, t(`perm2.${id}.${next ? "onDone" : "offDone"}` as MessageKey));
    } catch {
      toast({ kind: "danger", messageKey: "settings.prefsSaveFailed" });
    } finally {
      setBusy(null);
    }
  };

  const setLabConsent = async (next: boolean) => {
    setBusy("privateLab");
    try {
      if (next) {
        const result = await grantPrivateLab();
        const status = await readLab();
        if (status?.granted) {
          await getDb().prefs.setDurable(stamp("privateLab"));
          recordEvent("permission_changed", "privateLab: on");
          confirmChange("privateLab", t("perm2.privateLab.onDone"));
        } else if (result === "declined") {
          toast({ kind: "info", messageKey: "perm2.privateLab.declined" });
        } else if (result === "unavailable") {
          toast({ kind: "info", messageKey: "perm2.desktopOnly" });
        } else {
          toast({ kind: "danger", messageKey: "perm2.privateLab.grantFailed" });
        }
        return;
      }
      await revokeNativeConsent();
      const status = await readLab();
      if (status && status.granted) {
        toast({ kind: "danger", messageKey: "perm2.privateLab.revokeFailed" });
        return;
      }
      await getDb().prefs.setDurable(stamp("privateLab"));
      recordEvent("permission_changed", "privateLab: off");
      confirmChange("privateLab", t("perm2.privateLab.offDone"));
    } catch {
      toast({ kind: "danger", messageKey: "settings.prefsSaveFailed" });
    } finally {
      setBusy(null);
    }
  };

  const request = async (id: PermissionId, next: boolean) => {
    if (busy) return;
    if (id === "privateLab") {
      if (next) return void setLabConsent(true);
      let activeRuns = 0;
      try {
        activeRuns = (await getBridge().toolSupervisor.listActiveRuns()).length;
      } catch {
        // The count is only shown; the revoke stops whatever runs.
      }
      setPending({ id, next: false, activeRuns });
      return;
    }
    if (id === "toolProposals" && next) return setPending({ id, next: true });
    if (id === "autoApproveReads" && next) return setPending({ id, next: true });
    if (id === "localAssistant") {
      return void savePreference(id, next, { localAssistantEnabled: next });
    }
    if (id === "toolProposals") {
      return void savePreference(id, next, setToolProposalsFromSettings(next));
    }
    return void savePreference(id, next, { assistantAutoApproveReads: next });
  };

  const confirmPending = () => {
    const change = pending;
    setPending(null);
    if (!change) return;
    if (change.id === "privateLab") return void setLabConsent(false);
    if (change.id === "toolProposals") {
      return void savePreference(change.id, true, setToolProposalsFromSettings(true));
    }
    return void savePreference(change.id, true, { assistantAutoApproveReads: true });
  };

  const changedAt = (id: PermissionId): number | null => prefs.permissionChangedAt[id] ?? null;
  const when = (on: boolean, at: number | null): string =>
    at === null
      ? t("perm2.whenUnknown")
      : t(on ? "perm2.onSince" : "perm2.offSince", { date: formatDateTime(at, locale) });

  const labOn = lab.kind === "read" && lab.status.granted;
  const labWhen =
    lab.kind === "checking"
      ? t("perm2.checking")
      : lab.kind === "unavailable"
        ? t("perm2.desktopOnly")
        : lab.kind === "unreadable"
          ? t("perm2.privateLab.unreadable")
          : when(labOn, labOn ? (lab.status.grantedAt ?? changedAt("privateLab")) : changedAt("privateLab"));

  const proposalsBlocked = prefs.assistantAgentToolsEnabled
    ? !prefs.localAssistantEnabled
      ? t("jarvis.permission.gInactiveAssistantOff")
      : !labOn && lab.kind !== "checking"
        ? t("perm2.toolProposals.labOff")
        : null
    : null;

  const latestCloud = cloudAllowed.reduce<number | null>(
    (latest, e) => Math.max(latest ?? 0, e.cloudConsent!.grantedAt),
    null,
  );

  const pendingCopy = pending
    ? pending.id === "privateLab"
      ? {
          title: t("perm2.privateLab.confirmTitle"),
          body:
            t("perm2.privateLab.confirmBody") +
            (pending.activeRuns > 0
              ? ` ${t("perm2.privateLab.confirmRuns", { count: pending.activeRuns })}`
              : ""),
          label: t("perm2.privateLab.confirmAction"),
          danger: true,
        }
      : pending.id === "toolProposals"
        ? {
            title: t("perm2.toolProposals.confirmTitle"),
            body: t("perm2.toolProposals.confirmBody"),
            label: t("perm2.toolProposals.confirmAction"),
            danger: false,
          }
        : {
            title: t("perm2.autoApproveReads.confirmTitle"),
            body: t("perm2.autoApproveReads.confirmBody"),
            label: t("perm2.autoApproveReads.confirmAction"),
            danger: false,
          }
    : null;

  return (
    <section className="settings-section settings-section--wide perm-ledger" data-testid="permissions-ledger">
      <p className="muted settings-block-lede">{t("perm2.lede")}</p>

      <PermissionGroup icon={<FlaskConical size={14} />} title={t("perm2.group.lab")}>
        <PermissionRow
          id="privateLab"
          title={t("perm2.privateLab.title")}
          allows={t("perm2.privateLab.allows")}
          stops={t("perm2.privateLab.stops")}
          on={labOn}
          state={lab.kind === "checking" ? "checking" : lab.kind === "read" ? (labOn ? "on" : "off") : "unavailable"}
          when={labWhen}
          busy={busy === "privateLab"}
          disabled={lab.kind !== "read"}
          receipt={receipts.privateLab}
          flash={flash === "privateLab"}
          onToggle={(next) => void request("privateLab", next)}
          testId="private-lab-override"
        />
      </PermissionGroup>

      <PermissionGroup icon={<Bot size={14} />} title={t("perm2.group.jarvis")}>
        <PermissionRow
          id="localAssistant"
          title={t("perm2.localAssistant.title")}
          allows={t("perm2.localAssistant.allows")}
          stops={t("perm2.localAssistant.stops")}
          on={prefs.localAssistantEnabled}
          state={prefs.localAssistantEnabled ? "on" : "off"}
          when={when(prefs.localAssistantEnabled, changedAt("localAssistant"))}
          busy={busy === "localAssistant"}
          receipt={receipts.localAssistant}
          flash={flash === "localAssistant"}
          onToggle={(next) => void request("localAssistant", next)}
          testId="local-assistant-override"
        />
        <PermissionRow
          id="toolProposals"
          title={t("perm2.toolProposals.title")}
          allows={t("perm2.toolProposals.allows")}
          stops={t("perm2.toolProposals.stops")}
          on={prefs.assistantAgentToolsEnabled}
          state={prefs.assistantAgentToolsEnabled ? (proposalsBlocked ? "blocked" : "on") : "off"}
          when={when(prefs.assistantAgentToolsEnabled, changedAt("toolProposals"))}
          note={proposalsBlocked}
          busy={busy === "toolProposals"}
          receipt={receipts.toolProposals}
          flash={flash === "toolProposals"}
          onToggle={(next) => void request("toolProposals", next)}
          testId="local-assistant-agent-toggle"
        />
        <PermissionRow
          id="autoApproveReads"
          title={t("perm2.autoApproveReads.title")}
          allows={t("perm2.autoApproveReads.allows")}
          stops={t("perm2.autoApproveReads.stops")}
          on={prefs.assistantAutoApproveReads}
          state={prefs.assistantAutoApproveReads ? "on" : "off"}
          when={when(prefs.assistantAutoApproveReads, changedAt("autoApproveReads"))}
          note={prefs.assistantAgentToolsEnabled ? null : t("perm2.autoApproveReads.needsProposals")}
          disabled={!prefs.assistantAgentToolsEnabled}
          busy={busy === "autoApproveReads"}
          receipt={receipts.autoApproveReads}
          flash={flash === "autoApproveReads"}
          onToggle={(next) => void request("autoApproveReads", next)}
          testId="local-assistant-auto-approve-reads-toggle"
        />
      </PermissionGroup>

      <PermissionGroup icon={<Cloud size={14} />} title={t("perm2.group.cloud")}>
        <div className="perm-row" data-state={cloudAllowed.length > 0 ? "on" : "off"}>
          <div className="perm-row__main">
            <div className="perm-row__titleline">
              <h5 className="perm-row__title">{t("perm2.cloud.title")}</h5>
              <StateChip
                state={cloudAllowed.length > 0 ? "on" : "off"}
                label={
                  cloudAllowed.length > 0
                    ? t("perm2.cloud.onCount", { count: cloudAllowed.length })
                    : t("perm2.cloud.none")
                }
              />
            </div>
            <p className="perm-row__allows">{t("perm2.cloud.allows")}</p>
            <p className="perm-row__stops">
              <span className="perm-row__stops-label">{t("perm2.ifOff")}</span> {t("perm2.cloud.stops")}
            </p>
            <p className="perm-row__when">
              {latestCloud === null
                ? t("perm2.cloud.never")
                : t("perm2.cloud.latest", { date: formatDateTime(latestCloud, locale) })}
            </p>
          </div>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => openSettings("ai")}>
            {t("perm2.cloud.manage")}
          </button>
        </div>
      </PermissionGroup>

      <ConfirmDialog
        open={pendingCopy !== null}
        title={pendingCopy?.title ?? ""}
        body={pendingCopy?.body ?? ""}
        confirmLabel={pendingCopy?.label ?? ""}
        danger={pendingCopy?.danger}
        onClose={() => setPending(null)}
        onConfirm={confirmPending}
      />
    </section>
  );
}

function PermissionGroup({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="perm-group">
      <h4 className="perm-group__title">
        <span className="perm-group__icon" aria-hidden>
          {icon}
        </span>
        {title}
      </h4>
      <div className="perm-group__rows">{children}</div>
    </div>
  );
}

type RowState = "on" | "off" | "blocked" | "checking" | "unavailable";

function StateChip({ state, label }: { state: RowState; label: string }) {
  return (
    <span className={`perm-chip perm-chip--${state}`}>
      <span className="perm-chip__lamp" aria-hidden />
      {label}
    </span>
  );
}

function PermissionRow({
  id,
  title,
  allows,
  stops,
  on,
  state,
  when,
  note,
  busy,
  disabled,
  receipt,
  flash,
  onToggle,
  testId,
}: {
  id: PermissionId;
  title: string;
  allows: string;
  stops: string;
  on: boolean;
  state: RowState;
  when: string;
  note?: string | null;
  busy: boolean;
  disabled?: boolean;
  receipt?: string;
  flash: boolean;
  onToggle: (next: boolean) => void;
  testId: string;
}) {
  const { t } = useT();
  const titleId = `perm-${id}-title`;
  const allowsId = `perm-${id}-allows`;
  const chipLabel =
    state === "checking"
      ? t("perm2.checking")
      : state === "unavailable"
        ? t("perm2.unavailable")
        : state === "blocked"
          ? t("perm2.stateBlocked")
          : on
            ? t("perm2.stateOn")
            : t("perm2.stateOff");
  return (
    <div className="perm-row" data-state={state} data-flash={flash ? "true" : undefined} data-perm={id}>
      <div className="perm-row__main">
        <div className="perm-row__titleline">
          <h5 className="perm-row__title" id={titleId}>
            {title}
          </h5>
          <StateChip state={state} label={chipLabel} />
        </div>
        <p className="perm-row__allows" id={allowsId}>
          {allows}
        </p>
        <p className="perm-row__stops">
          <span className="perm-row__stops-label">{t("perm2.ifOff")}</span> {stops}
        </p>
        <p className="perm-row__when">{when}</p>
        {note && <p className="perm-row__note">{note}</p>}
        {receipt && (
          <p className="perm-row__receipt">
            <CheckCircle2 size={13} aria-hidden /> {receipt}
          </p>
        )}
      </div>
      <div className="perm-row__control">
        {busy && <Loader2 size={14} className="spin perm-row__busy" aria-hidden />}
        <label className="switch">
          <input
            type="checkbox"
            aria-labelledby={titleId}
            aria-describedby={allowsId}
            checked={on}
            disabled={disabled}
            aria-busy={busy || undefined}
            onChange={(e) => {
              if (!busy) onToggle(e.target.checked);
            }}
            data-testid={testId}
          />
          <span className="switch-track" aria-hidden />
        </label>
      </div>
    </div>
  );
}
