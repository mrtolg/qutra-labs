import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { EngagementSchema } from "@/domain/lab";
import { consentMatches, grantCloudConsent, revokeCloudConsent } from "@/lib/cloudConsent";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { createConversation } from "@/lib/db/conversations";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { CloudConsents } from "@/features/settings/CloudConsents";
import { useUi } from "@/state/ui";
import { AskJarvis, CloudConsentStat } from "./AskJarvis";

/* Asking Jarvis about an investigation, and its cloud allowance. */

const engagement = EngagementSchema.parse({
  id: "eng-1",
  title: "Home Lab",
  status: "active",
  createdAt: 1,
  updatedAt: 1,
});
const connection = { provider: "anthropic", host: "api.anthropic.com" };

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

beforeEach(() => {
  setDbForTesting(new Database(new MemoryStorageAdapter()));
  getDb().collection("engagements").put(engagement);
});

afterEach(() => setDbForTesting(null));

describe("the cloud allowance", () => {
  it("is kept per connection and leaves the investigation's last-worked time alone", async () => {
    await grantCloudConsent("eng-1", connection, 50);
    const granted = getDb().collection("engagements").get("eng-1")!;
    expect(granted).toMatchObject({ updatedAt: 1, cloudConsent: { ...connection, grantedAt: 50 } });
    expect(consentMatches(granted, connection)).toBe(true);
    expect(consentMatches(granted, { ...connection, host: "proxy.example" })).toBe(false);
    expect(consentMatches(granted, { provider: "groq", host: "api.anthropic.com" })).toBe(false);

    await revokeCloudConsent("eng-1");
    const revoked = getDb().collection("engagements").get("eng-1")!;
    expect(revoked.updatedAt).toBe(1);
    expect(revoked).not.toHaveProperty("cloudConsent");
  });
});

describe("Ask Jarvis", () => {
  it("opens Jarvis in a conversation linked to the investigation, reusing an empty one", async () => {
    render(
      <MemoryRouter initialEntries={["/lab"]}>
        <Routes>
          <Route path="*" element={<><AskJarvis engagement={engagement} /><Where /></>} />
        </Routes>
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Ask Jarvis" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/jarvis"));
    const [linked] = getDb().collection("conversations").getAll();
    expect(linked).toMatchObject({ engagementId: "eng-1", messages: [] });

    await userEvent.click(screen.getByRole("button", { name: "Ask Jarvis" }));
    await waitFor(() => expect(getDb().collection("conversations").getAll()).toHaveLength(1));
  });

  it("starts a new conversation rather than reopening an archived empty one", async () => {
    const archived = await createConversation(getDb(), { engagementId: "eng-1" });
    getDb().collection("conversations").patch(archived.id, { archivedAt: 5 });
    render(
      <MemoryRouter initialEntries={["/lab"]}>
        <Routes>
          <Route path="*" element={<><AskJarvis engagement={engagement} /><Where /></>} />
        </Routes>
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Ask Jarvis" }));

    await waitFor(() => expect(getDb().collection("conversations").getAll()).toHaveLength(2));
    const open = getDb()
      .collection("conversations")
      .getAll()
      .filter((c) => c.archivedAt === undefined);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ engagementId: "eng-1", messages: [] });
  });

  it("shows the allowance in the header and in Settings, and both take it back", async () => {
    await grantCloudConsent("eng-1", connection, 50);
    const { rerender } = render(
      <CloudConsentStat engagement={getDb().collection("engagements").get("eng-1")!} />,
    );
    expect(screen.getByTestId("lab-cloud-consent")).toHaveTextContent("Cloud allowed: api.anthropic.com");
    await userEvent.click(
      screen.getByRole("button", { name: "Revoke the cloud allowance (api.anthropic.com)" }),
    );
    await waitFor(() =>
      expect(getDb().collection("engagements").get("eng-1")).not.toHaveProperty("cloudConsent"),
    );
    rerender(<CloudConsentStat engagement={getDb().collection("engagements").get("eng-1")!} />);
    expect(screen.queryByTestId("lab-cloud-consent")).toBeNull();

    await grantCloudConsent("eng-1", connection, 50);
    rerender(<CloudConsents />);
    expect(screen.getByTestId("settings-cloud-consents")).toHaveTextContent("Home Lab");
    await userEvent.click(screen.getByRole("button", { name: "Revoke: Home Lab" }));
    expect(await screen.findByText(/No investigation has allowed/)).toBeInTheDocument();
  });

  it("announces a revoke and hands the focus on, since the button goes with the allowance", async () => {
    await grantCloudConsent("eng-1", connection, 50);
    useUi.setState({ liveMessage: "" });
    render(<CloudConsents />);
    await userEvent.click(screen.getByRole("button", { name: "Revoke: Home Lab" }));
    await waitFor(() => expect(useUi.getState().liveMessage).toBe("Cloud allowance revoked."));
    expect(screen.getByText("Investigations that may go to the cloud")).toHaveFocus();
  });

  it("says so when a revoke does not reach the disk, and the allowance stands", async () => {
    await grantCloudConsent("eng-1", connection, 50);
    vi.spyOn(getDb().collection("engagements"), "updateDurable").mockRejectedValueOnce(
      new Error("disk full"),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<CloudConsents />);
    await userEvent.click(screen.getByRole("button", { name: "Revoke: Home Lab" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be revoked");
    expect(getDb().collection("engagements").get("eng-1")).toHaveProperty("cloudConsent");
  });
});
