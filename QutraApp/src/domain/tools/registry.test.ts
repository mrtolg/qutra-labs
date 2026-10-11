import { describe, expect, it } from "vitest";
import { en } from "@/lib/i18n/en";
import { BUILTIN_PANELS, TOOL_CATALOG, countByStatus, toolsByCategory, workingBuiltins } from "./registry";

describe("tool catalog", () => {
  it("has exactly the 30 roadmap tools, numbered 1..30 uniquely", () => {
    expect(TOOL_CATALOG).toHaveLength(30);
    expect(TOOL_CATALOG.map((t) => t.n).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 30 }, (_, i) => i + 1),
    );
    expect(new Set(TOOL_CATALOG.map((t) => t.id)).size).toBe(30);
  });

  it("working builtins declare a panel; adapters declare an executable + install url", () => {
    for (const t of TOOL_CATALOG) {
      if (t.status === "builtin-working") expect(t.panel, t.id).toBeTruthy();
      if (t.status === "external-adapter") {
        expect(t.executable, t.id).toBeTruthy();
        expect(t.installUrl, t.id).toMatch(/^https:\/\//);
      }
    }
  });

  it("status counts add up to 30", () => {
    const c = countByStatus();
    expect(c["builtin-working"] + c["builtin-planned"] + c["external-adapter"]).toBe(30);
    expect(c["builtin-working"]).toBeGreaterThanOrEqual(13);
  });

  it("gives every app-own panel exactly one working tool", () => {
    const panels = workingBuiltins().map((t) => t.panel);
    for (const panel of BUILTIN_PANELS) {
      expect(panels.filter((p) => p === panel), panel).toHaveLength(1);
    }
    // Only the Sigma explorer is still planned, and no list shows it.
    expect(TOOL_CATALOG.filter((t) => t.status === "builtin-planned").map((t) => t.id)).toEqual(["sigma"]);
    expect(workingBuiltins().every((t) => t.status === "builtin-working")).toBe(true);
  });

  it("names and describes every tool in the catalogs, not in the registry", () => {
    for (const t of TOOL_CATALOG) {
      expect(en, t.id).toHaveProperty([`tools.item.${t.id}.name`]);
      expect(en, t.id).toHaveProperty([`tools.item.${t.id}.summary`]);
    }
  });

  it("groups by category", () => {
    expect(toolsByCategory("local")).toHaveLength(8);
  });
});
