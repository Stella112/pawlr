// Phase 1b live probe: pay ONE real testnet tick through Kite Passport (sandbox).
// Run from the repo root (kpass keeps its login here):
//   node scripts/probe/kite-tick.mjs [sellerBaseUrl]
//
// Steps: agree a session with the seller, read the unpaid 402 and check payee,
// network and amount against the agreed conditions, then pay once with
// `kpass session execute` (commands from `kpass --help`, v6.13.2). The full
// kpass JSON output is saved, with any token-like fields redacted.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { KITE_TESTNET, sha256Hex, hashConditions, toBaseUnits, CONDITIONS_HASH_HEADER } from "../../packages/protocol/dist/index.js";

const SELLER = process.argv[2] || "https://pawlr.16-61-50-207.sslip.io";
const KPASS = join(homedir(), ".kpass", "bin", process.platform === "win32" ? "kpass.exe" : "kpass");
const PRICE = "0.001";
const OUT_DIR = join("packages", "buyer", "test", "fixtures", "kite");
mkdirSync(OUT_DIR, { recursive: true });

const redact = (v) =>
  JSON.parse(JSON.stringify(v), (k, val) => (typeof val === "string" && /token|jwt|secret|private|signature|authorization/i.test(k) ? "[REDACTED]" : val));

// 1. Agree a session.
const health = await (await fetch(`${SELLER}/health`)).json();
const sections = [
  { name: "Refunds", text: "Customers may request a refund within 30 days of purchase. Refunds are paid to the original payment method within 14 days of approval. Opened digital downloads are refundable only if the file is faulty." },
];
const conditions = {
  version: "pawlr/1",
  sessionId: "probe-" + randomUUID().slice(0, 8),
  task: "Summarise each section of the supplied document",
  seller: { payTo: health.payTo, endpoint: `${SELLER}/tick` },
  network: KITE_TESTNET.network,
  asset: KITE_TESTNET.assetAddress,
  pricePerTick: PRICE,
  maxTicks: 1,
  maxSpend: PRICE,
  presence: { maxAgeSeconds: 300 },
  completion: { minSentences: 1, maxSentences: 3, minKeyTerms: 3 },
  relevance: { rule: "output must summarise the named section of the agreed document" },
  document: { sections: sections.map((s) => ({ name: s.name, sourceHash: sha256Hex(s.text) })) },
};
const created = await fetch(`${SELLER}/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conditions, sections }) });
const session = await created.json();
console.log("POST /sessions", created.status, JSON.stringify(session));
if (session.conditionsHash !== hashConditions(conditions)) throw new Error("ABORT: seller conditionsHash differs from ours");

// 2. Read the 402 challenge and check it BEFORE paying.
const url = `${SELLER}/tick/${session.sessionId}/1`;
const unpaid = await fetch(url, { headers: { [CONDITIONS_HASH_HEADER]: session.conditionsHash } });
const challenge = JSON.parse(Buffer.from(unpaid.headers.get("payment-required"), "base64").toString());
const offer = challenge.accepts[0];
console.log("unpaid", unpaid.status, JSON.stringify(offer));
const want = toBaseUnits(PRICE, KITE_TESTNET.assetDecimals).toString();
if (unpaid.status !== 402) throw new Error("ABORT: expected 402");
if (offer.payTo.toLowerCase() !== conditions.seller.payTo.toLowerCase()) throw new Error("ABORT: payee mismatch");
if (offer.network !== conditions.network) throw new Error("ABORT: network mismatch");
if (BigInt(offer.amount) > BigInt(want)) throw new Error("ABORT: amount above pricePerTick");
console.log("challenge OK: payee, network and amount match the agreed conditions");

// 3. Pay once.
const idempotencyKey = `pawlr-${session.sessionId}-1`;
const started = Date.now();
let raw;
try {
  raw = execFileSync(
    KPASS,
    ["session", "execute", "--url", url, "--method", "GET", "--headers", JSON.stringify({ [CONDITIONS_HASH_HEADER]: session.conditionsHash }), "--idempotency-key", idempotencyKey, "--no-interactive", "--output", "json"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
} catch (err) {
  raw = (err.stdout || "") + (err.stderr || "");
  console.log("kpass exit code", err.status);
}
const latencyMs = Date.now() - started;
let out;
try { out = JSON.parse(raw); } catch { out = { unparsed: raw }; }
const file = join(OUT_DIR, `execute-${new Date().toISOString().slice(0, 10)}-${session.sessionId}.json`);
writeFileSync(file, JSON.stringify({ capturedAt: new Date().toISOString(), source: "live kpass 6.13.2 session execute (sandbox)", url, idempotencyKey, latencyMs, output: redact(out) }, null, 2) + "\n");
console.log(`\nkpass output (${latencyMs} ms), saved to ${file}:`);
console.log(JSON.stringify(redact(out), null, 2).slice(0, 4000));
