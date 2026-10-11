import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { ensureLocaleLoaded } from "@/lib/i18n";
import { ensureBuiltinLocale, translateBuiltin, type AnyKey } from "./i18n";
import { createEngagement } from "@/services/appService";
import type { HttpReport, OsvReport, PickedManifests, TlsReport } from "@/lib/builtinTools";
import BuiltinToolPanel from "./index";
import { matches } from "./ConnectionsTool";

/* The built-in tool panels against canned answers (the dev-only fixture
   seam the e2e harness uses too): what is sent, what is refused before
   anything is sent, and what the result shows. */

const tr = (key: string, params?: Record<string, string | number>) =>
  translateBuiltin("tr", key as AnyKey, params);

const calls: { command: string; args: Record<string, unknown> }[] = [];

function fixtures(answers: Record<string, unknown>) {
  const wrapped: Record<string, unknown> = {};
  for (const [command, answer] of Object.entries(answers)) {
    wrapped[command] = (args: Record<string, unknown>) => {
      calls.push({ command, args });
      return typeof answer === "function" ? (answer as (a: Record<string, unknown>) => unknown)(args) : answer;
    };
  }
  window.__QUTRA_BUILTIN_FIXTURES__ = wrapped as never;
}

function mount(panel: Parameters<typeof BuiltinToolPanel>[0]["panel"]) {
  return render(
    <MemoryRouter>
      <BuiltinToolPanel panel={panel} />
    </MemoryRouter>,
  );
}

const CERT = {
  subject: "O=Qutra Labs Test, CN=localhost",
  subjectCn: "localhost",
  issuer: "C=TR, O=Qutra Labs Test, CN=Qutra Labs Test Root",
  issuerCn: "Qutra Labs Test Root",
  serial: "7A3F",
  notBefore: "2026-10-10T13:15:31Z",
  notAfter: "2045-12-09T13:15:31Z",
  notBeforeMs: Date.parse("2026-10-10T13:15:31Z"),
  notAfterMs: Date.parse("2045-12-09T13:15:31Z"),
  san: ["localhost", "127.0.0.1"],
  signature: "SHA-256 with RSA",
  key: "EC P-256",
  keyBits: 256,
  isCa: false,
  selfSigned: false,
  sha256: "ab".repeat(32),
  unreadable: false,
};

const TLS: TlsReport = {
  host: "localhost",
  port: 8443,
  address: "127.0.0.1",
  protocol: "TLS 1.3",
  cipher: "TLS13_AES_256_GCM_SHA384",
  alpn: "http/1.1",
  trusted: false,
  trustError: "unknown_issuer",
  nameMatches: true,
  protocols: [
    { version: "TLS 1.3", supported: true, cipher: "TLS13_AES_256_GCM_SHA384" },
    { version: "TLS 1.2", supported: false, cipher: null },
  ],
  chain: [CERT],
  daysLeft: 6999,
  warnings: ["untrusted:unknown_issuer"],
  checkedAt: Date.parse("2026-10-10T14:00:00Z"),
};

beforeAll(async () => {
  await ensureLocaleLoaded("tr");
  await ensureBuiltinLocale("tr");
});

beforeEach(() => {
  calls.length = 0;
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set({ locale: "tr", privateToolsEnabled: true });
  setDbForTesting(db);
});

afterEach(() => {
  delete window.__QUTRA_BUILTIN_FIXTURES__;
  setDbForTesting(null);
});

describe("keyboard-event viewer", () => {
  it("shows key, code and the modifiers held, and keeps nothing anywhere", () => {
    mount("keyboard");
    const well = screen.getByTestId("key-well");
    fireEvent.focus(well);
    fireEvent.keyDown(well, { key: "s", code: "KeyS", ctrlKey: true });
    expect(screen.getByTestId("key-cap")).toHaveTextContent("s");
    expect(within(well).getByText("KeyS")).toBeInTheDocument();
    expect(within(well).getByText(tr("builtin.keys.mod.Control"))).toHaveClass("is-on");
    expect(within(well).getByText(tr("builtin.keys.mod.Shift"))).not.toHaveClass("is-on");
    fireEvent.keyUp(well, { key: "s", code: "KeyS" });
    expect(screen.getByText(tr("builtin.keys.count", { count: 2 }))).toBeInTheDocument();
    // A space reads as a word, not as nothing.
    fireEvent.keyDown(well, { key: " ", code: "Space" });
    expect(screen.getByTestId("key-cap")).toHaveTextContent(tr("builtin.keys.space"));
    // Nothing reached storage.
    expect(JSON.stringify(localStorage)).not.toContain("KeyS");
    expect(getDb().collection("evidence").getAll()).toHaveLength(0);
    // It cannot be saved as evidence, only copied or exported.
    expect(screen.queryByRole("button", { name: tr("builtin.actions.save") })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: tr("builtin.keys.clear") }));
    expect(screen.getByText(tr("builtin.keys.empty"))).toBeInTheDocument();
  });

  it("lets Tab move the focus away and holds every other key", () => {
    mount("keyboard");
    const well = screen.getByTestId("key-well");
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    well.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    const save = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      well.dispatchEvent(save);
    });
    expect(save.defaultPrevented).toBe(true);
  });
});

describe("TLS inspector", () => {
  it("refuses a public target outside every scope before anything is sent", () => {
    fixtures({ builtin_tls: TLS });
    mount("tls");
    fireEvent.change(screen.getByLabelText(tr("builtin.tls.target")), { target: { value: "example.com" } });
    expect(screen.getByTestId("scope-verdict")).toHaveTextContent(tr("lab.decision.no_scope"));
    fireEvent.click(screen.getByRole("button", { name: tr("builtin.tls.run") }));
    expect(screen.getByRole("alert")).toHaveTextContent(tr("builtin.error.scope_blocked"));
    expect(calls).toHaveLength(0);
  });

  it("sends a local target with its decision and reads the chain it gets back", async () => {
    fixtures({ builtin_tls: TLS });
    mount("tls");
    fireEvent.change(screen.getByLabelText(tr("builtin.tls.target")), { target: { value: "localhost:8443" } });
    fireEvent.click(screen.getByRole("button", { name: tr("builtin.tls.run") }));
    await screen.findByText(tr("builtin.tls.trust.unknown_issuer"));
    expect(calls[0].command).toBe("builtin_tls");
    expect(calls[0].args.target).toBe("localhost:8443");
    expect(calls[0].args.scope).toMatchObject({ allowed: true, reason: "allowed_local", target: "localhost:8443", scopeId: "" });
    expect(screen.getByText(tr("builtin.tls.role.leaf"))).toBeInTheDocument();
    expect(screen.getByText(tr("builtin.tls.daysLeftShort", { days: 6999 }))).toBeInTheDocument();
    expect(screen.getByText(tr("builtin.tls.oldNotTried"))).toBeInTheDocument();
  });

  it("runs a public target under the investigation whose scope lists it, and saves the result there", async () => {
    fixtures({ builtin_tls: { ...TLS, host: "app.example.com", port: 443 } });
    const id = createEngagement("Müşteri testi");
    const engagement = getDb().collection("engagements").get(id)!;
    const scope = getDb().collection("authorizationScopes").get(engagement.scopeId!)!;
    getDb().collection("authorizationScopes").put({ ...scope, allowedTargets: ["example.com"], testerAck: true });
    mount("tls");
    fireEvent.change(screen.getByLabelText(tr("builtin.tls.target")), { target: { value: "app.example.com" } });
    expect(screen.getByTestId("scope-verdict")).toHaveTextContent(tr("lab.decision.allowed_in_scope"));
    fireEvent.click(screen.getByRole("button", { name: tr("builtin.tls.run") }));
    await screen.findByText(tr("builtin.tls.trust.unknown_issuer"));
    expect(calls[0].args.scope).toMatchObject({ scopeId: scope.id, reason: "allowed_in_scope", allowed: true });

    fireEvent.click(screen.getByRole("button", { name: tr("builtin.actions.save") }));
    await waitFor(() => expect(getDb().collection("evidence").getAll()).toHaveLength(1));
    const [evidence] = getDb().collection("evidence").getAll();
    expect(evidence).toMatchObject({ engagementId: id, source: "builtin:tls", kind: "text", title: "TLS · app.example.com:443" });
    expect(evidence.content).toContain("TLS · app.example.com:443");
  });

  it("words a failure and lets the user stop a run", async () => {
    let release: (value: unknown) => void = () => undefined;
    fixtures({
      builtin_tls: () => new Promise((resolve) => (release = resolve)),
      builtin_cancel: true,
    });
    mount("tls");
    fireEvent.change(screen.getByLabelText(tr("builtin.tls.target")), { target: { value: "127.0.0.1" } });
    fireEvent.click(screen.getByRole("button", { name: tr("builtin.tls.run") }));
    fireEvent.click(await screen.findByRole("button", { name: tr("builtin.run.cancel") }));
    expect(screen.getByRole("alert")).toHaveTextContent(tr("builtin.error.cancelled"));
    expect(calls.map((c) => c.command)).toEqual(["builtin_tls", "builtin_cancel"]);
    // A late answer from the stopped run is dropped.
    await act(async () => release(TLS));
    expect(screen.queryByText(tr("builtin.tls.role.leaf"))).toBeNull();
  });
});

describe("HTTP security analyzer", () => {
  it("shows the scorecard, worded checks and cookies", async () => {
    const report: HttpReport = {
      requested: "http://localhost:8080/",
      finalUrl: "http://localhost:8080/",
      status: 200,
      hops: [{ url: "http://localhost:8080/", status: 200, location: null }],
      stopped: null,
      headers: [["server", "Apache/2.4.29"]],
      checks: [
        { id: "https", level: "fail", value: null, notes: ["plainHttp"] },
        { id: "csp", level: "warn", value: null, notes: ["missing"] },
        { id: "server", level: "warn", value: "server: Apache/2.4.29", notes: ["versionDisclosed"] },
        { id: "cors", level: "pass", value: null, notes: ["notShared"] },
      ],
      cookies: [{ name: "PHPSESSID", secure: false, httpOnly: false, sameSite: null, domain: null, path: "/", persistent: false, issues: ["noHttpOnly", "noSameSite"] }],
      cspDirectives: [],
      counts: { pass: 1, warn: 2, fail: 1, info: 0 },
      checkedAt: 1,
    };
    fixtures({ builtin_http: report });
    mount("http");
    fireEvent.change(screen.getByLabelText(tr("builtin.http.target")), { target: { value: "http://localhost:8080/" } });
    fireEvent.click(screen.getByRole("button", { name: tr("builtin.http.run") }));
    await screen.findByText(tr("builtin.http.note.plainHttp"));
    expect(screen.getByText(tr("builtin.http.note.versionDisclosed"))).toBeInTheDocument();
    expect(screen.getByText(`${tr("builtin.http.cookie.noHttpOnly")}, ${tr("builtin.http.cookie.noSameSite")}`)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: tr("builtin.http.scoreAria", { fail: 1, warn: 2, pass: 1 }) })).toBeInTheDocument();
  });
});

describe("dependency and CVE center", () => {
  it("shows what will be sent before sending, then the ledger", async () => {
    const picked: PickedManifests = {
      token: "tok-1",
      files: [{ name: "package-lock.json", format: "package-lock", packages: 2, skipped: 1, error: null }],
      packages: [
        { ecosystem: "npm", name: "lodash", version: "4.17.15" },
        { ecosystem: "npm", name: "left-pad", version: "1.3.0" },
      ],
      ecosystems: { npm: 2 },
    };
    const report: OsvReport = {
      checked: 2,
      findings: [{ package: picked.packages[0], ids: ["GHSA-35jh-r3h4-6jhm"] }],
      advisories: [
        {
          id: "GHSA-35jh-r3h4-6jhm",
          aliases: ["CVE-2021-23337"],
          summary: "Command Injection in lodash",
          severity: "high",
          cvss: "CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H",
          score: 7.2,
          published: "2021-05-06T16:05:51Z",
          fixed: { lodash: ["4.17.21"] },
          url: "https://github.com/advisories/GHSA-35jh-r3h4-6jhm",
        },
      ],
      advisoriesCut: false,
      checkedAt: 1,
    };
    fixtures({ builtin_deps_pick: picked, builtin_deps_check: report });
    mount("deps");
    expect(screen.getByText(tr("builtin.dest.local"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: tr("builtin.deps.pick") }));
    await screen.findByText(tr("builtin.deps.dest", { count: 2 }));
    expect(screen.getByText(tr("builtin.deps.skipped", { count: 1 }), { exact: false })).toBeInTheDocument();
    expect(calls.map((c) => c.command)).toEqual(["builtin_deps_pick"]);

    fireEvent.click(screen.getByRole("button", { name: tr("builtin.deps.run", { count: 2 }) }));
    await screen.findByText("Command Injection in lodash");
    expect(calls[1]).toMatchObject({ command: "builtin_deps_check", args: { token: "tok-1" } });
    expect(screen.getByText(tr("builtin.deps.fixedIn", { versions: "4.17.21" }), { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/CVE-2021-23337/)).toBeInTheDocument();
  });
});

describe("connection monitor filter", () => {
  const row = {
    protocol: "tcp" as const,
    family: 4 as const,
    localAddress: "0.0.0.0",
    localPort: 8080,
    remoteAddress: "",
    remotePort: 0,
    state: "listen",
    pid: 1234,
    process: "node.exe",
  };
  it("narrows by view, protocol and text", () => {
    expect(matches(row, "listening", "all", "")).toBe(true);
    expect(matches(row, "connected", "all", "")).toBe(false);
    expect(matches(row, "all", "udp", "")).toBe(false);
    expect(matches(row, "all", "all", "NODE")).toBe(true);
    expect(matches(row, "all", "all", "8080")).toBe(true);
    expect(matches(row, "all", "all", "chrome")).toBe(false);
  });

  it("reads the tables on open and lists rows with their program", async () => {
    fixtures({ builtin_connections: { connections: [row], takenAt: 1, supported: true } });
    mount("connections");
    await screen.findByText("node.exe");
    expect(screen.getByText(tr("builtin.conns.everyInterface"))).toBeInTheDocument();
  });
});

describe("browser build", () => {
  it("shows the form and says the tool runs in the desktop app", () => {
    mount("rdap");
    expect(screen.getByText(tr("builtin.desktopOnly"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: tr("builtin.rdap.run") })).toBeDisabled();
  });
});
