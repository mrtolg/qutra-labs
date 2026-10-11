import { expect, test } from "@playwright/test";
import { isOutsideApp, openSettings, primePreferences, requireBaseURL } from "./helpers";

/* ============================================================
   Local Assistant Lab (ADR 0010 / §3.14).

   The unit tests prove the client never calls its injected fetch while
   disabled. These prove the same thing one level up, where it actually
   matters: no request leaves the running page. Playwright's request event sees
   every attempt the browser makes, including ones a mocked fetch would hide.
   ============================================================ */

test.describe("local assistant lab", () => {
  test("is off by default and makes no request at all", async ({ page, baseURL }) => {
    const origin = requireBaseURL(baseURL);
    const requests: string[] = [];
    page.on("request", (r) => {
      if (isOutsideApp(r.url(), origin)) requests.push(r.url());
    });

    await primePreferences(page, { locale: "en" });

    // Visit both surfaces that could plausibly probe the endpoint.
    await page.goto("/#/overview");
    await openSettings(page, "ai");
    await expect(page.getByTestId("local-assistant-settings")).toBeVisible();
    await expect(page.getByTestId("local-assistant-status")).toHaveText("Off");
    // The cloud connections sit under it; the browser build has no
    // Credential Manager and says so instead of offering key fields.
    await expect(page.getByText("Cloud connections", { exact: true })).toBeVisible();
    await expect(page.getByText("Cloud connections work in the desktop app.")).toBeVisible();

    await page.goto("/#/jarvis");
    await expect(page.getByTestId("local-assistant-off")).toBeVisible();

    // Merely opening Settings must not probe either — the health check is
    // explicitly opt-in, not on-mount.
    expect(requests, `unexpected outbound requests:\n${requests.join("\n")}`).toEqual([]);
  });

  /* The stopped-server case and the 11434 sweep live in
     `local-assistant-live.spec.ts`, which owns the endpoint's lifecycle. Asserting
     "nothing is listening" here raced that suite: with files running in parallel,
     the result depended on worker scheduling rather than on the app. */

  /* The configurable endpoint is gone, so these no longer
     assert "a bad URL is rejected" — they assert the stronger property that
     replaced it: there is no URL to get wrong. A stored value left over from an
     older profile is ignored rather than obeyed. */

  test("ignores an Ollama address stored by an older version", async ({
    page,
    baseURL,
  }) => {
    const origin = requireBaseURL(baseURL);
    const requests: string[] = [];
    page.on("request", (r) => {
      if (isOutsideApp(r.url(), origin)) requests.push(r.url());
    });

    await primePreferences(page, {
      locale: "en",
      localAssistantEnabled: true,
      ollamaBaseUrl: "http://127.0.0.1:11434",
    });
    await page.goto("/#/overview");
    await openSettings(page, "ai");
    await page.getByText("Advanced settings").click();

    // ADR 0016: Rust starts Qutra's own engine on a free port of its own
    // choosing. The renderer never shows an address Rust did not report, so
    // an Ollama address left in the profile is neither shown nor read.
    const endpointRow = page.getByTestId("local-assistant-endpoint");
    await expect(endpointRow).toContainText("None yet");
    await expect(endpointRow).not.toContainText("11434");
    await expect(endpointRow).not.toContainText("11435");
    await expect(page.getByTestId("local-assistant-endpoint-stale")).toHaveCount(0);

    await page.getByRole("button", { name: /Test connection|Retry/ }).click();
    await expect(page.getByTestId("local-assistant-status")).not.toHaveText(
      "Not checked yet",
      { timeout: 15_000 },
    );

    // Browser mode: the renderer still cannot reach either Ollama port.
    for (const url of requests) {
      expect(url, "the renderer must not talk to Ollama").not.toMatch(/11434|11435/);
    }
  });

  test("ignores a stored off-loopback endpoint", async ({ page, baseURL }) => {
    const origin = requireBaseURL(baseURL);
    const requests: string[] = [];
    page.on("request", (r) => {
      if (isOutsideApp(r.url(), origin)) requests.push(r.url());
    });

    await primePreferences(page, {
      locale: "en",
      localAssistantEnabled: true,
      ollamaBaseUrl: "http://example.com",
    });
    await page.goto("/#/overview");
    await openSettings(page, "ai");
    await page.getByRole("button", { name: /Test connection|Retry/ }).click();

    await expect(page.getByTestId("local-assistant-status")).not.toHaveText(
      "Not checked yet",
      { timeout: 15_000 },
    );
    expect(requests.filter((u) => u.includes("example.com"))).toEqual([]);
  });

  test("offers no free-form endpoint field at all", async ({ page }) => {
    await primePreferences(page, { locale: "en", localAssistantEnabled: true });
    await page.goto("/#/overview");
    await openSettings(page, "ai");
    await page.getByText("Advanced settings").click();

    // A text input here previously accepted loopback ports the CSP would then
    // block, so the UI could save a setting that could never work.
    await expect(page.getByLabel("Address (this computer only)")).toHaveCount(0);
    await expect(page.getByTestId("local-assistant-endpoint")).toContainText("None yet");
  });

  test("chat history can be cleared while the assistant is off", async ({ page }) => {
    // Seeded in the pre-conversation shape: boot migration v14 moves it into
    // a conversation document before Settings counts it.
    await primePreferences(page, {
      locale: "en",
      localAssistantEnabled: false,
      localAssistantHistory: [
        { role: "user", content: "remembered question" },
        { role: "assistant", content: "remembered answer" },
      ],
    });
    await page.goto("/#/overview");
    await openSettings(page, "ai");

    // Turning the assistant off hides the chat but keeps the transcript, so the
    // clear control has to be reachable from here or it is unreachable at all.
    const clear = page.getByTestId("local-assistant-clear-history");
    await expect(clear).toBeEnabled();
    await clear.click();
    const confirm = page.getByRole("dialog", { name: "Clear every conversation?" });
    await confirm.getByRole("button", { name: "Clear conversation" }).click();

    await expect(clear).toBeDisabled();
    const stored = await page.evaluate(() => {
      const prefs = localStorage.getItem("contextos.v1.preferences");
      const conversations = localStorage.getItem("contextos.v1.conversations");
      return {
        legacy: prefs ? JSON.parse(prefs).localAssistantHistory : null,
        conversations: conversations ? JSON.parse(conversations) : null,
      };
    });
    expect(stored).toEqual({ legacy: undefined, conversations: [] });
  });
});

/* The enable switch must be a thing the user can actually click.

   It shipped as a zero-sized control: the CSS gives `.switch` its box through
   `.switch-track`, and the span was rendered without that class, so the label
   collapsed to 0×0 — invisible and unclickable in the real app. Every test
   missed it because they all set the preference directly and never touched the
   control. This one drives it the way a user does. */
test("the Jarvis enable switch is visible and toggles", async ({ page }) => {
  await primePreferences(page, { locale: "en", localAssistantEnabled: false });
  await page.goto("/#/overview");
  await openSettings(page, "permissions");

  const panel = page.getByTestId("permissions-ledger");
  await expect(panel).toBeVisible();
  const label = panel.locator("label.switch", {
    has: page.getByRole("checkbox", { name: "Jarvis on the local model" }),
  });
  const track = label.locator(".switch-track");

  await expect(track).toBeVisible();
  const box = await track.boundingBox();
  expect(box?.width ?? 0, "the switch must have a clickable box").toBeGreaterThan(10);
  expect(box?.height ?? 0).toBeGreaterThan(10);

  await label.click();
  await expect(label.locator('input[type="checkbox"]')).toBeChecked();
});
