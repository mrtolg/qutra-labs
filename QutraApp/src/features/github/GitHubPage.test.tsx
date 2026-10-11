import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";

/* GitHub showed "Could not reach GitHub" with only Retry while an account
   was connected. Every refusal except offline and rate limits landed in that
   one state, so an expired or under-scoped token looked like a network fault
   that Retry could fix. */

const provider = vi.hoisted(() => ({
  isConnected: vi.fn(),
  getProfile: vi.fn(),
  getRepos: vi.fn(),
  getContributions: vi.fn(),
  disconnect: vi.fn(),
  connectWithToken: vi.fn(),
}));

vi.mock("./provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./provider")>();
  return {
    ...actual,
    GitHubProvider: class {
      constructor() {
        return provider;
      }
    },
  };
});

import { GitHubApiError } from "./provider";
import GitHubPage from "./GitHubPage";

function mount(failure: string) {
  setDbForTesting(new Database(new MemoryStorageAdapter()));
  provider.isConnected.mockResolvedValue(true);
  provider.getProfile.mockRejectedValue(new GitHubApiError(failure as never));
  provider.getRepos.mockResolvedValue([]);
  provider.getContributions.mockResolvedValue([]);
  provider.disconnect.mockResolvedValue(undefined);
  render(
    <MemoryRouter>
      <GitHubPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  setDbForTesting(null);
  vi.clearAllMocks();
});

describe("GitHub page when GitHub refuses the saved connection", () => {
  it("says an expired connection has expired and offers to connect again", async () => {
    mount("unauthorized");

    expect(await screen.findByText("Your GitHub connection has expired")).toBeInTheDocument();
    expect(screen.queryByText("Could not reach GitHub")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Connect again" }));
    expect(await screen.findByText("Connect GitHub")).toBeInTheDocument();
    expect(provider.disconnect).toHaveBeenCalledTimes(1);
  });

  it("says when GitHub refuses access, and offers to connect again", async () => {
    mount("forbidden");

    expect(
      await screen.findByText("GitHub refused access with this connection"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect again" })).toBeInTheDocument();
  });

  it("keeps Retry for a fault that retrying can fix", async () => {
    mount("github_error");

    expect(await screen.findByText("Could not reach GitHub")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect again" })).toBeNull();
  });
});
