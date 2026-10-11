import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { createEngagement } from "@/services/appService";
import { useInvestigationFiles } from "@/state/investigationFiles";
import LabPage from "./LabPage";

/* Files dropped on the window go into the investigation the Lab shows. The
   list of investigations shows none, so a drop there must have no target
   instead of landing in whichever investigation was worked on last. */

function renderLab(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<LabPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  setDbForTesting(new Database(new MemoryStorageAdapter()));
  useInvestigationFiles.setState({ byEngagement: {}, loadState: {}, dropTarget: null, dragOver: false });
});

afterEach(() => setDbForTesting(null));

describe("the Lab's drop target", () => {
  it("is the investigation on screen", () => {
    const id = createEngagement("Home lab");
    renderLab(`/lab?e=${id}&view=overview`);

    expect(useInvestigationFiles.getState().dropTarget).toBe(id);
  });

  it("is none while the list of investigations is shown", () => {
    createEngagement("Home lab");
    createEngagement("Office");
    renderLab("/lab?list=1");

    expect(useInvestigationFiles.getState().dropTarget).toBeNull();
  });
});
