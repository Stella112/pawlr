import type { DeliveryConditions, TickEvidence, TickVerdict } from "@pawlr/protocol";

/**
 * Reppo Eval Router: an independent verdict on a disputed or unclear tick (agent.md §9 step 10).
 *
 * Source: https://eval.reppo.xyz/agents.md (read 2026-11-14, docs/integration-notes.md §5).
 * docs.reppo.ai/api/eval/* still shows /agents/eval-requests/submit with accept/revise/reject;
 * that endpoint now returns 404 and agents.md §8 lists it as removed. Current API:
 *   POST {base}/agents/evals  {taskType: "response", input} → 201 {id, status: "QUEUED", ...}
 *   GET  {base}/agents/evals/{id} → status QUEUED | PROCESSING | COMPLETED | FAILED
 *   result: {score 0-100, decision accept|reject, confidence low|medium|high, route ship|review|block, reason, ...}
 * 440 credits per completed text evaluation; a FAILED evaluation is free. Scored by a panel of
 * independent evaluators, usually in 30-90 s (captured: about 10 s, fixtures/reppo/).
 *
 * Mapping to Pawlr (agent.md §9 asked for accept→pass, reject→fail, revise→unsure; the live API has
 * no "revise", so Pawlr maps the route, which is Reppo's own recommendation):
 *   ship → pass, block → fail, review → unsure.
 * The session resumes only on pass. Anything else (FAILED, timeout, unknown route) → unsure.
 */

export const REPPO_BASE_URL = "https://eval.reppo.xyz/api/v1";
export const REPPO_CREDITS_PER_EVAL = 440;

export interface ReppoResult {
  score: number;
  decision: "accept" | "reject";
  confidence: "low" | "medium" | "high";
  route: "ship" | "review" | "block";
  reason: string;
  [k: string]: unknown;
}

export interface ReppoEval {
  id: string;
  status: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED";
  creditsCharged?: number;
  result: ReppoResult | null;
  error?: unknown;
  [k: string]: unknown;
}

export interface ReppoClient {
  submit(input: string): Promise<ReppoEval>;
  get(id: string): Promise<ReppoEval>;
}

export class ReppoError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
}

export function reppoClient(apiKey: string, baseUrl = REPPO_BASE_URL, fetchImpl: typeof fetch = fetch): ReppoClient {
  if (!apiKey) throw new Error("REPPO_API_KEY is required");
  const base = baseUrl.replace(/\/+$/, "");
  const call = async (method: string, path: string, body?: unknown): Promise<ReppoEval> => {
    let res: Response;
    try {
      res = await fetchImpl(base + path, {
        method,
        headers: { Authorization: `Bearer ${apiKey}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new ReppoError(`network error: ${(err as { cause?: { code?: string } }).cause?.code ?? String(err)}`, null);
    }
    const text = await res.text();
    let j: unknown;
    try {
      j = JSON.parse(text);
    } catch {
      throw new ReppoError(`HTTP ${res.status}: not JSON`, res.status);
    }
    if (!res.ok) throw new ReppoError(`HTTP ${res.status}: ${(j as { error?: string }).error ?? "error"}`, res.status);
    return j as ReppoEval;
  };
  return {
    submit: (input) => call("POST", "/agents/evals", { taskType: "response", input }),
    get: (id) => call("GET", `/agents/evals/${encodeURIComponent(id)}`),
  };
}

export interface DisputeCase {
  conditions: DeliveryConditions;
  sectionText: string;
  evidence: TickEvidence;
  /** Notes the seller added to this tick (POST /sessions/:id/evidence/:tick). Untrusted, like the output. */
  sellerAdded?: { note: string }[];
  /** Pawlr's own ruling. Omit it to ask for a fully independent verdict (the benchmark does). */
  pawlrVerdict?: Pick<TickVerdict, "verdict" | "reason" | "quote">;
}

/** The `input` text sent to Reppo. Plain text in the "User prompt / AI response" form agents.md asks for. */
export function buildDisputeInput(c: DisputeCase): string {
  const parts = [
    `User prompt: A paid service was asked to deliver this, for one tick of a metered session:`,
    `Task: ${c.conditions.task}.`,
    `Section to summarise: "${c.evidence.sectionName}".`,
    `Agreed rule: ${c.conditions.relevance.rule}.`,
    `Agreed length: ${c.conditions.completion.minSentences} to ${c.conditions.completion.maxSentences} sentences.`,
    ``,
    `Text of section "${c.evidence.sectionName}" (the buyer's own copy, hash-checked):`,
    c.sectionText,
    ``,
    `AI response (the seller's delivered output for tick ${c.evidence.tick}; judge whether it meets the agreed rule):`,
    c.evidence.output,
  ];
  if (c.sellerAdded?.length) {
    parts.push(``, `The seller added this evidence to the dispute:`, ...c.sellerAdded.map((a) => `- ${a.note}`));
  }
  if (c.pawlrVerdict) {
    parts.push(``, `Pawlr's automated ruling, which is being disputed: ${c.pawlrVerdict.verdict}. Reason: ${c.pawlrVerdict.reason}`);
  }
  return parts.join("\n");
}

export interface DisputeOutcome {
  verdict: "pass" | "fail" | "unsure";
  evalId: string | null;
  route: ReppoResult["route"] | null;
  score: number | null;
  decision: ReppoResult["decision"] | null;
  confidence: ReppoResult["confidence"] | null;
  reason: string;
  credits: number;
  latencyMs: number;
}

export function mapReppoRoute(route: unknown): "pass" | "fail" | "unsure" {
  return route === "ship" ? "pass" : route === "block" ? "fail" : "unsure";
}

/** Submits a dispute and polls until Reppo answers. Never throws; a problem is an "unsure" outcome. */
export async function runDispute(
  c: DisputeCase,
  client: ReppoClient,
  opts: { pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<DisputeOutcome> {
  const pollMs = opts.pollMs ?? 5_000;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const started = now();
  const unsure = (reason: string, evalId: string | null = null): DisputeOutcome => ({
    verdict: "unsure", evalId, route: null, score: null, decision: null, confidence: null, reason, credits: 0, latencyMs: now() - started,
  });

  let ev: ReppoEval;
  try {
    ev = await client.submit(buildDisputeInput(c));
  } catch (err) {
    return unsure(`Reppo submit failed: ${(err as Error).message}`);
  }
  const id = ev.id;
  while (ev.status !== "COMPLETED" && ev.status !== "FAILED") {
    if (now() - started > timeoutMs) return unsure(`Reppo did not answer within ${Math.round(timeoutMs / 1000)} s`, id);
    await sleep(pollMs);
    try {
      ev = await client.get(id);
    } catch {
      // Transient read errors (seen live: a connect timeout) are retried on the next poll.
    }
  }
  if (ev.status === "FAILED" || !ev.result) return unsure(`Reppo evaluation failed (not charged)`, id);
  const r = ev.result;
  return {
    verdict: mapReppoRoute(r.route),
    evalId: id,
    route: r.route,
    score: r.score,
    decision: r.decision,
    confidence: r.confidence,
    reason: r.reason,
    credits: ev.creditsCharged ?? REPPO_CREDITS_PER_EVAL,
    latencyMs: now() - started,
  };
}

/** Applies a Reppo outcome to the disputed tick's verdict. Only "pass" lets the session resume. */
export function applyDispute(v: TickVerdict, o: DisputeOutcome): TickVerdict {
  const detail = o.evalId
    ? `Reppo eval ${o.evalId}: route ${o.route ?? "none"}, score ${o.score ?? "-"}, decision ${o.decision ?? "-"}, confidence ${o.confidence ?? "-"}`
    : o.reason;
  return {
    ...v,
    verdict: o.verdict,
    decidedBy: "reppo",
    checks: { ...v.checks, dispute: { ok: o.verdict === "pass" ? true : o.verdict === "fail" ? false : null, detail } },
    reason: `Reppo (independent): ${o.reason} Earlier Pawlr ruling: ${v.verdict}: ${v.reason}`,
    cost: { ...v.cost, reppoCredits: (v.cost.reppoCredits ?? 0) + o.credits },
  };
}
