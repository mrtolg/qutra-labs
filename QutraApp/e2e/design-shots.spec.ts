import { expect, test, type Page } from "@playwright/test";
import { openSettings, waitForAppReady } from "./helpers";
import { seedLivedIn } from "./seedLivedIn";

/* Design review screenshots. The main surfaces of a
   lived-in app in a typical setup (HUD dark, Turkish) at 1280 and 1920 px,
   so a change to the shared tokens or a page can be judged as a before/after
   pair. It only runs when an output folder is named:
     $env:DESIGN_SHOTS='C:\...\shots'; $env:DESIGN_SHOTS_TAG='after'
     npx playwright test e2e/design-shots.spec.ts */

const OUT = process.env.DESIGN_SHOTS;
const TAG = process.env.DESIGN_SHOTS_TAG ?? "before";

test.skip(!OUT, "set DESIGN_SHOTS to an output folder");

async function settle(page: Page) {
  await waitForAppReady(page);
  const main = page.locator("main");
  await expect
    .poll(async () => (await main.innerText()).trim().length)
    .toBeGreaterThan(10);
  // Toasts from earlier steps would cover the same corner in every shot.
  const close = page.locator(".toast-region .toast .btn--icon");
  while ((await close.count()) > 0) await close.first().click();
  // Let entrance motion and the glide thumbs finish.
  await page.waitForTimeout(450);
}

for (const [width, height] of [
  [1280, 800],
  [1920, 1080],
] as const) {
  test(`main surfaces at ${width}px`, async ({ page }) => {
    test.setTimeout(180_000);
    const shot = (name: string) =>
      page.screenshot({ path: `${OUT}/${name}-${width}-${TAG}.png` });
    const visit = async (route: string, name: string) => {
      await page.goto(route);
      await settle(page);
      await shot(name);
    };

    await page.setViewportSize({ width, height });
    await seedLivedIn(page);

    await visit("/#/overview", "home");
    await visit("/#/lab?list=1", "investigations");
    await visit("/#/lab?e=e-web&view=overview", "investigation");
    await visit("/#/lab?e=e-web&view=findings", "findings");
    await visit("/#/terminal", "terminal");
    await visit("/#/tools?view=box", "toolbox");

    // One built-in tool open on the toolbox's bench.
    const builtin = page.getByTestId("builtin-tool").filter({ hasText: "Klavye olayı görüntüleyici" });
    await builtin.scrollIntoViewIfNeeded();
    await builtin.click();
    await page.getByTestId("builtin-bench").scrollIntoViewIfNeeded();
    await page.waitForTimeout(350);
    await shot("builtin");

    await visit("/#/tools?view=registered", "registered");
    await visit("/#/tools?view=catalog", "catalog");
    await visit("/#/tools?view=playbooks", "playbooks");
    await visit("/#/tools?view=datasets", "datasets");
    await visit("/#/jarvis", "jarvis");
    await page.getByRole("button", { name: "Qutra ayarları" }).click();
    await page.waitForTimeout(400);
    await shot("jarvis-settings");
    await page.keyboard.press("Escape");

    await page.goto("/#/overview");
    await settle(page);
    for (const section of ["appearance", "shortcuts", "privacy", "permissions", "ai", "languageRegion"]) {
      await openSettings(page, section);
      await page.waitForTimeout(350);
      await shot(`settings-${section}`);
    }
  });
}
