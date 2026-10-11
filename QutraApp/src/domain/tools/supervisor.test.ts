import { describe, expect, it } from "vitest";
import {
  validateInvocation,
  isSafeRelativePath,
  isAuthorizedTarget,
  redactSensitive,
  buildAuditEntry,
  type ToolManifest,
} from "./supervisor";

const nmap: ToolManifest = {
  id: "nmap",
  executable: "nmap",
  subcommands: ["-sn", "-sV"],
  timeoutMs: 30_000,
  outputLimitBytes: 1_000_000,
  network: true,
};
const yara: ToolManifest = {
  id: "yara",
  executable: "yara",
  subcommands: ["scan"],
  timeoutMs: 10_000,
  outputLimitBytes: 500_000,
  network: false,
};

describe("path safety", () => {
  it("rejects absolute paths, traversal and NUL", () => {
    expect(isSafeRelativePath("samples/a.bin")).toBe(true);
    expect(isSafeRelativePath("a/b/../c")).toBe(true);
    expect(isSafeRelativePath("../../etc/passwd")).toBe(false);
    expect(isSafeRelativePath("/etc/passwd")).toBe(false);
    expect(isSafeRelativePath("C:\\Windows\\x")).toBe(false);
    expect(isSafeRelativePath("a\0b")).toBe(false);
  });
});

describe("target authorization", () => {
  it("allows loopback and private ranges, gates public behind consent", () => {
    expect(isAuthorizedTarget("127.0.0.1")).toBe(true);
    expect(isAuthorizedTarget("192.168.1.10")).toBe(true);
    expect(isAuthorizedTarget("10.0.0.5")).toBe(true);
    expect(isAuthorizedTarget("172.16.4.4")).toBe(true);
    expect(isAuthorizedTarget("scanme.nmap.org")).toBe(false);
    expect(isAuthorizedTarget("scanme.nmap.org", true)).toBe(true);
  });
});

describe("validateInvocation", () => {
  it("refuses a non-allowlisted executable", () => {
    const bad = validateInvocation({ ...nmap, executable: "rm" }, { subcommand: "-sn", args: [], target: "127.0.0.1" });
    expect(bad).toEqual({ ok: false, reason: "executable_not_allowlisted" });
  });

  it("refuses subcommands outside the fixed set", () => {
    expect(validateInvocation(nmap, { subcommand: "--script=evil", args: [], target: "127.0.0.1" }).ok).toBe(false);
  });

  it("rejects shell metacharacters and command injection in args", () => {
    for (const arg of ["1.2.3.4; rm -rf /", "$(whoami)", "a`b`", "x|y", "a && b", "n\newline"]) {
      const r = validateInvocation(yara, { subcommand: "scan", args: [arg] });
      expect(r.ok, arg).toBe(false);
    }
  });

  it("rejects path traversal in a file argument", () => {
    expect(validateInvocation(yara, { subcommand: "scan", args: ["../../secret"] })).toMatchObject({
      ok: false,
      reason: "path_traversal_rejected",
    });
  });

  it("requires an authorized target for network tools", () => {
    expect(validateInvocation(nmap, { subcommand: "-sn", args: [] })).toMatchObject({ reason: "target_required" });
    expect(validateInvocation(nmap, { subcommand: "-sn", args: [], target: "8.8.8.8" })).toMatchObject({
      reason: "target_not_authorized",
    });
    const ok = validateInvocation(nmap, { subcommand: "-sn", args: [], target: "192.168.1.5" });
    expect(ok.ok).toBe(true);
    expect(ok.ok && ok.spec.args).toEqual(["-sn"]);
  });

  it("builds an argv array (subcommand first), never a shell string", () => {
    const r = validateInvocation(yara, { subcommand: "scan", args: ["rules/r.yar", "samples/a.bin"] });
    expect(r).toEqual({ ok: true, spec: { executable: "yara", args: ["scan", "rules/r.yar", "samples/a.bin"] } });
  });
});

describe("redaction + audit", () => {
  it("redacts tokens, emails, home paths and hashes", () => {
    const red = redactSensitive(
      "tok ghp_ABCDEFGHIJKLMNOPQRSTUVWX12 mail a@b.com path C:\\Users\\mert\\x hash deadbeefdeadbeefdeadbeefdeadbeef",
    );
    expect(red).not.toContain("ghp_ABCDEFG");
    expect(red).toContain("[REDACTED_TOKEN]");
    expect(red).toContain("[REDACTED_EMAIL]");
    expect(red).toContain("[REDACTED_USER]");
    expect(red).toContain("[REDACTED_HASH]");
  });

  it("audit entries are redacted on build", () => {
    const e = buildAuditEntry({
      id: "1",
      at: 0,
      toolId: "gitleaks",
      action: "scan",
      scope: "local",
      classification: "observed",
      detail: "found token ghp_ABCDEFGHIJKLMNOPQRSTUVWX12",
    });
    expect(e.detail).toContain("[REDACTED_TOKEN]");
  });
});
