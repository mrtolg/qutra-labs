import { test, expect } from "@playwright/test";
import { primePreferences } from "./helpers";

/**
 * Real interactive terminal (PTY-backed in the native runtime). The browser
 * build has no PTY, so it must show an honest "native runtime required"
 * surface — never a fake or simulated shell.
 *
 * Native-only note: the "Stop all" control (`terminal-kill-all`) only
 * renders when `controller.available()` is true, which never happens in
 * this Playwright browser-mode suite. It is exercised manually in
 * `npm run tauri dev` and is out of scope for these e2e specs.
 */
test.describe("terminal", () => {
  test("shows honest native-required state in browser mode", async ({ page }) => {
    await primePreferences(page);
    await page.goto("/#/terminal");
    // Browser build never renders an xterm canvas.
    await expect(page.getByTestId("terminal-native-required")).toBeVisible();
    await expect(page.locator(".xterm")).toHaveCount(0);
    // "Stop all" is native-only chrome; it must not appear in the honest
    // browser fallback state either.
    await expect(page.getByTestId("terminal-kill-all")).toHaveCount(0);
  });
});
