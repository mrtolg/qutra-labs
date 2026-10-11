import { chromium, type FullConfig } from "@playwright/test";

/**
 * Load the app once before the suite so the first *test* does not pay for
 * Vite's cold compile.
 *
 * `webServer.url` only waits for the dev server to answer a request. It does
 * not wait for Vite to have compiled the module graph — that happens on the
 * first real page load, which without this lands inside whichever test runs
 * first, inside its 45s budget. Measured cold start is ~15s, so on an idle
 * machine it fits and on a loaded one it does not: the suite would fail with a
 * `locator.click` timeout in a test that has nothing wrong with it, and the
 * failure would move between tests as file order changed. That cost a real
 * misdiagnosis once — a flake was reported as a regression — so this removes
 * the cause rather than raising a timeout or adding a retry, either of which
 * would have hidden a genuine slowdown just as effectively.
 */
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use?.baseURL;
  if (!baseURL) {
    throw new Error("Playwright baseURL is unset");
  }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(baseURL, { waitUntil: "load", timeout: 120_000 });
    // The hash router mounts lazily; touch a real route so the route chunk is
    // compiled too, not just the shell.
    await page.goto(`${baseURL}/#/overview`, { waitUntil: "load", timeout: 120_000 });
  } finally {
    await browser.close();
  }
}
