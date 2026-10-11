import { resolveLabView, resolveToolsView } from "@/domain/workbench";
import type { SettingsSection } from "@/features/settings/sections";
import type { MessageKey } from "@/lib/i18n/en";

/* The companion's static guides: for every page, a short list of steps,
   each optionally pointing at an element of the app by its `data-guide`
   name. Everything is written text in the six languages (deferred copy);
   nothing here is generated, read from the screen or sent anywhere. */

export type PageId =
  | "overview"
  | "projects"
  | "files"
  | "github"
  | "lab.list"
  | "lab.overview"
  | "lab.targets"
  | "lab.runs"
  | "lab.evidence"
  | "lab.findings"
  | "lab.report"
  | "lab.scope"
  | "tools.box"
  | "tools.registered"
  | "tools.catalog"
  | "tools.playbooks"
  | "tools.datasets"
  | "terminal"
  | "assistant"
  | "settings"
  | "generic";

/** What the companion reads of the address: the path and the query. */
export interface RouteInput {
  pathname: string;
  search: string;
  /** The open Settings section; Settings is a dialog, not a route. */
  settingsSection?: SettingsSection | null;
}

/** The page the user is on, from the address (and the Settings dialog). */
export function pageIdFor({ pathname, search, settingsSection }: RouteInput): PageId {
  if (settingsSection) return "settings";
  const params = new URLSearchParams(search);
  switch (pathname.split("/")[1] ?? "") {
    case "overview":
      return "overview";
    case "workspaces":
    case "sessions":
      return "projects";
    case "files":
      return "files";
    case "github":
      return "github";
    case "lab":
      return params.get("list") === "1" ? "lab.list" : `lab.${resolveLabView(params.get("view"))}`;
    case "tools":
      return `tools.${resolveToolsView(params.get("view"))}`;
    case "terminal":
      return "terminal";
    case "jarvis":
      return "assistant";
    default:
      return "generic";
  }
}

/** The key "hide on this page" stores: a whole area's pages share one, so
    hiding it on Runs hides it on every investigation section. */
export function hideKeyFor(page: PageId): string {
  return page.split(".")[0] ?? page;
}

/** The words that name a page for the user. */
export const PAGE_NAME: Record<PageId, MessageKey> = {
  overview: "nav.overview",
  projects: "nav.workspaces",
  files: "nav.files",
  github: "nav.github",
  "lab.list": "lab.list.title",
  "lab.overview": "lab.view.overview",
  "lab.targets": "lab.view.targets",
  "lab.runs": "lab.view.runs",
  "lab.evidence": "lab.view.evidence",
  "lab.findings": "lab.view.findings",
  "lab.report": "lab.view.report",
  "lab.scope": "lab.view.scope",
  "tools.box": "tools.view.box",
  "tools.registered": "tools.view.registered",
  "tools.catalog": "tools.view.catalog",
  "tools.playbooks": "tools.view.playbooks",
  "tools.datasets": "tools.view.datasets",
  terminal: "topbar.terminal",
  assistant: "topbar.assistant",
  settings: "nav.settings",
  generic: "app.name",
};

export interface GuideStep {
  text: MessageKey;
  /** The `data-guide` name of the element this step is about. */
  target?: string;
}

/** The pages the companion has a guide for (the assistant page has its own
    page: the bubble is not drawn there). */
export type GuidedPage = Exclude<PageId, "assistant">;

const step = (page: string, n: number, target?: string): GuideStep => ({
  text: `companion.g.${page}.${n}` as MessageKey,
  ...(target ? { target } : {}),
});

export const GUIDES: Record<GuidedPage, readonly GuideStep[]> = {
  overview: [
    step("overview", 1),
    step("overview", 2, "home-workspaces"),
    step("overview", 3, "area-lab"),
    step("overview", 4, "search"),
  ],
  projects: [step("projects", 1, "projects-new"), step("projects", 2), step("projects", 3)],
  files: [step("files", 1, "files-add"), step("files", 2), step("files", 3)],
  github: [step("github", 1), step("github", 2), step("github", 3)],
  "lab.list": [step("lab.list", 1, "lab-new"), step("lab.list", 2, "lab-all"), step("lab.list", 3)],
  "lab.overview": [
    step("lab.overview", 1),
    step("lab.overview", 2, "lab-scope"),
    step("lab.overview", 3, "lab-view-targets"),
    step("lab.overview", 4, "lab-ask"),
  ],
  "lab.targets": [
    step("lab.targets", 1, "lab-add-files"),
    step("lab.targets", 2, "lab-add-target"),
    step("lab.targets", 3, "lab-scope"),
  ],
  "lab.runs": [step("lab.runs", 1), step("lab.runs", 2, "area-tools"), step("lab.runs", 3)],
  "lab.evidence": [
    step("lab.evidence", 1),
    step("lab.evidence", 2),
    step("lab.evidence", 3, "lab-view-overview"),
  ],
  "lab.findings": [
    step("lab.findings", 1),
    step("lab.findings", 2, "lab-import"),
    step("lab.findings", 3),
  ],
  "lab.report": [step("lab.report", 1), step("lab.report", 2, "lab-report"), step("lab.report", 3)],
  "lab.scope": [step("lab.scope", 1), step("lab.scope", 2), step("lab.scope", 3)],
  "tools.box": [step("tools.box", 1), step("tools.box", 2), step("tools.box", 3)],
  "tools.registered": [
    step("tools.registered", 1),
    step("tools.registered", 2, "area-lab"),
    step("tools.registered", 3),
  ],
  "tools.catalog": [
    step("tools.catalog", 1),
    step("tools.catalog", 2),
    step("tools.catalog", 3, "tools-view-registered"),
  ],
  "tools.playbooks": [
    step("tools.playbooks", 1),
    step("tools.playbooks", 2),
    step("tools.playbooks", 3, "tools-view-catalog"),
  ],
  "tools.datasets": [step("tools.datasets", 1), step("tools.datasets", 2, "tools-view-box")],
  terminal: [step("terminal", 1, "terminal-new"), step("terminal", 2), step("terminal", 3)],
  settings: [step("settings", 1), step("settings", 2), step("settings", 3)],
  generic: [step("generic", 1), step("generic", 2, "search")],
};

/** The steps of a page's guide; the assistant page has none. */
export function guideFor(page: PageId): readonly GuideStep[] {
  return page === "assistant" ? [] : GUIDES[page];
}

/** The words that name a "hide on this page" key (an area's pages). */
export const HIDE_KEY_NAME: Record<string, MessageKey> = {
  overview: "nav.overview",
  projects: "nav.workspaces",
  files: "nav.files",
  github: "nav.github",
  lab: "topbar.lab",
  tools: "topbar.tools",
  terminal: "topbar.terminal",
  settings: "nav.settings",
  generic: "app.name",
};
