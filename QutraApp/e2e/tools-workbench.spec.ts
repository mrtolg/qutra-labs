import { expect, test, type Page } from "@playwright/test";

/**
 * Tools › Registered tools as a workbench. The browser
 * build has no native supervisor, so the page is handed a fake one through
 * the development-only `__QUTRA_E2E_TOOLS__` seam: a few registered programs
 * in each state, one finished Nmap run with real Nmap XML, a TShark run with
 * real CSV, and investigation files to pick. Screenshots go to
 * e2e/screenshots/tools-workbench-*.png.
 */

const T = 1_791_640_000_000;
const DIR = "e2e/screenshots";

const NMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<nmaprun scanner="nmap" version="7.99">
<host><status state="up"/><address addr="127.0.0.1" addrtype="ipv4"/><hostnames></hostnames>
<ports>
<port protocol="tcp" portid="135"><state state="open"/><service name="msrpc" product="Microsoft Windows RPC"/></port>
<port protocol="tcp" portid="445"><state state="open"/><service name="microsoft-ds"/></port>
<port protocol="tcp" portid="3389"><state state="open"/><service name="ms-wbt-server"/></port>
</ports></host>
<runstats><finished summary="Nmap done; 1 IP address (1 host up) scanned in 17.80 seconds"/></runstats>
</nmaprun>`;

const TSHARK_CSV = `frame.time_relative,ip.src,dns.qry.name
"0.000000000","192.168.56.10","example.test"
"1.000000000","192.168.56.10","qutra.test"
`;

function installation(
  id: string,
  displayName: string,
  file: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    displayName,
    runner: "executable",
    canonicalPath: `C:\\Tools\\${file}`,
    sha256: "f51fab8041e5023d7290b540a2106f051ef0bd2bc3443c9daf318628b560fa29",
    sizeBytes: 3_145_728,
    version: "",
    publisher: "",
    signatureState: "valid",
    category: "local",
    riskTier: "low",
    docUrl: "",
    tags: [],
    workingDir: "C:\\Tools",
    enabled: true,
    changedSinceVerify: false,
    createdAt: T,
    updatedAt: T,
    lastVerifiedAt: T,
    ...extra,
  };
}

function run(id: string, installationId: string, profileId: string, extra: Record<string, unknown>) {
  return {
    id,
    requestId: `form-${id}`,
    profileId,
    installationId,
    engagementId: "eng1",
    state: "succeeded",
    argv: [],
    commandPreview: "",
    startedAt: T + 1_000,
    endedAt: T + 18_800,
    exitCode: 0,
    terminationReason: "completed",
    workingDir: "C:\\Tools",
    artifactDir: "",
    stdoutTail: "",
    stderrTail: "",
    bytesOut: 1200,
    bytesErr: 0,
    truncated: false,
    blockedReason: "",
    artifacts: [],
    createdAt: T + 1_000,
    updatedAt: T + 18_800,
    ...extra,
  };
}

async function seed(page: Page, locale: "tr" | "en") {
  const tools = {
    installations: [
      installation("tool-nmap", "Nmap", "nmap.exe", {
        version: "7.99",
        publisher: "Insecure.Com LLC",
        category: "network",
        riskTier: "medium",
      }),
      installation("tool-tshark", "TShark", "tshark.exe", { version: "4.6.1", publisher: "Wireshark Foundation" }),
      installation("tool-sigcheck", "Sigcheck", "sigcheck64.exe", {
        version: "2.91",
        publisher: "Sysinternals",
        changedSinceVerify: true,
      }),
      installation("tool-pebear", "PE-bear", "PE-bear.exe", { signatureState: "unsigned" }),
      installation("tool-fixture", "ContextOS Fixture", "contextos-fixture.exe", {
        enabled: false,
        signatureState: "unsigned",
      }),
    ],
    runs: [
      run("run-nmap", "tool-nmap", "form-nmap-services", { bytesOut: NMAP_XML.length }),
      run("run-tshark", "tool-tshark", "form-tshark-dns", { bytesOut: TSHARK_CSV.length }),
    ],
    files: [
      {
        id: "file-pcap",
        engagementId: "eng1",
        relPath: "files/capture.pcap",
        name: "capture.pcap",
        originalName: "capture.pcap",
        bytes: 420,
        sha256: "a",
        sha1: "b",
        md5: "c",
        kind: "pcap",
        sample: false,
        source: "picked",
        addedAt: T,
        missing: false,
        readOnly: true,
      },
    ],
    outputs: { "run-nmap": NMAP_XML, "run-tshark": TSHARK_CSV } as Record<string, string>,
  };
  await page.addInitScript(
    ({ tools, locale, T }) => {
      const K = "contextos.v1.";
      const set = (name: string, rows: unknown[]) =>
        localStorage.setItem(K + name, JSON.stringify(rows));
      localStorage.setItem(
        K + "preferences",
        JSON.stringify({
          locale,
          theme: "dark",
          onboardingDone: true,
          privateToolsEnabled: true,
          workbenchMode: "core",
        }),
      );
      set("engagements", [
        {
          id: "eng1",
          title: "Ev ağı incelemesi",
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
          allowedTargets: ["127.0.0.1", "192.168.56.0/24"],
          excludedTargets: [],
          authorizationRef: "AUTH-1",
          testerAck: true,
          revision: 1,
          notes: "",
          demo: false,
          createdAt: T,
          updatedAt: T,
        },
      ]);
      set("targets", [
        { id: "t1", engagementId: "eng1", raw: "127.0.0.1", normalized: "127.0.0.1", kind: "ip", scopeState: "in_scope", notes: "", demo: false, createdAt: T, updatedAt: T },
      ]);
      const outputs = tools.outputs;
      (window as unknown as Record<string, unknown>).__QUTRA_E2E_TOOLS__ = {
        installations: tools.installations,
        runs: tools.runs,
        files: tools.files,
        output: (runId: string, name: string) => (name === "stdout.log" ? (outputs[runId] ?? "") : ""),
        setEnabled: (id: string, enabled: boolean) => {
          const found = tools.installations.find((item) => item.id === id)!;
          found.enabled = enabled;
          return found;
        },
        runForm: (request: { installationId: string; formId: string; presetId: string }) => {
          const started = {
            ...tools.runs[0],
            id: `run-${Date.now()}`,
            installationId: request.installationId,
            profileId: `form-${request.formId}-${request.presetId}`,
            state: "running",
            startedAt: Date.now(),
            createdAt: Date.now(),
            endedAt: undefined,
            exitCode: undefined,
          };
          tools.runs.unshift(started);
          return { run: started, outputName: null };
        },
      };
    },
    { tools, locale, T },
  );
}

async function openTool(page: Page, name: string) {
  await page.locator(".lab-tool-row", { hasText: name }).first().click();
  await page.locator(".wb-head h3", { hasText: name }).waitFor();
  await page.waitForTimeout(300);
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${DIR}/tools-workbench-${name}.png`, fullPage: true });
}

test.describe("tools workbench", () => {
  test("Turkish: a known tool, its state, its form and its result", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await seed(page, "tr");
    await page.goto("/#/tools?view=registered&e=eng1");
    await page.getByTestId("tools-investigation").waitFor();

    // The test program is listed apart from the investigation tools.
    await expect(page.locator(".wb-list-group__title")).toHaveCount(2);
    await expect(page.locator(".wb-list-group").last()).toContainText("ContextOS Fixture");

    await openTool(page, "Nmap");
    await expect(page.locator(".wb-purpose")).toContainText("açık olduğunu bulur");
    await expect(page.getByTestId("wb-status")).toContainText("Hazır");
    // The preset says what will happen with the user's own value in it.
    await page.getByRole("radio", { name: "Hızlı tarama" }).click();
    await page.getByLabel("Hedef").fill("127.0.0.1");
    await expect(page.locator(".wb-sentence__text")).toContainText("127.0.0.1");
    await expect(page.locator(".wb-sentence__cmd")).toContainText("nmap -n -sT -T4 -F --open -oX - 127.0.0.1");
    await expect(page.getByTestId("wb-scope-verdict")).toHaveClass(/is-ok/);
    // The last run's Nmap XML reads as a port table.
    await expect(page.locator(".wb-table")).toContainText("msrpc");
    await expect(page.locator(".wb-result__lead")).toContainText("3 açık port");
    await shot(page, "tr-nmap");
    await page.locator(".wb-result").scrollIntoViewIfNeeded();
    await shot(page, "tr-nmap-result");

    // A value that could pass for a flag is refused before the click.
    await page.getByLabel("Hedef").fill("-iL x");
    await page.getByLabel("Hedef").blur();
    await expect(page.locator(".wb-run-btn")).toBeDisabled();
    await expect(page.locator(".wb-field__note.is-error")).toBeVisible();

    await openTool(page, "TShark");
    await page.getByRole("radio", { name: "DNS sorguları" }).click();
    await expect(page.locator(".wb-sentence__text")).toContainText("TShark");
    await expect(page.locator(".wb-table")).toContainText("qutra.test");
    // The file is picked from the investigation by name; the sentence names it.
    await page.getByLabel("Dosya", { exact: true }).selectOption("file-pcap");
    await expect(page.locator(".wb-sentence__text")).toContainText("capture.pcap");
    await shot(page, "tr-tshark");
    await page.locator(".wb-result").scrollIntoViewIfNeeded();
    await shot(page, "tr-tshark-result");

    await openTool(page, "Sigcheck");
    await expect(page.getByTestId("wb-status")).toContainText("Dosya değişti");
    await expect(page.getByRole("button", { name: "Yeni dosyaya güven" })).toBeVisible();
    await expect(page.locator(".wb-note--warn, .wb-note").filter({ hasText: "-accepteula" })).toBeVisible();
    await shot(page, "tr-sigcheck-changed");

    await openTool(page, "ContextOS Fixture");
    await expect(page.locator(".wb-tag")).toHaveText("Test programı");
    await expect(page.locator(".wb-purpose")).toContainText("inceleme aracı değildir");
    await expect(page.getByTestId("wb-status")).toContainText("Devre dışı");
    await shot(page, "tr-fixture-disabled");
    // The one-click fix says what it does, and does it.
    await page.getByRole("button", { name: "Etkinleştir" }).click();
    await expect(page.getByTestId("wb-status")).toContainText("Hazır");

    await openTool(page, "PE-bear");
    await expect(page.locator(".wb-purpose")).toContainText("hazır bir form yok");
    await shot(page, "tr-unknown-tool");

    // Advanced settings hold the record and the hand-written command.
    await page.getByRole("button", { name: /Gelişmiş ayarlar/ }).click();
    await expect(page.getByText("SHA-256").first()).toBeVisible();
    await shot(page, "tr-unknown-advanced");
  });

  test("English at 1920 and a run that starts", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await seed(page, "en");
    await page.goto("/#/tools?view=registered&e=eng1");
    await page.getByTestId("tools-investigation").waitFor();
    await openTool(page, "Nmap");
    await page.getByRole("radio", { name: "Chosen ports" }).click();
    await page.getByLabel("Target").fill("127.0.0.1");
    await expect(page.locator(".wb-sentence__text")).toContainText("22,80,443,3389,8080");
    await shot(page, "en-nmap-ports");
    await page.locator(".wb-run-btn").click();
    await expect(page.locator(".wb-state")).toContainText(/Running/i);
    await shot(page, "en-nmap-running");
  });
});
