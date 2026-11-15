// Owner step: ask Kite Passport for a spending session that the dashboard enforces.
// Run on a machine where `kpass` is logged in (sandbox on). Prints Kite's approval link,
// waits for the passkey approval, then saves Kite's approved session to data/passport/approved.json.
// Usage: node scripts/passport-request.mjs [--host pawlr.vercel.app] [--per-tx 0.001] [--total 0.5] [--ttl 604800]
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { PassportClient } from "../packages/buyer/dist/index.js";

const { values: v } = parseArgs({ options: { host: { type: "string", default: "pawlr.vercel.app" }, "per-tx": { type: "string", default: "0.001" }, total: { type: "string", default: "0.5" }, ttl: { type: "string", default: "604800" }, "request-id": { type: "string" } } });
const pc = new PassportClient();
let requestId = v["request-id"];
if (!requestId) {
  const r = await pc.request({ taskSummary: `Pawlr: pay ${v.host} one tick at a time, at most ${v["per-tx"]} per tick`, maxPerTx: v["per-tx"], maxTotal: v.total, ttlSeconds: Number(v.ttl), endpoint: { method: "GET", host: v.host, pathPrefix: "/tick/" } });
  requestId = r.requestId;
  console.log(`\nApprove with your passkey:\n${r.approvalUrl}\n\nrequest id: ${requestId}\n`);
}
for (let i = 0; i < 100; i++) {
  const st = await pc.status(requestId);
  if (st.state === "approved") {
    mkdirSync("data/passport", { recursive: true });
    writeFileSync("data/passport/approved.json", JSON.stringify({ requestId, approvedAt: new Date().toISOString(), kite: st.raw }, null, 1));
    console.log("approved:", JSON.stringify(st.session));
    process.exit(0);
  }
  if (st.state === "rejected" || st.state === "error") { console.log(st.state, JSON.stringify(st.raw).slice(0, 400)); process.exit(1); }
  await new Promise((r) => setTimeout(r, 5000));
}
console.log("still pending; rerun with --request-id", requestId);
