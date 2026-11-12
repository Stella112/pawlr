import { describe, expect, it } from "vitest";
import { canonicalJson, hashConditions, sha256Hex, toBaseUnits } from "../src/index.js";

describe("canonicalJson", () => {
  it("sorts keys recursively and has no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } })).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it("drops undefined fields", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("refuses non-finite numbers", () => {
    expect(() => canonicalJson({ a: Infinity })).toThrow();
  });
});

describe("hashConditions", () => {
  const base = { version: "pawlr/1", sessionId: "s1", nested: { x: 1, y: [1, 2] } };

  it("does not change when key order changes", () => {
    const reordered = { nested: { y: [1, 2], x: 1 }, sessionId: "s1", version: "pawlr/1" };
    expect(hashConditions(reordered)).toBe(hashConditions(base));
  });

  it("changes when any value changes", () => {
    const h = hashConditions(base);
    expect(hashConditions({ ...base, sessionId: "s2" })).not.toBe(h);
    expect(hashConditions({ ...base, nested: { x: 2, y: [1, 2] } })).not.toBe(h);
    expect(hashConditions({ ...base, nested: { x: 1, y: [2, 1] } })).not.toBe(h);
  });

  it("is lowercase sha256 hex", () => {
    expect(hashConditions(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("toBaseUnits", () => {
  it("converts decimals without float error", () => {
    expect(toBaseUnits("0.001", 6)).toBe(1000n);
    expect(toBaseUnits("0.001", 18)).toBe(1000000000000000n);
    expect(toBaseUnits("0.05", 6)).toBe(50000n);
  });

  it("rejects bad input", () => {
    expect(() => toBaseUnits("0.0000001", 6)).toThrow();
    expect(() => toBaseUnits("-1", 6)).toThrow();
    expect(() => toBaseUnits("1e3", 6)).toThrow();
  });
});
