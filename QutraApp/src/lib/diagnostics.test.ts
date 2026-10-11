import { beforeEach, describe, expect, it } from "vitest";
import {
  getDiagnosticErrors,
  recordDiagnosticError,
  resetDiagnosticErrorsForTesting,
} from "./diagnostics";

beforeEach(resetDiagnosticErrorsForTesting);

describe("diagnostic errors", () => {
  it("stores bounded plain error metadata rather than stack dumps", () => {
    for (let index = 0; index < 25; index += 1) {
      recordDiagnosticError(new Error(`failure-${index}`), "unit");
    }
    const errors = getDiagnosticErrors();
    expect(errors).toHaveLength(20);
    expect(errors[0]).toMatchObject({
      context: "unit",
      name: "Error",
      message: "failure-24",
    });
    expect(JSON.stringify(errors)).not.toContain("diagnostics.test.ts");
  });

  it("returns copies so callers cannot mutate the log", () => {
    recordDiagnosticError("failure", "unit");
    const first = getDiagnosticErrors();
    first[0].message = "changed";
    expect(getDiagnosticErrors()[0].message).toBe("failure");
  });
});
