import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import {
  resetBridgeForTesting,
  setBridgeForTesting,
  type DesktopBridge,
} from "@/lib/bridge";
import { useUi } from "@/state/ui";
import { CloudConnections } from "./CloudConnections";

/* The list of cloud API keys in Settings. Rust is mocked at `invoke`; keys
   are write-only, so no test ever reads one back. */

interface Row {
  id: number;
  provider: "anthropic" | "openai" | "brave";
  last4: string;
}

/** A fake Rust side: a list of keys (newest first), a model list or an error per service. */
function rust(
  opts: {
    models?: Record<string, unknown>;
    failures?: Record<string, unknown>;
    addError?: string;
    rows?: Row[];
  } = {},
) {
  const rows: Row[] = [...(opts.rows ?? [])];
  let next = rows.length;
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case "ai_keys_list":
        return rows.map((row) => ({ ...row }));
      case "ai_keys_add": {
        if (opts.addError) throw opts.addError;
        const key = String(args?.key);
        const entry: Row = {
          id: next++,
          provider: key.startsWith("sk-ant-")
            ? "anthropic"
            : key.startsWith("BSA")
              ? "brave"
              : "openai",
          last4: key.slice(-4),
        };
        rows.unshift(entry);
        return entry;
      }
      case "ai_keys_remove": {
        const at = rows.findIndex((row) => row.id === args?.id);
        if (at >= 0) rows.splice(at, 1);
        return undefined;
      }
      case "ai_key_has":
        return { present: false, last4: null, baseUrl: null };
      case "ai_list_models": {
        const target = args?.target as { provider: string };
        const name = target.provider === "anthropic" ? "anthropic" : "openai";
        if (opts.failures?.[name]) throw opts.failures[name];
        return opts.models?.[name] ?? [];
      }
      default:
        throw new Error(`unexpected ${command}`);
    }
  });
  return rows;
}

const KEY_FIELD = "Enter API key";
const field = () => screen.findByLabelText(KEY_FIELD);
const claude = () => screen.getByRole("region", { name: "Claude (Anthropic)" });
const openai = () => screen.getByRole("region", { name: "OpenAI" });

beforeEach(() => {
  invoke.mockReset();
  setDbForTesting(new Database(new MemoryStorageAdapter()));
  useUi.setState({ toasts: [] });
  setBridgeForTesting({ mode: "tauri" } as unknown as DesktopBridge);
});

afterEach(() => {
  resetBridgeForTesting();
  setDbForTesting(null);
});

describe("the list of cloud API keys", () => {
  it("starts with one empty field and no provider rows", async () => {
    rust();
    render(<CloudConnections />);

    const input = await field();
    expect(input).toHaveAttribute("type", "password");
    expect(screen.getByText(/No key yet/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "OpenAI" })).not.toBeInTheDocument();
  });

  it("saves a key, shows only its service and last four characters, and clears the field", async () => {
    rust();
    render(<CloudConnections />);

    const input = await field();
    await userEvent.type(input, "sk-ant-api03-example-WXYZ");
    expect(await screen.findByText("Claude (Anthropic) key recognised")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(invoke).toHaveBeenCalledWith("ai_keys_add", { key: "sk-ant-api03-example-WXYZ" });
    expect(await screen.findByText("••••WXYZ")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove the Claude (Anthropic) key ••••WXYZ" })).toBeInTheDocument();
    // A new empty field is below the saved row, and the key is gone from the page.
    expect(await field()).toHaveValue("");
    expect(screen.queryByDisplayValue(/example/)).not.toBeInTheDocument();
    expect(screen.queryByText(/example/)).not.toBeInTheDocument();
    expect(useUi.getState().toasts.map((toast) => toast.messageKey)).toContain(
      "settings.cloud.savedToast",
    );
  });

  it("puts the newest key on top, and recognises OpenAI from sk-proj-", async () => {
    rust({ rows: [{ id: 0, provider: "anthropic", last4: "AAAA" }] });
    render(<CloudConnections />);

    await userEvent.type(await field(), "sk-proj-example-key-BBBB{Enter}");

    await screen.findByText("••••BBBB");
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("OpenAI");
    expect(rows[0]).toHaveTextContent("••••BBBB");
    expect(rows[1]).toHaveTextContent("Claude (Anthropic)");
    expect(getDb().prefs.get().aiOpenAiPreset).toBe("openai");
  });

  it("says plainly that a key's start is not recognised, and saves nothing", async () => {
    rust();
    render(<CloudConnections />);

    await userEvent.type(await field(), "AIzaSyExample-1234567");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Anthropic keys start with sk-ant-; OpenAI keys start with sk- or sk-proj-. Brave Search keys start with BSA.",
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(invoke).not.toHaveBeenCalledWith("ai_keys_add", expect.anything());
  });

  it("lists a Brave Search key by name and last four, with no model card or chat route", async () => {
    rust({ rows: [{ id: 0, provider: "anthropic", last4: "AAAA" }] });
    render(<CloudConnections />);

    await userEvent.type(await field(), "BSAexampleBraveKey-9Q7z");
    expect(await screen.findByText("Brave Search key recognised")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(invoke).toHaveBeenCalledWith("ai_keys_add", { key: "BSAexampleBraveKey-9Q7z" });
    await screen.findByText("••••9Q7z");
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Brave Search");
    expect(rows[0]).toHaveTextContent("••••9Q7z");
    expect(screen.queryByText(/BSAexample/)).not.toBeInTheDocument();
    // It searches the internet; it is not a model Qutra can talk through.
    expect(screen.queryByRole("region", { name: "Brave Search" })).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("ai_list_models", expect.anything());
    expect(getDb().prefs.get().aiProvider).not.toBe("brave");
    expect(getDb().prefs.get().aiOpenAiPreset).not.toBe("brave");
  });

  it("removing a Brave Search key never warns that Qutra's chat loses its key", async () => {
    rust({ rows: [{ id: 3, provider: "brave", last4: "9Q7z" }] });
    getDb().prefs.set({ aiProvider: "openai_compat" });
    render(<CloudConnections />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Remove the Brave Search key ••••9Q7z" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).not.toHaveTextContent(/uses this connection right now/);
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove key" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("ai_keys_remove", { id: 3 }));
  });

  it("explains a key Rust refuses without repeating it", async () => {
    rust({ addError: "invalid_key" });
    render(<CloudConnections />);

    await userEvent.type(await field(), "sk-ant-short{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A key is 8 to 512 characters, without spaces.",
    );
    expect(screen.queryByText(/sk-ant-short/)).not.toBeInTheDocument();
  });

  it("hides the field once there are ten keys", async () => {
    rust({
      rows: Array.from({ length: 10 }, (_, id) => ({
        id,
        provider: "anthropic" as const,
        last4: String(1000 + id),
      })),
    });
    render(<CloudConnections />);

    expect(await screen.findAllByRole("listitem")).toHaveLength(10);
    expect(screen.queryByLabelText(KEY_FIELD)).not.toBeInTheDocument();
    expect(screen.getByText(/Remove one to add another/)).toBeInTheDocument();
  });

  it("shows the field again after a key is removed from a full list", async () => {
    rust({
      rows: Array.from({ length: 10 }, (_, id) => ({
        id,
        provider: "anthropic" as const,
        last4: String(1000 + id),
      })),
    });
    render(<CloudConnections />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Remove the Claude (Anthropic) key ••••1003" }),
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove key" }));

    expect(await field()).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(9);
  });

  it("removes a key only after the user confirms", async () => {
    rust({ rows: [{ id: 0, provider: "anthropic", last4: "WXYZ" }] });
    render(<CloudConnections />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Remove the Claude (Anthropic) key ••••WXYZ" }),
    );
    expect(invoke).not.toHaveBeenCalledWith("ai_keys_remove", expect.anything());
    const dialog = await screen.findByRole("dialog", {
      name: "Remove the Claude (Anthropic) ••••WXYZ key?",
    });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(invoke).not.toHaveBeenCalledWith("ai_keys_remove", expect.anything());

    await userEvent.click(screen.getByRole("button", { name: /Remove the Claude/ }));
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove key" }),
    );

    expect(invoke).toHaveBeenCalledWith("ai_keys_remove", { id: 0 });
    await waitFor(() => expect(screen.queryByText("••••WXYZ")).not.toBeInTheDocument());
    expect(screen.getByText(/No key yet/)).toBeInTheDocument();
  });

  it("says when a key could not be removed", async () => {
    rust({ rows: [{ id: 0, provider: "anthropic", last4: "WXYZ" }] });
    render(<CloudConnections />);
    const remove = await screen.findByRole("button", { name: /Remove the Claude/ });
    invoke.mockImplementationOnce(async () => {
      throw "platform_failure";
    });

    await userEvent.click(remove);
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove key" }),
    );

    await waitFor(() =>
      expect(useUi.getState().toasts.map((toast) => toast.messageKey)).toContain(
        "settings.cloud.error.removeFailed",
      ),
    );
  });

  it("warns that removing the only key of the route in use leaves Qutra unable to answer", async () => {
    rust({ rows: [{ id: 0, provider: "anthropic", last4: "WXYZ" }] });
    getDb().prefs.set({ aiProvider: "anthropic" });
    render(<CloudConnections />);

    await userEvent.click(await screen.findByRole("button", { name: /Remove the Claude/ }));

    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Qutra uses this connection right now",
    );
  });

  it("says cloud connections need the desktop app in the browser build", () => {
    setBridgeForTesting({ mode: "browser" } as unknown as DesktopBridge);
    render(<CloudConnections />);

    expect(screen.getByText("Cloud connections work in the desktop app.")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("the models of a service that has a key", () => {
  it("lists readable Claude names with the raw id as the tooltip, before any test", async () => {
    rust({ rows: [{ id: 0, provider: "anthropic", last4: "WXYZ" }] });
    render(<CloudConnections />);

    await screen.findByText("••••WXYZ");
    const select = within(claude()).getByLabelText("Model");
    expect(select).toHaveValue("claude-opus-5-5");
    for (const name of ["Claude Opus 5.5", "Claude Sonnet 5.5", "Claude Haiku 5.5"]) {
      expect(within(select).getByRole("option", { name })).toBeInTheDocument();
    }
    expect(within(select).getByRole("option", { name: "Claude Sonnet 5.5" })).toHaveAttribute(
      "title",
      "claude-sonnet-5-5",
    );
    // The raw id stays visible beside the readable name.
    expect(within(claude()).getByText("claude-opus-5-5")).toBeInTheDocument();
    expect(within(claude()).queryByText(/Claude \(Anthropic\) ·/)).not.toBeInTheDocument();

    await userEvent.selectOptions(select, "claude-haiku-5-5");
    expect(getDb().prefs.get().aiModels.anthropic).toBe("claude-haiku-5-5");
  });

  it("tests a connection and offers the models the service listed", async () => {
    rust({
      rows: [{ id: 0, provider: "openai", last4: "abcd" }],
      models: {
        openai: [
          { id: "gpt-4o", name: "gpt-4o" },
          { id: "o4-mini", name: "o4-mini" },
        ],
      },
    });
    render(<CloudConnections />);
    await screen.findByText("••••abcd");
    expect(within(openai()).queryByLabelText("Model")).not.toBeInTheDocument();

    await userEvent.click(within(openai()).getByRole("button", { name: "Test the connection" }));

    expect(await within(openai()).findByText("Connected · 2 models")).toBeInTheDocument();
    const select = within(openai()).getByLabelText("Model");
    expect(within(select).getByRole("option", { name: "GPT-4o" })).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: "Choose a model" })).toBeInTheDocument();
    expect(getDb().prefs.get().aiModels["openai_compat:openai"]).toBeUndefined();
    await userEvent.selectOptions(select, "gpt-4o");
    expect(getDb().prefs.get().aiModels["openai_compat:openai"]).toBe("gpt-4o");
  });

  it("says in plain words why a test failed", async () => {
    rust({
      rows: [
        { id: 0, provider: "openai", last4: "abcd" },
        { id: 1, provider: "anthropic", last4: "WXYZ" },
      ],
      failures: {
        anthropic: { code: "key_invalid" },
        openai: { code: "rate_limited", retryAfterSeconds: 12 },
      },
    });
    render(<CloudConnections />);
    await screen.findByText("••••WXYZ");

    await userEvent.click(within(claude()).getByRole("button", { name: "Test the connection" }));
    expect(await within(claude()).findByText(/The key was refused/)).toBeInTheDocument();

    await userEvent.click(within(openai()).getByRole("button", { name: "Test the connection" }));
    expect(await within(openai()).findByText(/Try again in 12 seconds/)).toBeInTheDocument();
  });

  it("uses a service for Qutra from its own card", async () => {
    rust({ rows: [{ id: 0, provider: "anthropic", last4: "WXYZ" }] });
    render(<CloudConnections />);
    await screen.findByText("••••WXYZ");

    await userEvent.click(within(claude()).getByRole("button", { name: "Use for Qutra" }));

    expect(getDb().prefs.get().aiProvider).toBe("anthropic");
    expect(within(claude()).getByText("Qutra uses this")).toBeInTheDocument();
    expect(within(claude()).queryByRole("button", { name: "Use for Qutra" })).not.toBeInTheDocument();
  });
});
