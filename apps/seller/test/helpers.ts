import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FacilitatorClient } from "@x402/core/server";
import { KITE_TESTNET, sha256Hex, type DeliveryConditions } from "@pawlr/protocol";
import { CachedSummarizer, createPublicApp, createTickService, loadConfig, Store, type Summarizer } from "../src/index.js";

export const ADMIN = "test-admin-password-0123";
export const PAY_TO = "0x" + "ab".repeat(20);

/**
 * TEST DOUBLE (not a real integration): stands in for the Pieverse
 * facilitator so tests never touch a network or move money. getSupported
 * returns the kind the live facilitator listed for Kite testnet on
 * 2026-11-12 (x402Version 2, scheme "exact", network "eip155:2368").
 */
export function fakeFacilitator() {
  const calls = { verify: 0, settle: 0, supported: 0 };
  const client: FacilitatorClient = {
    async getSupported() {
      calls.supported++;
      return { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:2368" }], extensions: [], signers: {} };
    },
    async verify() {
      calls.verify++;
      return { isValid: true, payer: "0x" + "cd".repeat(20) };
    },
    async settle(_payload, req) {
      calls.settle++;
      return { success: true, transaction: "0xTESTDOUBLE" + String(calls.settle).padStart(4, "0"), network: req.network, payer: "0x" + "cd".repeat(20) };
    },
  };
  return { client, calls };
}

/** TEST DOUBLE summarizer: deterministic, no SERV call. */
export function fakeSummarizer(opts: { fail?: boolean } = {}) {
  const calls: string[] = [];
  const s: Summarizer = {
    async summarize(name, text) {
      calls.push(name);
      if (opts.fail) throw new Error("summarizer down");
      return `Summary of ${name}: ${text.split(".")[0]}.`;
    },
  };
  return { summarizer: s, calls };
}

export const SECTIONS = [
  { name: "Refunds", text: "Customers may request a refund within 30 days of purchase. Refunds are paid within 14 days." },
  { name: "Shipping", text: "Shipping is free on orders over 50 dollars. Express delivery takes 1 to 2 business days." },
];

export function makeConditions(overrides: Partial<DeliveryConditions> = {}, sections = SECTIONS): DeliveryConditions {
  return {
    version: "pawlr/1",
    sessionId: "sess-" + randomUUID().slice(0, 8),
    task: "Summarise each section of the supplied document",
    seller: { payTo: PAY_TO, endpoint: "https://seller.example/tick" },
    network: "eip155:2368",
    asset: KITE_TESTNET.assetAddress,
    pricePerTick: "0.001",
    maxTicks: 4,
    maxSpend: "0.004",
    presence: { maxAgeSeconds: 120 },
    completion: { minSentences: 1, maxSentences: 3, minKeyTerms: 3 },
    relevance: { rule: "output must summarise the named section of the agreed document" },
    document: { sections: sections.map((s) => ({ name: s.name, sourceHash: sha256Hex(s.text) })) },
    ...overrides,
  };
}

export function setup(opts: { summarizerFails?: boolean; env?: Record<string, string> } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "pawlr-seller-test-"));
  const config = loadConfig({
    KITE_NETWORK: "testnet",
    SELLER_PAY_TO: PAY_TO,
    PRICE_PER_TICK: "0.001",
    ADMIN_PASSWORD: ADMIN,
    DATA_DIR: dataDir,
    ...opts.env,
  });
  const store = new Store(dataDir);
  const fac = fakeFacilitator();
  const sum = fakeSummarizer({ fail: opts.summarizerFails });
  // Same wiring as main.ts: the summarizer sits behind the section-hash cache.
  const tickApp = createTickService({ store, summarizer: new CachedSummarizer(sum.summarizer, store, "test-double") });
  let tickCalls = 0;
  const app = createPublicApp({
    config,
    store,
    facilitator: fac.client,
    forwardTick: async (body) => {
      tickCalls++;
      return tickApp.request("/internal/tick", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    },
  });
  return { app, store, config, fac, sum, tickCalls: () => tickCalls };
}

export async function createSession(app: ReturnType<typeof setup>["app"], conditions = makeConditions(), sections = SECTIONS) {
  const res = await app.request("/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conditions, sections }),
  });
  return { res, body: (await res.json()) as { sessionId: string; conditionsHash: string; error?: string; problems?: string[] }, conditions };
}

export const b64json = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
export const unb64json = (s: string) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));

/** Builds a PAYMENT-SIGNATURE header from a 402 challenge. The facilitator test double accepts it. */
export function paymentHeaderFor(paymentRequiredHeader: string) {
  const required = unb64json(paymentRequiredHeader);
  return b64json({
    x402Version: required.x402Version,
    resource: required.resource,
    accepted: required.accepts[0],
    payload: { signature: "0xTESTSIG", authorization: { from: "0x" + "cd".repeat(20), to: PAY_TO, value: required.accepts[0].amount } },
  });
}

export function admin(body: unknown, password = ADMIN) {
  return {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${password}` },
    body: JSON.stringify(body),
  };
}
