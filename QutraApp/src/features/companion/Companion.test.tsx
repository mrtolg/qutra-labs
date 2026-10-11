import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/lib/localAssistant/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/localAssistant/client")>();
  return {
    ...actual,
    localAssistant: {
      available: vi.fn().mockReturnValue(true),
      checkHealth: vi.fn(),
      listModels: vi.fn(),
      streamChat: vi.fn(),
      approveTool: vi.fn(),
    },
  };
});
vi.mock("@/lib/cloudAssistant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cloudAssistant")>();
  return { ...actual, streamCloudChat: vi.fn() };
});

import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { resetBridgeForTesting, setBridgeForTesting, type DesktopBridge } from "@/lib/bridge";
import { streamCloudChat } from "@/lib/cloudAssistant";
import { AssistantBlockedError, localAssistant } from "@/lib/localAssistant/client";
import { ensureLocaleLoaded } from "@/lib/i18n";
import { createEngagement } from "@/services/appService";
import { useUi } from "@/state/ui";
import { clearHighlight } from "./highlight";
import { resetCompanionForTesting } from "./store";
import Companion from "./Companion";

Element.prototype.scrollTo = vi.fn();
Element.prototype.scrollIntoView = vi.fn();

const streamChat = vi.mocked(localAssistant.streamChat);
const cloudChat = vi.mocked(streamCloudChat);

/** The companion on a page, beside two elements a guide step can point at. */
function renderAt(path: string, prefs: Record<string, unknown> = {}) {
  const db = getDb();
  db.prefs.set({ locale: "en", companionEnabled: true, ...prefs });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Companion />
      <button data-guide="lab-scope">Scope strip</button>
      <button data-guide="projects-new">New project</button>
    </MemoryRouter>,
  );
}

const bubble = () => screen.getByTestId("companion-bubble");
const open = async () => {
  await userEvent.click(bubble());
  return screen.getByTestId("companion-panel");
};

beforeEach(() => {
  setDbForTesting(new Database(new MemoryStorageAdapter()));
  resetCompanionForTesting();
  useUi.setState({ settingsSection: null, toasts: [] });
  streamChat.mockReset();
  cloudChat.mockReset();
});

afterEach(() => {
  clearHighlight();
  resetBridgeForTesting();
});

describe("where the bubble is", () => {
  it("is drawn on a page of the app, with a name for assistive tools", () => {
    renderAt("/overview");
    expect(bubble()).toHaveAccessibleName("Qutra, your guide for this page");
    expect(screen.getByTestId("companion")).toHaveClass("companion");
  });

  it("is not drawn on the Qutra page, which has the full chat", () => {
    renderAt("/jarvis");
    expect(screen.queryByTestId("companion-bubble")).not.toBeInTheDocument();
  });

  it("is not drawn where the user hid it", () => {
    renderAt("/lab?view=runs", { companionHidden: ["lab"] });
    expect(screen.queryByTestId("companion-bubble")).not.toBeInTheDocument();
  });
});

describe("the guide", () => {
  it("shows the page's steps one at a time", async () => {
    renderAt("/workspaces");
    const panel = await open();
    expect(within(panel).getByText("On this page: Projects")).toBeInTheDocument();
    expect(screen.getByTestId("companion-step")).toHaveTextContent(/New project/);
    expect(within(panel).getByText("Step 1 of 3")).toBeInTheDocument();

    await userEvent.click(within(panel).getByRole("button", { name: "Next" }));
    expect(within(panel).getByText("Step 2 of 3")).toBeInTheDocument();
    expect(screen.getByTestId("companion-step")).toHaveTextContent(/Open a project/);
    await userEvent.click(within(panel).getByRole("button", { name: "Previous" }));
    expect(within(panel).getByText("Step 1 of 3")).toBeInTheDocument();
  });

  it("follows the section of the investigation the user is in", async () => {
    renderAt("/lab?view=scope");
    const panel = await open();
    expect(within(panel).getByText("On this page: Scope")).toBeInTheDocument();
    expect(screen.getByTestId("companion-step")).toHaveTextContent(/allowed to test/);
  });

  it("is in the language the app is in", async () => {
    await ensureLocaleLoaded("tr");
    renderAt("/overview", { locale: "tr" });
    const panel = await open();
    expect(within(panel).getByText("Bu sayfa: Ana Sayfa")).toBeInTheDocument();
    expect(screen.getByTestId("companion-step")).toHaveTextContent("Dikkat gerektiriyor");
  });

  it("points at the element of the step", async () => {
    renderAt("/workspaces");
    const panel = await open();
    // Step 1 is about "New project", which is on this page.
    await userEvent.click(within(panel).getByTestId("companion-show"));
    expect(screen.getByRole("button", { name: "New project" })).toHaveAttribute(
      "data-guide-hit",
      "true",
    );
    expect(within(panel).getByRole("status")).toHaveTextContent(/Outlined on screen/);
  });

  it("says when the element is not on screen, and clicks nothing", async () => {
    renderAt("/files");
    const panel = await open();
    const clicked = vi.fn();
    document.addEventListener("click", clicked);
    await userEvent.click(within(panel).getByTestId("companion-show"));
    document.removeEventListener("click", clicked);
    expect(within(panel).getByRole("status")).toHaveTextContent(/can't find that on screen/);
    // Only the Show me press itself was a click.
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("asks nothing of the assistant while the user only reads and points", async () => {
    renderAt("/workspaces", { localAssistantEnabled: true });
    const panel = await open();
    await userEvent.click(within(panel).getByRole("button", { name: "Next" }));
    await userEvent.click(within(panel).getByRole("button", { name: "Previous" }));
    await userEvent.click(within(panel).getByTestId("companion-show"));
    expect(streamChat).not.toHaveBeenCalled();
    expect(cloudChat).not.toHaveBeenCalled();
  });

  it("closes with Escape and gives the focus back to the bubble", async () => {
    renderAt("/overview");
    await open();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("companion-panel")).not.toBeInTheDocument();
    expect(bubble()).toHaveFocus();
  });
});

describe("hide on this page", () => {
  it("hides the area, remembers it and offers a way back", async () => {
    renderAt("/lab?view=runs");
    const panel = await open();
    await userEvent.click(within(panel).getByTestId("companion-hide"));

    expect(getDb().prefs.get().companionHidden).toEqual(["lab"]);
    await waitFor(() => expect(screen.queryByTestId("companion-bubble")).not.toBeInTheDocument());
    const toast = useUi.getState().toasts.at(-1)!;
    expect(toast).toMatchObject({ messageKey: "companion.hidden", actionKey: "companion.showAgain" });

    act(() => toast.onAction?.());
    expect(getDb().prefs.get().companionHidden).toEqual([]);
    await waitFor(() => expect(screen.getByTestId("companion-bubble")).toBeInTheDocument());
  });
});

describe("a free question through the local engine", () => {
  it("goes through the assistant with the page's block, and cannot propose tools", async () => {
    streamChat.mockImplementation(async (_config, _messages, options) => {
      options?.onToken?.("Open Projects, then press New project.");
      return "Open Projects, then press New project.";
    });
    const id = createEngagement("ACME web");
    renderAt(`/tools?view=registered&e=${id}&tool=nmap`, { localAssistantEnabled: true });
    const panel = await open();

    await userEvent.type(within(panel).getByLabelText("Ask about this page"), "How do I start?");
    await userEvent.click(within(panel).getByRole("button", { name: "Send" }));

    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));
    const [config, messages] = streamChat.mock.calls[0]!;
    expect(config).toMatchObject({
      localAssistantEnabled: true,
      agentToolsEnabled: false,
      autoApproveReads: false,
      webAccess: false,
    });
    expect(messages[0]).toMatchObject({ role: "system" });
    expect(messages[0]!.content).toContain("CONTEXT (read-only)");
    expect(messages[0]!.content).toContain("Page: Registered tools (/tools (registered))");
    expect(messages[0]!.content).toContain("Open investigation: ACME web");
    expect(messages[0]!.content).toContain("Selected tool: nmap");
    expect(messages.at(-1)).toEqual({ role: "user", content: "How do I start?" });
    expect(
      await within(panel).findByText("Open Projects, then press New project."),
    ).toBeInTheDocument();
    expect(cloudChat).not.toHaveBeenCalled();
  });

  it("keeps nothing in the conversations the Qutra page saves", async () => {
    streamChat.mockResolvedValue("Sure.");
    renderAt("/overview", { localAssistantEnabled: true });
    const panel = await open();
    await userEvent.type(within(panel).getByLabelText("Ask about this page"), "Hi{Enter}");
    await within(panel).findByText("Sure.");
    expect(getDb().collection("conversations").getAll()).toEqual([]);
  });

  it("asks to turn the assistant on when it is off, and sends nothing", async () => {
    renderAt("/overview", { localAssistantEnabled: false });
    const panel = await open();
    expect(within(panel).getByText(/turn on the Qutra assistant/)).toBeInTheDocument();
    expect(within(panel).queryByLabelText("Ask about this page")).not.toBeInTheDocument();
    expect(streamChat).not.toHaveBeenCalled();
    // The guide still works without it.
    expect(screen.getByTestId("companion-step")).toBeInTheDocument();
  });

  it("puts the question back in the box when no answer came", async () => {
    streamChat.mockRejectedValue(new AssistantBlockedError("offline"));
    renderAt("/overview", { localAssistantEnabled: true });
    const panel = await open();
    await userEvent.type(within(panel).getByLabelText("Ask about this page"), "Where is it?{Enter}");

    expect(await within(panel).findByRole("alert")).toBeInTheDocument();
    expect(within(panel).getByLabelText("Ask about this page")).toHaveValue("Where is it?");
    expect(within(panel).queryByText("Where is it?", { selector: "p" })).not.toBeInTheDocument();
  });
});

describe("a free question through the cloud", () => {
  it("goes through the chosen connection and leaves the user's own records here", async () => {
    setBridgeForTesting({ mode: "tauri" } as unknown as DesktopBridge);
    cloudChat.mockImplementation(async (_target, _model, _messages, options) => {
      options.onToken?.("Check the scope first.");
      return {
        text: "Check the scope first.",
        blocks: null,
        stop: "end_turn",
        refusalCategory: null,
        servedBy: "claude-opus-5-5",
        fallbackFrom: null,
        usage: null,
      };
    });
    const id = createEngagement("ACME web");
    renderAt(`/lab?e=${id}&view=runs`, { aiProvider: "anthropic" });
    const panel = await open();
    expect(within(panel).getByText(/Questions go to Claude/)).toBeInTheDocument();

    await userEvent.type(within(panel).getByLabelText("Ask about this page"), "What next?{Enter}");

    await waitFor(() => expect(cloudChat).toHaveBeenCalledTimes(1));
    const [target, model, messages] = cloudChat.mock.calls[0]!;
    expect(target).toEqual({ provider: "anthropic" });
    expect(model).toBe("claude-opus-5-5");
    const sent = JSON.stringify(messages);
    expect(sent).toContain("Page: Runs");
    expect(sent).toContain("What next?");
    expect(sent).not.toContain("ACME web");
    expect(messages).toHaveLength(1);
    expect(streamChat).not.toHaveBeenCalled();
    expect(await within(panel).findByText("Check the scope first.")).toBeInTheDocument();
  });
});
