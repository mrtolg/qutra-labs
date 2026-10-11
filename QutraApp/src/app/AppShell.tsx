import { useEffect, type MouseEvent } from "react";
import { TopBar } from "./TopBar";
import { SubNav } from "./SubNav";
import { CommandPalette } from "./CommandPalette";
import { SettingsDialog } from "@/features/settings/SettingsDialog";
import { Workbench } from "./workbench/Workbench";
import { Toasts } from "@/components/ui/Toasts";
import { AssistantGreeting } from "./AssistantGreeting";
import { FileDrops } from "@/features/lab/FileDrops";
import { useT } from "@/lib/i18n";
import { useSurfaceCovered } from "./context/panelState";
import { useAppliedAppearance } from "./useAppliedAppearance";
import { useShortcuts } from "./useShortcuts";

export function SkipToMainLink() {
  const { t } = useT();
  // Under the overlay context panel #main is inert, so the link would go nowhere.
  const covered = useSurfaceCovered();

  const focusMain = (event: MouseEvent<HTMLAnchorElement>) => {
    const main = document.getElementById("main");
    if (!(main instanceof HTMLElement)) return;
    event.preventDefault();
    main.focus();
    main.scrollIntoView({ block: "nearest" });
  };

  return (
    <a href="#main" className="skip-link" onClick={focusMain} inert={covered}>
      {t("a11y.skipToMain")}
    </a>
  );
}

export function AppShell() {

  useEffect(() => {
    let cancelled = false;
    const root = document.documentElement;
    delete root.dataset.appReady;
    void document.fonts.ready.then(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => resolve()),
          );
        }),
    ).then(() => {
      if (!cancelled) root.dataset.appReady = "true";
    });
    return () => {
      cancelled = true;
      delete root.dataset.appReady;
    };
  }, []);

  useAppliedAppearance();

  useShortcuts();

  return (
    <div className="shell">
      <SkipToMainLink />
      <TopBar />
      <SubNav />
      <Workbench />
      <CommandPalette />
      {/* After the palette: a section chosen there opens this once the
          palette has handed focus back, so both share one origin. */}
      <SettingsDialog />
      <Toasts />
      <AssistantGreeting />
      {/* Files dropped on the window go to the open investigation. */}
      <FileDrops />
    </div>
  );
}
