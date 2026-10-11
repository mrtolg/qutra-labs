import { expect, test, type Page } from "@playwright/test";
import { primePreferences, waitForAppReady } from "./helpers";

/* Lab's views are a segmented control inside the
   surface, and one context panel replaces the Inspector and the bottom panel.
   The shots sit next to targets/drafts/7-lab*.png and 8-context-panel*.png. */

const HUD = { theme: "system", packId: "hud", themeMode: "dark", material: "none" };
const T = 1_759_300_000_000;

function seed(page: Page, outOfScope = false) {
  return page.addInitScript(
    ({ T, outOfScope }) => {
      const K = "contextos.v1.";
      const set = (name: string, rows: unknown[]) =>
        localStorage.setItem(K + name, JSON.stringify(rows));
      set("workspaces", [
        {
          id: "ws1",
          name: "qutra-app",
          color: "#37d6e0",
          purpose: "Desktop app for local security work: terminal, tools and the lab.",
          type: "software",
          status: "active",
          localPath: "C:\\src\\qutra-app",
          git: {
            connected: true,
            branch: "main",
            dirtyFiles: 3,
            ahead: 1,
            behind: 0,
            lastCommits: [
              { hash: "9f3c2a1d", message: "Lab: views as a segmented control", author: "Samil", at: T, additions: 184, deletions: 97 },
            ],
          },
          createdAt: T,
          updatedAt: T,
          lastActivityAt: T,
        },
      ]);
      set("tasks", [
        { id: "t1", title: "Keyboard test for Ctrl+B on every surface", workspaceId: "ws1", status: "todo", createdAt: T, updatedAt: T },
      ]);
      set("engagements", [
        {
          id: "eng1",
          title: "Home Lab — Internal Range",
          purpose: "training_lab",
          status: "active",
          clientLabel: "",
          contacts: [],
          notes: "",
          tags: [],
          scopeId: "sc1",
          demo: false,
          createdAt: T,
          updatedAt: T,
        },
      ]);
      set("authorizationScopes", [
        {
          id: "sc1",
          engagementId: "eng1",
          ownerLabel: "self",
          description: "",
          allowedTargets: ["192.168.56.0/24"],
          excludedTargets: ["192.168.56.1"],
          authorizationRef: "AUTH-2026-014",
          testerAck: true,
          revision: 1,
          createdAt: T,
          updatedAt: T,
        },
      ]);
      set(
        "findings",
        [
          ["f1", "SMB signing not required", "high", "192.168.56.101:445"],
          ["f2", "TLS 1.0 still accepted", "medium", "192.168.56.104:443"],
          ["f3", "Server banner shows version", "low", "http://localhost:3000"],
        ].map(([id, title, severity, target]) => ({
          id,
          engagementId: "eng1",
          title,
          severity,
          status: "new",
          affectedTargets: [target],
          fingerprint: `fp-${id}`,
          firstSeen: T,
          lastSeen: T,
          createdAt: T,
          updatedAt: T,
        })),
      );
      set("targets", [
        {
          id: "tg1",
          engagementId: "eng1",
          raw: outOfScope ? "8.8.8.8" : "192.168.56.101",
          normalized: outOfScope ? "8.8.8.8" : "192.168.56.101",
          kind: "ip",
          scopeState: "unknown",
          notes: "",
          demo: false,
          createdAt: T,
          updatedAt: T,
        },
      ]);
    },
    { T, outOfScope },
  );
}

const panel = (page: Page) => page.getByRole("complementary", { name: "Context" });
const toggle = (page: Page) => page.getByRole("button", { name: "Context panel" });

test("an investigation's sections are under the top bar", async ({ page }) => {
  await primePreferences(page, HUD);
  await seed(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/lab?e=eng1&view=overview");
  await waitForAppReady(page);

  // One navigation bar. The views left the surface for
  // the sections row, and there is no side rail. Spec 2026-10-07: six
  // sections; Scope opens from the strip.
  const views = page
    .locator(".subnav")
    .getByRole("navigation", { name: "Home Lab — Internal Range: investigation sections" });
  await expect(views.getByRole("button")).toHaveCount(6);
  await expect(
    page.locator("main").getByRole("navigation", { name: /investigation sections/ }),
  ).toHaveCount(0);
  await expect(page.locator("nav.rail")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { level: 1, name: "Home Lab — Internal Range" }),
  ).toBeVisible();
  await page.screenshot({ path: "e2e/screenshots/s8-lab-1440.png" });

  await views.getByRole("button", { name: "Evidence" }).click();
  await expect(page).toHaveURL(/view=evidence/);
  await expect(page.getByText("No evidence recorded yet")).toBeVisible();
});

test("an out-of-scope target shows the blocked bar with the way out", async ({ page }) => {
  await primePreferences(page, HUD);
  await seed(page, true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/lab?e=eng1&view=evidence");
  await waitForAppReady(page);

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Runs are blocked.");
  await page.screenshot({ path: "e2e/screenshots/s8-lab-empty-1440.png" });
  await alert.getByRole("button", { name: "Open scope" }).click();
  await expect(page).toHaveURL(/view=scope/);
});

test("Ctrl+B opens the panel beside the surface on a wide window", async ({ page }) => {
  await primePreferences(page, HUD);
  await seed(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/lab?e=eng1&view=runs");
  await waitForAppReady(page);
  // The screenshots below need the Runs view drawn, not its loading skeleton.
  await expect(page.getByText("Running tools requires the desktop app")).toBeVisible();

  await expect(panel(page)).toHaveCount(0);
  await page.keyboard.press("Control+b");
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toHaveAttribute("data-mode", "push");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");

  // It takes layout space: the surface ends where the panel begins.
  const main = await page.locator("main#main").boundingBox();
  const aside = await panel(page).boundingBox();
  expect(Math.round(main!.x + main!.width)).toBeLessThanOrEqual(Math.round(aside!.x) + 1);
  expect(Math.round(aside!.width)).toBe(360);

  await panel(page).getByRole("tab", { name: "Runs output" }).click();
  await expect(panel(page).getByText("No run selected")).toBeVisible();
  await page.screenshot({ path: "e2e/screenshots/s8-context-panel-1440.png" });

  await panel(page).getByRole("tab", { name: "Repo" }).click();
  await expect(panel(page).getByText("Lab: views as a segmented control")).toBeVisible();
  await page.screenshot({ path: "e2e/screenshots/s8-context-panel-repo-1440.png" });

  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
});

test("at 1100 px the panel overlays the surface and a click outside closes it", async ({
  page,
}) => {
  await primePreferences(page, HUD);
  await seed(page);
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto("/#/terminal");
  await waitForAppReady(page);

  const before = await page.locator("main#main").boundingBox();
  await toggle(page).click();
  await expect(panel(page)).toHaveAttribute("data-mode", "overlay");
  await panel(page).getByRole("tab", { name: "Project" }).click();
  await expect(panel(page).getByRole("combobox", { name: "Active project" })).toHaveValue("ws1");
  // The surface keeps its width under the overlay.
  expect((await page.locator("main#main").boundingBox())!.width).toBe(before!.width);
  await page.screenshot({ path: "e2e/screenshots/s8-context-panel-narrow-1100.png" });

  await page.mouse.click(100, 450);
  await expect(panel(page)).toHaveCount(0);

  await toggle(page).click();
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  await expect(toggle(page)).toBeFocused();
});

/* As an overlay the panel covers the surface, so Tab and
   Shift+Tab may only land in the panel or the top bar and its sections row
   above it, never on a control hidden behind it. A modal from a segment and
   Escape still hand focus back to their openers. */
for (const width of [1100, 900]) {
  test(`at ${width} px the keyboard never reaches what the overlay covers`, async ({ page }) => {
    await primePreferences(page, HUD);
    await seed(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#/lab?e=eng1&view=overview");
    await waitForAppReady(page);

    await toggle(page).click();
    await expect(panel(page)).toHaveAttribute("data-mode", "overlay");

    const where = () =>
      page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return "body";
        if (el.closest("aside.ctx")) return "panel";
        if (el.closest("header.topbar")) return "topbar";
        if (el.closest(".subnav")) return "sections";
        return `covered:${el.tagName.toLowerCase()}.${el.className}`;
      });

    for (const segment of ["Project", "Files", "Repo", "Runs output"]) {
      await panel(page).getByRole("tab", { name: segment }).click();
      const seen = new Set<string>();
      for (const key of ["Tab", "Shift+Tab"]) {
        for (let i = 0; i < 30; i += 1) {
          await page.keyboard.press(key);
          const at = await where();
          expect(at, `${segment}, ${key} #${i + 1}`).not.toMatch(/^covered:/);
          seen.add(at);
        }
      }
      expect(seen.has("panel"), segment).toBe(true);
    }

    // A modal opened from a segment returns focus to its opener, panel open.
    await panel(page).getByRole("tab", { name: "Project" }).click();
    const start = panel(page).getByRole("button", { name: "Start session" });
    await start.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(panel(page)).toBeVisible();
    await expect(start).toBeFocused();

    // Escape closes the overlay; focus goes back to the toggle that opened it.
    await page.keyboard.press("Escape");
    await expect(panel(page)).toHaveCount(0);
    await expect(toggle(page)).toBeFocused();
    await page.keyboard.press("Tab");
    expect(await where()).not.toBe("body");
  });
}
