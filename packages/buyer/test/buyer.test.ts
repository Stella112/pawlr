import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatTransport, RawResponse } from "@pawlr/verifier";
import { admin, paymentHeaderFor, setup } from "../../../apps/seller/test/helpers.js";
import {
  BuyerConfigError,
  KpassPayer,
  Ledger,
  agreeSession,
  buildConditions,
  checkChallenge,
  fetchSellerInfo,
  loadSpendLimits,
  parseDocument,
  runTicks,
  type Payer,
  type PayRequest,
  type PayResult,
} from "../src/index.js";

/**
 * End-to-end buyer tests against the REAL seller app and REAL verifier, in
 * memory. TEST DOUBLES (no network, no money): the facilitator (from the
 * seller helpers), the payer (does the x402 exchange the way kpass does),
 * and the SERV judge (returns the real response shape with a ruling
 * derived from the output).
 */

const DOC = `# Refunds
Customers may request a refund within 30 days of purchase. Refunds are paid to the original payment method within 14 days of approval.

# Shipping
Shipping is free on orders over 50 dollars. Standard delivery takes 3 to 5 business days, and express delivery takes 1 to 2 business days.

# Returns
Customers return items by post within 30 days. Returned items must be unused and in their original packaging.
`;
const BASE = "http://seller.test";

/** TEST DOUBLE payer: performs the x402 exchange against the seller app, like kpass would. */
class SellerPayer implements Payer {
  calls: PayRequest[] = [];
  crash: "none" | "after-serve" | "before-send" = "none";
  constructor(private app: ReturnType<typeof setup>["app"]) {}
  async pay(req: PayRequest): Promise<PayResult> {
    this.calls.push(req);
    if (this.crash === "before-send") throw new Error("SIMULATED crash before the payment was sent");
    const path = req.url.replace(BASE, "");
    const unpaid = await this.app.request(path, { headers: req.headers });
    const paid = await this.app.request(path, { headers: { ...req.headers, "payment-signature": paymentHeaderFor(unpaid.headers.get("payment-required")!) } });
    const body = await paid.json();
    if (this.crash === "after-serve") throw new Error("SIMULATED crash after the seller served and settled");
    return paid.ok ? { kind: "paid", status: paid.status, body, raw: body } : { kind: "not-charged", errorCode: `http_${paid.status}`, message: JSON.stringify(body), raw: body };
  }
}

/** TEST DOUBLE SERV judge: real response shape (from captured fixture honest.json), ruling derived from the output. */
const honestFixture = JSON.parse(readFileSync(new URL("../../verifier/test/fixtures/captured/honest.json", import.meta.url), "utf8"));
const judge: ChatTransport = async (body: any): Promise<RawResponse> => {
  const output = /<seller_output>([\s\S]*)<\/seller_output>/.exec(body.messages[1].content)![1]!;
  const inj = /ignore previous instructions/i.exec(output);
  const ruling = inj
    ? { verdict: "fail", quote: output.slice(inj.index, inj.index + 28), reason: "Contains an instruction aimed at the judge." }
    : { verdict: "pass", quote: output.slice(0, 30), reason: "Summarises the section." };
  const b = structuredClone(honestFixture.recorded[0].response.body);
  b.choices[0].message.content = JSON.stringify(ruling);
  return { status: 200, body: b, latencyMs: 1 };
};

async function world(opts: { maxTicks?: number; env?: Record<string, string>; fetchWrap?: (f: typeof fetch) => typeof fetch } = {}) {
  const s = setup({ env: { PUBLIC_BASE_URL: BASE } });
  // The seller helpers' PAY_TO; the buyer reads it from /health like a real buyer.
  let f: typeof fetch = ((url: any, init?: any) => s.app.request(String(url).replace(BASE, ""), init)) as typeof fetch;
  if (opts.fetchWrap) f = opts.fetchWrap(f);
  const seller = { ...(await fetchSellerInfo(BASE, f)), baseUrl: BASE };
  const sections = parseDocument(DOC);
  const limits = loadSpendLimits(opts.env ?? { MAX_SPEND: "0.01", MAX_PER_TICK: "0.001" }, "testnet");
  const conditions = buildConditions(seller, sections, { maxTicks: opts.maxTicks ?? 5, maxSpend: limits.maxSpend });
  const conditionsHash = await agreeSession(seller, conditions, sections, f);
  const payer = new SellerPayer(s.app);
  const dataDir = mkdtempSync(join(tmpdir(), "pawlr-buyer-test-"));
  const go = () => runTicks({ seller, conditions, conditionsHash, sections, limits }, { payer, verifier: { serv: judge, sleep: async () => {} }, fetch: f, dataDir });
  return { s, payer, conditions, conditionsHash, dataDir, go };
}

describe("document", () => {
  it("splits Markdown headings into named, hashed sections with key terms", () => {
    const secs = parseDocument(DOC);
    expect(secs.map((x) => x.name)).toEqual(["Refunds", "Shipping", "Returns"]);
    expect(secs[0]!.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(secs[0]!.keyTerms[0]).toBe("refund");
    expect(() => parseDocument("no headings")).toThrow();
  });
});

describe("tick loop", () => {
  it("5 honest ticks: all pass, 5 payments, settlement tx recorded, receipt totals", async () => {
    const w = await world();
    const r = await w.go();
    expect(r.receipt.ticks.map((t) => t.verdict)).toEqual(["pass", "pass", "pass", "pass", "pass"]);
    expect(w.payer.calls).toHaveLength(5);
    expect(w.s.fac.calls.settle).toBe(5);
    expect(r.receipt).toMatchObject({ ticksPaid: 5, ticksRefused: 0, ticksInReview: 0, totalPaid: "0.005", maxLossBound: "0.001" });
    expect(r.receipt.ticks[0]!.payment.txHash).toBe("0xTESTDOUBLE0001");
    expect(r.stoppedBecause).toBe("all ticks done");
  });

  it.each(["injection", "junk", "empty", "stale"])("SIMULATED %s from tick 3: exactly one bad tick is paid, then the loop pauses with a reason", async (mode) => {
    const w = await world();
    await w.s.app.request("/admin/failure", admin({ sessionId: w.conditions.sessionId, mode, fromTick: 3 }));
    const r = await w.go();
    expect(r.receipt.ticks.map((t) => t.verdict)).toEqual(["pass", "pass", "fail"]);
    expect(w.payer.calls).toHaveLength(3); // tick 3 paid once, ticks 4 and 5 never paid
    expect(w.s.fac.calls.settle).toBe(3);
    expect(r.stoppedBecause).toMatch(/^PAUSED at tick 3/);
    expect(r.receipt.ticks[2]!.reason.length).toBeGreaterThan(5);
    expect(r.receipt.ticksPaid).toBe(3);
  });

  it("stops before paying when the next tick would exceed MAX_SPEND", async () => {
    const w = await world({ env: { MAX_SPEND: "0.002", MAX_PER_TICK: "0.001" } });
    const r = await w.go();
    expect(w.payer.calls).toHaveLength(2);
    expect(r.stoppedBecause).toMatch(/spend cap/);
  });
});

describe("payee and amount checks (abort without paying)", () => {
  const tamper = (patch: Record<string, string>) => (f: typeof fetch) =>
    (async (url: any, init?: any) => {
      const res = await f(url, init);
      const h = res.headers.get("payment-required");
      if (!h) return res;
      const j = JSON.parse(Buffer.from(h, "base64").toString());
      j.accepts = j.accepts.map((a: any) => ({ ...a, ...patch }));
      const headers = new Headers(res.headers);
      headers.set("payment-required", Buffer.from(JSON.stringify(j)).toString("base64"));
      return new Response(await res.text(), { status: res.status, headers });
    }) as typeof fetch;

  it.each([
    ["payee", { payTo: "0x" + "99".repeat(20) }],
    ["network", { network: "eip155:2366" }],
    ["amount", { amount: "2000000000000000" }],
  ])("a changed %s in the 402 challenge aborts before any payment", async (_name, patch) => {
    const w = await world({ fetchWrap: tamper(patch) });
    const r = await w.go();
    expect(r.stoppedBecause).toMatch(/^ABORT before paying tick 1/);
    expect(w.payer.calls).toHaveLength(0);
    expect(w.s.fac.calls.verify).toBe(0);
  });

  it("checkChallenge accepts a cheaper amount", () => {
    const c = { network: "eip155:2368", seller: { payTo: "0xAA" }, asset: "0xBB", pricePerTick: "0.001" } as any;
    expect(checkChallenge([{ scheme: "exact", network: "eip155:2368", payTo: "0xaa", asset: "0xbb", amount: "999" }], c).ok).toBe(true);
  });
});

describe("never two payments for the same tick", () => {
  it("crash after the seller served tick 1: the rerun recovers it from the evidence route and does not pay it again", async () => {
    const w = await world({ maxTicks: 2 });
    w.payer.crash = "after-serve";
    await expect(w.go()).rejects.toThrow(/SIMULATED crash/);
    const led = JSON.parse(readFileSync(join(w.dataDir, "ledger", `${w.conditions.sessionId}.json`), "utf8"));
    expect(led.ticks["1"].state).toBe("paying");

    w.payer.crash = "none";
    const r = await w.go();
    const tick1Payments = w.payer.calls.filter((c) => c.url.endsWith("/1"));
    expect(tick1Payments).toHaveLength(1);
    expect(w.s.fac.calls.settle).toBe(2); // tick 1 once, tick 2 once
    expect(r.receipt.ticks.map((t) => t.verdict)).toEqual(["pass", "pass"]);
  });

  it("crash before the payment was sent: the rerun retries once with the SAME idempotency key", async () => {
    const w = await world({ maxTicks: 1 });
    w.payer.crash = "before-send";
    await expect(w.go()).rejects.toThrow(/SIMULATED crash/);
    w.payer.crash = "none";
    await w.go();
    expect(w.payer.calls).toHaveLength(2);
    expect(w.payer.calls[0]!.idempotencyKey).toBe(w.payer.calls[1]!.idempotencyKey);
    expect(w.s.fac.calls.settle).toBe(1);
  });

  it("the ledger refuses to start a second payment for a tick", () => {
    const dir = mkdtempSync(join(tmpdir(), "pawlr-ledger-"));
    const l = new Ledger(dir, "s1", "h".repeat(64));
    l.beginPayment(1, "u");
    expect(() => l.beginPayment(1, "u")).toThrow(/refusing to start a second payment/);
    expect(() => new Ledger(dir, "s1", "x".repeat(64))).toThrow(/different conditionsHash/);
  });
});

describe("spend guards", () => {
  it("mainnet refuses to start without MAX_SPEND and MAX_PER_TICK", () => {
    expect(() => loadSpendLimits({}, "mainnet")).toThrow(BuyerConfigError);
    expect(() => loadSpendLimits({ MAX_SPEND: "1" }, "mainnet")).toThrow(BuyerConfigError);
    expect(loadSpendLimits({ MAX_SPEND: "1", MAX_PER_TICK: "0.01" }, "mainnet")).toEqual({ maxSpend: "1", maxPerTick: "0.01" });
  });
  it("refuses a seller price above MAX_PER_TICK", async () => {
    const w = await world({ env: { MAX_SPEND: "0.01", MAX_PER_TICK: "0.0005" } });
    await expect(w.go()).rejects.toThrow(/above MAX_PER_TICK/);
    expect(w.payer.calls).toHaveLength(0);
  });
});

describe("KpassPayer output parsing (fake kpass binary prints the JSON)", () => {
  const script = new URL("./fake-kpass.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const runWith = async (json: unknown, exit: number) => {
    const f = join(mkdtempSync(join(tmpdir(), "kp-")), "out.json");
    writeFileSync(f, JSON.stringify(json));
    process.env.FAKE_KPASS_OUT = f;
    process.env.FAKE_KPASS_EXIT = String(exit);
    return new KpassPayer({ bin: process.execPath, prefixArgs: [script] }).pay({ url: "https://x/tick/s/1", headers: {}, idempotencyKey: "k" });
  };

  it("real captured refusal (payment_target_forbidden, exit 6) -> not-charged", async () => {
    const cap = JSON.parse(readFileSync(new URL("./fixtures/kite/execute-2026-11-13-probe-40374aa0.json", import.meta.url), "utf8"));
    const r = await runWith(cap.output, 6);
    expect(r).toMatchObject({ kind: "not-charged", errorCode: "payment_target_forbidden" });
  });

  it("documented success shape (Kite x402-execute reference, not yet captured live) -> paid with the merchant body", async () => {
    const r = await runWith({ status: "success", x402: { status_code: 200, response_body: '{"tick":1}', parsed_response_body: { tick: 1 } } }, 0);
    expect(r).toMatchObject({ kind: "paid", status: 200, body: { tick: 1 } });
  });

  it("documented exit 7 (payment outcome pending) -> uncertain, never retried with a new key", async () => {
    const r = await runWith({ status: "error", error_code: "payment_outcome_pending", error: "pending", details: { tx_hash: "0xabc" } }, 7);
    expect(r).toMatchObject({ kind: "uncertain", txHash: "0xabc" });
  });
});
