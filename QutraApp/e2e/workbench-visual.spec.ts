import { expect, test, type Page } from "@playwright/test";

/**
 * Visual QA for the workbench shell + Security Laboratory IA.
 * Seeds a demo engagement (scope, targets, findings, evidence) directly into
 * the document store, then screenshots each required surface in both themes at
 * the required viewports. Native tool execution is honestly unavailable in the
 * browser; these shots verify layout, density, theming and Turkish text.
 */

const T = 1_700_000_000_000;

function seed(
  page: Page,
  theme: "light" | "dark",
  locale = "en",
) {
  return page.addInitScript(
    ({ theme, locale, T }) => {
      const K = "contextos.v1.";
      const set = (name: string, rows: unknown[]) =>
        localStorage.setItem(K + name, JSON.stringify(rows));
      localStorage.setItem(
        K + "preferences",
        JSON.stringify({
          locale,
          theme,
          onboardingDone: true,
          privateToolsEnabled: true,
          workbenchMode: "core",
        }),
      );
      set("engagements", [
        {
          id: "eng1",
          title: "Home Lab — Internal Review",
          purpose: "training_lab",
          status: "active",
          clientLabel: "",
          contacts: [],
          notes: "",
          tags: [],
          scopeId: "sc1",
          demo: false,
          createdAt: T,
          updatedAt: T,
        },
      ]);
      set("authorizationScopes", [
        {
          id: "sc1",
          engagementId: "eng1",
          ownerLabel: "self",
          description: "",
          allowedTargets: ["scanme.example.org"],
          excludedTargets: [],
          authorizationRef: "AUTH-2026-01",
          testerAck: true,
          revision: 2,
          notes: "",
          demo: false,
          createdAt: T,
          updatedAt: T,
        },
      ]);
      set("targets", [
        { id: "t1", engagementId: "eng1", raw: "127.0.0.1", normalized: "127.0.0.1", kind: "ip", scopeState: "in_scope", notes: "", demo: false, createdAt: T, updatedAt: T },
        { id: "t2", engagementId: "eng1", raw: "192.168.1.10", normalized: "192.168.1.10", kind: "ip", scopeState: "in_scope", notes: "", demo: false, createdAt: T, updatedAt: T },
        { id: "t3", engagementId: "eng1", raw: "scanme.example.org", normalized: "scanme.example.org", kind: "hostname", scopeState: "in_scope", notes: "", demo: false, createdAt: T, updatedAt: T },
      ]);
      const f = (id: string, title: string, severity: string, status: string, evidenceIds: string[], sourceTool: string) => ({
        id, engagementId: "eng1", title, description: "Observed during authorized review.", severity, confidence: "medium", status,
        affectedTargets: ["192.168.1.10"], affectedAssets: [], sourceTool, ruleId: "", location: "", fingerprint: "fp-" + id,
        firstSeen: T, lastSeen: T, cvssVector: "", cvssVersion: "", cwe: [], cve: [], attack: [], reproduction: "", impact: "",
        remediation: severity === "high" ? "Restrict access and patch." : "", references: [], evidenceIds, assignee: "",
        tags: [], falsePositiveReason: "", importBatchId: "", parserVersion: "", history: [{ at: T, to: status, note: "" }], demo: false, createdAt: T, updatedAt: T,
      });
      set("findings", [
        f("fд1".replace("д", "1"), "Exposed admin panel without auth", "critical", "confirmed", ["ev1"], "nmap"),
        f("f2", "TLS certificate expired", "high", "new", [], "nmap"),
        f("f3", "Directory listing enabled", "medium", "new", [], "nikto"),
        f("f4", "Verbose server banner", "low", "confirmed", ["ev2"], "nmap"),
        f("f5", "Informational: HTTP methods", "info", "false_positive", [], "nikto"),
      ]);
      set("evidence", [
        { id: "ev1", findingId: "f1", engagementId: "eng1", kind: "output", title: "nmap -sV 192.168.1.10 (stdout)", content: "PORT   STATE SERVICE VERSION\n80/tcp open  http    nginx 1.24.0\n8080/tcp open  http-proxy admin", path: "", sha256: "", capturedAt: T, source: "run:run-demo (stdout)", sensitivity: "normal", includeInReport: true, demo: false, createdAt: T },
        { id: "ev2", findingId: "f4", engagementId: "eng1", kind: "text", title: "Banner observation", content: "Server: nginx/1.24.0", path: "", sha256: "", capturedAt: T, source: "manual", sensitivity: "normal", includeInReport: true, demo: false, createdAt: T },
      ]);
    },
    { theme, locale, T },
  );
}

const DIR = "e2e/screenshots";

async function shot(page: Page, name: string) {
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: false });
}

for (const theme of ["dark", "light"] as const) {
  test(`workbench + lab — ${theme} 1440x900`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seed(page, theme);

    await page.goto("/#/overview");
    await page.locator("main").waitFor();
    await shot(page, `${theme}-overview-workbench`);

    await page.goto("/#/lab?e=eng1&view=overview");
    await page.locator(".lab-head").waitFor();
    await shot(page, `${theme}-lab-overview`);

    await page.goto("/#/lab?e=eng1&view=runs");
    await page.locator(".lab-head").waitFor();
    await shot(page, `${theme}-lab-runs`);

    await page.goto("/#/lab?e=eng1&view=findings");
    await page.locator("table.lab-table").first().waitFor();
    await page.locator("table.lab-table tbody tr").first().click();
    await page.locator(".lab-record").waitFor();
    await shot(page, `${theme}-lab-findings-detail`);

    // Each evidence row says where it came from, on its own line,
    // and the row's title keeps its width.
    await page.locator(".lab-record").getByRole("tab", { name: "Evidence" }).click();
    const evidenceTitle = page.locator(".lab-evidence-row .truncate").first();
    await expect(page.locator(".lab-origin__line").first()).toHaveText(/^Scan output · /);
    expect((await evidenceTitle.boundingBox())?.width ?? 0).toBeGreaterThan(80);
    await shot(page, `${theme}-lab-finding-evidence`);

    await page.goto("/#/tools?view=registered&e=eng1");
    await page.getByTestId("tools-investigation").waitFor();
    await shot(page, `${theme}-lab-tools`);

    await page.goto("/#/lab?e=eng1&view=scope");
    await page.locator(".lab-head").waitFor();
    await shot(page, `${theme}-lab-scope`);
  });
}

test("narrow regression — 1280x720 and 900x700", async ({ page }) => {
  await seed(page, "dark");
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/#/lab?e=eng1&view=findings");
  await page.locator("table.lab-table").first().waitFor();
  await shot(page, "dark-lab-findings-1280x720");

  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto("/#/lab?e=eng1&view=overview");
  await page.locator(".lab-head").waitFor();
  await shot(page, "dark-lab-overview-900x700");
});

test("Turkish lab overview", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await seed(page, "light", "tr");
  await page.goto("/#/lab?e=eng1&view=overview");
  await page.locator(".lab-head").waitFor();
  await shot(page, "tr-lab-overview");
});
