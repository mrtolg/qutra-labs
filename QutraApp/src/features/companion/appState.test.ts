import { beforeEach, describe, expect, it } from "vitest";
import { CONTEXT_FOOTER, CONTEXT_HEADER, CONTEXT_LIMITS } from "@/domain/assistantContext";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { createEngagement } from "@/services/appService";
import { appStateFor, companionContext, safeRoute } from "./appState";

beforeEach(() => setDbForTesting(new Database(new MemoryStorageAdapter())));

const engagements = () => getDb().collection("engagements").getAll();

describe("what the companion knows of the app", () => {
  it("knows the page, the open investigation and the selected tool", () => {
    const id = createEngagement("ACME web");
    const state = appStateFor(
      { pathname: "/tools", search: `?view=registered&e=${id}&tool=nmap` },
      engagements(),
    );
    expect(state).toEqual({
      page: "tools.registered",
      route: "/tools (registered)",
      investigation: "ACME web",
      tool: "nmap",
    });
  });

  it("falls back to the investigation worked on last, on the Lab only", () => {
    createEngagement("Older");
    createEngagement("Newer");
    const lab = appStateFor({ pathname: "/lab", search: "?view=runs" }, engagements());
    expect(lab.page).toBe("lab.runs");
    expect(lab.investigation).toBeDefined();
    const tools = appStateFor({ pathname: "/tools", search: "?view=catalog" }, engagements());
    expect(tools.investigation).toBeUndefined();
    const list = appStateFor({ pathname: "/lab", search: "?list=1" }, engagements());
    expect(list.investigation).toBeUndefined();
  });

  it("knows the Settings section while Settings is open", () => {
    const state = appStateFor(
      { pathname: "/overview", search: "", settingsSection: "privacy" },
      engagements(),
    );
    expect(state).toMatchObject({ page: "settings", settingsSection: "privacy" });
  });

  it("reads no ids and no free text from the address", () => {
    expect(safeRoute("/lab", "?e=eng-1&view=findings&focus=import&q=secret")).toBe("/lab (findings)");
    expect(safeRoute("/workspaces/ws-9/notes", "?x=1")).toBe("/workspaces");
    expect(safeRoute("/tools", "?view=playbooks&tool=nmap&e=eng-1")).toBe("/tools (playbooks)");
  });

  it("passes on a tool id only in the form the app writes", () => {
    const odd = appStateFor(
      { pathname: "/tools", search: "?view=registered&tool=" + encodeURIComponent("Some Tool; rm -rf /") },
      engagements(),
    );
    expect(odd.tool).toBeUndefined();
  });
});

describe("the block that rides with a free question", () => {
  const steps = ["Press New project to add one.", "Open a project from the list."];

  it("is fenced like the project context and names the page and its steps", () => {
    const text = companionContext(
      { page: "projects", route: "/workspaces" },
      { pageName: "Projects", steps, withRecords: true },
    );
    expect(text.startsWith(CONTEXT_HEADER)).toBe(true);
    expect(text.endsWith(CONTEXT_FOOTER)).toBe(true);
    expect(text).toContain("Page: Projects (/workspaces)");
    expect(text).toContain("1. Press New project to add one.");
  });

  it("carries the investigation and tool only when the answer stays on this computer", () => {
    const state = {
      page: "tools.registered" as const,
      route: "/tools (registered)",
      investigation: "ACME web",
      tool: "nmap",
    };
    const local = companionContext(state, { pageName: "Registered tools", steps, withRecords: true });
    expect(local).toContain("Open investigation: ACME web");
    expect(local).toContain("Selected tool: nmap");
    const cloud = companionContext(state, { pageName: "Registered tools", steps, withRecords: false });
    expect(cloud).not.toContain("ACME web");
    expect(cloud).not.toContain("nmap");
    expect(cloud).toContain("Page: Registered tools");
  });

  it("stays under the ceiling, however long the investigation's name is", () => {
    const state = {
      page: "lab.runs" as const,
      route: "/lab (runs)",
      investigation: "x".repeat(5_000),
    };
    const text = companionContext(state, {
      pageName: "Runs",
      steps: Array.from({ length: 4 }, () => "y".repeat(400)),
      withRecords: true,
    });
    expect(text.length).toBeLessThanOrEqual(CONTEXT_LIMITS.total);
    expect(text).toContain("Page: Runs");
  });
});
