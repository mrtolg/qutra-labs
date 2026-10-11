import { expect, test, type Page } from "@playwright/test";
import { waitForAppReady } from "./helpers";
import { seedLivedIn as seed } from "./seedLivedIn";

/**
 * Screens of the redesigned pages: Home, the
 * Investigations list and header, Terminal and the top bar, in Turkish on the
 * dark HUD theme, at 1280 px (text must fit) and 1920 px (still readable).
 * Records are seeded straight into the document store so the shots show a
 * lived-in app; nothing here invents data the app would not have.
 *
 * DESIGN_SHOT=before writes the "before" set; the default is "after".
 */

const DIR = "e2e/screenshots/design-pages";
const SET = process.env.DESIGN_SHOT === "before" ? "before" : "after";

async function shot(page: Page, name: string) {
  // Let entrance motion settle; the shots compare layouts, not frames.
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${DIR}/${SET}-${name}.png`, fullPage: false });
}

async function noSideScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflow).toBe(false);
}

for (const [width, height] of [
  [1280, 800],
  [1920, 1080],
] as const) {
  test(`design pages at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await seed(page);

    await page.goto("/#/overview");
    await waitForAppReady(page);
    await noSideScroll(page);
    await shot(page, `home-${width}`);

    await page.goto("/#/lab?e=e-web&view=overview");
    await page.locator(".lab-head").waitFor();
    await noSideScroll(page);
    await shot(page, `lab-header-${width}`);

    await page.goto("/#/lab?list=1");
    await page.locator(".lab-list").waitFor();
    await noSideScroll(page);
    await shot(page, `lab-list-${width}`);

    await page.goto("/#/lab?switch=1");
    await page.locator(".lab-switch__panel").waitFor();
    await shot(page, `lab-switch-${width}`);

    await page.goto("/#/terminal");
    await page.locator("main").waitFor();
    await noSideScroll(page);
    await shot(page, `terminal-${width}`);
  });
}

test("design pages, first run with nothing saved", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await seed(page, { empty: true });
  await page.goto("/#/overview");
  await waitForAppReady(page);
  await shot(page, "home-empty-1280");

  await page.goto("/#/lab");
  await page.locator("main").waitFor();
  await shot(page, "lab-empty-1280");
});
