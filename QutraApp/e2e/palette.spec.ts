import { expect, test } from "@playwright/test";
import { loadDemo, primePreferences } from "./helpers";

/* ============================================================
   Command Palette (previously untested).

   Three commands used to look like they worked and did nothing:
     - "New session" only opened the project list,
     - "Capture context" navigated to `?capture=1`, which no page read,
     - picking a specific file opened the generic Files page, discarding it.

   A command that appears to succeed while doing nothing is worse than a
   missing one, so these assert the real outcome — a dialog that opens, a
   destination that carries the selection — not just that navigation happened.
   ============================================================ */

async function openPalette(page: import("@playwright/test").Page) {
  // Via the top bar's Search rather than Ctrl+K: the shortcut depends on where
  // focus landed after navigation, which made this flaky for no useful reason.
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

test.describe("command palette", () => {
  test("New session opens the real start-session dialog", async ({ page }) => {
    await primePreferences(page);
    await loadDemo(page);

    await openPalette(page);
    await page.getByRole("option", { name: /New session/i }).first().click();

    // The dialog itself must appear — not merely a navigation to some page.
    // Its primary action is what distinguishes it from the command label.
    await expect(page.getByRole("button", { name: "Start session" })).toBeVisible();

    // And it must be scoped to a concrete project.
    await expect(page).toHaveURL(/#\/workspaces\/[^/?]+/);
  });

  test("Capture context opens the snapshot dialog", async ({ page }) => {
    await primePreferences(page);
    await loadDemo(page);

    await openPalette(page);
    await page.getByRole("option", { name: /Capture context/i }).first().click();

    await expect(page.getByRole("dialog")).toBeVisible();
    // Scoped to the dialog: the workspace toolbar carries the same label. The
    // dialog's primary action also shows a selected-item count.
    await expect(
      page.getByRole("dialog").getByRole("button", { name: /Capture snapshot \(/ }),
    ).toBeVisible();
  });

  test("the action parameter is consumed, so going back does not reopen", async ({
    page,
  }) => {
    await primePreferences(page);
    await loadDemo(page);

    await openPalette(page);
    await page.getByRole("option", { name: /Capture context/i }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Left in the URL, `?action=` would reopen on every refresh and would also
    // make this a second working tab for the same workspace.
    await expect(page).not.toHaveURL(/action=/);

    await page.reload();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("choosing a file goes to the project that owns it", async ({ page }) => {
    await primePreferences(page);
    await loadDemo(page);

    await openPalette(page);
    // The palette only indexes `file`/`folder` resources, and this is the one
    // the demo dataset seeds. Asserted rather than skipped, so the test cannot
    // silently stop covering anything.
    await page.getByRole("combobox").fill("contextos repo");

    const fileResult = page.getByRole("option", { name: /contextos repo/ }).first();
    await expect(fileResult, "demo data must seed the folder resource").toBeVisible();
    await fileResult.click();

    // The selection must survive: the resources tab of the project that owns
    // the file, never the bare Files page that discarded which file was picked.
    await expect(page).toHaveURL(/#\/workspaces\/[^/]+\/resources/);
  });

  test("with no projects, the command says so instead of pretending", async ({
    page,
  }) => {
    // No demo data: nothing to start a session on.
    await primePreferences(page);
    await page.goto("/#/overview");

    await openPalette(page);
    await page.getByRole("option", { name: /New session/i }).first().click();

    // It lands where a project is created, and no session dialog is claimed.
    await expect(page).toHaveURL(/#\/workspaces$/);
    await expect(
      page.getByRole("heading", { name: /start .*session/i }),
    ).toHaveCount(0);
  });
});

/* ============================================================
   The palette is the navigation (docs/design/shell-spec.md §4).

   Enumerated from the palette itself, not from a list in this file, so a
   target added to the registry is opened here without anyone remembering to
   add it. `commands.test.ts` proves the registry covers every route, Lab
   view and Settings section; this proves each entry actually gets there.
   ============================================================ */

function hashLocation(url: string) {
  const hash = new URL(url).hash.replace(/^#/, "");
  const [path, search = ""] = hash.split("?");
  return { path, params: new URLSearchParams(search) };
}

test.describe("command palette coverage", () => {
  test("every place it lists opens from it", async ({ page }) => {
    test.setTimeout(90_000);
    await primePreferences(page);
    await loadDemo(page);

    await openPalette(page);
    const ids = await page
      .locator('[role="option"][data-command-id^="nav:"]:not([data-group="recent"])')
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-command-id")!));
    await page.keyboard.press("Escape");
    // 8 destinations, 7 investigation sections and 5 Tools sections at the
    // time of writing (Settings is no longer a route, see below); the
    // floor guards against the list silently emptying.
    expect(ids.length).toBeGreaterThanOrEqual(16);

    for (const id of ids) {
      await openPalette(page);
      await page
        .locator(`[data-command-id="${id}"]:not([data-group="recent"])`)
        .click();
      await expect(page.getByRole("dialog")).toHaveCount(0);

      const want = hashLocation(`http://x/#${id.slice("nav:".length)}`);
      await expect
        .poll(() => hashLocation(page.url()).path, { message: id })
        .toBe(want.path);
      const got = hashLocation(page.url()).params;
      for (const [key, value] of want.params) {
        expect(got.get(key), `${id}: ${key}`).toBe(value);
      }
    }
  });

  test("every Settings section it lists opens the Settings window there", async ({ page }) => {
    test.setTimeout(90_000);
    await primePreferences(page);
    await loadDemo(page);
    await page.goto("/#/overview");

    await openPalette(page);
    const sections = await page
      .locator('[role="option"][data-command-id^="settings:"]:not([data-group="recent"])')
      .evaluateAll((els) =>
        els.map((el) => ({
          id: el.getAttribute("data-command-id")!,
          label: el.querySelector(".truncate")?.textContent ?? "",
        })),
      );
    await page.keyboard.press("Escape");
    // 13 sections at the time of writing.
    expect(sections.length).toBeGreaterThanOrEqual(13);

    for (const { id, label } of sections) {
      await openPalette(page);
      await page.locator(`[data-command-id="${id}"]:not([data-group="recent"])`).click();
      const settings = page.getByRole("dialog", { name: "Settings" });
      await expect(settings, id).toBeVisible();
      await expect(settings.getByRole("heading", { name: label, exact: true }), id).toBeVisible();
      // A window over the surface, not a route.
      await expect(page).toHaveURL(/#\/overview$/);
      await page.keyboard.press("Escape");
      await expect(settings, id).toHaveCount(0);
    }
  });

  test("the search field has a label that stays visible", async ({ page }) => {
    await primePreferences(page);
    await page.goto("/#/overview");
    await openPalette(page);

    const field = page.getByLabel("Search pages, settings and commands");
    await expect(field).toBeFocused();
    await field.fill("privacy");
    await expect(
      page.getByText("Search pages, settings and commands", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("option", { name: /Privacy/ }).first(),
    ).toBeVisible();
  });

  test("New investigation asks for a name, then opens the new investigation", async ({ page }) => {
    await primePreferences(page);
    await page.goto("/#/overview");

    await openPalette(page);
    await page.getByRole("option", { name: /New investigation/ }).first().click();

    await expect(page).toHaveURL(/#\/lab\?new=1$/);
    const dialog = page.getByRole("dialog", { name: "New investigation" });
    await dialog.getByLabel("Name", { exact: true }).fill("Palette engagement");
    await dialog.getByRole("button", { name: "Create" }).click();
    await expect(page).toHaveURL(/#\/lab\?e=[^&]+&view=overview$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Palette engagement" }),
    ).toBeVisible();
  });

  test("New terminal in the browser build lands on Work's honest state", async ({
    page,
  }) => {
    await primePreferences(page);
    await page.goto("/#/overview");

    await openPalette(page);
    await page.getByRole("option", { name: /New terminal/ }).first().click();

    await expect(page).toHaveURL(/#\/terminal$/);
    await expect(page.getByTestId("terminal-native-required")).toBeVisible();
  });
});
