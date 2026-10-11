import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

const sandboxMarker = "sandbox-cache";
const currentBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
// A sandboxed shell gives each session a browser cache the next session does not
// have, so on a developer machine the browsers are pinned to one stable folder.
// CI must not be pinned: the workflow installs Chromium into Playwright's
// default location just before the suite, and overriding the path there sent
// every test to an empty folder ("Executable doesn't exist", each test ~5 ms).
if (
  !process.env.CI &&
  (!currentBrowsersPath ||
    currentBrowsersPath === "0" ||
    currentBrowsersPath.includes(sandboxMarker))
) {
  const root = process.env.LOCALAPPDATA || os.homedir();
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(root, "qutra-playwright");
}

function e2eOrigin(): string {
  const raw = process.env.QUTRA_E2E_PORT;
  if (raw === undefined || raw === "") return "http://localhost:5174";
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(
      `QUTRA_E2E_PORT must be an integer from 1 to 65535, got ${JSON.stringify(raw)}`,
    );
  }
  const port = Number(raw);
  if (port < 1 || port > 65535) {
    throw new Error(
      `QUTRA_E2E_PORT must be an integer from 1 to 65535, got ${JSON.stringify(raw)}`,
    );
  }
  return `http://localhost:${port}`;
}

const e2eOriginUrl = e2eOrigin();

export default defineConfig({
  testDir: "./e2e",
  // Warms Vite's module graph before the first test, so no test pays the cold
  // compile inside its own budget. See e2e/global-setup.ts for why this is a
  // setup step rather than a bigger timeout or a retry.
  globalSetup: "./e2e/global-setup.ts",
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: e2eOriginUrl,
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: e2eOriginUrl,
    // Gate and CI start a fresh Vite. Reusing a leftover on this port already
    // cost eight ERR_CONNECTION_REFUSED failures when that process died
    // mid-suite (BASELINE.md: webServer.timeout 60s, strictPort false).
    reuseExistingServer: process.env.QUTRA_GATE !== "1" && !process.env.CI,
    timeout: 120_000,
  },
});
