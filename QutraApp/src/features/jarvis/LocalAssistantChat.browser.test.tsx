import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { setRuntimeForTesting } from "@/lib/runtime";
import { LocalAssistantChat } from "./LocalAssistantChat";

/* Browser-mode honesty at the *surface*, not just the client.

   `client.test.ts` already pins the two client-level halves of this claim --
   "is unavailable rather than pretending in a browser build" (checkHealth +
   streamChat) and "invokes nothing and reports unavailable rather than
   pretending in a browser build" (approveTool). What no test covered is the
   surface a user actually looks at: that the Qutra chat, driven through the
   *real* client (deliberately NOT the module mock the approval tests use),
   says so plainly and never renders an approval control there.

   The runtime seam is the only thing stubbed. `localAssistant` is the real
   singleton, so `streamChat`'s own `available()` guard -- which runs before
   it subscribes to the event stream or invokes `assistant_start` -- is the
   thing under test. */

// jsdom does not implement Element.scrollTo; the component calls it to keep
// the transcript pinned to the bottom. Test-environment gap, not behavior.
Element.prototype.scrollTo = vi.fn();

afterEach(() => {
  setDbForTesting(null);
  setRuntimeForTesting(null);
  vi.clearAllMocks();
});

function seedDb() {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set({
    localAssistantEnabled: true,
    assistantContextEnabled: false,
  });
  setDbForTesting(db);
  return db;
}

describe("LocalAssistantChat in a browser build", () => {
  it("says the broker is desktop-only and never renders an approval control", async () => {
    setRuntimeForTesting("browser");
    seedDb();
    const user = userEvent.setup();

    render(<LocalAssistantChat />);

    await user.type(screen.getByLabelText("Message to Qutra"), "run whoami");
    await user.click(screen.getByRole("button", { name: "Send" }));

    // The honest refusal, mapped from the `unavailable` wire code -- not a
    // generic failure, and not silence.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Qutra works only in the desktop app. The browser version can't reach it.",
    );

    // Nothing to approve, because nothing was ever proposed: the turn was
    // refused before the client subscribed or invoked anything.
    expect(screen.queryByTestId("assistant-approval-card")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve & run" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();

    // The turn ended: the composer is usable again rather than stuck busy.
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });
});
