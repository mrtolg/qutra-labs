import {
  BadgeCheck,
  BookOpen,
  Bug,
  Crosshair,
  Database,
  FileText,
  FlaskConical,
  LayoutDashboard,
  Paperclip,
  Play,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { MessageKey } from "@/lib/i18n/en";
import type { LabView, ToolsView } from "@/domain/workbench";

export interface LabViewDef {
  view: LabView;
  labelKey: MessageKey;
  icon: LucideIcon;
}

/** An investigation's sections under the top bar (spec 2026-10-07 §5.1).
    Scope is reached from the scope strip, so it has no tab. */
export const LAB_VIEW_DEFS: readonly LabViewDef[] = [
  { view: "overview", labelKey: "lab.view.overview", icon: LayoutDashboard },
  { view: "targets", labelKey: "lab.view.targets", icon: Crosshair },
  { view: "runs", labelKey: "lab.view.runs", icon: Play },
  { view: "evidence", labelKey: "lab.view.evidence", icon: Paperclip },
  { view: "findings", labelKey: "lab.view.findings", icon: Bug },
  { view: "report", labelKey: "lab.view.report", icon: FileText },
] as const;

export interface ToolsViewDef {
  view: ToolsView;
  labelKey: MessageKey;
  icon: LucideIcon;
}

/** The Tools area's sections: the toolbox, the registered programs and the
    three guide sections. */
export const TOOLS_VIEW_DEFS: readonly ToolsViewDef[] = [
  { view: "box", labelKey: "tools.view.box", icon: Wrench },
  { view: "registered", labelKey: "tools.view.registered", icon: BadgeCheck },
  { view: "catalog", labelKey: "tools.view.catalog", icon: BookOpen },
  { view: "playbooks", labelKey: "tools.view.playbooks", icon: FlaskConical },
  { view: "datasets", labelKey: "tools.view.datasets", icon: Database },
] as const;
