import { expect, test } from "@playwright/test";
import { isOutsideApp, loadDemo, primePreferences, requireBaseURL } from "./helpers";

/* ============================================================
   Read-only project context.

   What this can prove in a browser build: the user is shown exactly what will
   be attached, and can turn it off. What it cannot prove: what the broker
   sends, because the broker is native and Playwright runs the web build. The
   packing rules themselves are covered by `src/domain/assistantContext.test.ts`.
   ============================================================ */

test.describe("qutra read-only context", () => {
  test("shows what will be attached and reaches nothing to build it", async ({
    page,
    baseURL,
  }) => {
    const origin = requireBaseURL(baseURL);
    const requests: string[] = [];
    page.on("request", (r) => {
      if (isOutsideApp(r.url(), origin)) requests.push(r.url());
    });

    await primePreferences(page, { locale: "en", localAssistantEnabled: true });
    await loadDemo(page);
    await page.goto("/#/jarvis");

    const disclosure = page.getByTestId("qutra-context");
    await expect(disclosure).toContainText("Context attached");
    await disclosure.click();

    // The rows name the project the context is built from — metadata the app
    // already holds, not file contents.
    await expect(disclosure).toContainText("project:");
    await expect(disclosure).toContainText(
      "No file contents are read",
    );

    // Building context must not touch the network: it is assembled from local
    // records, and a browser build has no broker to ask anyway.
    expect(requests, `unexpected requests:\n${requests.join("\n")}`).toEqual([]);
  });

  test("can be turned off, and then says so", async ({ page }) => {
    await primePreferences(page, { locale: "en", localAssistantEnabled: true });
    await loadDemo(page);
    await page.goto("/#/jarvis");

    const disclosure = page.getByTestId("qutra-context");
    await disclosure.click();
    await page.getByTestId("qutra-context-toggle").uncheck();

    await expect(disclosure).toContainText("Context off");
    await expect(disclosure).not.toContainText("project:");

    // The choice persists rather than resetting on the next visit.
    const stored = await page.evaluate(() => {
      const raw = localStorage.getItem("contextos.v1.preferences");
      return raw ? JSON.parse(raw).assistantContextEnabled : null;
    });
    expect(stored).toBe(false);
  });

  test("is not attached when the assistant itself is off", async ({ page }) => {
    await primePreferences(page, { locale: "en", localAssistantEnabled: false });
    await loadDemo(page);
    await page.goto("/#/jarvis");

    // No assistant, no context surface: there is nothing to attach it to.
    await expect(page.getByTestId("qutra-context")).toHaveCount(0);
    await expect(page.getByTestId("local-assistant-off")).toBeVisible();
  });
});
