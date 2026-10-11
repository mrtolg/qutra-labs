import { describe, expect, it } from "vitest";
import { evaluateTarget, normalizeTarget, scopeReach, targetMatchesPattern } from "./scope";
import {
  assertTransition,
  canTransition,
  InvalidRunTransition,
  isTerminal,
  reconcileOnRestart,
} from "./runState";
import { buildCommand } from "./command";
import { collectionSchemas } from "../types";
import { AuthorizationScopeSchema, ToolProfileSchema } from "../lab";

/* ---------- scope / target normalization ---------- */

describe("normalizeTarget", () => {
  it("classifies loopback, private and public hosts", () => {
    expect(normalizeTarget("localhost").location).toBe("loopback");
    expect(normalizeTarget("127.0.0.1").location).toBe("loopback");
    expect(normalizeTarget("10.1.2.3").location).toBe("private");
    expect(normalizeTarget("192.168.1.10").location).toBe("private");
    expect(normalizeTarget("172.16.0.9").location).toBe("private");
    expect(normalizeTarget("8.8.8.8").location).toBe("public");
    expect(normalizeTarget("example.com").location).toBe("public");
  });

  it("classifies URLs, CIDRs and files", () => {
    const url = normalizeTarget("https://localhost:3000/app");
    expect(url.kind).toBe("url");
    expect(url.location).toBe("loopback");
    expect(url.host).toBe("localhost");

    const cidr = normalizeTarget("192.168.0.0/24");
    expect(cidr.kind).toBe("cidr");
    expect(cidr.location).toBe("private");

    const file = normalizeTarget("C:\\scans\\out.xml");
    expect(file.kind).toBe("file");
    expect(file.location).toBe("local");
  });

  it("calls a range private only when all of it is private", () => {
    // A short prefix reaches past the private block it starts in: 10.0.0.0/0
    // is the whole IPv4 space.
    expect(normalizeTarget("10.0.0.0/0").location).toBe("public");
    expect(normalizeTarget("10.0.0.0/7").location).toBe("public");
    expect(normalizeTarget("10.0.0.0/8").location).toBe("private");
    expect(normalizeTarget("172.16.0.0/11").location).toBe("public");
    expect(normalizeTarget("172.16.0.0/12").location).toBe("private");
    expect(normalizeTarget("192.168.0.0/15").location).toBe("public");
    expect(normalizeTarget("192.168.4.0/22").location).toBe("private");
    expect(normalizeTarget("169.254.0.0/16").location).toBe("private");
    expect(normalizeTarget("127.0.0.0/7").location).toBe("public");
    expect(normalizeTarget("127.0.0.0/8").location).toBe("loopback");
    expect(normalizeTarget("127.0.0.1/32").location).toBe("loopback");
    // Not a range at all.
    expect(normalizeTarget("10.0.0.0/33").location).toBe("unknown");
  });

  it("treats a path on another machine as that machine, not as a local file", () => {
    const unc = normalizeTarget("\\\\files.example.com\\share\\a.pcap");
    expect(unc.kind).toBe("file");
    expect(unc.location).toBe("public");
    expect(unc.host).toBe("files.example.com");
    expect(normalizeTarget("\\\\10.0.0.5\\share").location).toBe("private");
    expect(normalizeTarget("//8.8.8.8/share/x").location).toBe("public");
    expect(normalizeTarget("file://203.0.113.9/share/x").location).toBe("public");
    expect(normalizeTarget("\\\\localhost\\c$\\x").location).toBe("loopback");
    // These stay on this machine.
    expect(normalizeTarget("file:///C:/scans/out.xml").location).toBe("local");
    expect(normalizeTarget("file://localhost/C:/scans/out.xml").location).toBe("local");
    expect(normalizeTarget("\\\\?\\C:\\scans\\out.xml").location).toBe("local");
    expect(normalizeTarget("\\\\.\\pipe\\x").location).toBe("local");
    expect(normalizeTarget("/home/me/out.xml").location).toBe("local");
  });
});

describe("targetMatchesPattern", () => {
  it("matches exact, CIDR, bare-domain and wildcard patterns", () => {
    expect(targetMatchesPattern(normalizeTarget("203.0.113.5"), "203.0.113.0/24")).toBe(true);
    expect(targetMatchesPattern(normalizeTarget("203.0.114.5"), "203.0.113.0/24")).toBe(false);
    expect(targetMatchesPattern(normalizeTarget("app.example.com"), "example.com")).toBe(true);
    expect(targetMatchesPattern(normalizeTarget("example.com"), "example.com")).toBe(true);
    expect(targetMatchesPattern(normalizeTarget("api.example.com"), "*.example.com")).toBe(true);
    expect(targetMatchesPattern(normalizeTarget("evil.com"), "example.com")).toBe(false);
  });
});

const baseScope = () =>
  AuthorizationScopeSchema.parse({
    id: "sc1",
    engagementId: "e1",
    testerAck: true,
    allowedTargets: [],
    excludedTargets: [],
    createdAt: 0,
    updatedAt: 0,
  });

describe("evaluateTarget", () => {
  it("allows local targets without any scope but blocks public ones", () => {
    expect(evaluateTarget("127.0.0.1", undefined).allowed).toBe(true);
    expect(evaluateTarget("C:/x/y.pcap", undefined).reason).toBe("allowed_local");
    const pub = evaluateTarget("scanme.example.com", undefined);
    expect(pub.allowed).toBe(false);
    expect(pub.reason).toBe("no_scope");
  });

  it("permits a public target only with an explicit allow entry", () => {
    const scope = { ...baseScope(), allowedTargets: ["scanme.nmap.org"] };
    expect(evaluateTarget("scanme.nmap.org", scope).reason).toBe("allowed_in_scope");
    expect(evaluateTarget("other.public.com", scope).reason).toBe("out_of_scope");
  });

  it("lets exclusion win over allow", () => {
    const scope = {
      ...baseScope(),
      allowedTargets: ["10.0.0.0/8"],
      excludedTargets: ["10.0.0.5"],
    };
    expect(evaluateTarget("10.0.0.5", scope).reason).toBe("excluded");
    expect(evaluateTarget("10.0.0.6", scope).allowed).toBe(true);
  });

  it("enforces acknowledgment, expiry and the time window", () => {
    expect(evaluateTarget("8.8.8.8", { ...baseScope(), testerAck: false }).reason).toBe(
      "no_acknowledgment",
    );
    expect(
      evaluateTarget("8.8.8.8", { ...baseScope(), expiresAt: 100 }, 200).reason,
    ).toBe("scope_expired");
    expect(
      evaluateTarget("8.8.8.8", { ...baseScope(), windowStart: 500 }, 200).reason,
    ).toBe("outside_window");
  });

  it("does not let a range or a network path past the scope as local", () => {
    expect(evaluateTarget("10.0.0.0/0", undefined).reason).toBe("no_scope");
    expect(evaluateTarget("10.0.0.0/0", { ...baseScope(), testerAck: false }).reason).toBe(
      "no_acknowledgment",
    );
    expect(evaluateTarget("10.0.0.0/0", baseScope()).reason).toBe("out_of_scope");
    expect(evaluateTarget("\\\\files.example.com\\share", undefined).reason).toBe("no_scope");
    const scope = { ...baseScope(), allowedTargets: ["files.example.com"] };
    expect(evaluateTarget("\\\\files.example.com\\share", scope).reason).toBe("allowed_in_scope");
  });

  it("records the scope revision on every decision made against a scope", () => {
    const scope = { ...baseScope(), revision: 4, allowedTargets: ["8.8.8.8"] };
    expect(evaluateTarget("8.8.8.8", scope).scopeRevision).toBe(4);
  });
});

describe("scopeReach", () => {
  it("reaches nothing without a scope, or once it expired or is outside its window", () => {
    expect(scopeReach(undefined)).toEqual({ kind: "none", reason: "no_scope" });
    expect(scopeReach({ ...baseScope(), expiresAt: 100 }, 200)).toEqual({
      kind: "none",
      reason: "scope_expired",
    });
    expect(scopeReach({ ...baseScope(), windowStart: 500 }, 200)).toEqual({
      kind: "none",
      reason: "outside_window",
    });
    // evaluateTarget agrees: even a local target is refused then.
    expect(evaluateTarget("10.0.0.5", { ...baseScope(), expiresAt: 100 }, 200).allowed).toBe(false);
  });

  it("reaches local and private addresses with an empty or unacknowledged scope", () => {
    expect(scopeReach(baseScope())).toEqual({ kind: "local", unconfirmed: [] });
    const pending = { ...baseScope(), testerAck: false, allowedTargets: ["scanme.nmap.org"] };
    expect(scopeReach(pending)).toEqual({ kind: "local", unconfirmed: ["scanme.nmap.org"] });
    // evaluateTarget agrees: 10.0.0.0/8 runs, the listed name waits.
    expect(evaluateTarget("10.0.0.0/8", pending).allowed).toBe(true);
    expect(evaluateTarget("scanme.nmap.org", pending).reason).toBe("no_acknowledgment");
  });

  it("reaches the listed targets once acknowledged, and local ones too", () => {
    const scope = { ...baseScope(), allowedTargets: ["scanme.nmap.org"] };
    expect(scopeReach(scope)).toEqual({ kind: "listed", allowed: ["scanme.nmap.org"] });
    expect(evaluateTarget("192.168.0.0/16", scope).allowed).toBe(true);
  });
});

/* ---------- run state machine ---------- */

describe("run state machine", () => {
  it("permits valid transitions and rejects invalid ones", () => {
    expect(canTransition("draft", "validated")).toBe(true);
    expect(canTransition("running", "succeeded")).toBe(true);
    expect(canTransition("draft", "running")).toBe(false);
    expect(canTransition("succeeded", "running")).toBe(false);
    expect(() => assertTransition("draft", "running")).toThrow(InvalidRunTransition);
  });

  it("knows terminal states and reconciles orphans on restart", () => {
    expect(isTerminal("succeeded")).toBe(true);
    expect(isTerminal("running")).toBe(false);
    expect(reconcileOnRestart("running")).toBe("orphaned");
    expect(reconcileOnRestart("starting")).toBe("orphaned");
    expect(reconcileOnRestart("succeeded")).toBe("succeeded");
  });
});

/* ---------- command builder ---------- */

function profile(args: unknown[], values: Record<string, string> = {}) {
  return ToolProfileSchema.parse({
    id: "p1",
    installationId: "i1",
    name: "p",
    args,
    values,
    createdAt: 0,
    updatedAt: 0,
  });
}

describe("buildCommand", () => {
  it("names the sensitive values exactly as they go into argv, for Rust to redact", () => {
    const p = profile(
      [
        { id: "pw", name: "Password", flag: "--password", type: "string", order: 1, sensitive: true },
        { id: "keys", name: "Keys", flag: "-k", type: "string", order: 2, sensitive: true, repeatable: true },
        { id: "host", name: "Host", flag: "", type: "target", order: 3 },
      ],
      { pw: "  hunter22 ", keys: "alpha1, beta2", host: "10.0.0.5" },
    );
    const built = buildCommand(p);
    expect(built.argv).toEqual(["--password", "hunter22", "-k", "alpha1", "-k", "beta2", "10.0.0.5"]);
    // Trimmed and split as in argv, so an exact replace in Rust finds them.
    expect(built.sensitive).toEqual(["hunter22", "alpha1", "beta2"]);
  });

  it("emits flag+value pairs and quotes the preview", () => {
    const p = profile(
      [
        { id: "a", name: "Ports", flag: "-p", type: "port_range", order: 1 },
        { id: "b", name: "Target", flag: "", type: "target", order: 2 },
      ],
      { a: "80,443", b: "scanme.example.com" },
    );
    const built = buildCommand(p, { executableLabel: "nmap" });
    expect(built.errors).toEqual([]);
    expect(built.argv).toEqual(["-p", "80,443", "scanme.example.com"]);
    expect(built.preview).toBe("nmap -p 80,443 scanme.example.com");
  });

  it("flags a missing required argument", () => {
    const p = profile([{ id: "a", name: "Target", type: "target", required: true, order: 1 }]);
    const built = buildCommand(p);
    expect(built.errors[0]).toMatchObject({ argId: "a", message: "is required" });
    expect(built.argv).toEqual([]);
  });

  it("validates integers, ports, durations and rejects traversal", () => {
    expect(buildCommand(profile([{ id: "a", name: "N", type: "integer", order: 1 }], { a: "x" })).errors).toHaveLength(1);
    expect(buildCommand(profile([{ id: "a", name: "P", type: "port_range", order: 1 }], { a: "70000" })).errors).toHaveLength(1);
    expect(buildCommand(profile([{ id: "a", name: "F", type: "file", order: 1 }], { a: "../etc/passwd" })).errors).toHaveLength(1);
    expect(buildCommand(profile([{ id: "a", name: "D", type: "duration", order: 1 }], { a: "30s" })).errors).toHaveLength(0);
  });

  it("handles booleans (flag only) and repeatable values", () => {
    const boolT = buildCommand(profile([{ id: "a", name: "V", flag: "-v", type: "boolean", order: 1 }], { a: "true" }));
    expect(boolT.argv).toEqual(["-v"]);
    const boolF = buildCommand(profile([{ id: "a", name: "V", flag: "-v", type: "boolean", order: 1 }], { a: "false" }));
    expect(boolF.argv).toEqual([]);
    const rep = buildCommand(profile([{ id: "a", name: "Script", flag: "--script", type: "string", repeatable: true, order: 1 }], { a: "http-title, ssl-cert" }));
    expect(rep.argv).toEqual(["--script", "http-title", "--script", "ssl-cert"]);
  });

  it("quotes tokens containing spaces in the preview only", () => {
    const p = profile([{ id: "a", name: "Out", flag: "-o", type: "string", order: 1 }], { a: "my report.txt" });
    const built = buildCommand(p, { executableLabel: "tool" });
    expect(built.argv).toEqual(["-o", "my report.txt"]);
    expect(built.preview).toBe('tool -o "my report.txt"');
  });
});

/* ---------- registry integration ---------- */

describe("lab collection registry", () => {
  it("registers all lab collections", () => {
    for (const name of [
      "engagements",
      "authorizationScopes",
      "assets",
      "targets",
      "services",
      "toolDefinitions",
      "toolInstallations",
      "toolProfiles",
      "installationBindings",
      "toolRuns",
      "artifacts",
    ] as const) {
      expect(collectionSchemas[name]).toBeDefined();
    }
  });
});
