import { describe, expect, it } from "vitest";
import { ToolProfileSchema } from "./lab";

describe("ToolProfile launchKind", () => {
  it("defaults to batch for existing profiles (backward compatible)", () => {
    const p = ToolProfileSchema.parse({
      id: "p1", installationId: "i1", name: "x",
      createdAt: 1, updatedAt: 1,
    });
    expect(p.launchKind).toBe("batch");
  });
  it("accepts gui and interactive", () => {
    for (const k of ["gui", "interactive", "batch"] as const) {
      const p = ToolProfileSchema.parse({
        id: "p1", installationId: "i1", name: "x", launchKind: k,
        createdAt: 1, updatedAt: 1,
      });
      expect(p.launchKind).toBe(k);
    }
  });
  it("rejects an unknown kind", () => {
    expect(() => ToolProfileSchema.parse({
      id: "p1", installationId: "i1", name: "x", launchKind: "rm-rf",
      createdAt: 1, updatedAt: 1,
    })).toThrow();
  });
});
