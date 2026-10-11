import { useMemo } from "react";
import { useCollection } from "@/lib/db/database";
import { useUi } from "@/state/ui";

/**
 * The project the context panel shows: the one the shell has active, else the
 * most recently touched project that is not archived — the same rule the
 * palette's project actions use.
 */
export function useActiveProject() {
  const workspaces = useCollection("workspaces");
  const activeWorkspaceId = useUi((s) => s.activeWorkspaceId);
  const projects = useMemo(
    () =>
      workspaces
        .filter((w) => w.status !== "archived")
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt),
    [workspaces],
  );
  const project = projects.find((p) => p.id === activeWorkspaceId) ?? projects[0];
  return { projects, project };
}
