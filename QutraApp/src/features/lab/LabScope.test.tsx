import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { createEngagement } from "@/services/appService";
import { LabScope } from "./labViews";

/* Each edit of the scope is a new revision, and a run is attested to the
   revision it started under. Tabbing through the fields without changing
   anything must not make an earlier run look stale. */

let engagementId = "";

function scope() {
  const engagement = getDb().collection("engagements").get(engagementId)!;
  return getDb().collection("authorizationScopes").get(engagement.scopeId!)!;
}

function renderScope() {
  const engagement = getDb().collection("engagements").get(engagementId)!;
  return render(<LabScope engagement={engagement} scope={scope()} targets={[]} />);
}

beforeEach(() => {
  setDbForTesting(new Database(new MemoryStorageAdapter()));
  engagementId = createEngagement("Home lab");
  const saved = scope();
  getDb()
    .collection("authorizationScopes")
    .put({ ...saved, allowedTargets: ["10.0.0.0/24"], excludedTargets: ["10.0.0.1"] });
});

afterEach(() => setDbForTesting(null));

describe("Scope fields", () => {
  it("keep the revision and the update time when nothing was edited", async () => {
    const before = scope();
    renderScope();

    const user = userEvent.setup();
    await user.click(screen.getByRole("textbox", { name: "Allowed targets" }));
    await user.tab();
    await user.tab();

    expect(scope().revision).toBe(before.revision);
    expect(scope().updatedAt).toBe(before.updatedAt);
  });

  it("make a new revision when the list changed", async () => {
    const before = scope();
    renderScope();

    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Allowed targets" }), "{enter}scanme.example.org");
    await user.tab();

    expect(scope().allowedTargets).toEqual(["10.0.0.0/24", "scanme.example.org"]);
    expect(scope().revision).toBe(before.revision + 1);
  });

  it("make a new revision when the excluded list changed", async () => {
    const before = scope();
    renderScope();

    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Excluded targets" }), "{enter}10.0.0.2");
    await user.tab();

    expect(scope().excludedTargets).toEqual(["10.0.0.1", "10.0.0.2"]);
    expect(scope().revision).toBe(before.revision + 1);
  });
});
