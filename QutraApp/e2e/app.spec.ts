import { expect, test } from "@playwright/test";
import { loadDemo, openSettings, primePreferences } from "./helpers";

const CORE_ROUTES = [
  ["/overview", "Home"],
  ["/workspaces", "Projects"],
  ["/files", "Files"],
  ["/tools", "Tools"],
  ["/lab", "Security Lab"],
  ["/terminal", "Terminal"],
  ["/github", "GitHub"],
  // The assistant is Qutra; the route stays /jarvis.
  ["/jarvis", "Qutra"],
] as const;

const RETIRED_ROUTES = [
  // Settings is a modal over the current surface.
  "/settings",
  "/today",
  "/inbox",
  "/notes",
  "/pages",
  "/timeline",
  "/clipboard",
  "/sessions",
  "/tasks",
  "/snippets",
  "/errors",
  "/automations",
  "/insights",
] as const;

test.describe("simplified product shell", () => {
  test.beforeEach(async ({ page }) => {
    await primePreferences(page);
  });

  test("one navigation bar, never the nine modules, and every route renders", async ({
    page,
  }) => {
    await page.goto("/#/overview");
    // The nine-item sidebar and the side rail are gone (one navigation bar).
    // Home's sections sit under the top bar
    // and every route below stays reachable.
    await expect(page.locator("nav.rail")).toHaveCount(0);
    const home = page.getByRole("navigation", { name: "Home sections" });
    await expect(home.getByRole("button")).toHaveCount(4);
    await expect(page.locator(".ctx-sidebar")).toHaveCount(0);

    for (const [route] of CORE_ROUTES) {
      await page.goto(`/#${route}`);
      const main = page.locator("main");
      await expect(main).toBeVisible();
      await expect
        .poll(async () => (await main.innerText()).trim().length)
        .toBeGreaterThan(10);
    }
  });

  test("retired bookmarks stay on the dead path and show not-found", async ({
    page,
  }) => {
    for (const retired of RETIRED_ROUTES) {
      await page.goto(`/#${retired}`);
      await expect(page).toHaveURL(
        new RegExp(`#${retired.replace("/", "\\/")}$`),
      );
      await expect(
        page.getByRole("heading", { name: "Nothing here" }),
      ).toBeVisible();
    }
  });

  test("onboarding skip lands on Overview", async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await page.goto("/#/onboarding");
    await page.getByRole("button", { name: "Skip setup" }).click();
    await expect(page).toHaveURL(/#\/overview$/);
    await expect(page.locator("main")).toBeVisible();
  });

  test("demo workspace opens and can start a focus session", async ({ page }) => {
    await loadDemo(page);
    await page.goto("/#/workspaces");
    await page.getByText("Qutra Labs Desktop", { exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "Qutra Labs Desktop" })).toBeVisible();
    await page.getByRole("button", { name: "New session" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("files page can add and remove a local path", async ({ page }) => {
    await page.goto("/#/files");
    await page.getByLabel("Path").fill("C:\\Dev\\contextos\\notes.txt");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("notes.txt").first()).toBeVisible();
    await expect(page.getByText("C:\\Dev\\contextos\\notes.txt").first()).toBeVisible();
    await page
      .getByRole("button", { name: "Delete: notes.txt" })
      .click();
    await expect(page.getByText("No files yet")).toBeVisible();
  });

  test("terminal explains itself when the native runtime is unavailable", async ({ page }) => {
    // The terminal is a real PTY-backed shell in the native runtime. This is
    // a browser build, so it must show the honest native-required state
    // rather than a fake or gated shell — independent of privateToolsEnabled.
    await page.goto("/#/terminal");
    await expect(page.getByTestId("terminal-native-required")).toBeVisible();
    await expect(page.locator(".xterm")).toHaveCount(0);
  });
});

test.describe("data lifecycle", () => {
  test("export downloads a schema-versioned JSON file", async ({ page }) => {
    await primePreferences(page);
    await loadDemo(page);
    const settings = await openSettings(page, "importExport");
    const downloadPromise = page.waitForEvent("download");
    await settings.getByRole("button", { name: "Export", exact: true }).first().click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/contextos-export-.*\.json/);
  });

  test("delete-all requires typed confirmation and returns to onboarding", async ({
    page,
  }) => {
    await primePreferences(page);
    await loadDemo(page);
    const settings = await openSettings(page, "advanced");
    await settings.getByRole("button", { name: "Delete", exact: true }).click();
    const confirm = page.getByRole("button", { name: "Delete", exact: true }).last();
    await expect(confirm).toBeDisabled();
    await page.getByRole("textbox", { name: "DELETE" }).fill("DELETE");
    await confirm.click();
    await expect(
      page.getByRole("heading", { name: "Welcome to Qutra Labs" }),
    ).toBeVisible({ timeout: 10_000 });
  });
});
