import { kiteChainByNetwork, toBaseUnits, type DeliveryConditions, type RefundClaim, type TickVerdict } from "@pawlr/protocol";
import { parseResponse, usageOf, type ChatTransport } from "@pawlr/verifier";

/**
 * Recover (CLAUDE.md §10.2): SERV Reasoning drafts one refund claim from the
 * receipt data only; code re-checks the amount and wins on any mismatch.
 * The claim is a request. Money is not returned automatically.
 */

const CLAIM_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "pawlr_claim",
    strict: true,
    schema: {
      type: "object",
      properties: {
        amountOwed: { type: "string" },
        ticks: { type: "array", items: { type: "integer" } },
        summary: { type: "string" },
        evidence: {
          type: "array",
          items: {
            type: "object",
            properties: { tick: { type: "integer" }, quote: { type: "string" }, reason: { type: "string" } },
            required: ["tick", "quote", "reason"],
            additionalProperties: false,
          },
        },
      },
      required: ["amountOwed", "ticks", "summary", "evidence"],
      additionalProperties: false,
    },
  },
} as const;

const CLAIM_SYSTEM =
  "You draft a refund request for a buyer who paid per tick. Use only the receipt data provided. " +
  "For each claimed tick, give the exact quote and reason recorded in the receipt. amountOwed is pricePerTick times the number of claimed ticks, as a decimal string. " +
  "Write a short, factual summary addressed to the seller. Do not invent facts, amounts or ticks.";

export interface ClaimDraft {
  claim: RefundClaim;
  /** What code changed after SERV's draft, if anything. */
  corrections: string[];
  usd: number | null;
}

export function amountFor(ticks: number[], conditions: DeliveryConditions): string {
  const chain = kiteChainByNetwork(conditions.network)!;
  const units = BigInt(ticks.length) * toBaseUnits(conditions.pricePerTick, chain.assetDecimals);
  const s = units.toString().padStart(chain.assetDecimals + 1, "0");
  const whole = s.slice(0, -chain.assetDecimals) || "0";
  const frac = s.slice(-chain.assetDecimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export async function draftClaim(
  input: { conditions: DeliveryConditions; conditionsHash: string; ticks: number[]; verdicts: TickVerdict[] },
  serv: ChatTransport,
  model = "gpt-5.4-mini",
): Promise<ClaimDraft> {
  const claimed = [...new Set(input.ticks)].sort((a, b) => a - b);
  const records = claimed.map((n) => {
    const v = input.verdicts.find((x) => x.tick === n);
    return { tick: n, verdict: v?.verdict ?? "unknown", quote: v?.quote ?? "", reason: v?.reason ?? "", paid: input.conditions.pricePerTick, settlement: v?.payment.txHash ?? null };
  });
  const body = {
    model,
    temperature: 0,
    messages: [
      { role: "system", content: CLAIM_SYSTEM },
      {
        role: "user",
        content: `<receipt>${JSON.stringify({ sessionId: input.conditions.sessionId, pricePerTick: input.conditions.pricePerTick, network: input.conditions.network, claimedTicks: records })}</receipt>`,
      },
    ],
    response_format: CLAIM_FORMAT,
  };
  const raw = await serv(body);
  const parsed = parseResponse(raw);
  const corrections: string[] = [];
  const expectedAmount = amountFor(claimed, input.conditions);
  const codeEvidence = records.map((r) => ({ tick: r.tick, quote: r.quote, reason: r.reason }));

  let summary = `Refund requested for tick(s) ${claimed.join(", ")} of session ${input.conditions.sessionId}: ${expectedAmount} owed.`;
  const evidence = codeEvidence;
  const content = (raw.body as any)?.choices?.[0]?.message?.content;
  let draft: any = null;
  try {
    draft = typeof content === "string" ? JSON.parse(content) : null;
  } catch {
    draft = null;
  }
  if (draft && typeof draft.summary === "string") {
    summary = draft.summary;
    if (draft.amountOwed !== expectedAmount) corrections.push(`SERV said amountOwed ${draft.amountOwed}; code computed ${expectedAmount} (code wins)`);
    const draftTicks = JSON.stringify([...(draft.ticks ?? [])].sort((a: number, b: number) => a - b));
    if (draftTicks !== JSON.stringify(claimed)) corrections.push(`SERV listed ticks ${draftTicks}; code uses ${JSON.stringify(claimed)}`);
    // Evidence must match the receipt exactly; anything else is replaced by the receipt's own record.
    const ok = Array.isArray(draft.evidence) && draft.evidence.length === codeEvidence.length && draft.evidence.every((e: any) => codeEvidence.some((c) => c.tick === e.tick && c.quote === e.quote));
    if (!ok) corrections.push("SERV evidence did not match the receipt word for word; replaced with the receipt's quotes and reasons");
  } else {
    corrections.push(`SERV gave no usable claim (${parsed.kind}); code drafted it from the receipt`);
  }
  return {
    claim: { sessionId: input.conditions.sessionId, conditionsHash: input.conditionsHash, ticks: claimed, amountOwed: expectedAmount, summary, evidence },
    corrections,
    usd: usageOf(raw)?.usd ?? null,
  };
}

export async function sendClaim(sellerBaseUrl: string, claim: RefundClaim, fetchImpl: typeof fetch = fetch) {
  const r = await fetchImpl(`${sellerBaseUrl}/sessions/${claim.sessionId}/refund-requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(claim),
  });
  const body = (await r.json()) as any;
  if (r.status !== 201) throw new Error(`seller refused the claim (${r.status}): ${JSON.stringify(body)}`);
  return body as { requestId: string; receivedAt: string; note: string };
}
