import { Check, Cloud, Cpu, type LucideIcon } from "lucide-react";
import { aiConnections, type KeyStatus } from "@/lib/aiConnections";
import { getDb, usePreferences } from "@/lib/db/database";
import { useT } from "@/lib/i18n";
import { useUi } from "@/state/ui";
import type { Preferences } from "@/domain/types";
import { useKeyStatus } from "./cloudKeyStatus";

type Route = Preferences["aiProvider"];

interface RouteOption {
  id: Route;
  icon: LucideIcon;
  name: string;
  /** Where a question goes on this route. */
  where: string;
  /** What the route needs, or that it is ready. */
  state: string;
  ready: boolean;
  /** False while Rust has not answered yet. */
  known: boolean;
  /** A cloud route without a key cannot be chosen. */
  disabled: boolean;
}

function hostOf(address: string | null): string | null {
  if (!address) return null;
  try {
    return new URL(address).host || null;
  } catch {
    return null;
  }
}

/**
 * Which way Jarvis talks: the local model on this computer, Claude, or the
 * OpenAI-compatible service. One choice, three tiles: each says where a
 * question goes and whether the route is ready, read from the stored
 * preference and from Rust's key status (never from a guess).
 */
export function JarvisRoutePicker() {
  const { t } = useT();
  const prefs = usePreferences();
  const toast = useUi((s) => s.toast);
  const announce = useUi((s) => s.announce);
  const desktop = aiConnections.available();
  const anthropic = useKeyStatus(desktop ? { provider: "anthropic" } : null);
  const compat = useKeyStatus(
    desktop ? { provider: "openai_compat", preset: prefs.aiOpenAiPreset } : null,
  );

  const cloudState = (status: KeyStatus | null): string =>
    !desktop
      ? t("settings.route.desktopOnly")
      : status === null
        ? t("settings.route.checking")
        : status.present
          ? status.last4
            ? t("settings.cloud.keySaved", { last4: status.last4 })
            : t("settings.cloud.keySavedNoKey")
          : t("settings.route.needsKey");

  const compatName = `${t("settings.cloud.compatName")} · ${t(`settings.cloud.preset.${prefs.aiOpenAiPreset}`)}`;
  const options: RouteOption[] = [
    {
      id: "ollama",
      icon: Cpu,
      name: t("settings.route.local"),
      where: t("settings.route.whereLocal"),
      state: prefs.localAssistantEnabled
        ? t("settings.route.localOn")
        : t("settings.route.localOff"),
      ready: prefs.localAssistantEnabled,
      known: true,
      disabled: false,
    },
    {
      id: "anthropic",
      icon: Cloud,
      name: t("settings.cloud.anthropicName"),
      where: hostOf(anthropic?.baseUrl ?? null) ?? "api.anthropic.com",
      state: cloudState(anthropic),
      ready: Boolean(anthropic?.present),
      known: desktop && anthropic !== null,
      disabled: !anthropic?.present && prefs.aiProvider !== "anthropic",
    },
    {
      id: "openai_compat",
      icon: Cloud,
      name: compatName,
      where: hostOf(compat?.baseUrl ?? null) ?? t("settings.route.whereCompat"),
      state: cloudState(compat),
      ready: Boolean(compat?.present),
      known: desktop && compat !== null,
      disabled: !compat?.present && prefs.aiProvider !== "openai_compat",
    },
  ];

  const current = options.find((option) => option.id === prefs.aiProvider) ?? options[0];

  const choose = (option: RouteOption) => {
    if (option.disabled || option.id === prefs.aiProvider) return;
    getDb().prefs.set({ aiProvider: option.id });
    const message = t("settings.route.switched", { name: option.name });
    toast({ kind: "success", message });
    announce(message);
  };

  return (
    <div className="route-picker">
      <div className="route-picker__head">
        <h4 className="settings-block-heading" id="jarvis-route-label">
          {t("settings.route.title")}
        </h4>
        <p className="muted route-picker__lede">{t("settings.route.lede")}</p>
      </div>
      <div className="route-picker__tiles" role="radiogroup" aria-labelledby="jarvis-route-label">
        {options.map((option) => {
          const Icon = option.icon;
          const selected = option.id === current.id;
          return (
            <label
              key={option.id}
              className={`route-tile${selected ? " is-selected" : ""}${option.disabled ? " is-disabled" : ""}`}
              data-route={option.id}
            >
              <input
                type="radio"
                className="sr-only"
                name="jarvis-route"
                value={option.id}
                checked={selected}
                disabled={option.disabled}
                onChange={() => choose(option)}
              />
              <span className="route-tile__top">
                <span className="route-tile__icon" aria-hidden>
                  <Icon size={15} />
                </span>
                <span className="route-tile__name">{option.name}</span>
                {selected && <Check size={14} className="route-tile__check" aria-hidden />}
              </span>
              <span className="route-tile__where mono">→ {option.where}</span>
              <span className={`route-tile__state${option.ready ? " is-ready" : ""}`}>
                <span className={`dot ${option.ready ? "dot--success" : "dot--muted"}`} aria-hidden />
                {option.state}
              </span>
            </label>
          );
        })}
      </div>
      {current.known && !current.ready && (
        <p className="callout callout--warning route-picker__warning" role="status">
          {current.id === "ollama"
            ? t("settings.route.localOffWarning")
            : t("settings.route.noKeyWarning", { name: current.name })}
        </p>
      )}
    </div>
  );
}
