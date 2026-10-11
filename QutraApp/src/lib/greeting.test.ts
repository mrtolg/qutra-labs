import { describe, expect, it } from "vitest";
import { addressName, dayPart } from "./greeting";

describe("the greeting's time of day", () => {
  it("follows the clock", () => {
    expect(dayPart(5)).toBe("morning");
    expect(dayPart(11)).toBe("morning");
    expect(dayPart(12)).toBe("afternoon");
    expect(dayPart(17)).toBe("afternoon");
    expect(dayPart(18)).toBe("evening");
    expect(dayPart(21)).toBe("evening");
    expect(dayPart(22)).toBe("night");
    expect(dayPart(0)).toBe("night");
    expect(dayPart(4)).toBe("night");
  });

  it("uses the form of address as typed, cleaned up", () => {
    expect(addressName("  Mert   Bey ")).toBe("Mert Bey");
    expect(addressName("   ")).toBe("");
    expect(addressName("")).toBe("");
  });
});
