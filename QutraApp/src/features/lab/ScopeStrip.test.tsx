import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { AuthorizationScope } from "@/domain/lab";
import { ScopeStrip } from "./ScopeStrip";

const scope = (allowed: string[], over: Partial<AuthorizationScope> = {}): AuthorizationScope =>
  ({
    id: "s1",
    engagementId: "e1",
    ownerLabel: "",
    description: "",
    allowedTargets: allowed,
    excludedTargets: [],
    authorizationRef: "",
    testerAck: true,
    revision: 1,
    notes: "",
    demo: false,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }) as AuthorizationScope;

const strip = (s: AuthorizationScope | undefined) => {
  render(<ScopeStrip scope={s} targets={[]} onOpen={() => {}} />);
  return screen.getByRole("button");
};

/* The strip says what the gate (evaluateTarget) lets a tool reach: local and
   private addresses need no entry, so it never claims they are blocked. */
describe("ScopeStrip", () => {
  it("names the allowed targets, adds local and private addresses, and says the rest is blocked", () => {
    expect(strip(scope(["scanme.example.org", "api.lab.local", "203.0.113.0/24", "x.lab"]))).toHaveTextContent(
      "Allowed: scanme.example.org, api.lab.local, 203.0.113.0/24 +1 more · local and private addresses too · everything else is blocked",
    );
  });

  it("says only local and private addresses can be scanned while nothing is listed", () => {
    expect(strip(scope([]))).toHaveTextContent(
      "Only local and private addresses can be scanned · everything else is blocked",
    );
  });

  it("says listed targets wait for the acknowledgment", () => {
    expect(strip(scope(["scanme.example.org"], { testerAck: false }))).toHaveTextContent(
      "Awaiting confirmation: scanme.example.org · until then only local and private addresses can be scanned",
    );
  });

  it("says nothing can be scanned without a scope", () => {
    expect(strip(undefined)).toHaveTextContent("No scope yet: no target can be scanned.");
  });

  it("says nothing can be scanned once the scope has expired", () => {
    expect(strip(scope(["scanme.example.org"], { expiresAt: 1 }))).toHaveTextContent(
      "The scope has expired: no target can be scanned.",
    );
  });

  it("opens the scope editor", () => {
    const onOpen = vi.fn();
    render(<ScopeStrip scope={scope([])} targets={[]} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalled();
  });
});
