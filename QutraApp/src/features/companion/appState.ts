import { useMemo } from "react";
import { useLocation } from "react-router-dom";
import { CONTEXT_FOOTER, CONTEXT_HEADER, CONTEXT_LIMITS } from "@/domain/assistantContext";
import type { Engagement } from "@/domain/lab";
import { resolveLabView, resolveToolsView } from "@/domain/workbench";
import type { SettingsSection } from "@/features/settings/sections";
import { useCollection } from "@/lib/db/database";
import { useUi } from "@/state/ui";
import { pageIdFor, type PageId } from "./guides";

/* What the companion knows: the page, and a few facts the app itself holds
   about it. Never the page's content and never the screen. Every value is
   short, and the user's own records (an investigation's name, a tool's id)
   are marked so a cloud turn can leave them out. */

/** A tool id as the app writes it; anything else is not passed on. */
const TOOL_ID = /^[a-z0-9][a-z0-9._-]{0,39}$/;

export interface AppState {
  page: PageId;
  /** The address without anything but the page and its section. */
  route: string;
  /** The open investigation's name (the user's own text). */
  investigation?: string;
  /** The tool picked in the address (the user's own registrations). */
  tool?: string;
  settingsSection?: SettingsSection;
}

/** The path and the one query value that names a section; no ids. */
export function safeRoute(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  const segment = pathname.split("/")[1] ?? "";
  if (segment === "lab") {
    return params.get("list") === "1" ? "/lab (all)" : `/lab (${resolveLabView(params.get("view"))})`;
  }
  if (segment === "tools") return `/tools (${resolveToolsView(params.get("view"))})`;
  return `/${segment}`;
}

/** The investigation the Lab shows for an address: the one named by `e`, and
    on the Lab itself the one worked on last when it names none. */
function openInvestigation(
  engagements: readonly Engagement[],
  pathname: string,
  params: URLSearchParams,
): Engagement | undefined {
  const segment = pathname.split("/")[1] ?? "";
  if (segment !== "lab" && segment !== "tools") return undefined;
  if (params.get("list") === "1") return undefined;
  const named = engagements.find((e) => e.id === params.get("e"));
  if (named || segment === "tools") return named;
  return [...engagements]
    .filter((e) => e.status !== "archived")
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

/** The facts for an address. Pure, so the lookup is tested without a router. */
export function appStateFor(
  input: {
    pathname: string;
    search: string;
    settingsSection?: SettingsSection | null;
  },
  engagements: readonly Engagement[],
): AppState {
  const params = new URLSearchParams(input.search);
  const page = pageIdFor(input);
  const investigation = openInvestigation(engagements, input.pathname, params);
  const toolParam = params.get("tool");
  return {
    page,
    route: safeRoute(input.pathname, input.search),
    ...(investigation ? { investigation: investigation.title } : {}),
    ...(toolParam && TOOL_ID.test(toolParam) ? { tool: toolParam } : {}),
    ...(input.settingsSection ? { settingsSection: input.settingsSection } : {}),
  };
}

/** The page's state, following the address and the Settings dialog. */
export function useAppState(): AppState {
  const { pathname, search } = useLocation();
  const settingsSection = useUi((state) => state.settingsSection);
  const engagements = useCollection("engagements");
  return useMemo(
    () => appStateFor({ pathname, search, settingsSection }, engagements),
    [pathname, search, settingsSection, engagements],
  );
}

const clip = (value: string, limit: number): string => {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
};

const STEPS_LINE = "Steps the app's guide gives for this page:";

export interface ContextFacts {
  /** The page's name as the user reads it. */
  pageName: string;
  /** The settings section's name, when Settings is open. */
  settingsName?: string;
  /** The guide's steps, in the user's language. */
  steps: readonly string[];
  /** Whether the user's own records (investigation, tool) may ride along. */
  withRecords: boolean;
}

/**
 * The block that goes with a free question: where the user is and what the
 * page's guide says, fenced like the project context so nothing inside it
 * reads as an instruction. Records of the user's own go only when the answer
 * stays on this computer. Never longer than `CONTEXT_LIMITS.total`.
 */
export function companionContext(state: AppState, facts: ContextFacts): string {
  const lines = [
    CONTEXT_HEADER,
    `Page: ${clip(facts.pageName, CONTEXT_LIMITS.field)} (${state.route})`,
  ];
  if (facts.settingsName) lines.push(`Settings section: ${clip(facts.settingsName, 60)}`);
  if (facts.withRecords && state.investigation) {
    lines.push(`Open investigation: ${clip(state.investigation, CONTEXT_LIMITS.field)}`);
  }
  if (facts.withRecords && state.tool) lines.push(`Selected tool: ${state.tool}`);
  if (facts.steps.length > 0) {
    lines.push(STEPS_LINE);
    facts.steps.forEach((text, index) => {
      lines.push(`${index + 1}. ${clip(text, CONTEXT_LIMITS.field)}`);
    });
  }
  lines.push(CONTEXT_FOOTER);
  const text = lines.join("\n");
  if (text.length <= CONTEXT_LIMITS.total) return text;
  // Over the ceiling: the steps give way, the facts stay.
  const at = lines.indexOf(STEPS_LINE);
  const head = at < 0 ? lines.slice(0, -1) : lines.slice(0, at);
  return [...head, CONTEXT_FOOTER].join("\n").slice(0, CONTEXT_LIMITS.total);
}
