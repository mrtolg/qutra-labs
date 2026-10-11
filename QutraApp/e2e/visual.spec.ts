import { expect, test } from "@playwright/test";
import { loadDemo, openSettings, primePreferences } from "./helpers";

const ROUTES = [
  ["overview", "/#/overview"],
  ["projects", "/#/workspaces"],
  ["files", "/#/files"],
  ["tools", "/#/tools"],
  ["security-lab", "/#/lab"],
  ["terminal", "/#/terminal"],
  ["github", "/#/github"],
  ["jarvis", "/#/jarvis"],
] as const;

test.describe("visual sweep", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`eight product routes and Settings render cleanly - ${theme}`, async ({ page }) => {
      const errors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      page.on("pageerror", (error) => errors.push(error.message));

      await primePreferences(page, { theme });
      await loadDemo(page);
      for (const [name, route] of ROUTES) {
        await page.goto(route);
        const main = page.locator("main");
        await expect(main).toBeVisible();
        await expect
          .poll(async () => (await main.innerText()).trim().length)
          .toBeGreaterThan(10);
        await page.screenshot({
          path: `e2e/screenshots/${theme}-${name}.png`,
          fullPage: false,
        });
      }
      // Settings is a window over the current surface, not a route.
      await page.goto("/#/overview");
      await openSettings(page, "appearance");
      await page.screenshot({
        path: `e2e/screenshots/${theme}-settings.png`,
        fullPage: false,
      });
      expect(errors, errors.join("\n")).toEqual([]);
    });
  }

  for (const [width, height] of [
    [1280, 720],
    [1024, 768],
    [800, 900],
  ] as const) {
    test(`overview and project remain usable at ${width}x${height}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await primePreferences(page);
      await loadDemo(page);
      await page.goto("/#/overview");
      await expect(page.locator("main")).toBeVisible();
      await page.screenshot({
        path: `e2e/screenshots/narrow-${width}x${height}-overview.png`,
      });
      await page.goto("/#/workspaces/ws_demo_desktop");
      await expect(
        page.getByRole("heading", { name: "Qutra Labs Desktop" }),
      ).toBeVisible();
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth + 1,
      );
      expect(overflow).toBe(false);
      await page.screenshot({
        path: `e2e/screenshots/narrow-${width}x${height}-project.png`,
      });
    });
  }
});
