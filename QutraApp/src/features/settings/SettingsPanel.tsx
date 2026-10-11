import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import {
  Settings2,
  Palette,
  Languages,
  Keyboard,
  Activity,
  Lock,
  KeyRound,
  Bot,
  HardDrive,
  Archive,
  Bell,
  Wrench,
  Info,
  Search,
  type LucideIcon,
} from "lucide-react";
import { useT } from "@/lib/i18n";
import { useUi } from "@/state/ui";
import type { MessageKey } from "@/lib/i18n/en";
import type { SettingsSection } from "./sections";
import { GeneralSection } from "./GeneralSection";
import { AppearanceSection } from "./AppearanceSection";
import { LanguageRegionSection } from "./LanguageRegionSection";
import { ShortcutsSection } from "./ShortcutsSection";
import { CaptureSection } from "./CaptureSection";
import { PrivacySection } from "./PrivacySection";
import { PermissionsSection } from "./PermissionsSection";
import { AiProvidersSection } from "./AiProvidersSection";
import { StorageSection } from "./StorageSection";
import { ImportExportSection } from "./ImportExportSection";
import { NotificationsSection } from "./NotificationsSection";
import { AdvancedSection } from "./AdvancedSection";
import { AboutSection } from "./AboutSection";

type Section = SettingsSection;

const SECTION_ICONS: Record<Section, LucideIcon> = {
  general: Settings2,
  appearance: Palette,
  languageRegion: Languages,
  shortcuts: Keyboard,
  capture: Activity,
  privacy: Lock,
  permissions: KeyRound,
  ai: Bot,
  storage: HardDrive,
  importExport: Archive,
  notifications: Bell,
  advanced: Wrench,
  about: Info,
};

/** One component per section, each in its own file. */
const SECTION_CONTENT: Record<Section, ComponentType> = {
  general: GeneralSection,
  appearance: AppearanceSection,
  languageRegion: LanguageRegionSection,
  shortcuts: ShortcutsSection,
  capture: CaptureSection,
  privacy: PrivacySection,
  permissions: PermissionsSection,
  ai: AiProvidersSection,
  storage: StorageSection,
  importExport: ImportExportSection,
  notifications: NotificationsSection,
  advanced: AdvancedSection,
  about: AboutSection,
};

const NAV_GROUPS: {
  labelKey: MessageKey;
  sections: readonly Section[];
}[] = [
  {
    labelKey: "settings.group.app",
    sections: ["general", "appearance", "languageRegion", "shortcuts"],
  },
  {
    labelKey: "settings.group.privacy",
    sections: ["capture", "privacy", "permissions", "ai"],
  },
  {
    labelKey: "settings.group.data",
    sections: ["storage", "importExport", "notifications"],
  },
  {
    labelKey: "settings.group.system",
    sections: ["advanced", "about"],
  },
];

/** The Settings sections and their content, shown inside SettingsDialog. */
export default function SettingsPanel({ section }: { section: Section }) {
  const { t, locale } = useT();
  const openSettings = useUi((s) => s.openSettings);

  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const setSection = (s: Section) => openSettings(s);

  useEffect(() => {
    if (paneRef.current) paneRef.current.scrollTop = 0;
  }, [section]);

  // The first open loads this panel after the modal is already showing; take
  // focus then. Later opens are focused by SettingsDialog itself.
  useEffect(() => {
    const input = searchRef.current;
    if (input?.closest("dialog")?.open) input.focus();
  }, []);

  const sectionLabel = (s: Section): string =>
    t(`settings.${s}` as MessageKey);

  const visibleGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    return NAV_GROUPS.map((group) => ({
      ...group,
      sections: group.sections.filter((s) => {
        if (!q) return true;
        return (
          sectionLabel(s).toLowerCase().includes(q) ||
          t(group.labelKey).toLowerCase().includes(q)
        );
      }),
    })).filter((group) => group.sections.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, locale]);

  const SectionIcon = SECTION_ICONS[section];
  const SectionContent = SECTION_CONTENT[section];

  return (
    <div className="settings-shell">
      <aside className="settings-rail" aria-label={t("settings.sections")}>
        <div className="settings-rail-head">
          <label className="field-label" htmlFor="settings-search">
            {t("settings.searchLabel")}
          </label>
          <label className="settings-search">
            <Search size={14} aria-hidden />
            <input
              ref={searchRef}
              id="settings-search"
              className="settings-search-input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
        </div>
        <nav className="settings-nav">
          {visibleGroups.map((group) => (
            <div className="settings-nav-group" key={group.labelKey}>
              <div className="settings-nav-label">{t(group.labelKey)}</div>
              {group.sections.map((s) => {
                const Icon = SECTION_ICONS[s];
                return (
                  <button
                    key={s}
                    type="button"
                    data-section={s}
                    className={section === s ? "active" : ""}
                    aria-current={section === s ? "true" : undefined}
                    onClick={() => setSection(s)}
                  >
                    <Icon size={15} aria-hidden />
                    <span>{sectionLabel(s)}</span>
                  </button>
                );
              })}
            </div>
          ))}
          {visibleGroups.length === 0 && (
            <p className="settings-nav-empty muted">{t("settings.searchNoResults")}</p>
          )}
        </nav>
      </aside>

      {/* The rail and the pane scroll independently; this marks the pane as
          the modal's primary vertical scroll surface for the scroll tests. */}
      <div ref={paneRef} className="settings-pane" data-scroll-owner="settings">
        <header className="settings-pane-head">
          <span className="settings-pane-icon" aria-hidden>
            <SectionIcon size={16} />
          </span>
          <h3>{sectionLabel(section)}</h3>
        </header>
        <div className="settings-pane-body">
          <SectionContent />
        </div>
      </div>
    </div>
  );
}
