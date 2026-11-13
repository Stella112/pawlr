// Pawlr benchmark (agent.md §13). Real sessions against the live seller on Kite testnet:
// real on-chain payments, real SERV rulings. Failures are STAGED with the seller's failure switch.
//
//   node --env-file=.env apps/bench/dist/index.js            # prints the estimate only
//   node --env-file=.env apps/bench/dist/index.js --yes      # runs it
//
// Needs: BUYER_PRIVATE_KEY (funded with pUSD), SERV_API_KEY, ADMIN_PASSWORD (the seller's).
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { TickVerdict } from "@pawlr/protocol";
import { servTransport, type CostEntry } from "@pawlr/verifier";
import { WalletPayer, agreeSession, buildConditions, fetchSellerInfo, loadSpendLimits, parseDocument, runTicks } from "@pawlr/buyer";

const SCENARIOS = ["honest", "junk", "off-topic", "stale", "empty", "injection", "subtle"] as const;
type Scenario = (typeof SCENARIOS)[number];

interface TickRow {
  scenario: Scenario;
  sessionId: string;
  tick: number;
  served: string; // ground truth from the seller's truth log
  bad: boolean;
  verdict: TickVerdict["verdict"]; // code + SERV (what actually ran)
  decidedBy: string;
  codeOnly: "pass" | "fail"; // the same evidence judged by the code checks alone
  quote: string | null;
  reason: string;
  latencyMs: number;
  servUsd: number;
  txHash: string | null;
}

const { values } = parseArgs({
  options: {
    yes: { type: "boolean", default: false },
    seller: { type: "string", default: "https://pawlr.vercel.app" },
    ticks: { type: "string", default: "5" },
    "fail-from": { type: "string", default: "3" },
    doc: { type: "string", default: "docs/demo-document.md" },
    out: { type: "string", default: "data/bench" },
  },
});
const K = Number(values.ticks);
const N = Number(values["fail-from"]);

const seller = await fetchSellerInfo(values.seller!);
const price = Number(seller.pricePerTick);
const maxTicks = SCENARIOS.length * K;
const SERV_PER_RULING = 0.0015; // observed ~$0.001 per ruling (docs/integration-notes.md); padded
console.log(`Pawlr benchmark on ${seller.network} against ${seller.baseUrl}`);
console.log(`Scenarios: ${SCENARIOS.join(", ")}; ${K} ticks each, staged failure from tick ${N}.`);
console.log(`Estimated spend (upper bound): ${maxTicks} ticks x ${price} = ${(maxTicks * price).toFixed(3)} test tokens; SERV ~$${(maxTicks * SERV_PER_RULING).toFixed(3)}; Dolphin $0 and Reppo 0 credits (not built).`);
if (!values.yes) {
  console.log("Dry run. Re-run with --yes to spend.");
  process.exit(0);
}

const env = (k: string) => {
  const v = (process.env[k] ?? "").trim();
  if (!v) throw new Error(`${k} is required`);
  return v;
};
const adminPw = env("ADMIN_PASSWORD");
const outDir = values.out!;
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const rawFile = join(outDir, `ticks-${stamp}.jsonl`);
const costFile = join(outDir, `costs-${stamp}.jsonl`);
const sections = parseDocument(readFileSync(values.doc!, "utf8"));
const limits = loadSpendLimits({ MAX_SPEND: (K * price).toFixed(6), MAX_PER_TICK: seller.pricePerTick }, "testnet");
const serv = servTransport(env("SERV_API_KEY"));
const rows: TickRow[] = [];

for (const scenario of SCENARIOS) {
  const conditions = buildConditions(seller, sections, { maxTicks: K, maxSpend: limits.maxSpend });
  const conditionsHash = await agreeSession(seller, conditions, sections);
  if (scenario !== "honest") {
    const r = await fetch(`${seller.baseUrl}/admin/failure`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminPw}` },
      body: JSON.stringify({ sessionId: conditions.sessionId, mode: scenario, fromTick: N }),
    });
    if (!r.ok) throw new Error(`could not stage ${scenario}: ${r.status}`);
  }
  const res = await runTicks(
    { seller, conditions, conditionsHash, sections, limits },
    {
      payer: new WalletPayer({ privateKey: env("BUYER_PRIVATE_KEY"), conditions }),
      verifier: { serv, onCost: (c: CostEntry) => appendFileSync(costFile, JSON.stringify({ scenario, ...c }) + "\n") },
      dataDir: join(outDir, "runs"),
    },
  );
  const truth = (await (await fetch(`${seller.baseUrl}/admin/truth/${conditions.sessionId}`, { headers: { authorization: `Bearer ${adminPw}` } })).json()) as {
    tick: number;
    served: string;
  }[];
  for (const v of res.receipt.ticks) {
    const t = truth.find((x) => x.tick === v.tick);
    const served = t?.served ?? "unknown";
    const codeOk = v.checks.presence.ok === true && v.checks.integrity.ok === true && v.checks.completion.ok === true;
    const row: TickRow = {
      scenario,
      sessionId: conditions.sessionId,
      tick: v.tick,
      served,
      bad: served !== "honest",
      verdict: v.verdict,
      decidedBy: v.decidedBy,
      codeOnly: codeOk ? "pass" : "fail",
      quote: v.quote,
      reason: v.reason,
      latencyMs: v.latencyMs,
      servUsd: v.cost.servUsd ?? 0,
      txHash: v.payment.txHash,
    };
    rows.push(row);
    appendFileSync(rawFile, JSON.stringify(row) + "\n");
  }
  console.log(`${scenario.padEnd(10)} paid ${res.receipt.ticksPaid}/${K}: ${res.receipt.ticks.map((t) => `${t.tick}:${t.verdict}`).join(" ")}  (${res.stoppedBecause.slice(0, 60)})`);
}

// ── Metrics ──────────────────────────────────────────────────────────────────
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : "–");
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : 0;
};
const good = rows.filter((r) => !r.bad);
const bad = rows.filter((r) => r.bad);
const m = {
  serv: {
    falseAccepts: bad.filter((r) => r.verdict === "pass").length,
    falseRejects: good.filter((r) => r.verdict === "fail").length,
    unsure: rows.filter((r) => r.verdict === "unsure").length,
  },
  code: {
    falseAccepts: bad.filter((r) => r.codeOnly === "pass").length,
    falseRejects: good.filter((r) => r.codeOnly === "fail").length,
  },
};
const perScenario = SCENARIOS.map((s) => {
  const rs = rows.filter((r) => r.scenario === s);
  const firstBad = rs.find((r) => r.bad)?.tick ?? null;
  const paidFromFirstBad = firstBad === null ? 0 : rs.filter((r) => r.tick >= firstBad).length;
  const caughtBy = rs.find((r) => r.bad && r.verdict !== "pass");
  const codeCatches = rs.find((r) => r.bad)?.codeOnly === "fail";
  return { s, rs, firstBad, paidFromFirstBad, caughtBy, codeCatches };
});
const lat = rows.map((r) => r.latencyMs);
const servRows = rows.filter((r) => r.servUsd > 0);
const servUsd = rows.reduce((a, r) => a + r.servUsd, 0);

const md = `# Benchmark

**Run:** ${new Date().toISOString()} · **Network:** Kite testnet (\`${seller.network}\`) · **Seller:** ${seller.baseUrl}
**Payments:** real, settled on-chain in Pawlr Test USD (pUSD). **Failures:** STAGED with the seller's failure switch from tick ${N}; ground truth is the seller's truth log.
**Configurations measured:** code + SERV Reasoning (what ran) and code only (the same evidence judged by the code checks alone). Dolphin and Reppo are not built, so those configurations are not measured.

## Per scenario (${K} ticks each)

| Scenario | Ticks paid | Bad ticks paid | Caught at | Decided by | Quote relied on | Code alone would catch it? |
|---|---|---|---|---|---|---|
${perScenario
  .map(({ s, rs, firstBad, paidFromFirstBad, caughtBy, codeCatches }) =>
    s === "honest"
      ? `| honest | ${rs.length}/${K} | 0 | – | ${[...new Set(rs.map((r) => r.decidedBy))].join(", ")} | – | – |`
      : `| ${s} (staged) | ${rs.length}/${K} | ${paidFromFirstBad} | ${caughtBy ? `tick ${caughtBy.tick} (${caughtBy.verdict})` : "**not caught**"} | ${caughtBy?.decidedBy ?? "–"} | ${caughtBy?.quote ? `“${caughtBy.quote.replace(/\|/g, "\\|").slice(0, 70)}”` : "–"} | ${firstBad === null ? "–" : codeCatches ? "yes" : "no"} |`,
  )
  .join("\n")}

**Ticks paid after the first bad tick (including it), every scenario: ${Math.max(...perScenario.map((p) => p.paidFromFirstBad))}.** The requirement is at most 1.

## Accuracy over all ${rows.length} judged ticks (${good.length} good, ${bad.length} bad)

| Configuration | False accepts (bad paid as good) | False rejects (good refused) | Unsure |
|---|---|---|---|
| Code only | ${m.code.falseAccepts}/${bad.length} | ${m.code.falseRejects}/${good.length} | – |
| Code + SERV Reasoning | ${m.serv.falseAccepts}/${bad.length} | ${m.serv.falseRejects}/${good.length} | ${m.serv.unsure} (${pct(m.serv.unsure, rows.length)}) |

Code only would have let ${m.code.falseAccepts} bad tick(s) through${m.code.falseAccepts ? ` (${[...new Set(bad.filter((r) => r.codeOnly === "pass").map((r) => r.scenario))].join(", ")})` : ""}; those need the judgment call SERV makes.

## Cost and speed

| Metric | Value |
|---|---|
| SERV cost per SERV-judged tick | $${servRows.length ? (servUsd / servRows.length).toFixed(5) : "0"} (${servRows.length} ticks; ticks failed by code cost $0) |
| SERV cost, whole benchmark | $${servUsd.toFixed(4)} |
| Payment per tick | ${seller.pricePerTick} pUSD (test token) |
| Verification latency p50 / p95 | ${quantile(lat, 0.5)} ms / ${quantile(lat, 0.95)} ms |

Raw data: [\`docs/benchmark-ticks.jsonl\`](benchmark-ticks.jsonl) (one line per tick: scenario, truth, both verdicts, quote, reason, latency, cost, tx hash).
`;
writeFileSync("docs/benchmark.md", md);
writeFileSync(join("docs", "benchmark-ticks.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`\nWrote docs/benchmark.md and docs/benchmark-ticks.jsonl (raw also in ${rawFile}).`);
console.log(`False accepts: code+SERV ${m.serv.falseAccepts}/${bad.length}, code-only ${m.code.falseAccepts}/${bad.length}; max bad ticks paid ${Math.max(...perScenario.map((p) => p.paidFromFirstBad))}; SERV $${servUsd.toFixed(4)}`);
