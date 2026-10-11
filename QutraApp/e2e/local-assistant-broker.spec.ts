import { expect, test } from "@playwright/test";
import { isOutsideApp, openSettings, primePreferences, requireBaseURL } from "./helpers";

/* ============================================================
   Qutra in a browser build — and why there is no streaming test here.

   This file replaces a suite that stood up a fake Ollama on 11435 and drove the
   whole chat surface through it. That test is gone because the code path it
   exercised is gone: every request goes through the Rust broker, so the
   renderer has no HTTP client for the lab and the CSP no longer grants it one.

   Deleting it was better than keeping it. It only passed while the port
   happened to be occupied (it skipped); the moment the port was free it would
   have failed — a broken test hiding behind a skip, which reads as coverage
   while proving nothing.

   Playwright runs the web build, which has no Tauri runtime, so browser e2e
   *cannot* exercise the broker at all. That boundary is covered instead by:

     - `src/lib/localAssistant/client.test.ts` — the IPC adapter against a
       mocked invoke/listen (token assembly, cancel, timeout, busy).
     - `cargo test` in `src-tauri/src/assistant/**` — endpoint pinning,
       deadlines, single-flight, cancellation, audit shape.
     - Manual verification against the real lab (see ADR 0010).

   What this file still proves is real: with no broker present, Qutra says so
   instead of pretending — and reaches for nothing on the way.
   ============================================================ */

test.describe("qutra without a native broker", () => {
  test("reports that the desktop app is required, and asks for nothing", async ({
    page,
    baseURL,
  }) => {
    const origin = requireBaseURL(baseURL);
    const requests: string[] = [];
    page.on("request", (r) => {
      if (isOutsideApp(r.url(), origin)) requests.push(r.url());
    });

    await primePreferences(page, { locale: "en", localAssistantEnabled: true });
    await page.goto("/#/overview");
    await openSettings(page, "ai");
    await page.getByRole("button", { name: /Test connection|Retry/ }).click();

    await expect(page.getByTestId("local-assistant-status")).toHaveText(
      "Desktop app required",
      { timeout: 15_000 },
    );
    await expect(page.getByText(/browser version can't reach it/i)).toBeVisible();

    // The honest part: it did not quietly try the endpoint first.
    expect(
      requests,
      `a browser build must reach nothing:\n${requests.join("\n")}`,
    ).toEqual([]);
  });

  test("chat refuses instead of fabricating an answer", async ({ page, baseURL }) => {
    const origin = requireBaseURL(baseURL);
    const requests: string[] = [];
    page.on("request", (r) => {
      if (isOutsideApp(r.url(), origin)) requests.push(r.url());
    });

    await primePreferences(page, { locale: "en", localAssistantEnabled: true });
    await page.goto("/#/jarvis");

    const chat = page.getByTestId("local-assistant-chat");
    // The enabled view keeps its readiness panel while not ready
    // (security review #2), so a browser build says up front that it cannot answer here.
    await expect(chat.getByTestId("readiness-browser")).toBeVisible();

    await page.getByLabel("Message to Qutra").fill("are you there?");
    await page.getByRole("button", { name: "Send" }).click();

    // The question is kept — a refusal must not eat what the user typed.
    await expect(chat).toContainText("are you there?");
    // And the failure is surfaced rather than left as a spinner.
    //
    // A browser build fails with `unavailable`, not `offline`: there is no
    // broker here at all. It used to be told to go start the isolated Ollama
    // server, which is misdirection -- starting it would change nothing. The
    // assistant error map now answers each code on its own terms, so this
    // asserts the honest one. Scoped to the turn's alert: the panel above
    // carries the same sentence, and must not stand in for the refusal.
    await expect(chat.getByRole("alert").filter({ hasText: /browser version can't reach it/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/start-isolated-ollama\.ps1/)).toHaveCount(0);

    expect(requests).toEqual([]);
  });
});
