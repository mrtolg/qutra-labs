import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { LOCALE_NAMES, SUPPORTED_LOCALES, useT } from "@/lib/i18n";
import { getDb, usePreferences } from "@/lib/db/database";
import { Segmented } from "@/components/ui/Segmented";
import { loadDemoData, isSeeded } from "@/domain/seed";
import { createId } from "@/lib/id";
import { now } from "@/lib/time";
import { recordEvent } from "@/services/appService";
import type { PermissionKey } from "@/domain/types";
import type { MessageKey } from "@/lib/i18n/en";
import {
  applyAppearanceAttributes,
  probeAppearanceCapabilities,
  resolveAppearance,
} from "@/lib/appearance";

const PERMS: PermissionKey[] = [
  "file_access",
  "git_inspection",
  "window_metadata",
  "global_shortcuts",
  "notifications",
];

export default function OnboardingPage() {
  const { t } = useT();
  const navigate = useNavigate();
  const prefs = usePreferences();
  const db = getDb();
  const [step, setStep] = useState(0);
  const [wsName, setWsName] = useState("");
  const [saveError, setSaveError] = useState(false);
  const total = 4;

  useEffect(() => {
    const root = document.documentElement;
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = resolveAppearance(
        prefs,
        probeAppearanceCapabilities(),
        scheme.matches,
      );
      applyAppearanceAttributes(root, resolved);
      root.dataset.density = prefs.density;
      root.dataset.reduceMotion = String(prefs.reduceMotion);
      root.lang = prefs.locale;
    };
    apply();
    scheme.addEventListener("change", apply);
    return () => scheme.removeEventListener("change", apply);
  }, [prefs]);

  const updatePrefs = async (
    patch: Parameters<typeof db.prefs.setDurable>[0],
  ) => {
    setSaveError(false);
    try {
      await db.prefs.setDurable(patch);
    } catch {
      setSaveError(true);
    }
  };

  const finish = async () => {
    setSaveError(false);
    try {
      await db.prefs.setDurable({ onboardingDone: true });
      navigate("/overview", { replace: true });
    } catch {
      setSaveError(true);
    }
  };

  const createWs = async () => {
    if (!wsName.trim()) return;
    const ws = {
      id: createId("ws"),
      name: wsName.trim(),
      color: "oklch(0.45 0.15 330)",
      icon: "folder",
      purpose: "",
      type: "software" as const,
      status: "active" as const,
      favorite: false,
      tags: [],
      defaultCommands: [],
      environmentLabels: [],
      ignoredPaths: [],
      browserCollections: [],
      restoreBehavior: "ask" as const,
      health: "needs_handoff" as const,
      demo: false,
      createdAt: now(),
      updatedAt: now(),
      lastActivityAt: now(),
    };
    setSaveError(false);
    try {
      await db.collection("workspaces").putDurable(ws);
      recordEvent("workspace_opened", ws.name, { workspaceId: ws.id });
      setStep(3);
    } catch {
      setSaveError(true);
    }
  };

  const setPerm = async (key: PermissionKey, state: "granted" | "denied") => {
    setSaveError(false);
    try {
      await db
        .collection("permissions")
        .putDurable({ id: key, key, state, updatedAt: now() });
    } catch (error) {
      setSaveError(true);
      throw error;
    }
  };

  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <div className="onboarding-steps">
          {t("onb.step", { current: step + 1, total })}
        </div>

        {step === 0 && (
          <>
            <div className="flex" style={{ gap: 10, marginBottom: "var(--sp-3)" }}>
              <img
                className="brand-logo"
                src="/favicon.png"
                alt=""
                aria-hidden
                style={{ width: 28, height: 28, borderRadius: 6 }}
              />
              <h1 style={{ fontSize: "var(--fs-24)" }}>{t("onb.welcome")}</h1>
            </div>
            <p className="muted" style={{ marginBottom: "var(--sp-5)" }}>
              {t("onb.promise")}
            </p>
            <div className="flex">
              <button type="button" className="btn btn--primary" onClick={() => setStep(1)}>
                {t("onb.start")} <ArrowRight size={14} aria-hidden />
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => void finish()}>
                {t("onb.skipAll")}
              </button>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <h1 style={{ marginBottom: "var(--sp-4)" }}>{t("onb.prefs")}</h1>
            <div className="stack" style={{ gap: "var(--sp-3)" }}>
              <div className="setting-row">
                <label className="setting-label" htmlFor="onb-language">
                  {t("common.language")}
                </label>
                <select
                  id="onb-language"
                  className="select"
                  value={prefs.locale}
                  onChange={(event) =>
                    void updatePrefs({
                      locale: event.target.value as typeof prefs.locale,
                    })
                  }
                >
                  {SUPPORTED_LOCALES.map((locale) => (
                    <option key={locale} value={locale}>
                      {LOCALE_NAMES[locale]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="setting-row">
                <div className="setting-label">{t("common.theme")}</div>
                <Segmented
                  ariaLabel={t("common.theme")}
                  value={prefs.themeMode}
                  onChange={(v) => {
                    void updatePrefs({
                      theme: "system",
                      themeMode: v,
                    });
                  }}
                  options={[
                    { value: "system", label: t("settings.theme.system") },
                    { value: "light", label: t("settings.theme.light") },
                    { value: "dark", label: t("settings.theme.dark") },
                  ]}
                />
              </div>
              <div className="setting-row">
                <div className="setting-label">{t("common.density")}</div>
                <Segmented
                  ariaLabel={t("common.density")}
                  value={prefs.density}
                  onChange={(v) => void updatePrefs({ density: v })}
                  options={[
                    { value: "comfortable", label: t("settings.density.comfortable") },
                    { value: "compact", label: t("settings.density.compact") },
                  ]}
                />
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label" id="onb-start-on-login">
                    {t("settings.startOnLogin")}
                  </div>
                  <div className="setting-hint">{t("settings.startOnLoginHint")}</div>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    aria-labelledby="onb-start-on-login"
                    checked={false}
                    disabled
                    title={t("settings.startOnLoginUnavailable")}
                    onChange={() => undefined}
                  />
                  <span className="switch-track" aria-hidden />
                </label>
              </div>
            </div>
            <div className="flex" style={{ marginTop: "var(--sp-5)" }}>
              <button type="button" className="btn btn--secondary" onClick={() => setStep(0)}>
                {t("action.back")}
              </button>
              <button type="button" className="btn btn--primary" onClick={() => setStep(2)}>
                {t("action.next")}
              </button>
              <div style={{ flex: 1 }} />
              <button type="button" className="btn btn--ghost" onClick={() => void finish()}>
                {t("onb.skipAll")}
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h1 style={{ marginBottom: "var(--sp-2)" }}>{t("onb.firstWs")}</h1>
            <p className="muted" style={{ marginBottom: "var(--sp-4)", fontSize: "var(--fs-13)" }}>
              {t("onb.firstWsHint")}
            </p>
            <div className="field" style={{ marginBottom: "var(--sp-3)" }}>
              <label htmlFor="onb-ws-name">{t("common.name")}</label>
              <input
                id="onb-ws-name"
                className="input"
                value={wsName}
                onChange={(e) => setWsName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void createWs();
                }}
              />
            </div>
            <div className="flex" style={{ flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn btn--primary"
                disabled={!wsName.trim()}
                onClick={() => void createWs()}
              >
                {t("onb.createWs")}
              </button>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => {
                  if (!isSeeded(db)) loadDemoData(db);
                  setStep(3);
                }}
              >
                {t("onb.useDemo")}
              </button>
              <div style={{ flex: 1 }} />
              <button type="button" className="btn btn--ghost" onClick={() => setStep(3)}>
                {t("action.skip")}
              </button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h1 className="flex" style={{ gap: 8, marginBottom: "var(--sp-2)" }}>
              <ShieldCheck size={18} aria-hidden style={{ color: "var(--success)" }} />
              {t("onb.permTitle")}
            </h1>
            <p className="muted" style={{ marginBottom: "var(--sp-4)", fontSize: "var(--fs-13)" }}>
              {t("onb.permHint")}
            </p>
            <div className="stack" style={{ gap: "var(--sp-2)", maxHeight: 320, overflowY: "auto" }}>
              {PERMS.map((key) => (
                <PermRow key={key} permKey={key} onDecide={setPerm} />
              ))}
            </div>
            <div className="flex" style={{ marginTop: "var(--sp-5)" }}>
              <button type="button" className="btn btn--secondary" onClick={() => setStep(2)}>
                {t("action.back")}
              </button>
              <div style={{ flex: 1 }} />
              <button type="button" className="btn btn--primary" onClick={() => void finish()}>
                {t("onb.finish")}
              </button>
            </div>
          </>
        )}
        {saveError && (
          <p className="form-error" role="alert" style={{ marginTop: "var(--sp-3)" }}>
            {t("settings.prefsSaveFailed")}
          </p>
        )}
      </div>
    </div>
  );
}

function PermRow({
  permKey,
  onDecide,
}: {
  permKey: PermissionKey;
  onDecide: (key: PermissionKey, state: "granted" | "denied") => Promise<void>;
}) {
  const { t } = useT();
  const [state, setState] = useState<"granted" | "denied" | null>(null);
  const [busy, setBusy] = useState(false);

  const decide = async (next: "granted" | "denied") => {
    setBusy(true);
    try {
      await onDecide(permKey, next);
      setState(next);
    } catch {
      // The parent renders the save error and keeps the choice available.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel panel-body" style={{ padding: "var(--sp-2) var(--sp-3)" }}>
      <div className="flex">
        <strong style={{ flex: 1, fontSize: "var(--fs-13)" }}>
          {t(`perm.${permKey}` as MessageKey)}
        </strong>
        {state === null ? (
          <>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={busy}
              onClick={() => void decide("granted")}
            >
              {t("perm.grant")}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={busy}
              onClick={() => void decide("denied")}
            >
              {t("perm.notNow")}
            </button>
          </>
        ) : (
          <span className={`badge ${state === "granted" ? "badge--success" : "badge--neutral"}`}>
            {t(`perm.${state}` as MessageKey)}
          </span>
        )}
      </div>
      <p className="muted" style={{ fontSize: "var(--fs-12)", marginTop: 4 }}>
        {t(`perm.${permKey}.what` as MessageKey)} {t(`perm.${permKey}.why` as MessageKey)}
      </p>
    </div>
  );
}
