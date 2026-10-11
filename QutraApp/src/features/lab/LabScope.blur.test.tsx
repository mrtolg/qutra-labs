import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AuthorizationScopeSchema, EngagementSchema } from "@/domain/lab";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { LabScope } from "./labViews";

const T = 1_700_000_000_000;

const engagement = EngagementSchema.parse({
  id: "eng-1",
  title: "Home Lab",
  purpose: "training_lab",
  status: "active",
  scopeId: "sc-1",
  createdAt: T,
  updatedAt: T,
});

beforeEach(() => {
  setDbForTesting(new Database(new MemoryStorageAdapter()));
  getDb()
    .collection("authorizationScopes")
    .put(
      AuthorizationScopeSchema.parse({
        id: "sc-1",
        engagementId: "eng-1",
        allowedTargets: ["10.0.0.0/24"],
        excludedTargets: ["10.0.0.1"],
        authorizationRef: "ticket-1",
        testerAck: true,
        revision: 3,
        createdAt: T,
        updatedAt: T,
      }),
    );
});

afterEach(() => setDbForTesting(null));

describe("LabScope field blur", () => {
  it("does not bump revision when allowed targets did not change", () => {
    const scope = getDb().collection("authorizationScopes").get("sc-1")!;
    render(<LabScope engagement={engagement} scope={scope} targets={[]} />);

    fireEvent.blur(screen.getByLabelText("Allowed targets"));

    const next = getDb().collection("authorizationScopes").get("sc-1")!;
    expect(next.revision).toBe(3);
    expect(next.updatedAt).toBe(T);
  });

  it("does not bump revision when excluded targets did not change", () => {
    const scope = getDb().collection("authorizationScopes").get("sc-1")!;
    render(<LabScope engagement={engagement} scope={scope} targets={[]} />);

    fireEvent.blur(screen.getByLabelText("Excluded targets"));

    const next = getDb().collection("authorizationScopes").get("sc-1")!;
    expect(next.revision).toBe(3);
    expect(next.updatedAt).toBe(T);
  });

  it("bumps revision when allowed targets change", () => {
    const scope = getDb().collection("authorizationScopes").get("sc-1")!;
    render(<LabScope engagement={engagement} scope={scope} targets={[]} />);

    const field = screen.getByLabelText("Allowed targets");
    fireEvent.change(field, { target: { value: "10.0.0.0/24\n192.168.0.0/16" } });
    fireEvent.blur(field);

    const next = getDb().collection("authorizationScopes").get("sc-1")!;
    expect(next.revision).toBe(4);
    expect(next.allowedTargets).toEqual(["10.0.0.0/24", "192.168.0.0/16"]);
  });
});
