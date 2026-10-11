import { useLocation, useNavigate } from "react-router-dom";
import { Home, PanelRight, Search, Settings } from "lucide-react";
import { useT } from "@/lib/i18n";
import { useUi } from "@/state/ui";
import { usePreferences } from "@/lib/db/database";
import { toggleContextPanel } from "./context/panelState";
import { SURFACES, areaFor } from "./surfaces";
import { useGlideThumb } from "./useGlideThumb";
import { useShortcutBindings } from "./useShortcuts";
import { ariaKeyshortcuts, bindingKeys, bindingText, keyLabel } from "@/lib/shortcuts";

/** Home first, then the four areas, each with the shortcut that opens it. */
const AREAS = [
  { area: "home", to: "/overview", labelKey: "nav.overview", icon: Home, shortcut: "go.home" },
  ...SURFACES.map(({ area, to, labelKey, icon }) => ({ area, to, labelKey, icon, shortcut: `go.${area}` })),
] as const;

/**
 * The app's top bar under the native Windows title bar: mark and name
 * (home), the area switcher, Search and Settings. Since the one-bar
 * layout it is the app's only navigation bar: choosing an area
 * slides its sections into the row below (SubNav). It is navigation, not a
 * tab pattern, so the switcher is a <nav> of buttons with aria-current; the
 * highlight glides to the chosen area.
 */
export function TopBar() {
  const { t, locale } = useT();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const setPaletteOpen = useUi((s) => s.setPaletteOpen);
  const openSettings = useUi((s) => s.openSettings);
  const current = areaFor(pathname);
  const contextOpen = usePreferences().contextPanelOpen;
  const bindings = useShortcutBindings();
  const titled = (label: string, id: string) =>
    bindings[id] ? `${label} (${bindingText(bindings[id])})` : label;
  // The highlight is one element that moves to the chosen button.
  const { ref: segRef, thumb } = useGlideThumb<HTMLDivElement>(`${current}|${locale}`);


  return (
    <header className="topbar">
      <button
        type="button"
        className="topbar-home"
        onClick={() => navigate("/overview")}
        aria-label={`${t("app.name")} — ${t("nav.overview")}`}
      >
        {/* Both variants ship; app.css shows the one the theme owns. */}
        <img className="logo-mark logo-mark--red" src="/brand/q-mark.svg" alt="" aria-hidden />
        <img className="logo-mark logo-mark--cyan" src="/brand/q-mark-cyan.svg" alt="" aria-hidden />
        <span className="topbar-brand">{t("app.name")}</span>
      </button>
      <nav className="topbar-center" aria-label={t("topbar.surfaces")}>
        <div className={thumb ? "topbar-seg has-thumb" : "topbar-seg"} ref={segRef}>
          {thumb && (
            <span
              className="topbar-seg__thumb"
              aria-hidden
              style={{ transform: `translateX(${thumb.x}px)`, width: thumb.width }}
            />
          )}
          {AREAS.map((a) => (
            <button
              key={a.to}
              type="button"
              data-guide={`area-${a.area}`}
              aria-current={a.area === current ? "page" : undefined}
              aria-keyshortcuts={ariaKeyshortcuts(bindings[a.shortcut])}
              title={bindings[a.shortcut] ? titled(t(a.labelKey), a.shortcut) : undefined}
              onClick={() => navigate(a.to)}
            >
              <a.icon size={15} aria-hidden />
              {t(a.labelKey)}
            </button>
          ))}
        </div>
      </nav>
      <div className="topbar-end">
        <button
          type="button"
          className="topbar-search"
          data-guide="search"
          onClick={() => setPaletteOpen(true)}
          aria-keyshortcuts={ariaKeyshortcuts(bindings.palette)}
        >
          <Search size={14} aria-hidden />
          {t("topbar.search")}
          {bindings.palette && (
            <kbd aria-hidden>{bindingKeys(bindings.palette).map(keyLabel).join(" ")}</kbd>
          )}
        </button>
        <button
          type="button"
          className="topbar-icon"
          onClick={() => openSettings()}
          data-guide="settings"
          aria-label={t("nav.settings")}
          aria-keyshortcuts={ariaKeyshortcuts(bindings.settings)}
          title={titled(t("nav.settings"), "settings")}
        >
          <Settings size={17} aria-hidden />
        </button>
        <button
          type="button"
          className="topbar-icon"
          onClick={toggleContextPanel}
          data-guide="context"
          aria-label={t("ctx.toggle")}
          aria-pressed={contextOpen}
          aria-keyshortcuts={ariaKeyshortcuts(bindings.contextPanel)}
          title={titled(t("ctx.toggle"), "contextPanel")}
        >
          <PanelRight size={17} aria-hidden />
        </button>
      </div>
    </header>
  );
}
