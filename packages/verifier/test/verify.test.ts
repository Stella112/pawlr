import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TickVerdict } from "@pawlr/protocol";
import { verifyTick, type ChatTransport, type RawResponse, type ScreenClient, type VerifyInput } from "../src/index.js";

/**
 * Fixture-driven tests. Fixtures under fixtures/captured/ and fixtures/serv/ are
 * real SERV responses (captured 2026-11-12 and 2026-11-13). Where a test
 * replays them in a constructed order, or alters one field, it says so.
 * Responses marked SYNTHETIC are written by hand because the condition
 * (429 / 503 / network error) cannot be produced on demand.
 */

const load = (p: string) => JSON.parse(readFileSync(new URL(`./fixtures/${p}`, import.meta.url), "utf8"));

interface Captured {
  case: string;
  nowMs: number;
  conditions: VerifyInput["conditions"];
  sectionTexts: Record<string, string>;
  evidence: VerifyInput["evidence"];
  recorded: { request: unknown; response: RawResponse }[];
  verdict: TickVerdict;
}

function inputOf(c: Captured): VerifyInput {
  return {
    conditions: c.conditions,
    expected: { sessionId: c.evidence.sessionId, lastTick: c.evidence.tick - 1, conditionsHash: c.evidence.conditionsHash },
    sectionTexts: c.sectionTexts,
    evidence: c.evidence,
    payment: { txHash: null, amount: "0.001", network: c.conditions.network },
  };
}

/** Replays responses in order and records what was sent. */
function replay(responses: RawResponse[]) {
  const sent: any[] = [];
  const t: ChatTransport = async (body) => {
    sent.push(body);
    const r = responses.shift();
    if (!r) throw new Error("replay: no more responses");
    return r;
  };
  return { t, sent };
}

const deps = (serv: ChatTransport, nowMs: number, extra = {}) => ({ serv, now: () => nowMs, sleep: async () => {}, ...extra });
const servFixture = (name: string): RawResponse => {
  const f = load(`serv/${name}.json`);
  return { status: f.response.status, body: f.response.body, latencyMs: f.response.latencyMs };
};
const withQuote = (r: RawResponse, quote: string): RawResponse => {
  const b = structuredClone(r.body) as any;
  const content = JSON.parse(b.choices[0].message.content);
  b.choices[0].message.content = JSON.stringify({ ...content, quote });
  return { ...r, body: b };
};

describe("replaying captured SERV rulings (prompt ruling-v1)", () => {
  for (const name of ["honest", "contradiction", "injection", "wrongFocus", "vague", "borderline1"]) {
    it(`${name}: reproduces the captured verdict`, async () => {
      const c: Captured = load(`captured/${name}.json`);
      const { t, sent } = replay(c.recorded.map((r) => r.response));
      const v = await verifyTick(inputOf(c), deps(t, c.nowMs));
      expect(v.verdict).toBe(c.verdict.verdict);
      expect(v.decidedBy).toBe(c.verdict.decidedBy);
      expect(v.quote).toBe(c.verdict.quote);
      expect(sent).toHaveLength(c.recorded.length);
      sent.forEach((body, i) => expect(body).toEqual(c.recorded[i]!.request));
    });
  }

  it("pass: honest summary passes with a quote from the seller output, cost recorded", async () => {
    const c: Captured = load("captured/honest.json");
    const v = await verifyTick(inputOf(c), deps(replay(c.recorded.map((r) => r.response)).t, c.nowMs));
    expect(v).toMatchObject({ verdict: "pass", decidedBy: "serv", promptVersion: "ruling-v1" });
    expect(v.checks.quote?.ok).toBe(true);
    expect(c.evidence.output).toContain(v.quote);
    expect(v.cost.servTokens).toBeGreaterThan(0);
    expect(v.cost.servUsd).toBeGreaterThan(0);
  });

  it("fail: a contradicting summary fails with a reason and quote", async () => {
    const c: Captured = load("captured/contradiction.json");
    const v = await verifyTick(inputOf(c), deps(replay(c.recorded.map((r) => r.response)).t, c.nowMs));
    expect(v.verdict).toBe("fail");
    expect(v.quote).toBeTruthy();
    expect(v.reason.length).toBeGreaterThan(10);
  });

  it("code fail: too few key terms is decided by code with no SERV call", async () => {
    const c: Captured = load("captured/vague.json");
    const { t, sent } = replay([]);
    const v = await verifyTick(inputOf(c), deps(t, c.nowMs));
    expect(v).toMatchObject({ verdict: "fail", decidedBy: "code" });
    expect(sent).toHaveLength(0);
  });

  it("sends the guard tool with every ruling and a system message first", async () => {
    const c: Captured = load("captured/honest.json");
    const { t, sent } = replay(c.recorded.map((r) => r.response));
    await verifyTick(inputOf(c), deps(t, c.nowMs));
    expect(sent[0].messages[0].role).toBe("system");
    expect(sent[0].tools.map((x: any) => x.function.name)).toEqual(["serv_prompt_guard"]);
    expect(sent[0].response_format.json_schema.name).toBe("pawlr_ruling");
  });
});

describe("guard hit", () => {
  it("is unsure, sent to review, never pass, and the Shadow Agent is not run (real refusal from probe p3)", async () => {
    const c: Captured = load("captured/injection.json");
    const { t, sent } = replay([servFixture("p3_guard_rf_injection")]);
    const v = await verifyTick(inputOf(c), deps(t, c.nowMs));
    expect(v.verdict).toBe("unsure");
    expect(v.reason).toBe("evidence flagged as injection attempt");
    expect(v.checks.guard.ok).toBe(false);
    expect(sent).toHaveLength(1);
  });
});

describe("invalid quote and the Shadow Agent", () => {
  const c: Captured = load("captured/honest.json");
  const honestRuling = c.recorded[0]!.response;
  // DERIVED: the real honest ruling with its quote replaced by words that appear in neither text.
  const invented = withQuote(honestRuling, "Refunds are instant and unconditional.");

  it("invalid quote -> unsure -> Shadow Agent; still no valid quote -> review (shadow reply: real probe p6 response)", async () => {
    const { t, sent } = replay([invented, servFixture("p6_shadow_rf_subtle")]);
    const v = await verifyTick(inputOf(c), deps(t, c.nowMs));
    expect(v.verdict).toBe("unsure");
    expect(v.decidedBy).toBe("serv+shadow");
    expect(v.quote).toBeNull();
    expect(sent).toHaveLength(2);
    expect(sent[1].tools.map((x: any) => x.function.name)).toEqual(["serv_prompt_guard", "serv_shadow_agent"]);
    const shadowTool = sent[1].tools[1].function.parameters.properties;
    expect(shadowTool.max_iterations.default).toBe(3);
    expect(shadowTool.hint.default).toMatch(/must quote exact words/);
    expect(v.checks.shadow?.detail).toMatch(/does not expose the Shadow Agent outcome/);
  });

  it("invalid quote -> Shadow Agent returns a valid ruling -> decided by serv+shadow (replayed: real contradiction ruling)", async () => {
    const contradiction: Captured = load("captured/contradiction.json");
    const cInput = inputOf(contradiction);
    const { t } = replay([withQuote(contradiction.recorded[0]!.response, "made-up words"), contradiction.recorded[0]!.response]);
    const v = await verifyTick(cInput, deps(t, contradiction.nowMs));
    expect(v).toMatchObject({ verdict: "fail", decidedBy: "serv+shadow" });
    expect(v.checks.quote?.ok).toBe(true);
  });

  it("a model 'unsure' with a valid quote also goes to the Shadow Agent", async () => {
    // DERIVED: the real honest ruling with verdict changed to unsure.
    const b = structuredClone(honestRuling.body) as any;
    const content = JSON.parse(b.choices[0].message.content);
    b.choices[0].message.content = JSON.stringify({ ...content, verdict: "unsure" });
    const { t, sent } = replay([{ ...honestRuling, body: b }, honestRuling]);
    const v = await verifyTick(inputOf(c), deps(t, c.nowMs));
    expect(sent).toHaveLength(2);
    expect(v).toMatchObject({ verdict: "pass", decidedBy: "serv+shadow" });
  });
});

describe("judge errors: never pass on error", () => {
  const c: Captured = load("captured/honest.json");

  it("real 400 (missing system prompt, probe p0) -> unsure, not retried", async () => {
    const { t, sent } = replay([servFixture("p0_no_system")]);
    const v = await verifyTick(inputOf(c), deps(t, c.nowMs));
    expect(v.verdict).toBe("unsure");
    expect(v.reason).toMatch(/judge error: HTTP 400: A system prompt is required/);
    expect(sent).toHaveLength(1);
  });

  // SYNTHETIC responses: 503 and network errors cannot be captured on demand.
  const s503: RawResponse = { status: 503, body: { error: { message: "SYNTHETIC upstream unavailable" } }, latencyMs: 5 };
  const s429: RawResponse = { status: 429, body: { error: { message: "SYNTHETIC rate limited" } }, latencyMs: 5 };
  const sNet: RawResponse = { status: null, body: "SYNTHETIC ECONNRESET", latencyMs: 5 };

  it("503 twice -> retried once with backoff, then unsure 'judge unavailable'", async () => {
    const { t, sent } = replay([s503, s503]);
    const sleeps: number[] = [];
    const v = await verifyTick(inputOf(c), deps(t, c.nowMs, { sleep: async (ms: number) => void sleeps.push(ms) }));
    expect(v).toMatchObject({ verdict: "unsure", reason: "judge unavailable" });
    expect(sent).toHaveLength(2);
    expect(sleeps).toEqual([1500]);
  });

  it("429 then a real ruling -> the retry succeeds", async () => {
    const { t, sent } = replay([s429, c.recorded[0]!.response]);
    const v = await verifyTick(inputOf(c), deps(t, c.nowMs));
    expect(v.verdict).toBe("pass");
    expect(sent).toHaveLength(2);
  });

  it("network error twice -> unsure", async () => {
    const { t } = replay([sNet, sNet]);
    expect((await verifyTick(inputOf(c), deps(t, c.nowMs))).verdict).toBe("unsure");
  });

  it("invalid JSON or a truncated answer -> unsure after the Shadow Agent, never pass", async () => {
    const bad = structuredClone(c.recorded[0]!.response) as RawResponse;
    (bad.body as any).choices[0].message.content = '{"verdict":"pass","quo'; // DERIVED: truncated
    const truncated = structuredClone(bad);
    (truncated.body as any).choices[0].finish_reason = "length";
    for (const r of [bad, truncated]) {
      const { t } = replay([r, r]);
      expect((await verifyTick(inputOf(c), deps(t, c.nowMs))).verdict).toBe("unsure");
    }
  });
});

describe("Dolphin screen in the pipeline (TEST DOUBLE screen; the real client is tested in partners.test.ts)", () => {
  const c: Captured = load("captured/honest.json");
  const ruling = JSON.parse((c.recorded[0]!.response.body as any).choices[0].message.content);
  const screenPass: ScreenClient = async () => ({ parsed: { kind: "ruling", ...ruling }, usd: 0.00001, latencyMs: 3 });
  const screenFail: ScreenClient = async () => ({ parsed: { kind: "ruling", verdict: "fail", quote: ruling.quote, reason: "x" }, usd: 0.00001, latencyMs: 3 });

  it("demo mode: a screen pass still gets a SERV ruling (dolphin+serv)", async () => {
    const { t, sent } = replay([c.recorded[0]!.response]);
    const v = await verifyTick(inputOf(c), deps(t, c.nowMs, { screen: screenPass, mode: "demo" }));
    expect(sent).toHaveLength(1);
    expect(v).toMatchObject({ verdict: "pass", decidedBy: "dolphin+serv" });
    expect(v.cost.dolphinUsd).toBeGreaterThan(0);
  });

  it("economy mode: a screen pass with a valid quote settles the tick without SERV", async () => {
    const { t, sent } = replay([]);
    const v = await verifyTick(inputOf(c), deps(t, c.nowMs, { screen: screenPass, mode: "economy" }));
    expect(sent).toHaveLength(0);
    expect(v).toMatchObject({ verdict: "pass", decidedBy: "dolphin" });
  });

  it("a screen fail always escalates to SERV", async () => {
    const { t, sent } = replay([c.recorded[0]!.response]);
    const v = await verifyTick(inputOf(c), deps(t, c.nowMs, { screen: screenFail, mode: "economy" }));
    expect(sent).toHaveLength(1);
    expect(v.decidedBy).toBe("serv");
  });
});
