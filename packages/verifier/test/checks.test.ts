import { describe, expect, it } from "vitest";
import { hashConditions, sha256Hex, type DeliveryConditions, type TickEvidence } from "@pawlr/protocol";
import { completionCheck, integrityCheck, presenceCheck } from "../src/index.js";

const SECTION = "Customers may request a refund within 30 days of purchase. Refunds are paid to the original payment method within 14 days.";
const conditions: DeliveryConditions = {
  version: "pawlr/1",
  sessionId: "sess-checks",
  task: "Summarise each section of the supplied document",
  seller: { payTo: "0x" + "ab".repeat(20), endpoint: "https://seller.example/tick" },
  network: "eip155:2368",
  asset: "0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A",
  pricePerTick: "0.001",
  maxTicks: 4,
  maxSpend: "0.004",
  presence: { maxAgeSeconds: 120 },
  completion: { minSentences: 1, maxSentences: 3, minKeyTerms: 3 },
  relevance: { rule: "output must summarise the named section of the agreed document" },
  document: { sections: [{ name: "Refunds", sourceHash: sha256Hex(SECTION) }] },
};
const hash = hashConditions(conditions);
const NOW = Date.parse("2026-11-13T12:00:00Z");
const exp = { sessionId: "sess-checks", lastTick: 2, conditionsHash: hash };

function ev(over: Partial<TickEvidence> = {}): TickEvidence {
  const output = over.output ?? "Customers can request a refund within 30 days, paid to the original payment method.";
  return {
    sessionId: "sess-checks",
    tick: 3,
    timestamp: new Date(NOW).toISOString(),
    sectionName: "Refunds",
    sourceHash: sha256Hex(SECTION),
    outputHash: sha256Hex(output),
    conditionsHash: hash,
    output,
    ...over,
  };
}

describe("presence", () => {
  it("passes for the next tick, fresh, under the agreed hash", () => {
    expect(presenceCheck(ev(), exp, conditions, NOW).ok).toBe(true);
  });
  it("fails on the wrong session, a skipped or repeated tick, or another hash", () => {
    expect(presenceCheck(ev({ sessionId: "other" }), exp, conditions, NOW).ok).toBe(false);
    expect(presenceCheck(ev({ tick: 4 }), exp, conditions, NOW).ok).toBe(false);
    expect(presenceCheck(ev({ tick: 2 }), exp, conditions, NOW).ok).toBe(false);
    expect(presenceCheck(ev({ conditionsHash: "0".repeat(64) }), exp, conditions, NOW).ok).toBe(false);
  });
  it("allows 30 s of clock skew into the future, not 31", () => {
    expect(presenceCheck(ev({ timestamp: new Date(NOW + 30_000).toISOString() }), exp, conditions, NOW).ok).toBe(true);
    expect(presenceCheck(ev({ timestamp: new Date(NOW + 31_000).toISOString() }), exp, conditions, NOW).ok).toBe(false);
  });
  it("fails stale evidence beyond maxAgeSeconds", () => {
    expect(presenceCheck(ev({ timestamp: new Date(NOW - 120_000).toISOString() }), exp, conditions, NOW).ok).toBe(true);
    expect(presenceCheck(ev({ timestamp: new Date(NOW - 121_000).toISOString() }), exp, conditions, NOW).ok).toBe(false);
    expect(presenceCheck(ev({ timestamp: "yesterday" }), exp, conditions, NOW).ok).toBe(false);
  });
});

describe("integrity", () => {
  it("passes when section and output hashes match", () => {
    expect(integrityCheck(ev(), conditions).ok).toBe(true);
  });
  it("fails on an unknown section, a changed section hash, or an output that does not match its hash", () => {
    expect(integrityCheck(ev({ sectionName: "Shipping" }), conditions).ok).toBe(false);
    expect(integrityCheck(ev({ sourceHash: sha256Hex("tampered") }), conditions).ok).toBe(false);
    const e = ev();
    expect(integrityCheck({ ...e, output: e.output + " Extra." }, conditions).ok).toBe(false);
  });
});

describe("completion", () => {
  it("passes 1 to 3 sentences with at least 3 key terms", () => {
    expect(completionCheck(ev(), SECTION, conditions).ok).toBe(true);
  });
  it("fails empty output and 0 or 4 sentences", () => {
    expect(completionCheck(ev({ output: "" }), SECTION, conditions).ok).toBe(false);
    expect(completionCheck(ev({ output: "..." }), SECTION, conditions).ok).toBe(false);
    const four = "A refund is possible. Customers ask. Payment is original. Done in days.";
    expect(completionCheck(ev({ output: four }), SECTION, conditions).ok).toBe(false);
    const three = "A refund is possible. Customers ask. Payment is original.";
    expect(completionCheck(ev({ output: three }), SECTION, conditions).ok).toBe(true);
  });
  it("fails with 2 key terms and passes with 3", () => {
    expect(completionCheck(ev({ output: "A refund for customers." }), SECTION, conditions).ok).toBe(false);
    expect(completionCheck(ev({ output: "A refund for customers via payment." }), SECTION, conditions).ok).toBe(true);
  });
});
