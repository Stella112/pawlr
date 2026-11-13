// Phase 4 live probes against the Dolphin inference API.
// Run: node --env-file=.env scripts/probe/dolphin.mjs   (after `pnpm build`)
//
// Shapes from https://dphn.ai/docs/dphn-api (read 2026-11-14, see docs/integration-notes.md §4):
// base URL https://lighthouse.dphn.ai/run/text-v/v1, OpenAI-compatible, Bearer key,
// POST /chat/completions, GET /models, model deepseek-ai/DeepSeek-V4.1-Flash.
// Not documented: response_format / json_schema support, usage fields. This probe settles both.
// The API key is never printed or saved.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildRulingRequest } from "../../packages/verifier/dist/serv.js";

const BASE = "https://lighthouse.dphn.ai/run/text-v/v1";
const KEY = process.env.DOLPHIN_API_KEY;
const MODEL = process.env.DOLPHIN_MODEL || "deepseek-ai/DeepSeek-V4.1-Flash";
if (!KEY) throw new Error("DOLPHIN_API_KEY missing from .env");

const OUT_DIR = join("packages", "verifier", "test", "fixtures", "dolphin");
mkdirSync(OUT_DIR, { recursive: true });
const CAPTURED_AT = new Date().toISOString();

const SECTION_NAME = "Refunds";
const SECTION_TEXT =
  "Customers may request a refund within 30 days of purchase. Refunds are paid to the original payment method " +
  "within 14 days of approval. Digital downloads that have been opened are not eligible for a refund unless the " +
  "file is faulty. To start a refund, customers contact support with their order number.";
const OUTPUTS = {
  honest:
    "Customers can ask for a refund within 30 days of purchase, and approved refunds go back to the original payment " +
    "method within 14 days. Opened digital downloads are refundable only if the file is faulty.",
  offTopic: "Shipping is free on orders over 50 dollars, and express delivery takes 1 to 2 business days.",
};
const conditions = {
  task: "Summarise each section of the supplied document",
  relevance: { rule: "output must summarise the named section of the agreed document" },
  completion: { minSentences: 1, maxSentences: 3, minKeyTerms: 3 },
};

function rulingBody(output) {
  const b = buildRulingRequest({ conditions, sectionName: SECTION_NAME, sectionText: SECTION_TEXT, sellerOutput: output }, { model: MODEL, shadow: false });
  delete b.tools; // serv_* tools are SERV-only
  return b;
}

async function call(name, purpose, method, path, body) {
  const started = Date.now();
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch {}
  const headers = Object.fromEntries([...res.headers].filter(([k]) => !/cookie|authorization/i.test(k)));
  const fx = { capturedAt: CAPTURED_AT, source: "live Dolphin call, scripts/probe/dolphin.mjs", purpose, request: body ?? { method, path }, status: res.status, headers, latencyMs: Date.now() - started, body: parsed };
  writeFileSync(join(OUT_DIR, `${name}.json`), JSON.stringify(fx, null, 2));
  const c = parsed?.choices?.[0];
  console.log(`${name}: HTTP ${res.status} ${fx.latencyMs}ms finish=${c?.finish_reason} usage=${JSON.stringify(parsed?.usage)} content=${JSON.stringify(c?.message?.content)?.slice(0, 300)}`);
  return parsed;
}

const models = await call("d0_models", "GET /models", "GET", "/models");
console.log("models:", JSON.stringify(models?.data?.map?.((m) => m.id) ?? models).slice(0, 400));
await call("d1_ruling_honest", "structured ruling (json_schema), honest output", "POST", "/chat/completions", rulingBody(OUTPUTS.honest));
await call("d2_ruling_offtopic", "structured ruling (json_schema), off-topic output", "POST", "/chat/completions", rulingBody(OUTPUTS.offTopic));
