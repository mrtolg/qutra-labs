import { describe, expect, it } from "vitest";
import { checkExclusion } from "./exclusionRules";

const none: { value: string }[] = [];

describe("checking a new exclusion", () => {
  it("keeps a name or word as typed, trimmed", () => {
    expect(checkExclusion("pattern", "  Acme Holding ", none)).toEqual({
      ok: true,
      value: "Acme Holding",
    });
  });

  it("takes a domain in lower case and refuses a URL or a non-domain", () => {
    expect(checkExclusion("domain", "Corp.Acme.Local.", none)).toEqual({
      ok: true,
      value: "corp.acme.local",
    });
    expect(checkExclusion("domain", "https://corp.acme.local", none)).toEqual({
      ok: false,
      error: "privacy2.error.domainOnly",
    });
    expect(checkExclusion("domain", "corp.acme.local/x", none)).toEqual({
      ok: false,
      error: "privacy2.error.domainOnly",
    });
    expect(checkExclusion("domain", "acme", none)).toEqual({
      ok: false,
      error: "privacy2.error.domain",
    });
  });

  it("takes a drive or network folder path, without its trailing slash", () => {
    expect(checkExclusion("path", "C:\\Clients\\Acme\\", none)).toEqual({
      ok: true,
      value: "C:\\Clients\\Acme",
    });
    expect(checkExclusion("path", "\\\\fileserver\\cases", none)).toEqual({
      ok: true,
      value: "\\\\fileserver\\cases",
    });
    expect(checkExclusion("path", "Clients\\Acme", none)).toEqual({
      ok: false,
      error: "privacy2.error.path",
    });
  });

  it("refuses what would mask too much or nothing at all", () => {
    expect(checkExclusion("pattern", "   ", none)).toEqual({ ok: false, error: "privacy2.error.empty" });
    expect(checkExclusion("pattern", "ab", none)).toEqual({ ok: false, error: "privacy2.error.short" });
    expect(checkExclusion("pattern", "x".repeat(257), none)).toEqual({
      ok: false,
      error: "privacy2.error.long",
    });
    expect(checkExclusion("pattern", "two\nlines", none)).toEqual({
      ok: false,
      error: "privacy2.error.oneLine",
    });
    // A value inside the marker would mask the marker again.
    expect(checkExclusion("pattern", "Masked", none)).toEqual({
      ok: false,
      error: "privacy2.error.marker",
    });
  });

  it("refuses a value already excluded, whatever its case", () => {
    expect(checkExclusion("pattern", "acme holding", [{ value: "Acme Holding" }])).toEqual({
      ok: false,
      error: "privacy2.error.duplicate",
    });
  });

  it("stops at the number Rust reads", () => {
    const full = Array.from({ length: 500 }, (_, i) => ({ value: `value-${i}` }));
    expect(checkExclusion("pattern", "one more", full)).toEqual({
      ok: false,
      error: "privacy2.error.tooMany",
    });
  });
});
