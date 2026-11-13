import { CONDITIONS_HASH_HEADER, kiteChainByNetwork, toBaseUnits, type DeliveryConditions } from "@pawlr/protocol";

/** One entry of `accepts` in an x402 v2 challenge (shape captured 2026-11-12, docs/integration-notes.md §2). */
export interface PaymentOffer {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

export class ChallengeError extends Error {}

/** Asks for the tick without paying and returns the decoded PAYMENT-REQUIRED challenge. Free. */
export async function readChallenge(url: string, conditionsHash: string, fetchImpl: typeof fetch = fetch): Promise<PaymentOffer[]> {
  const res = await fetchImpl(url, { headers: { [CONDITIONS_HASH_HEADER]: conditionsHash } });
  if (res.status !== 402) {
    const body = await res.text().catch(() => "");
    throw new ChallengeError(`expected 402 from the seller, got ${res.status}: ${body.slice(0, 200)}`);
  }
  const header = res.headers.get("payment-required");
  if (!header) throw new ChallengeError("402 without a PAYMENT-REQUIRED header");
  let decoded: { accepts?: PaymentOffer[] };
  try {
    decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    throw new ChallengeError("PAYMENT-REQUIRED header is not base64 JSON");
  }
  if (!Array.isArray(decoded.accepts) || !decoded.accepts.length) throw new ChallengeError("challenge has no accepts");
  return decoded.accepts;
}

/**
 * agent.md §10.1: before paying, the payee and network must equal the agreed
 * conditions, and the amount must be no more than pricePerTick. Kite Passport
 * sessions cannot be pinned to one payee (no such field in the delegation), so
 * this check is Pawlr's.
 */
export function checkChallenge(offers: PaymentOffer[], conditions: DeliveryConditions): { ok: true; offer: PaymentOffer } | { ok: false; reason: string } {
  const chain = kiteChainByNetwork(conditions.network);
  if (!chain) return { ok: false, reason: `unknown network ${conditions.network}` };
  const maxUnits = toBaseUnits(conditions.pricePerTick, chain.assetDecimals);
  const problems: string[] = [];
  for (const o of offers) {
    const p: string[] = [];
    if (o.network !== conditions.network) p.push(`network ${o.network} is not ${conditions.network}`);
    if (o.payTo.toLowerCase() !== conditions.seller.payTo.toLowerCase()) p.push(`payee ${o.payTo} is not ${conditions.seller.payTo}`);
    if (o.asset.toLowerCase() !== conditions.asset.toLowerCase()) p.push(`asset ${o.asset} is not ${conditions.asset}`);
    let units: bigint | null = null;
    try {
      units = BigInt(o.amount);
    } catch {
      p.push(`amount "${o.amount}" is not an integer`);
    }
    if (units !== null && units > maxUnits) p.push(`amount ${o.amount} is above pricePerTick (${maxUnits} base units)`);
    if (!p.length) return { ok: true, offer: o };
    problems.push(p.join("; "));
  }
  return { ok: false, reason: problems.join(" | ") };
}
