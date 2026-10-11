import { describe, it, expect } from "vitest";
import { engagementScopeStatus } from "./scope";
import { AuthorizationScopeSchema } from "@/domain/lab";

function scope(over: Record<string, unknown> = {}) {
  return AuthorizationScopeSchema.parse({
    id: "sc-1",
    engagementId: "eng-1",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  });
}

describe("engagementScopeStatus", () => {
  it("is not_configured when no scope or an empty scope", () => {
    expect(engagementScopeStatus(undefined, []).status).toBe("not_configured");
    expect(engagementScopeStatus(scope(), []).status).toBe("not_configured");
  });

  it("is acknowledgement_required when a non-local target lacks tester ack", () => {
    const s = scope({ allowedTargets: ["example.com"], testerAck: false });
    const r = engagementScopeStatus(s, [{ raw: "example.com" }]);
    expect(r.status).toBe("acknowledgement_required");
  });

  it("is validated for acknowledged in-scope targets", () => {
    const s = scope({ allowedTargets: ["example.com"], testerAck: true });
    const r = engagementScopeStatus(s, [{ raw: "example.com" }, { raw: "127.0.0.1" }]);
    expect(r.status).toBe("validated");
    expect(r.outOfScopeCount).toBe(0);
  });

  it("flags out-of-scope targets with a count", () => {
    const s = scope({ allowedTargets: ["example.com"], testerAck: true });
    const r = engagementScopeStatus(s, [
      { raw: "example.com" }, // in allow list
      { raw: "8.8.8.8" }, // public, not allowed → out of scope
    ]);
    expect(r.status).toBe("target_out_of_scope");
    expect(r.outOfScopeCount).toBe(1);
  });

  it("local-only targets are validated even without ack once scope exists", () => {
    const s = scope({ excludedTargets: ["10.0.0.9"], testerAck: false });
    const r = engagementScopeStatus(s, [{ raw: "127.0.0.1" }]);
    expect(r.status).toBe("validated");
  });
});
