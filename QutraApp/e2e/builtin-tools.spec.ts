import { expect, test, type Page } from "@playwright/test";
import { waitForAppReady } from "./helpers";

/* The app's own built-in tools. The
   browser harness has no Rust side, so each panel answers from canned
   results through the dev-only fixture seam (src/lib/builtinTools.ts) —
   the same shapes Rust returns, built from the recorded fixtures under
   src-tauri/src/builtin_tools/fixtures. These shots check layout, Turkish
   copy and states; the work itself is tested in Rust. */

const T = Date.parse("2026-10-10T12:00:00Z");
const DIR = "e2e/screenshots";

const CERT = (cn: string, issuer: string, from: string, to: string, extra: Record<string, unknown> = {}) => ({
  subject: `O=Example Corp, CN=${cn}`,
  subjectCn: cn,
  issuer: `C=US, O=Example Trust, CN=${issuer}`,
  issuerCn: issuer,
  serial: "04A1F3C29B7E",
  notBefore: from,
  notAfter: to,
  notBeforeMs: Date.parse(from),
  notAfterMs: Date.parse(to),
  san: [],
  signature: "ECDSA with SHA-384",
  key: "EC P-256",
  keyBits: 256,
  isCa: false,
  selfSigned: false,
  sha256: "5f2c8e7d0a41b39c6e2d7f18a0c4b5e9d3f6a2b8c1e7d4f09a3b6c8e2d5f7a1c",
  unreadable: false,
  ...extra,
});

const FIXTURES = {
  builtin_metadata_pick: {
    name: "IMG_20260912_141503.jpg",
    bytes: 3_482_114,
    modifiedMs: T - 86_400_000 * 28,
    kind: "jpeg",
    sha256: "9b1f3e4c7a2d5b8e0f6c1a3d9e7b2c4f8a0d6e3b1c5f7a9d2e4b6c8f0a1d3e5b",
    observations: [
      { id: "identify:0", key: "identify.kind", value: "jpeg", group: "summary" },
      { id: "image:1", key: "image.camera", value: "Apple iPhone 15 Pro", group: "summary" },
      { id: "image:2", key: "image.taken", value: "2026:09:12 14:15:03", group: "summary" },
      { id: "image:3", key: "image.software", value: "17.6.1", group: "summary" },
      { id: "image:4", key: "image.gps", value: "41.008238, 28.978359", group: "interesting", hint: "gpsLocation" },
      { id: "image:5", key: "image.owner", value: "Ayşe Yılmaz", group: "interesting", hint: "identifying" },
    ],
    tags: ["Make: Apple", "Model: iPhone 15 Pro", "Software: 17.6.1", "DateTimeOriginal: 2026:09:12 14:15:03", "Artist: Ayşe Yılmaz", "GPSLatitude: 41/1 0/1 29.66/1"],
    fields: [
      { source: "xmp", key: "xmp:CreatorTool", value: "Adobe Lightroom 9.4 (Windows)" },
      { source: "xmp", key: "xmp:ModifyDate", value: "2026-09-13T09:41:22+03:00" },
      { source: "xmp", key: "dc:creator", value: "Ayşe Yılmaz" },
      { source: "xmp", key: "xmpMM:DocumentID", value: "xmp.did:7f1e2c9a-41b3-4d0e-9a6f-3c2b1e8d7a40" },
    ],
    flags: [],
    gps: { lat: 41.008238, lon: 28.978359 },
    limited: false,
  },
  builtin_connections: {
    supported: true,
    takenAt: T,
    connections: [
      { protocol: "tcp", family: 4, localAddress: "0.0.0.0", localPort: 135, remoteAddress: "", remotePort: 0, state: "listen", pid: 1188, process: "svchost.exe" },
      { protocol: "tcp", family: 4, localAddress: "0.0.0.0", localPort: 445, remoteAddress: "", remotePort: 0, state: "listen", pid: 4, process: "System" },
      { protocol: "tcp", family: 4, localAddress: "127.0.0.1", localPort: 5432, remoteAddress: "", remotePort: 0, state: "listen", pid: 6120, process: "postgres.exe" },
      { protocol: "tcp", family: 4, localAddress: "0.0.0.0", localPort: 8080, remoteAddress: "", remotePort: 0, state: "listen", pid: 9412, process: "node.exe" },
      { protocol: "tcp", family: 6, localAddress: "::", localPort: 3389, remoteAddress: "", remotePort: 0, state: "listen", pid: 1376, process: "svchost.exe" },
      { protocol: "udp", family: 4, localAddress: "0.0.0.0", localPort: 5353, remoteAddress: "", remotePort: 0, state: "bound", pid: 2280, process: "chrome.exe" },
      { protocol: "tcp", family: 4, localAddress: "192.168.1.24", localPort: 51544, remoteAddress: "140.82.112.25", remotePort: 443, state: "established", pid: 2280, process: "chrome.exe" },
      { protocol: "tcp", family: 4, localAddress: "192.168.1.24", localPort: 51602, remoteAddress: "20.42.65.92", remotePort: 443, state: "established", pid: 3964, process: "OneDrive.exe" },
      { protocol: "tcp", family: 4, localAddress: "127.0.0.1", localPort: 51710, remoteAddress: "127.0.0.1", remotePort: 5432, state: "established", pid: 9412, process: "node.exe" },
      { protocol: "tcp", family: 4, localAddress: "192.168.1.24", localPort: 51488, remoteAddress: "151.101.1.69", remotePort: 443, state: "time_wait", pid: 0, process: "System Idle Process" },
    ],
  },
  builtin_rdap: {
    kind: "ip",
    query: "8.8.8.8",
    servers: ["rdap.org", "rdap.arin.net"],
    handle: "NET-8-8-8-0-2",
    name: "GOGL",
    status: ["active"],
    events: [
      { action: "last changed", date: "2023-12-28T17:24:56-05:00" },
      { action: "registration", date: "2023-12-28T17:24:33-05:00" },
    ],
    entities: [
      { handle: "GOGL", roles: ["registrant"], name: "Google LLC", kind: "org", emails: [], country: "" },
      { handle: "ABUSE5250-ARIN", roles: ["abuse"], name: "Abuse", kind: "group", emails: ["network-abuse@google.com"], country: "" },
      { handle: "ZG39-ARIN", roles: ["technical", "administrative"], name: "Google LLC", kind: "group", emails: ["arin-contact@google.com"], country: "" },
    ],
    range: "8.8.8.0 – 8.8.8.255",
    cidrs: ["8.8.8.0/24"],
    networkType: "DIRECT ALLOCATION",
    country: "",
    parent: "NET-8-0-0-0-2",
    asnRange: "",
    nameservers: [],
    dnssec: null,
    port43: "whois.arin.net",
    remarks: [],
  },
  builtin_tls: {
    host: "app.example.com",
    port: 443,
    address: "93.184.215.14",
    protocol: "TLS 1.3",
    cipher: "TLS13_AES_256_GCM_SHA384",
    alpn: "h2",
    trusted: true,
    trustError: null,
    nameMatches: true,
    protocols: [
      { version: "TLS 1.3", supported: true, cipher: "TLS13_AES_256_GCM_SHA384" },
      { version: "TLS 1.2", supported: true, cipher: "TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384" },
    ],
    chain: [
      CERT("app.example.com", "Example Trust ECC CA 2026", "2026-08-01T00:00:00Z", "2026-10-30T23:59:59Z", {
        san: ["app.example.com", "www.example.com", "example.com", "api.example.com"],
      }),
      CERT("Example Trust ECC CA 2026", "Example Trust Root G2", "2024-03-01T00:00:00Z", "2031-03-01T00:00:00Z", {
        subject: "C=US, O=Example Trust, CN=Example Trust ECC CA 2026",
        isCa: true,
        signature: "SHA-384 with RSA",
        sha256: "c3d1a9f04e72b6158d2e9a3c7f01b4e6a8d5c2f9e3b7a1d0c6f4e8b2a5d9c7f3",
      }),
    ],
    daysLeft: 20,
    warnings: ["expires_soon"],
    checkedAt: T,
  },
  builtin_http: {
    requested: "http://app.example.com/",
    finalUrl: "https://app.example.com/login",
    status: 200,
    hops: [
      { url: "http://app.example.com/", status: 301, location: "https://app.example.com/" },
      { url: "https://app.example.com/", status: 302, location: "/login" },
      { url: "https://app.example.com/login", status: 200, location: null },
    ],
    stopped: null,
    headers: [
      ["server", "nginx/1.24.0"],
      ["x-powered-by", "PHP/8.1.2"],
      ["strict-transport-security", "max-age=86400"],
      ["content-security-policy", "default-src 'self'; script-src 'self' 'unsafe-inline' https:"],
      ["access-control-allow-origin", "https://cors-check.invalid"],
      ["access-control-allow-credentials", "true"],
      ["set-cookie", "PHPSESSID=…; path=/; HttpOnly"],
      ["set-cookie", "__Host-csrf=…; Path=/; Secure; HttpOnly; SameSite=Strict"],
      ["x-content-type-options", "nosniff"],
    ],
    checks: [
      { id: "https", level: "pass", value: null, notes: [] },
      { id: "hsts", level: "warn", value: "max-age=86400", notes: ["shortMaxAge"] },
      { id: "csp", level: "fail", value: "default-src 'self'; script-src 'self' 'unsafe-inline' https:", notes: ["unsafeInline", "wideSources", "noBaseUri", "noFrameAncestors"] },
      { id: "frame", level: "warn", value: null, notes: ["missing"] },
      { id: "nosniff", level: "pass", value: "nosniff", notes: [] },
      { id: "referrer", level: "info", value: null, notes: ["missingDefault"] },
      { id: "permissions", level: "info", value: null, notes: ["missing"] },
      { id: "coop", level: "info", value: null, notes: ["missing"] },
      { id: "coep", level: "info", value: null, notes: ["missing"] },
      { id: "corp", level: "info", value: null, notes: ["missing"] },
      { id: "cors", level: "fail", value: "https://cors-check.invalid", notes: ["reflectsOrigin", "withCredentials"] },
      { id: "cache", level: "warn", value: null, notes: ["missingWithCookies"] },
      { id: "server", level: "warn", value: "server: nginx/1.24.0 · x-powered-by: PHP/8.1.2", notes: ["versionDisclosed"] },
    ],
    cookies: [
      { name: "PHPSESSID", secure: false, httpOnly: true, sameSite: null, domain: null, path: "/", persistent: false, issues: ["noSecure", "noSameSite"] },
      { name: "__Host-csrf", secure: true, httpOnly: true, sameSite: "strict", domain: null, path: "/", persistent: false, issues: [] },
    ],
    cspDirectives: [
      ["default-src", "'self'"],
      ["script-src", "'self' 'unsafe-inline' https:"],
    ],
    counts: { pass: 2, warn: 4, fail: 2, info: 5 },
    checkedAt: T,
  },
  builtin_deps_pick: {
    token: "e2e-token",
    files: [
      { name: "package-lock.json", format: "package-lock", packages: 2, skipped: 0, error: null },
      { name: "requirements.txt", format: "requirements", packages: 1, skipped: 2, error: null },
    ],
    packages: [
      { ecosystem: "npm", name: "lodash", version: "4.17.15" },
      { ecosystem: "npm", name: "minimist", version: "1.2.5" },
      { ecosystem: "PyPI", name: "requests", version: "2.19.0" },
    ],
    ecosystems: { npm: 2, PyPI: 1 },
  },
  builtin_deps_check: {
    checked: 3,
    findings: [
      { package: { ecosystem: "npm", name: "lodash", version: "4.17.15" }, ids: ["GHSA-35jh-r3h4-6jhm", "GHSA-p6mc-m468-83gw"] },
      { package: { ecosystem: "npm", name: "minimist", version: "1.2.5" }, ids: ["GHSA-xvch-5gv4-984h"] },
      { package: { ecosystem: "PyPI", name: "requests", version: "2.19.0" }, ids: ["PYSEC-2018-28"] },
    ],
    advisories: [
      { id: "GHSA-35jh-r3h4-6jhm", aliases: ["CVE-2021-23337"], summary: "Command Injection in lodash", severity: "high", cvss: "CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H", score: 7.2, published: "2021-05-06T16:05:51Z", fixed: { lodash: ["4.17.21"] }, url: "https://github.com/advisories/GHSA-35jh-r3h4-6jhm" },
      { id: "GHSA-p6mc-m468-83gw", aliases: ["CVE-2020-8203"], summary: "Prototype Pollution in lodash", severity: "high", cvss: null, score: null, published: "2020-07-15T19:15:48Z", fixed: { lodash: ["4.17.19"] }, url: "https://github.com/advisories/GHSA-p6mc-m468-83gw" },
      { id: "GHSA-xvch-5gv4-984h", aliases: ["CVE-2021-44906"], summary: "Prototype Pollution in minimist", severity: "critical", cvss: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", score: 9.8, published: "2022-03-18T00:01:09Z", fixed: { minimist: ["1.2.6"] }, url: "https://github.com/advisories/GHSA-xvch-5gv4-984h" },
      { id: "PYSEC-2018-28", aliases: ["CVE-2018-18074"], summary: "The Requests package before 2.20.0 for Python sends an HTTP Authorization header to an http URI upon receiving a same-hostname https-to-http redirect", severity: "", cvss: null, score: null, published: "2018-10-09T17:29:00Z", fixed: { requests: ["2.20.0"] }, url: "" },
    ],
    advisoriesCut: false,
    checkedAt: T,
  },
};

async function prime(page: Page) {
  await page.addInitScript(
    ({ T, fixtures }) => {
      const K = "contextos.v1.";
      localStorage.setItem(
        K + "preferences",
        JSON.stringify({ locale: "tr", theme: "system", packId: "hud", themeMode: "dark", material: "none", onboardingDone: true, privateToolsEnabled: true }),
      );
      localStorage.setItem(
        K + "engagements",
        JSON.stringify([
          { id: "eng1", title: "Example Corp dış yüzey", purpose: "other", kind: "web", status: "active", clientLabel: "", contacts: [], notes: "", tags: [], scopeId: "sc1", demo: false, createdAt: T, updatedAt: T },
        ]),
      );
      localStorage.setItem(
        K + "authorizationScopes",
        JSON.stringify([
          { id: "sc1", engagementId: "eng1", ownerLabel: "Example Corp", description: "", allowedTargets: ["example.com", "8.8.8.8"], excludedTargets: [], authorizationRef: "SOW-2026-14", testerAck: true, revision: 2, notes: "", demo: false, createdAt: T, updatedAt: T },
        ]),
      );
      (window as unknown as { __QUTRA_BUILTIN_FIXTURES__: unknown }).__QUTRA_BUILTIN_FIXTURES__ = fixtures;
    },
    { T, fixtures: FIXTURES },
  );
}

/** A built-in tool's tile in the toolbox (Araç kutusu). */
function tile(page: Page, name: string) {
  return page.getByTestId("builtin-tool").filter({ hasText: name });
}

/** Open one built-in tool on the toolbox's bench, the way the page offers
    it (its tile), and return the bench and the tool's panel on it. */
async function openTool(page: Page, name: string) {
  const button = tile(page, name);
  await button.scrollIntoViewIfNeeded();
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  const row = page.getByTestId("builtin-bench");
  await expect(row).toHaveAccessibleName(name);
  const panel = row.locator(".bt-tool");
  await panel.waitFor();
  return { row, panel };
}

/** The whole bench at 1280 px wide (the narrowest width text must fit
    at), in a window tall enough to hold it: the page scrolls inside its own
    container, which an element screenshot cannot reach past. */
async function shot(page: Page, row: ReturnType<Page["locator"]>, name: string) {
  await page.setViewportSize({ width: 1280, height: 2600 });
  await row.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await row.screenshot({ path: `${DIR}/${name}.png` });
}

test.describe("built-in tools (tr, dark)", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await prime(page);
    await page.goto("/#/tools");
    await waitForAppReady(page);
  });

  test("no tool is listed as planned", async ({ page }) => {
    await expect(page.getByText("Planlandı", { exact: true })).toHaveCount(0);
    await expect(page.getByText("(planlandı)")).toHaveCount(0);
    for (const name of ["Üst veri inceleyici", "Klavye olayı görüntüleyici", "Bağlantı ve PID izleyici", "IP / RDAP / ASN sorgusu", "TLS sertifika inceleyici", "HTTP güvenlik çözümleyici", "Bağımlılık ve CVE merkezi"]) {
      await expect(tile(page, name)).toHaveCount(1);
    }
  });

  test("metadata inspector reads a photo's location and XMP", async ({ page }) => {
    const { row, panel } = await openTool(page, "Üst veri inceleyici");
    await panel.getByRole("button", { name: "Dosya seç…" }).click();
    await expect(panel.getByText("41.008238, 28.978359")).toBeVisible();
    await expect(panel.getByText("Adobe Lightroom 9.4 (Windows)")).toBeVisible();
    await shot(page, row, "builtin-metadata-tr");
  });

  test("keyboard viewer shows a combination without running it", async ({ page }) => {
    const { row, panel } = await openTool(page, "Klavye olayı görüntüleyici");
    const well = panel.getByTestId("key-well");
    await well.click();
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyK");
    await expect(panel.getByTestId("key-cap")).toHaveText("k");
    await expect(well.getByText("Ctrl", { exact: true })).toHaveClass(/is-on/);
    await shot(page, row, "builtin-keyboard-tr");
    await page.keyboard.up("Control");
    // The app's own Ctrl+K palette did not open.
    await expect(page.locator("dialog.palette")).toHaveCount(0);
  });

  test("connection monitor lists ports with their programs", async ({ page }) => {
    const { row, panel } = await openTool(page, "Bağlantı ve PID izleyici");
    await expect(panel.getByText("postgres.exe")).toBeVisible();
    await shot(page, row, "builtin-connections-tr");
    await panel.getByLabel("Bağlantılarda ara").fill("node");
    await expect(panel.locator("tbody tr")).toHaveCount(2);
  });

  test("RDAP lookup under the investigation's scope", async ({ page }) => {
    const { row, panel } = await openTool(page, "IP / RDAP / ASN sorgusu");
    await panel.getByLabel("IP adresi, alan adı veya AS numarası").fill("8.8.8.8");
    await expect(panel.getByTestId("scope-verdict")).toHaveText(/kapsam içinde/);
    await panel.getByRole("button", { name: "Sorgula" }).click();
    await expect(panel.getByRole("heading", { name: "Google LLC" })).toBeVisible();
    await shot(page, row, "builtin-rdap-tr");
  });

  test("RDAP refuses a target outside the scope", async ({ page }) => {
    const { row, panel } = await openTool(page, "IP / RDAP / ASN sorgusu");
    await panel.getByLabel("IP adresi, alan adı veya AS numarası").fill("1.1.1.1");
    await expect(panel.getByTestId("scope-verdict")).toHaveText(/kapsam dışı/);
    await panel.getByRole("button", { name: "Sorgula" }).click();
    await expect(panel.getByRole("alert")).toContainText("kapsamı dışında");
    await shot(page, row, "builtin-rdap-blocked-tr");
  });

  test("TLS inspector draws the chain with validity bars", async ({ page }) => {
    const { row, panel } = await openTool(page, "TLS sertifika inceleyici");
    await panel.getByLabel("Sunucu ve bağlantı noktası").fill("app.example.com");
    await panel.getByRole("button", { name: "İncele" }).click();
    await expect(panel.getByText("Güvenilir zincir, ad eşleşiyor")).toBeVisible();
    await expect(panel.getByText("20 gün kaldı")).toBeVisible();
    await shot(page, row, "builtin-tls-tr");
  });

  test("HTTP analyzer scores the headers", async ({ page }) => {
    const { row, panel } = await openTool(page, "HTTP güvenlik çözümleyici");
    await panel.getByLabel("Adres (URL)").fill("http://app.example.com/");
    await panel.getByRole("button", { name: "Çözümle" }).click();
    await expect(panel.getByText("'unsafe-inline' sayfaya eklenen betiklerin çalışmasına izin verir.", { exact: false })).toBeVisible();
    await shot(page, row, "builtin-http-tr");
  });

  test("dependency center shows what goes out, then the ledger", async ({ page }) => {
    const { row, panel } = await openTool(page, "Bağımlılık ve CVE merkezi");
    await shot(page, row, "builtin-deps-empty-tr");
    await panel.getByRole("button", { name: "Bildirim dosyalarını seç…" }).click();
    await expect(panel.getByText("3 paket adı ve sürümü api.osv.dev'e gider", { exact: false })).toBeVisible();
    await panel.getByRole("button", { name: "3 paketi OSV.dev'de denetle" }).click();
    await expect(panel.getByText("Prototype Pollution in minimist")).toBeVisible();
    await shot(page, row, "builtin-deps-tr");
  });
});
