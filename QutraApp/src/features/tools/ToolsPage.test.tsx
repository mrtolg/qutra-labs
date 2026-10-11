import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { ensureLocaleLoaded, translate, type MessageKey } from "@/lib/i18n";
import { TOOL_CATALOG, workingBuiltins } from "@/domain/tools/registry";
import ToolsPage from "./ToolsPage";

/* The tool list must not mix languages. These cases render the real page in
   Turkish. */

const tr = (key: string) => translate("tr", key as MessageKey);

function mount() {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set({ locale: "tr", privateToolsEnabled: true });
  setDbForTesting(db);
  render(
    <MemoryRouter>
      <ToolsPage />
    </MemoryRouter>,
  );
}

/** Opens a built-in tool on the bench under the grid and returns the bench. */
function openTool(id: string): HTMLElement {
  const name = tr(`tools.item.${id}.name`);
  const card = screen
    .getAllByTestId("builtin-tool")
    .find((button) => button.textContent?.startsWith(name)) as HTMLElement;
  fireEvent.click(card);
  expect(card).toHaveAttribute("aria-expanded", "true");
  return screen.getByRole("region", { name });
}

beforeAll(async () => {
  await ensureLocaleLoaded("tr");
});

afterEach(() => {
  setDbForTesting(null);
});

describe("Tools page in Turkish", () => {
  it("names and describes every working built-in tool in Turkish, and lists no planned one", () => {
    mount();
    for (const tool of workingBuiltins()) {
      expect(screen.getByText(tr(`tools.item.${tool.id}.name`)), tool.id).toBeInTheDocument();
      expect(screen.getByText(tr(`tools.item.${tool.id}.summary`)), tool.id).toBeInTheDocument();
    }
    // A tool not built yet is never listed, and nothing says "planned".
    for (const tool of TOOL_CATALOG.filter((entry) => entry.status === "builtin-planned")) {
      expect(screen.queryByText(tr(`tools.item.${tool.id}.name`)), tool.id).toBeNull();
    }
    expect(screen.queryByText(tr("tools.statusPlanned"))).toBeNull();
    // The registry's English identity is never what the row shows.
    expect(screen.queryByText("Transform workbench")).toBeNull();
    expect(screen.queryByText(/Encode\/decode\/transform data/)).toBeNull();
  });

  it("describes a launcher program in Turkish", () => {
    mount();
    const nmap = screen.getByRole("listitem", { name: "Nmap" });
    expect(within(nmap).getByText(tr("tools.item.nmap.summary"))).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: tr("launcher.title") })).toBeInTheDocument();
  });

  it("finds a built-in tool with the page's one search", () => {
    mount();
    fireEvent.change(screen.getByLabelText(tr("launcher.filterLabel")), {
      target: { value: tr("tools.item.jwt.name") },
    });
    expect(screen.getAllByTestId("builtin-tool")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText(tr("launcher.filterLabel")), {
      target: { value: "zzzz" },
    });
    expect(screen.queryAllByTestId("builtin-tool")).toHaveLength(0);
    expect(
      screen.getByText(translate("tr", "launcher.builtInNoMatch", { query: "zzzz" })),
    ).toBeInTheDocument();
  });

  it("explains an invalid Regex pattern and invalid flags in Turkish", () => {
    mount();
    const row = openTool("regex");

    fireEvent.change(within(row).getByLabelText(tr("tools.regexPattern")), {
      target: { value: "(" },
    });
    expect(within(row).getByText(tr("tools.regexInvalidPattern"))).toBeInTheDocument();

    fireEvent.change(within(row).getByLabelText(tr("tools.regexPattern")), {
      target: { value: "a" },
    });
    fireEvent.change(within(row).getByLabelText(tr("tools.regexFlags")), {
      target: { value: "x" },
    });
    expect(within(row).getByText(tr("tools.regexInvalidFlags"))).toBeInTheDocument();
    // The engine's own English sentence never reaches the panel.
    expect(within(row).queryByText(/Invalid/i)).toBeNull();
  });
});
