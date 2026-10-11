import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { useUi } from "@/state/ui";
import { Workbench } from "./Workbench";

/* ============================================================
   Conformance with docs/architecture/workbench-reference-deep-dive.md.

   That document compares VS Code, Zed and AFFiNE and lands on one sentence for
   this product: take the IDE's *shape*, not its *engine*. These lock the
   invariants it names, because each of them is the kind of thing that looks
   harmless to "improve" and is expensive to get back:

     §11.1  Home is never a sticky tab. (Its content is the dashboard
            now; `features/overview/OverviewPage.test.tsx` covers it.)
     §11.5  Closing the last tab lands on Home; the window survives.
     §11.4  Noisy chrome starts closed and opens on a work signal.
     §11.7  Settings is a rail + section pane, not a second app.
     §7     Do not port the contribution/URI/split-group machinery.

   Home-as-non-tab and last-tab-to-Home are already covered in
   `domain/workbench.test.ts` and `workbench.component.test.tsx`; this file
   covers the rest.
   ============================================================ */

function seedDb() {
  const db = new Database(new MemoryStorageAdapter());
  setDbForTesting(db);
  return db;
}

beforeEach(() => {
  useUi.setState({
    paletteOpen: false,
    activeWorkspaceId: null,
  });
});

describe("cold start (§11.4)", () => {
  it("closes the context panel even when the last session left it open", async () => {
    const db = seedDb();
    // Previous session ended with the panel open on Runs output.
    db.prefs.set({ contextPanelOpen: true, contextPanelSegment: "runs" });

    render(
      <MemoryRouter initialEntries={["/overview"]}>
        <Routes>
          <Route path="*" element={<Workbench />} />
        </Routes>
      </MemoryRouter>,
    );

    // A deliberate departure from "restore exactly what was there": the first
    // paint is the work surface, not leftover chrome.
    await waitFor(() => expect(db.prefs.get().contextPanelOpen).toBe(false));
    // The segment it was on is kept for the next Ctrl+B.
    expect(db.prefs.get().contextPanelSegment).toBe("runs");
  });
});

describe("no IDE engine port (§7)", () => {
  const SRC = path.resolve(process.cwd(), "src");

  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) sources(full, out);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  it("has not grown VS Code / Zed workbench machinery", () => {
    // The reference document is explicit that the *shape* is worth copying and
    // the engine is not: contribution registries, URI-keyed editor inputs and
    // split pane grids are platform costs this product has no evidence for.
    const banned = [
      "EditorInput",
      "IEditorService",
      "IEditorGroupsService",
      "editorGroup",
      "SerializableGrid",
      "registerContribution",
      "contributionPoint",
      "PaneGroup",
      "ActivityBarPart",
    ];

    const hits: string[] = [];
    for (const file of sources(SRC)) {
      const text = fs.readFileSync(file, "utf8");
      for (const token of banned) {
        if (text.includes(token)) {
          hits.push(`${path.relative(process.cwd(), file)} → ${token}`);
        }
      }
    }

    expect(
      hits,
      `IDE engine constructs appeared in product code:\n${hits.join("\n")}`,
    ).toEqual([]);
  });
});
