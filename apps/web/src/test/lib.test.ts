import { diffLines } from "../lib/diff";
import { fmtToken, parseToken, waterfall } from "../lib/format";

describe("format", () => {
  it("formats and parses 6-decimal amounts", () => {
    expect(fmtToken("100000000")).toBe("100.00");
    expect(fmtToken("1234567890")).toBe("1,234.56");
    expect(parseToken("12.5")).toBe("12500000");
    expect(() => parseToken("1.1234567")).toThrow();
  });
  it("waterfall conserves value to the unit", () => {
    for (const price of ["100000000", "99999999", "10000001", "1"]) {
      const w = waterfall(price, { reviewer: 800, producer: 5500, sales: 700, seats: 1500 });
      expect(Object.values(w).reduce((s, v) => s + BigInt(v), 0n)).toBe(BigInt(price));
    }
  });
});

describe("diff", () => {
  it("marks added and removed lines", () => {
    const d = diffLines("a\nb\nc", "a\nc\nd");
    expect(d.filter((l) => l.kind === "del").map((l) => l.text)).toEqual(["b"]);
    expect(d.filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["d"]);
  });
});
