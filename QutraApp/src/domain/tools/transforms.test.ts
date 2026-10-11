import { describe, expect, it } from "vitest";
import {
  encode,
  decode,
  inspectJwt,
  shannonEntropy,
  detectFileSignature,
  looksCatastrophic,
  testRegex,
} from "./transforms";

describe("encoding studio", () => {
  it("round-trips every encoding", () => {
    const s = "Qutra Labs · 28'' café";
    for (const kind of ["base64", "hex", "url", "rot13", "binary", "reverse"] as const) {
      expect(decode(encode(s, kind), kind)).toBe(s);
    }
  });
  it("produces known base64 and hex", () => {
    expect(encode("hi", "base64")).toBe("aGk=");
    expect(encode("hi", "hex")).toBe("6869");
    expect(encode("abc", "rot13")).toBe("nop");
  });
});

describe("JWT inspector", () => {
  // header {"alg":"HS256"} . payload {"sub":"1","exp":1000} . sig
  const token =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIiwiZXhwIjoxMDAwfQ.sig";
  it("decodes header/payload locally and computes expiry", () => {
    const j = inspectJwt(token, 2_000_000);
    expect(j.header.alg).toBe("HS256");
    expect(j.payload.sub).toBe("1");
    expect(j.signaturePresent).toBe(true);
    expect(j.expiresAt).toBe(1000_000);
    expect(j.isExpired).toBe(true);
  });
  it("throws on malformed input rather than guessing", () => {
    expect(() => inspectJwt("nope")).toThrow();
  });
});

describe("entropy + file signature", () => {
  it("scores low entropy for repetition and high for random-ish", () => {
    expect(shannonEntropy(new Uint8Array(64).fill(65))).toBeCloseTo(0);
    const varied = Uint8Array.from(Array.from({ length: 256 }, (_, i) => i));
    expect(shannonEntropy(varied)).toBeCloseTo(8, 1);
  });
  it("detects PNG and flags an extension mismatch", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]);
    expect(detectFileSignature(png, "png")).toMatchObject({ mime: "image/png", extensionMismatch: false });
    expect(detectFileSignature(png, "txt").extensionMismatch).toBe(true);
    expect(detectFileSignature(new Uint8Array([1, 2, 3]))).toMatchObject({ mime: null });
  });
});

describe("regex laboratory", () => {
  it("warns on catastrophic patterns", () => {
    expect(looksCatastrophic("(a+)+")).toBe(true);
    expect(looksCatastrophic("(a|a)*")).toBe(true);
    expect(looksCatastrophic("\\d{3}-\\d{4}")).toBe(false);
  });
  it("runs a bounded match and reports compile errors", () => {
    const ok = testRegex("\\d+", "", "a1 b22 c333");
    expect(ok.matches).toEqual(["1", "22", "333"]);
    const bad = testRegex("(", "", "x");
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe("invalidPattern");
    expect(bad.detail).toBeTruthy();
    expect(testRegex("a", "x", "a").error).toBe("invalidFlags");
    expect(testRegex("a", "ii", "a").error).toBe("invalidFlags");
    expect(testRegex("a", "uv", "a").error).toBe("invalidFlags");
    // A bad pattern with bad flags names the flags, which the user fixes first.
    expect(testRegex("(", "x", "a").error).toBe("invalidFlags");
  });
});
