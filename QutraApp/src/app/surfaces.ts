import {
  MessageSquare,
  ScanSearch,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { MessageKey } from "@/lib/i18n/en";

/** The five areas of the one navigation bar. */
export type Area = "home" | "lab" | "tools" | "assistant" | "terminal";

interface Surface {
  key: "1" | "2" | "3" | "4";
  area: Exclude<Area, "home">;
  to: string;
  labelKey: MessageKey;
  icon: LucideIcon;
  /** First path segments that belong to this surface. */
  owns: readonly string[];
}

/** The areas after Home, in bar order; Ctrl+1–4 open them. */
export const SURFACES: readonly Surface[] = [
  {
    key: "1",
    area: "lab",
    to: "/lab",
    labelKey: "topbar.lab",
    icon: ScanSearch,
    owns: ["lab"],
  },
  {
    key: "2",
    area: "tools",
    to: "/tools",
    labelKey: "topbar.tools",
    icon: Wrench,
    owns: ["tools"],
  },
  {
    key: "3",
    area: "assistant",
    to: "/jarvis",
    labelKey: "topbar.assistant",
    icon: MessageSquare,
    owns: ["jarvis"],
  },
  {
    key: "4",
    area: "terminal",
    to: "/terminal",
    labelKey: "topbar.terminal",
    icon: SquareTerminal,
    owns: ["terminal"],
  },
];

export function surfaceFor(pathname: string): Surface | undefined {
  const segment = pathname.split("/")[1] ?? "";
  return SURFACES.find((s) => s.owns.includes(segment));
}

/** Home owns every page that belongs to no surface: Home itself, projects
    (and a project's focus session), files, GitHub. */
export function areaFor(pathname: string): Area {
  return surfaceFor(pathname)?.area ?? "home";
}
