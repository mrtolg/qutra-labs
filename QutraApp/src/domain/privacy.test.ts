import { describe, expect, it } from "vitest";
import {
  looksLikeSecret,
  matchesExclusion,
  redactForDiagnostics,
} from "./privacy";
import type { ExclusionRule } from "./types";

const rule = (kind: ExclusionRule["kind"], value: string): ExclusionRule => ({
  id: value,
  kind,
  value,
  note: "",
  demo: false,
  createdAt: 0,
});

describe("looksLikeSecret", () => {
  it("detects API-style keys, tokens and PEM blocks", () => {
    expect(looksLikeSecret("sk-abcdefghijklmnop1234")).toBe(true);
    expect(looksLikeSecret("AKIAIOSFODNN7EXAMPLE")).toBe(true);
    expect(looksLikeSecret("ghp_abcdefghijklmnopqrstuv123456")).toBe(true);
    expect(looksLikeSecret("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
    expect(looksLikeSecret("password: hunter2secret")).toBe(true);
    expect(looksLikeSecret("şifre = benimgizlim123")).toBe(true);
  });
  it("does not flag ordinary text, urls or numbers", () => {
    expect(looksLikeSecret("Meet me at 14:30 tomorrow")).toBe(false);
    expect(looksLikeSecret("https://example.com/docs")).toBe(false);
    expect(looksLikeSecret("1234567890")).toBe(false);
    expect(looksLikeSecret("")).toBe(false);
  });
});

describe("matchesExclusion", () => {
  it("matches app, path, domain and regex patterns", () => {
    expect(matchesExclusion("KeePassXC.exe", [rule("app", "keepassxc")])).toBeTruthy();
    expect(
      matchesExclusion("C:\\Users\\dev\\Documents\\personal\\x.txt", [
        rule("path", "c:\\users\\dev\\documents\\personal"),
      ]),
    ).toBeTruthy();
    expect(matchesExclusion("https://mybank.example", [rule("domain", "bank")])).toBeTruthy();
    expect(matchesExclusion("token=abc", [rule("pattern", "token=\\w+")])).toBeTruthy();
    expect(matchesExclusion("nothing", [rule("pattern", "([")])).toBeUndefined();
  });
});

describe("redactForDiagnostics", () => {
  it("strips secrets and user paths", () => {
    const input =
      "key sk-abcdefghijklmnop1234 at C:\\Users\\samil\\Documents\\log.txt";
    const out = redactForDiagnostics(input);
    expect(out).not.toContain("sk-abcdefghijklmnop1234");
    expect(out).not.toContain("samil");
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("C:\\Users\\[user]");
  });
});
