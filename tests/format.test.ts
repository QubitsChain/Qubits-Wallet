import { describe, expect, it } from "vitest";

import { amount, baseUnits, brief } from "../src/shared/format";

describe("native token amounts (18 decimals)", () => {
  const TOKEN = 10n ** 18n;

  it("shows base units as tokens", () => {
    expect(amount("0")).toBe("0");
    expect(amount("1")).toBe("0.000000000000000001");
    expect(amount((TOKEN + TOKEN / 2n).toString())).toBe("1.5");
    expect(amount("1234567890123456789")).toBe("1.234567890123456789");
    expect(amount((2_000n * TOKEN).toString())).toBe("2,000");
    // Beyond what a JavaScript number can hold.
    expect(amount("340282366920938463463374607431768211455")).toBe(
      "340,282,366,920,938,463,463.374607431768211455",
    );
  });

  it("reads tokens back exactly", () => {
    for (const units of ["1", "999999", "1000000", "1500000000000000000", "1234567890123456789", "340282366920938463463374607431768211455"]) {
      expect(baseUnits(amount(units))).toBe(units);
    }
    expect(baseUnits(" 1_000.5 ")).toBe("1000500000000000000000");
    expect(baseUnits("0.0000000000000000001")).toBeNull();
    expect(baseUnits("0")).toBeNull();
    expect(baseUnits("1e6")).toBeNull();
  });

  it("shortens what is only there to be read", () => {
    expect(brief("0")).toBe("0");
    expect(brief((1_500n * TOKEN).toString())).toBe("1,500");
    expect(brief("898993722500000000000000")).toBe("898,993.7225");
    expect(brief("898993722512345678901234")).toBe("898,993.722512");
    // a fee keeps enough digits to mean something
    expect(brief("34700000000000")).toBe("0.0000347");
    expect(brief("34712345678901")).toBe("0.00003471");
    expect(brief("777")).toBe("0.000000000000000777");
    expect(brief("1234")).toBe("0.000000000000001234");
    // nothing but a rounding left
    expect(brief("5000000000000000001")).toBe("5");
    // a token's own decimals
    expect(brief("1234567", 6)).toBe("1.234567");
  });
});
