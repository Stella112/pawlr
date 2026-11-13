import type { Check, DeliveryConditions, TickEvidence, TickVerdict } from "@pawlr/protocol";
import { completionCheck, integrityCheck, presenceCheck, type Expected } from "./checks.js";
import { buildRulingRequest, parseResponse, PROMPT_VERSION, usageOf, type ChatTransport, type Parsed, type RawResponse } from "./serv.js";
import { checkQuote } from "./text.js";

/**
 * The verifier pipeline (agent.md §9). Pure library: every external call
 * goes through an injected client, so tests replay recorded responses.
 *
 * Honesty: with standard x402 a tick is paid, then judged. A failing tick
 * stops the NEXT payment; it does not undo the one already made.
 */

/** Optional first-pass screen (Dolphin, see dolphin.ts). Same ruling shape as SERV. */
export type ScreenClient = (input: { conditions: DeliveryConditions; sectionName: string; sectionText: string; sellerOutput: string }) => Promise<{
  parsed: Parsed;
  usd?: number;
  latencyMs: number;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  status?: number | null;
}>;

export interface CostEntry {
  at: string;
  provider: "serv" | "dolphin" | "reppo";
  purpose: "ruling" | "shadow" | "screen" | "dispute" | "claim";
  model: string;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  usd: number | null;
  credits?: number;
  status: number | null;
  requestId?: string;
}

export interface VerifierDeps {
  serv: ChatTransport;
  model?: string;
  screen?: ScreenClient;
  /** "demo": every tick gets a SERV ruling. "economy": a Dolphin pass with a valid quote can settle the tick. */
  mode?: "demo" | "economy";
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onCost?: (entry: CostEntry) => void;
}

export interface VerifyInput {
  conditions: DeliveryConditions;
  expected: Expected;
  /** Buyer's own copy of each section's text, by name. */
  sectionTexts: Record<string, string>;
  evidence: TickEvidence;
  payment: { txHash: string | null; amount: string; network: string };
}

const NOT_RUN: Check = { ok: null, detail: "not run" };
const RETRY_BACKOFF_MS = 1500;

export async function verifyTick(input: VerifyInput, deps: VerifierDeps): Promise<TickVerdict> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const model = deps.model ?? "gpt-5.4-mini";
  const started = now();
  const { conditions, evidence: ev } = input;
  const cost: TickVerdict["cost"] = {};
  const checks: TickVerdict["checks"] = { presence: NOT_RUN, integrity: NOT_RUN, completion: NOT_RUN, guard: NOT_RUN };

  const done = (verdict: TickVerdict["verdict"], decidedBy: TickVerdict["decidedBy"], reason: string, quote: string | null, promptVersion: string | null): TickVerdict => ({
    sessionId: ev.sessionId,
    tick: ev.tick,
    verdict,
    decidedBy,
    checks,
    quote,
    reason,
    payment: input.payment,
    cost,
    promptVersion,
    latencyMs: now() - started,
    createdAt: new Date(now()).toISOString(),
  });

  // 1-3. Code checks. Any failure is decisive.
  checks.presence = presenceCheck(ev, input.expected, conditions, now());
  if (!checks.presence.ok) return done("fail", "code", `Presence: ${checks.presence.detail}`, null, null);
  checks.integrity = integrityCheck(ev, conditions);
  if (!checks.integrity.ok) return done("fail", "code", `Integrity: ${checks.integrity.detail}`, null, null);
  const sectionText = input.sectionTexts[ev.sectionName];
  if (sectionText === undefined) return done("unsure", "code", `Buyer has no text for section "${ev.sectionName}"`, null, null);
  checks.completion = completionCheck(ev, sectionText, conditions);
  if (!checks.completion.ok) return done("fail", "code", `Completion: ${checks.completion.detail}`, null, null);

  const judgeInput = { conditions, sectionName: ev.sectionName, sectionText, sellerOutput: ev.output };

  // 5. Optional Dolphin screen.
  let screenPassed = false;
  if (deps.screen) {
    type ScreenOut = Awaited<ReturnType<ScreenClient>>;
    const s: ScreenOut = await deps.screen(judgeInput).catch((err): ScreenOut => ({ parsed: { kind: "error", status: null, retryable: false, detail: String(err) }, usd: 0, latencyMs: 0 }));
    if (s.usd !== undefined) cost.dolphinUsd = (cost.dolphinUsd ?? 0) + s.usd;
    deps.onCost?.({
      at: new Date(now()).toISOString(),
      provider: "dolphin",
      purpose: "screen",
      model: s.model ?? "dolphin",
      latencyMs: s.latencyMs,
      promptTokens: s.promptTokens,
      completionTokens: s.completionTokens,
      usd: s.usd ?? null,
      status: s.status ?? null,
    });
    if (s.parsed.kind === "ruling") {
      const q = checkQuote(s.parsed.quote, ev.output, sectionText);
      screenPassed = s.parsed.verdict === "pass" && q.ok;
      checks.screen = { ok: screenPassed, detail: `Dolphin said ${s.parsed.verdict}; ${q.detail}` };
      if (screenPassed && deps.mode === "economy") {
        checks.guard = { ok: null, detail: "not run (economy mode: settled by Dolphin screen)" };
        return done("pass", "dolphin", `Dolphin screen: ${s.parsed.reason}`, s.parsed.quote, null);
      }
    } else {
      checks.screen = { ok: false, detail: `Dolphin screen gave no usable ruling (${s.parsed.kind}); escalating to SERV` };
    }
  }
  const servDecider = screenPassed ? "dolphin+serv" : "serv";

  // 4 + 6. SERV ruling with PromptGuard in the same request.
  const call = async (shadow: boolean): Promise<Parsed> => {
    const body = buildRulingRequest(judgeInput, { model, shadow });
    let raw: RawResponse = await deps.serv(body);
    let parsed = parseResponse(raw);
    record(raw, shadow);
    if (parsed.kind === "error" && parsed.retryable) {
      await sleep(RETRY_BACKOFF_MS);
      raw = await deps.serv(body);
      parsed = parseResponse(raw);
      record(raw, shadow);
    }
    return parsed;
  };
  const record = (raw: RawResponse, shadow: boolean) => {
    const u = usageOf(raw);
    if (u) {
      cost.servTokens = (cost.servTokens ?? 0) + u.promptTokens + u.completionTokens;
      cost.servUsd = (cost.servUsd ?? 0) + u.usd;
    }
    deps.onCost?.({
      at: new Date(now()).toISOString(),
      provider: "serv",
      purpose: shadow ? "shadow" : "ruling",
      model,
      latencyMs: raw.latencyMs,
      promptTokens: u?.promptTokens,
      completionTokens: u?.completionTokens,
      usd: u ? u.usd : null,
      status: raw.status,
      requestId: raw.requestId,
    });
  };

  const first = await call(false);
  if (first.kind === "error") {
    checks.relevance = { ok: null, detail: `judge error: ${first.detail}` };
    return done("unsure", "serv", first.retryable ? "judge unavailable" : `judge error: ${first.detail}`, null, PROMPT_VERSION);
  }
  if (first.kind === "guard-refusal") {
    // Never pass on a guard hit. Sent straight to review; the Shadow Agent is not run on flagged evidence.
    checks.guard = { ok: false, detail: `SERV PromptGuard refused the request ("${first.refusal}")` };
    checks.relevance = NOT_RUN;
    return done("unsure", "serv", "evidence flagged as injection attempt", null, PROMPT_VERSION);
  }
  checks.guard = { ok: true, detail: "PromptGuard did not flag the evidence (the guard is one layer, not a guarantee)" };

  const judged = judge(first);
  checks.relevance = judged.relevance;
  checks.quote = judged.quote;
  if (judged.verdict !== "unsure") return done(judged.verdict, servDecider, judged.reason, judged.quoteText, PROMPT_VERSION);

  // 8. Shadow Agent, on unsure only.
  const second = await call(true);
  if (second.kind === "error") {
    checks.shadow = { ok: null, detail: `shadow call error: ${second.detail}` };
    return done("unsure", "serv+shadow", judged.reason, null, PROMPT_VERSION);
  }
  if (second.kind === "guard-refusal") {
    checks.guard = { ok: false, detail: `SERV PromptGuard refused the shadow request ("${second.refusal}")` };
    checks.shadow = { ok: false, detail: "shadow request refused by PromptGuard" };
    return done("unsure", "serv+shadow", "evidence flagged as injection attempt", null, PROMPT_VERSION);
  }
  const shadowJudged = judge(second);
  checks.shadow = {
    ok: shadowJudged.verdict !== "unsure",
    detail: `Shadow Agent revision: ${shadowJudged.verdict} (${shadowJudged.quote.detail}). SERV does not expose the Shadow Agent outcome (e.g. "exhausted") in the API response.`,
  };
  if (shadowJudged.verdict !== "unsure") {
    checks.relevance = shadowJudged.relevance;
    checks.quote = shadowJudged.quote;
    return done(shadowJudged.verdict, "serv+shadow", shadowJudged.reason, shadowJudged.quoteText, PROMPT_VERSION);
  }
  return done("unsure", "serv+shadow", `${shadowJudged.reason} (still unsure after Shadow Agent; sent to review)`, null, PROMPT_VERSION);

  // 7. Quote-or-hold: a ruling without a valid quote never pays and never fails a tick.
  function judge(p: Exclude<Parsed, { kind: "error" } | { kind: "guard-refusal" }>) {
    if (p.kind !== "ruling") {
      const detail = p.kind === "refusal" ? `model refused: ${p.refusal}` : p.detail;
      return { verdict: "unsure" as const, reason: `No usable ruling: ${detail}`, quoteText: null, relevance: { ok: null, detail } as Check, quote: { ok: false, detail: "no quote" } as Check };
    }
    const q = checkQuote(p.quote, ev.output, sectionText!);
    const relevance: Check = { ok: p.verdict === "pass" ? true : p.verdict === "fail" ? false : null, detail: `SERV said ${p.verdict}: ${p.reason}` };
    if (!q.ok) return { verdict: "unsure" as const, reason: `SERV said ${p.verdict}, but its quote failed the quote check (${q.detail}); held for review`, quoteText: null, relevance, quote: { ok: false, detail: q.detail } as Check };
    return { verdict: p.verdict, reason: p.reason, quoteText: p.quote, relevance, quote: { ok: true, detail: q.detail } as Check };
  }
}
