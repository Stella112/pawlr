import { describe, expect, it } from "vitest";
import { CONDITIONS_HASH_HEADER, KITE_TESTNET, hashConditions, sha256Hex } from "@pawlr/protocol";
import { ConfigError, INJECTION_TEXT, loadConfig } from "../src/index.js";
import { ADMIN, PAY_TO, SECTIONS, admin, createSession, makeConditions, paymentHeaderFor, setup, unb64json } from "./helpers.js";

/** Asks for tick n without paying, then pays (via the facilitator test double) and returns the paid response. */
async function payTick(s: ReturnType<typeof setup>, sessionId: string, hash: string, n: number) {
  const unpaid = await s.app.request(`/tick/${sessionId}/${n}`, { headers: { [CONDITIONS_HASH_HEADER]: hash } });
  expect(unpaid.status).toBe(402);
  const required = unpaid.headers.get("payment-required");
  expect(required).toBeTruthy();
  return s.app.request(`/tick/${sessionId}/${n}`, {
    headers: { [CONDITIONS_HASH_HEADER]: hash, "payment-signature": paymentHeaderFor(required!) },
  });
}

describe("config: mainnet guards", () => {
  const good = { KITE_NETWORK: "mainnet", SELLER_PAY_TO: PAY_TO, PRICE_PER_TICK: "0.01", ADMIN_PASSWORD: "a-long-enough-password!" };

  it("accepts a sane mainnet config", () => {
    expect(loadConfig(good).chain.network).toBe("eip155:2366");
  });
  it("refuses a placeholder receiving address", () => {
    expect(() => loadConfig({ ...good, SELLER_PAY_TO: "0x0000000000000000000000000000000000000000" })).toThrow(ConfigError);
  });
  it("refuses a price above 0.05 per tick", () => {
    expect(() => loadConfig({ ...good, PRICE_PER_TICK: "0.050001" })).toThrow(/above 0.05/);
    expect(() => loadConfig({ ...good, PRICE_PER_TICK: "0.0500001" })).toThrow(ConfigError);
    expect(loadConfig({ ...good, PRICE_PER_TICK: "0.05" }).pricePerTick).toBe("0.05");
  });
  it("refuses an admin password shorter than 16 characters", () => {
    expect(() => loadConfig({ ...good, ADMIN_PASSWORD: "fifteen-chars!!" })).toThrow(/16/);
  });
  it("still requires an admin password and a real address on testnet", () => {
    expect(() => loadConfig({ ...good, KITE_NETWORK: "testnet", ADMIN_PASSWORD: "" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...good, KITE_NETWORK: "testnet", SELLER_PAY_TO: "nope" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...good, KITE_NETWORK: "testnet", SELLER_PAY_TO: "0x0000000000000000000000000000000000000000" })).toThrow(/placeholder/);
  });
});

describe("sessions", () => {
  it("returns the canonical conditions hash", async () => {
    const s = setup();
    const { res, body, conditions } = await createSession(s.app);
    expect(res.status).toBe(201);
    expect(body.conditionsHash).toBe(hashConditions(conditions));
  });

  it("refuses conditions that do not match the seller or the section texts", async () => {
    const s = setup();
    const tampered = SECTIONS.map((x, i) => (i === 0 ? { ...x, text: x.text + " Extra." } : x));
    const r1 = await createSession(s.app, makeConditions(), tampered);
    expect(r1.res.status).toBe(422);
    expect(r1.body.problems?.join()).toMatch(/sourceHash/);
    const r2 = await createSession(s.app, makeConditions({ pricePerTick: "0.002" }));
    expect(r2.res.status).toBe(422);
    const r3 = await createSession(s.app, makeConditions({ network: "eip155:2366" }));
    expect(r3.res.status).toBe(422);
  });
});

describe("paywall", () => {
  it("answers an unpaid tick with 402 and never reaches the tick handler", async () => {
    const s = setup();
    const { body } = await createSession(s.app);
    const res = await s.app.request(`/tick/${body.sessionId}/1`, { headers: { [CONDITIONS_HASH_HEADER]: body.conditionsHash } });
    expect(res.status).toBe(402);
    expect(s.tickCalls()).toBe(0);
    const required = unb64json(res.headers.get("payment-required")!);
    expect(required.x402Version).toBe(2);
    const a = required.accepts[0];
    expect(a).toMatchObject({ scheme: "exact", network: "eip155:2368", asset: KITE_TESTNET.assetAddress, payTo: PAY_TO, amount: "1000000000000000" });
    expect(s.fac.calls.verify).toBe(0);
    expect(s.fac.calls.settle).toBe(0);
  });

  it("rejects invalid tick requests with 403 before any payment is asked for, verified or settled", async () => {
    const s = setup();
    const { body } = await createSession(s.app);
    const paidHeader = paymentHeaderFor((await s.app.request(`/tick/${body.sessionId}/1`, { headers: { [CONDITIONS_HASH_HEADER]: body.conditionsHash } })).headers.get("payment-required")!);
    const cases = [
      { path: `/tick/no-such-session/1`, hash: body.conditionsHash },
      { path: `/tick/${body.sessionId}/1`, hash: "0".repeat(64) },
      { path: `/tick/${body.sessionId}/2`, hash: body.conditionsHash },
      { path: `/tick/${body.sessionId}/99`, hash: body.conditionsHash },
    ];
    for (const c of cases) {
      const res = await s.app.request(c.path, { headers: { [CONDITIONS_HASH_HEADER]: c.hash, "payment-signature": paidHeader } });
      expect(res.status, c.path).toBe(403);
    }
    expect(s.fac.calls.verify).toBe(0);
    expect(s.fac.calls.settle).toBe(0);
    expect(s.tickCalls()).toBe(0);
  });

  it("serves a paid tick with full evidence and settles exactly once", async () => {
    const s = setup();
    const { body } = await createSession(s.app);
    const res = await payTick(s, body.sessionId, body.conditionsHash, 1);
    expect(res.status).toBe(200);
    const ev = await res.json();
    expect(Object.keys(ev).sort()).toEqual(["conditionsHash", "output", "outputHash", "sectionName", "sessionId", "sourceHash", "tick", "timestamp"]);
    expect(ev).toMatchObject({ sessionId: body.sessionId, tick: 1, sectionName: "Refunds", conditionsHash: body.conditionsHash, sourceHash: sha256Hex(SECTIONS[0]!.text) });
    expect(ev.outputHash).toBe(sha256Hex(ev.output));
    expect(s.fac.calls.verify).toBe(1);
    expect(s.fac.calls.settle).toBe(1);
    const receipt = unb64json(res.headers.get("payment-response")!);
    expect(receipt.transaction).toBe("0xTESTDOUBLE0001");
    // The settlement is recorded and shown with the evidence.
    const read = await (await s.app.request(`/sessions/${body.sessionId}/evidence/1`)).json();
    expect(read.settlement.transaction).toBe("0xTESTDOUBLE0001");
  });

  it("does not settle when the tick handler fails (error status, buyer not charged)", async () => {
    const s = setup({ summarizerFails: true });
    const { body } = await createSession(s.app);
    const res = await payTick(s, body.sessionId, body.conditionsHash, 1);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(s.fac.calls.verify).toBe(1);
    expect(s.fac.calls.settle).toBe(0);
    // The tick was not served, so the same tick can be requested again.
    expect(s.store.getSession(body.sessionId)!.lastServedTick).toBe(0);
  });

  it("will not serve the same tick twice", async () => {
    const s = setup();
    const { body } = await createSession(s.app);
    expect((await payTick(s, body.sessionId, body.conditionsHash, 1)).status).toBe(200);
    const again = await s.app.request(`/tick/${body.sessionId}/1`, { headers: { [CONDITIONS_HASH_HEADER]: body.conditionsHash } });
    expect(again.status).toBe(403);
    expect(s.fac.calls.settle).toBe(1);
  });
});

describe("failure switch (SIMULATED failures) and truth log", () => {
  it("needs the admin password", async () => {
    const s = setup();
    const { body } = await createSession(s.app);
    const req = { sessionId: body.sessionId, mode: "empty", fromTick: 2 };
    expect((await s.app.request("/admin/failure", { method: "POST", body: JSON.stringify(req) })).status).toBe(401);
    expect((await s.app.request("/admin/failure", admin(req, "wrong-password-xxxxxx"))).status).toBe(401);
    expect((await s.app.request("/admin/failure", admin(req))).status).toBe(200);
  });

  it("degrades output from the chosen tick, never reveals it in the response, and the truth log matches what was served", async () => {
    const s = setup();
    const { body } = await createSession(s.app);
    await s.app.request("/admin/failure", admin({ sessionId: body.sessionId, mode: "injection", fromTick: 2 }));

    const served = [];
    for (const n of [1, 2]) {
      const res = await payTick(s, body.sessionId, body.conditionsHash, n);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toMatch(/simulat|failure|injection|mode/i);
      served.push(JSON.parse(text));
    }
    expect(served[0].output).not.toContain(INJECTION_TEXT);
    expect(served[1].output).toContain(INJECTION_TEXT);

    const truth = s.store.readTruth(body.sessionId);
    expect(truth.map((t) => t.served)).toEqual(["honest", "injection"]);
    expect(truth.map((t) => t.evidence)).toEqual(served);
  });

  it.each([
    ["junk", (o: string) => o.length > 0 && !o.includes("Summary of")],
    ["off-topic", (o: string) => /weather/.test(o)],
    ["empty", (o: string) => o === ""],
    ["subtle", (o: string) => o.startsWith("Summary of Shipping")],
  ] as const)("mode %s changes the output", async (mode, check) => {
    const s = setup();
    const { body } = await createSession(s.app);
    await s.app.request("/admin/failure", admin({ sessionId: body.sessionId, mode, fromTick: 1 }));
    const ev = await (await payTick(s, body.sessionId, body.conditionsHash, 1)).json();
    expect(ev.sectionName).toBe("Refunds");
    expect(check(ev.output)).toBe(true);
    expect(s.store.readTruth(body.sessionId)[0]!.served).toBe(mode);
  });

  it("mode stale backdates the evidence beyond maxAgeSeconds", async () => {
    const s = setup();
    const { body, conditions } = await createSession(s.app);
    await s.app.request("/admin/failure", admin({ sessionId: body.sessionId, mode: "stale", fromTick: 1 }));
    const ev = await (await payTick(s, body.sessionId, body.conditionsHash, 1)).json();
    const ageSeconds = (Date.now() - Date.parse(ev.timestamp)) / 1000;
    expect(ageSeconds).toBeGreaterThan(conditions.presence.maxAgeSeconds);
  });
});

describe("evidence, add-evidence and refund inbox", () => {
  it("serves stored evidence, lets only the admin add to it, and stores refund requests", async () => {
    const s = setup();
    const { body } = await createSession(s.app);
    const ev = await (await payTick(s, body.sessionId, body.conditionsHash, 1)).json();

    const read = await (await s.app.request(`/sessions/${body.sessionId}/evidence/1`)).json();
    expect(read.evidence).toEqual(ev);

    const add = { note: "Section was summarised from the agreed text." };
    expect((await s.app.request(`/sessions/${body.sessionId}/evidence/1`, { method: "POST", body: JSON.stringify(add) })).status).toBe(401);
    expect((await s.app.request(`/sessions/${body.sessionId}/evidence/1`, admin(add))).status).toBe(201);
    expect((await (await s.app.request(`/sessions/${body.sessionId}/evidence/1`)).json()).added).toHaveLength(1);

    const claim = { sessionId: body.sessionId, conditionsHash: body.conditionsHash, ticks: [1], amountOwed: "0.001", summary: "Tick 1 failed.", evidence: [{ tick: 1, quote: "x", reason: "y" }] };
    const r = await s.app.request(`/sessions/${body.sessionId}/refund-requests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(claim) });
    expect(r.status).toBe(201);
    const rb = await r.json();
    expect(rb.requestId).toMatch(/[0-9a-f-]{36}/);
    expect(rb.note).toBe("Refund requested. Money is not returned automatically.");
    expect(s.store.getRefundRequests(body.sessionId)).toHaveLength(1);
  });
});

describe("summary cache", () => {
  it("summarises each section once, across sessions", async () => {
    const s = setup();
    for (let i = 0; i < 2; i++) {
      const { body } = await createSession(s.app);
      await payTick(s, body.sessionId, body.conditionsHash, 1);
    }
    expect(s.sum.calls).toEqual(["Refunds"]);
  });
});

describe("health", () => {
  it("reports version and network", async () => {
    const s = setup();
    const h = await (await s.app.request("/health")).json();
    expect(h).toMatchObject({ ok: true, network: "eip155:2368", asset: "pieUSD", version: expect.any(String) });
    void ADMIN;
  });
});
