import { describe, expect, it } from "vitest";
import { errorSimilarity, fingerprintError } from "./errors";

describe("fingerprintError", () => {
  it("is stable across paths, line numbers and ids", () => {
    const a = fingerprintError(
      "Error: cannot read foo at C:\\Dev\\app\\src\\main.ts:120:5 (pid 4821)",
    );
    const b = fingerprintError(
      "Error: cannot read foo at C:\\Other\\place\\src\\main.ts:98:11 (pid 99182)",
    );
    expect(a).toBe(b);
  });

  it("differs for genuinely different errors", () => {
    expect(fingerprintError("TypeError: x is not a function")).not.toBe(
      fingerprintError("ReferenceError: y is not defined"),
    );
  });
});

describe("errorSimilarity", () => {
  it("scores similar messages higher than unrelated ones", () => {
    const base = "Failed to resolve import @/lib/bridge from RestorePanel";
    const similar = "Failed to resolve import @/lib/db from SettingsPage";
    const unrelated = "Segmentation fault in native module";
    expect(errorSimilarity(base, similar)).toBeGreaterThan(
      errorSimilarity(base, unrelated),
    );
  });
  it("handles empty inputs", () => {
    expect(errorSimilarity("", "x")).toBe(0);
  });
});
