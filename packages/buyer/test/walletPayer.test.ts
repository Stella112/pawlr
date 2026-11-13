import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import type { ChatTransport, RawResponse } from "@pawlr/verifier";
import { admin, setup } from "../../../apps/seller/test/helpers.js";
import { WalletPayer, agreeSession, buildConditions, fetchSellerInfo, loadSpendLimits, parseDocument, runTicks } from "../src/index.js";

/**
 * Backup route: the REAL x402 client (@x402/fetch + @x402/evm, EIP-3009
 * signing with a throwaway key generated here) against the REAL seller app.
 * TEST DOUBLES: the facilitator (seller helpers; no chain, no money) and the
 * SERV judge.
 */

const BASE = "http://seller.test";
const DOC = `# Refunds
Customers may request a refund within 30 days of purchase. Refunds are paid to the original payment method within 14 days of approval.

# Shipping
Shipping is free on orders over 50 dollars. Standard delivery takes 3 to 5 business days, and express delivery takes 1 to 2 business days.
`;

const honest = JSON.parse(readFileSync(new URL("../../verifier/test/fixtures/captured/honest.json", import.meta.url), "utf8"));
const judge: ChatTransport = async (body: any): Promise<RawResponse> => {
  const out = /<seller_output>([\s\S]*)<\/seller_output>/.exec(body.messages[1].content)![1]!;
  const inj = /ignore previous instructions/i.exec(out);
  const ruling = inj ? { verdict: "fail", quote: out.slice(inj.index, inj.index + 28), reason: "Instruction aimed at the judge." } : { verdict: "pass", quote: out.slice(0, 30), reason: "Summarises the section." };
  const b = structuredClone(honest.recorded[0].response.body);
  b.choices[0].message.content = JSON.stringify(ruling);
  return { status: 200, body: b, latencyMs: 1 };
};

async function world(fetchWrap?: (f: typeof fetch) => typeof fetch) {
  const s = setup({ env: { PUBLIC_BASE_URL: BASE } });
  let f = ((input: any, init?: any) => s.app.request(input instanceof Request ? input : String(input).replace(BASE, ""), init)) as typeof fetch;
  if (fetchWrap) f = fetchWrap(f);
  const seller = { ...(await fetchSellerInfo(BASE, f)), baseUrl: BASE };
  const sections = parseDocument(DOC);
  const limits = loadSpendLimits({ MAX_SPEND: "0.01", MAX_PER_TICK: "0.001" }, "testnet");
  const conditions = buildConditions(seller, sections, { maxTicks: 4, maxSpend: limits.maxSpend });
  const conditionsHash = await agreeSession(seller, conditions, sections, f);
  const payer = new WalletPayer({ privateKey: generatePrivateKey(), conditions, fetchImpl: f });
  const go = () => runTicks({ seller, conditions, conditionsHash, sections, limits }, { payer, verifier: { serv: judge, sleep: async () => {} }, fetch: f, dataDir: mkdtempSync(join(tmpdir(), "pawlr-wallet-")) });
  return { s, conditions, payer, go };
}

describe("WalletPayer (direct x402, backup route)", () => {
  it("signs real EIP-3009 payments, the seller settles each tick once, tx hash comes from PAYMENT-RESPONSE", async () => {
    const w = await world();
    const r = await w.go();
    expect(r.receipt.ticks.map((t) => t.verdict)).toEqual(["pass", "pass", "pass", "pass"]);
    expect(w.s.fac.calls.verify).toBe(4);
    expect(w.s.fac.calls.settle).toBe(4);
    expect(r.receipt.ticks.map((t) => t.payment.txHash)).toEqual(["0xTESTDOUBLE0001", "0xTESTDOUBLE0002", "0xTESTDOUBLE0003", "0xTESTDOUBLE0004"]);
    expect(w.payer.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("SIMULATED injection from tick 2: one bad tick paid, then the loop pauses", async () => {
    const w = await world();
    await w.s.app.request("/admin/failure", admin({ sessionId: w.conditions.sessionId, mode: "injection", fromTick: 2 }));
    const r = await w.go();
    expect(r.receipt.ticks.map((t) => t.verdict)).toEqual(["pass", "fail"]);
    expect(w.s.fac.calls.settle).toBe(2);
  });

  it("the signing policy refuses a payee that differs from the agreed one, even if Pawlr's pre-check were bypassed", async () => {
    // Only the PAID request sees a tampered challenge: the policy is the last line.
    const w = await world();
    const tampered = new WalletPayer({ privateKey: generatePrivateKey(), conditions: { ...w.conditions, seller: { ...w.conditions.seller, payTo: "0x" + "99".repeat(20) } }, fetchImpl: ((input: any, init?: any) => w.s.app.request(input instanceof Request ? input : String(input).replace(BASE, ""), init)) as typeof fetch });
    const r = await tampered.pay({ url: `${BASE}/tick/${w.conditions.sessionId}/1`, headers: { "pawlr-conditions-hash": "x" }, idempotencyKey: "k" });
    expect(r.kind).toBe("not-charged");
    expect(w.s.fac.calls.verify).toBe(0);
  });

  it("refuses a malformed key", () => {
    expect(() => new WalletPayer({ privateKey: "0x123", conditions: {} as any })).toThrow(/BUYER_PRIVATE_KEY/);
  });
});
