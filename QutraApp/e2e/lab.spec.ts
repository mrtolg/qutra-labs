import { test, expect } from "@playwright/test";
import { NEW_ENGAGEMENT, newEngagement, primePreferences } from "./helpers";

/**
 * Security Laboratory (workbench IA): authorization scope enforcement is
 * visible and honest across the mode-driven views. A public target is out of
 * scope until explicitly allowed; loopback is local; exclusions/ack are
 * respected. Findings import and the native-execution boundary are exercised
 * through the real UI.
 */
test.describe("security laboratory", () => {
  test("live scope evaluation gates targets", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(e.message));

    await primePreferences(page, { locale: "en", privateToolsEnabled: true });
    await page.goto("/#/lab");
    await newEngagement(page);

    // Targets are their own section; the scope opens from the strip above it.
    const targets = () => page.getByRole("button", { name: "Targets and files", exact: true }).click();
    const scope = () => page.getByTestId("lab-scope-strip").click();
    await targets();

    const live = page.getByTestId("lab-live-decision");
    const addInput = page.getByLabel("Add target", { exact: true });

    // A fresh scope is unacknowledged: a public target is blocked accordingly.
    await addInput.fill("scanme.example.org");
    await expect(live).toContainText("Blocked · not acknowledged");

    // Loopback is a local target — allowed without an explicit entry.
    await addInput.fill("127.0.0.1");
    await expect(live).toContainText("Allowed · local");

    // Acknowledge; the public target is now out of scope until allowed.
    await scope();
    await page.getByRole("checkbox").check();
    await targets();
    await addInput.fill("scanme.example.org");
    await expect(live).toContainText("Blocked · out of scope");

    // Authorize the public target explicitly.
    await scope();
    await page.getByLabel("Allowed targets").fill("scanme.example.org");
    await page.getByLabel("Allowed targets").blur();

    await targets();
    await addInput.fill("scanme.example.org");
    await expect(live).toContainText("Allowed · in scope");
    await page.getByRole("button", { name: "Add target" }).click();

    // The saved target shows an allowed badge.
    const targetRow = page.locator(".lab-target").filter({ hasText: "scanme.example.org" });
    await expect(targetRow.getByText("Allowed · in scope")).toBeVisible();

    // The scope strip over every section reflects a validated scope.
    await expect(page.locator(".lab-scope-badge")).toContainText("Scope validated");

    await page.screenshot({ path: "e2e/screenshots/en-lab-scope.png" });
    expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  });

  test("imports SARIF output into normalized findings", async ({ page }) => {
    await primePreferences(page, { locale: "en", privateToolsEnabled: true });
    await page.goto("/#/lab");
    await newEngagement(page);
    // The overview's "Open Findings" link also matches a non-exact name.
    await page.getByRole("button", { name: "Findings", exact: true }).click();

    const sarif = JSON.stringify({
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "semgrep", rules: [{ id: "sqli", name: "SQL Injection", defaultConfiguration: { level: "error" } }] } },
          results: [
            {
              ruleId: "sqli",
              message: { text: "tainted" },
              locations: [{ physicalLocation: { artifactLocation: { uri: "db.ts" }, region: { startLine: 5 } } }],
            },
          ],
        },
      ],
    });

    // The Lab's sections row has an "Import scan output" button too; this is the field.
    await page.getByRole("textbox", { name: "Import scan output" }).fill(sarif);
    await page.getByRole("button", { name: "Preview" }).click();
    await expect(page.getByTestId("lab-parsed-count")).toContainText("1 findings parsed");
    await page.getByRole("button", { name: "Commit import" }).click();

    const list = page.getByTestId("lab-findings");
    await expect(list.getByText("SQL Injection")).toBeVisible();
    await expect(list.getByText("High", { exact: true })).toBeVisible();
    await expect(page.getByTestId("lab-import-msg")).toContainText("1 new");

    await page.screenshot({ path: "e2e/screenshots/en-lab-findings.png" });
  });

  test("tool library is honest in browser mode", async ({ page }) => {
    await primePreferences(page, { locale: "en", privateToolsEnabled: true });
    await page.goto("/#/lab");
    await newEngagement(page);
    // Registered tools live in the Tools area now (spec 2026-10-07 §5.1).
    await page.goto("/#/tools?view=registered");

    const unavailable = page.getByTestId("native-tools-unavailable");
    await expect(unavailable).toContainText(
      "Running tools requires the desktop app",
    );
    await expect(unavailable).toContainText("never pretends a run succeeded");
    // "Launch" is the single button that routes to a live process (gui
    // detached / interactive terminal / batch supervised, see
    // ToolLabPanel.launch()) — it must not exist behind the native boundary.
    await expect(page.getByRole("button", { name: "Launch" })).toHaveCount(0);

    // The boundary must not be a dead end. All three ways forward are offered,
    // and the offline one is a real navigation rather than advice.
    await expect(unavailable).toContainText("Offline utilities work here");
    await expect(unavailable).toContainText("Running tools needs the desktop app");
    await expect(unavailable).toContainText("Start with the sample program");

    // The fixture CTA must name the file that actually exists in the repo.
    await expect(unavailable).toContainText("src-tauri/fixtures/contextos_fixture.rs");
    await expect(unavailable).not.toContainText("Qutra");

    await page.screenshot({ path: "e2e/screenshots/en-lab-native-boundary.png" });

    await unavailable.getByRole("link", { name: "Open offline Tools" }).click();
    await expect(page).toHaveURL(/#\/tools$/);
  });

  test("Runs view shows the same native boundary as Tools", async ({ page }) => {
    await primePreferences(page, { locale: "en", privateToolsEnabled: true });
    await page.goto("/#/lab");
    await newEngagement(page);
    await page.getByRole("button", { name: "Runs", exact: true }).click();

    // Runs used to render its own smaller dead end for the identical condition.
    const unavailable = page.getByTestId("native-tools-unavailable");
    await expect(unavailable).toContainText("Offline utilities work here");
    await expect(unavailable).toContainText("Start with the sample program");
    await expect(unavailable).toContainText("src-tauri/fixtures/contextos_fixture.rs");
  });

  /* Regression (ADR 0007). The Lab tools view was reachable by direct URL
     while the Private Lab opt-in was off, because the gate had only been wired
     into Tools, Terminal and the Bottom Panel. Deep link, refresh and restored
     tab are all the same entry, so all three are asserted. */
  test("tools view refuses a deep link when Private Lab is off", async ({ page }) => {
    await primePreferences(page, { locale: "en", privateToolsEnabled: false });

    // An engagement is what the tools view renders into, and a returning user
    // has one from a previous session. Creating it here reproduces the real
    // deep-link case rather than an empty-lab case that would pass trivially.
    await page.goto("/#/lab");
    await newEngagement(page);

    // The old Lab address still works: it redirects to Tools › Registered tools.
    await page.goto("/#/lab?view=tools");
    await expect(page).toHaveURL(/#\/tools\?view=registered/);

    const gate = page.getByTestId("native-tools-consent-required");
    await expect(gate).toBeVisible();
    // The opt-in must be offered, not merely the door shut.
    await expect(gate.getByRole("button", { name: "Enable Private Lab" })).toBeVisible();

    // No part of the tool surface may render without consent.
    await expect(page.getByTestId("native-tools-unavailable")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add tool" })).toHaveCount(0);
    // "Launch" is the single button that routes to a live process (gui
    // detached / interactive terminal / batch supervised, see
    // ToolLabPanel.launch()) — it must not exist behind the consent gate.
    await expect(page.getByRole("button", { name: "Launch" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Emergency stop" })).toHaveCount(0);

    // A reload of the same deep link must not drift open.
    await page.reload();
    await expect(page.getByTestId("native-tools-consent-required")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add tool" })).toHaveCount(0);

    await page.screenshot({ path: "e2e/screenshots/en-lab-consent-gate.png" });
  });

  test("Enable in the browser does not fake a native Private Lab grant", async ({
    page,
  }) => {
    await primePreferences(page, { locale: "en", privateToolsEnabled: false });
    await page.goto("/#/lab");
    await newEngagement(page);
    await page.goto("/#/lab?view=tools");

    const gate = page.getByTestId("native-tools-consent-required");
    await expect(gate.getByTestId("private-lab-native-status")).toBeVisible();

    await gate.getByRole("button", { name: "Enable Private Lab" }).click();

    await expect(page.getByTestId("private-lab-grant-status")).toBeVisible();
    await expect(page.getByTestId("native-tools-consent-required")).toBeVisible();
    await expect(page.getByTestId("native-tools-unavailable")).toHaveCount(0);

    const stored = await page.evaluate(() => {
      const raw = localStorage.getItem("contextos.v1.preferences");
      return raw ? JSON.parse(raw).privateToolsEnabled : null;
    });
    expect(stored).toBe(false);
  });

  test("Private Lab exposes safe tool guides and useful workbench actions", async ({ page }) => {
    await primePreferences(page, { locale: "en", privateToolsEnabled: true });
    await page.goto("/#/lab");
    await newEngagement(page);
    // The guides are Tools sections now; the sub-bar picks them.
    await page.goto("/#/tools?view=catalog");

    await expect(page.getByRole("heading", { level: 2, name: "Catalog" })).toBeVisible();
    await page.getByLabel("Search tools, purposes or telemetry...").fill("Nmap");
    await page.getByRole("button", { name: "Open usage guide: Nmap" }).click();
    await expect(page.getByRole("heading", { name: "Nmap" })).toBeVisible();
    await expect(
      page.getByText("nmap -sV --version-light <authorized-lab-target>"),
    ).toBeVisible();
    await page.getByRole("button", { name: "Add acquisition task" }).click();

    await page.getByLabel("Search tools, purposes or telemetry...").fill("sqlmap");
    await page.getByRole("button", { name: "Open usage guide: sqlmap" }).click();
    await expect(
      page.getByText(/No executable example is provided/),
    ).toBeVisible();
    await page.screenshot({
      path: "e2e/screenshots/en-private-lab-tool-guide.png",
    });

    await page.getByRole("button", { name: "Playbooks", exact: true }).click();
    await expect(page.getByText("Owned repository audit")).toBeVisible();
    await expect(page.getByText("Offline binary triage")).toBeVisible();

    await page.getByRole("button", { name: "Datasets", exact: true }).click();
    // The sub-bar is the only tab row: the guides have no tabs of their own.
    await expect(page.getByRole("tablist")).toHaveCount(0);

    const stored = await page.evaluate(() => {
      const raw = localStorage.getItem("contextos.v1.tasks");
      return raw ? JSON.parse(raw) : [];
    });
    expect(stored).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tags: expect.arrayContaining(["private-lab", "tool-acquisition"]),
        }),
      ]),
    );
  });

  test("Private Lab remains usable in a narrow workbench", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await primePreferences(page, { locale: "tr", privateToolsEnabled: true });
    await page.goto("/#/lab");
    await newEngagement(page, "Ev laboratuvarı", NEW_ENGAGEMENT.tr);
    await page.goto("/#/tools?view=catalog");

    await expect(
      page.getByRole("heading", { level: 2, name: "Katalog" }),
    ).toBeVisible();
    await page.getByLabel("Araç, amaç ya da kanıt türü ara…").fill("Ghidra");
    await page
      .getByRole("button", { name: "Kılavuzu aç: Ghidra" })
      .click();
    await expect(page.getByText("ghidra <prepared-fixture-binary>")).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    await page.screenshot({
      path: "e2e/screenshots/tr-private-lab-narrow.png",
    });
  });

  test("Turkish laboratory renders approved terms", async ({ page }) => {
    await primePreferences(page, { locale: "tr", privateToolsEnabled: true });
    await page.goto("/#/lab");
    await newEngagement(page, "Ev laboratuvarı", NEW_ENGAGEMENT.tr);
    await page.getByRole("button", { name: "Hedefler ve dosyalar", exact: true }).click();
    const addInput = page.getByLabel("Hedef ekle", { exact: true });
    await addInput.fill("8.8.8.8");
    await expect(page.getByTestId("lab-live-decision")).toContainText("Engellendi · yetki beyanı yok");
    await page.screenshot({ path: "e2e/screenshots/tr-lab-scope.png" });
  });
});
