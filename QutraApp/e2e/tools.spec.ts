import { test, expect } from "@playwright/test";
import { primePreferences, waitForAppReady } from "./helpers";

/* The tool launcher (Araç kutusu). The browser build can run no program, so
   every row must still offer a way forward (its download page) and its
   guide. */

test.describe("tool launcher", () => {
  test.beforeEach(async ({ page }) => {
    await primePreferences(page, { locale: "en", privateToolsEnabled: true });
    await page.goto("/#/tools");
    await waitForAppReady(page);
  });

  test("every program offers a way forward and its guide", async ({ page }) => {
    const tiles = page.getByTestId("tool-tile");
    await expect(tiles).toHaveCount(35);
    await expect(page.getByTestId("launcher-browser-notice")).toBeVisible();
    const count = await tiles.count();
    for (let i = 0; i < count; i++) {
      await expect(tiles.nth(i).getByRole("button", { name: "Download page" })).toHaveCount(1);
      await expect(tiles.nth(i).getByRole("button", { name: "Guide" })).toHaveCount(1);
    }
    const zap = page.getByRole("listitem", { name: "OWASP ZAP" });
    await expect(zap.getByText("Passive by default; local/authorized apps only.")).toBeVisible();
    await page.screenshot({ path: "e2e/screenshots/en-tool-launcher.png" });
  });

  test("a category chip and the filter narrow the grid", async ({ page }) => {
    await page.getByRole("button", { name: "Reverse engineering" }).click();
    await expect(page.getByRole("button", { name: "Reverse engineering" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId("tool-tile")).toHaveCount(7);

    await page.getByRole("button", { name: "All · 35" }).click();
    await page.getByLabel("Filter tools").fill("sqlmap");
    await expect(page.getByTestId("tool-tile")).toHaveCount(1);
    await expect(page.getByRole("listitem", { name: "sqlmap" })).toBeVisible();
  });
});
