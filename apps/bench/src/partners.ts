// Pawlr benchmark, partner pass (agent.md §13): Dolphin screen and Reppo agreement.
//
// Re-judges the REAL evidence of the benchmark run (docs/benchmark-ticks.jsonl; the evidence each
// paid tick delivered is in the buyer ledgers under data/bench/runs/ledger/). No new payments.
// Failures in that run were STAGED with the seller's failure switch; ground truth is the truth log.
//
//   node --env-file=.env apps/bench/dist/partners.js          # prints the estimate only
//   node --env-file=.env apps/bench/dist/partners.js --yes    # makes the live Dolphin and Reppo calls
//
// Dolphin: every tick that passed the code checks (the ones that reach the relevance stage) is
// screened. Economy mode = a Dolphin pass with a code-checked quote settles the tick; anything else
// keeps the SERV verdict that was recorded in the run.
// Reppo: the disputed set (every tick Pawlr refused) plus honest controls, judged independently:
// Pawlr's own ruling is NOT sent, so Reppo cannot simply agree with it.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { DeliveryConditions, TickEvidence } from "@pawlr/protocol";
import { RELEVANCE_RULE, parseDocument } from "@pawlr/buyer";
import {
  checkQuote,
  dolphinScreen,
  dolphinTransport,
  mapReppoRoute,
  reppoClient,
  runDispute,
  REPPO_CREDITS_PER_EVAL,
  type CostEntry,
} from "@pawlr/verifier";

interface TickRow {
  scenario: string;
  sessionId: string;
  tick: number;
  served: string;
  bad: boolean;
  verdict: "pass" | "fail" | "unsure";
  decidedBy: string;
  codeOnly: "pass" | "fail";
  servUsd: number;
  latencyMs: number;
}

const { values } = parseArgs({
  options: {
    yes: { type: "boolean", default: false },
    doc: { type: "string", default: "docs/demo-document.md" },
    ledgers: { type: "string", default: "data/bench/runs/ledger" },
    controls: { type: "string", default: "2" },
    out: { type: "string", default: "data/bench" },
    // Re-read Reppo evals that had not finished (by their saved eval id) and rewrite the report. No new submissions.
    refresh: { type: "boolean", default: false },
  },
});

const rows: TickRow[] = readFileSync("docs/benchmark-ticks.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const sections = Object.fromEntries(parseDocument(readFileSync(values.doc!, "utf8")).map((s) => [s.name, s.text]));
const evidenceOf = (r: TickRow): TickEvidence => {
  const l = JSON.parse(readFileSync(join(values.ledgers!, `${r.sessionId}.json`), "utf8")) as { ticks: Record<string, { evidence?: TickEvidence }> };
  const ev = l.ticks[String(r.tick)]?.evidence;
  if (!ev) throw new Error(`no evidence in the ledger for ${r.sessionId} tick ${r.tick}`);
  return ev;
};
// The judged parts of the agreed conditions, as buildConditions writes them (packages/buyer/src/run.ts).
const conditions = {
  task: "Summarise each section of the supplied document",
  relevance: { rule: RELEVANCE_RULE },
  completion: { minSentences: 1, maxSentences: 3, minKeyTerms: 3 },
} as unknown as DeliveryConditions;

const screened = rows.filter((r) => r.codeOnly === "pass");
const disputed = rows.filter((r) => r.verdict !== "pass");
const controls = rows.filter((r) => r.scenario === "honest").slice(0, Number(values.controls));
const reppoSet = [...disputed, ...controls];

console.log(`Partner pass over ${rows.length} recorded ticks (Kite testnet run; failures STAGED).`);
console.log(`Dolphin: ${screened.length} screens, about $${(screened.length * 0.00003).toFixed(4)} (DeepSeek V4.1 Flash, ~$0.00003 each).`);
console.log(`Reppo: ${reppoSet.length} evaluations (${disputed.length} disputed + ${controls.length} honest controls) = ${reppoSet.length * REPPO_CREDITS_PER_EVAL} credits.`);
if (!values.yes && !values.refresh) {
  console.log("Dry run. Re-run with --yes to spend.");
  process.exit(0);
}

const env = (k: string, d = "") => (process.env[k] ?? "").trim() || d;
mkdirSync(values.out!, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const costFile = join(values.out!, `partner-costs-${stamp}.jsonl`);
const runAt = values.refresh ? "re-read pending Reppo evals at " + new Date().toISOString() : new Date().toISOString();
const logCost = (c: CostEntry & Record<string, unknown>) => appendFileSync(costFile, JSON.stringify(c) + "\n");

// ── Dolphin ──────────────────────────────────────────────────────────────────
const dolphinModel = env("DOLPHIN_MODEL", "deepseek-ai/DeepSeek-V4.1-Flash");
const screen = dolphinScreen({ transport: dolphinTransport(env("DOLPHIN_API_KEY"), env("DOLPHIN_BASE_URL") || undefined), model: dolphinModel });
interface DolphinRow { key: string; scenario: string; tick: number; bad: boolean; dolphin: string; quoteOk: boolean; servVerdict: string; economy: string; usd: number; latencyMs: number; reason: string }
const saved = values.refresh
  ? readFileSync("docs/benchmark-partners.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l))
  : [];
const dRows: DolphinRow[] = saved.filter((x) => x.kind === "dolphin");
for (const r of values.refresh ? [] : screened) {
  const ev = evidenceOf(r);
  const s = await screen({ conditions, sectionName: ev.sectionName, sectionText: sections[ev.sectionName]!, sellerOutput: ev.output });
  logCost({ at: new Date().toISOString(), provider: "dolphin", purpose: "screen", model: dolphinModel, latencyMs: s.latencyMs, promptTokens: s.promptTokens, completionTokens: s.completionTokens, usd: s.usd ?? null, status: s.status ?? null });
  const verdict = s.parsed.kind === "ruling" ? s.parsed.verdict : `no ruling (${s.parsed.kind})`;
  const quoteOk = s.parsed.kind === "ruling" && checkQuote(s.parsed.quote, ev.output, sections[ev.sectionName]!).ok;
  const settles = verdict === "pass" && quoteOk;
  dRows.push({
    key: `${r.scenario}:${r.tick}`, scenario: r.scenario, tick: r.tick, bad: r.bad, dolphin: verdict, quoteOk,
    servVerdict: r.verdict, economy: settles ? "pass" : r.verdict, usd: s.usd ?? 0, latencyMs: s.latencyMs,
    reason: s.parsed.kind === "ruling" ? s.parsed.reason : "",
  });
  console.log(`dolphin ${r.scenario}:${r.tick} truth=${r.served} → ${verdict}${quoteOk ? "" : " (quote failed)"}`);
}

// ── Reppo ────────────────────────────────────────────────────────────────────
const reppo = reppoClient(env("REPPO_API_KEY"), env("REPPO_BASE_URL") || undefined);
interface ReppoRow { key: string; scenario: string; tick: number; bad: boolean; set: "disputed" | "control"; pawlr: string; reppo: string; route: string | null; score: number | null; confidence: string | null; evalId: string | null; credits: number; latencyMs: number; reason: string }
const rRows: ReppoRow[] = values.refresh
  ? await Promise.all(
      saved
        .filter((x) => x.kind === "reppo")
        .map(async (x: ReppoRow): Promise<ReppoRow> => {
          if (x.route || !x.evalId) return x;
          const e = await reppo.get(x.evalId);
          console.log(`reppo ${x.key} eval ${x.evalId}: ${e.status} ${e.result?.route ?? ""}`);
          if (e.status !== "COMPLETED" || !e.result) return x;
          const r = e.result;
          return { ...x, reppo: mapReppoRoute(r.route), route: r.route, score: r.score, confidence: r.confidence, credits: e.creditsCharged ?? REPPO_CREDITS_PER_EVAL, reason: r.reason, latencyMs: x.latencyMs };
        }),
    )
  : await Promise.all(
  reppoSet.map(async (r): Promise<ReppoRow> => {
    const ev = evidenceOf(r);
    const o = await runDispute({ conditions, sectionText: sections[ev.sectionName]!, evidence: ev }, reppo, { timeoutMs: 6 * 60_000 });
    logCost({ at: new Date().toISOString(), provider: "reppo", purpose: "dispute", model: "reppo-eval-router", latencyMs: o.latencyMs, usd: null, credits: o.credits, status: null, requestId: o.evalId ?? undefined });
    console.log(`reppo ${r.scenario}:${r.tick} truth=${r.served} pawlr=${r.verdict} → ${o.route ?? "none"} (${o.verdict}, score ${o.score})`);
    return {
      key: `${r.scenario}:${r.tick}`, scenario: r.scenario, tick: r.tick, bad: r.bad, set: disputed.includes(r) ? "disputed" : "control",
      pawlr: r.verdict, reppo: o.verdict, route: o.route, score: o.score, confidence: o.confidence, evalId: o.evalId, credits: o.credits, latencyMs: o.latencyMs, reason: o.reason,
    };
  }),
);

// ── Metrics ──────────────────────────────────────────────────────────────────
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : 0;
};
const good = rows.filter((r) => !r.bad);
const bad = rows.filter((r) => r.bad);
const economyOf = (r: TickRow) => dRows.find((d) => d.key === `${r.scenario}:${r.tick}`)?.economy ?? r.verdict;
const eco = {
  fa: bad.filter((r) => economyOf(r) === "pass").length,
  fr: good.filter((r) => economyOf(r) === "fail").length,
  unsure: rows.filter((r) => economyOf(r) === "unsure").length,
};
const dolphinUsd = dRows.reduce((a, d) => a + d.usd, 0);
const servUsdAll = rows.reduce((a, r) => a + r.servUsd, 0);
const settledByDolphin = dRows.filter((d) => d.economy === "pass" && d.dolphin === "pass" && d.quoteOk);
const servSaved = settledByDolphin.reduce((a, d) => a + (rows.find((r) => `${r.scenario}:${r.tick}` === d.key)?.servUsd ?? 0), 0);
const demoPerTick = (servUsdAll + dolphinUsd) / rows.length;
const ecoPerTick = (servUsdAll - servSaved + dolphinUsd) / rows.length;
const dolphinBadPassed = dRows.filter((d) => d.bad && d.dolphin === "pass" && d.quoteOk);
const disputedRows = rRows.filter((r) => r.set === "disputed");
const agree = disputedRows.filter((r) => r.reppo === r.pawlr).length;
const reppoCredits = rRows.reduce((a, r) => a + r.credits, 0);

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ");
const section = `<!-- partners:start -->
## Partners: Dolphin screen and Reppo agreement

**Run:** ${runAt}. Re-judges the **same real evidence** the ${rows.length} ticks above delivered (stored in the buyer's ledgers), with live Dolphin and Reppo calls. No new payments. Failures were **staged**.

### Dolphin screen (\`${dolphinModel}\`)

Every tick that passed the code checks (${screened.length}) was screened. In **economy mode** a Dolphin pass with a quote that code finds in the texts settles the tick without SERV; anything else goes to SERV (the recorded SERV verdict is used).

| Configuration | False accepts | False rejects | Unsure | Cost per tick (judging) |
|---|---|---|---|---|
| Code + SERV (demo mode, Dolphin screens but SERV rules on every tick) | ${bad.filter((r) => r.verdict === "pass").length}/${bad.length} | ${good.filter((r) => r.verdict === "fail").length}/${good.length} | ${rows.filter((r) => r.verdict === "unsure").length} | $${demoPerTick.toFixed(6)} |
| Code + Dolphin + SERV, economy mode | ${eco.fa}/${bad.length} | ${eco.fr}/${good.length} | ${eco.unsure} | $${ecoPerTick.toFixed(6)} |

- Dolphin cost for all ${screened.length} screens: **$${dolphinUsd.toFixed(6)}** (p50 latency ${quantile(dRows.map((d) => d.latencyMs), 0.5)} ms).
- In economy mode Dolphin settled **${settledByDolphin.length}** of ${screened.length} ticks and saved $${servSaved.toFixed(5)} of SERV calls.
- Bad ticks Dolphin passed with a valid quote: **${dolphinBadPassed.length}**${dolphinBadPassed.length ? ` (${dolphinBadPassed.map((d) => d.key).join(", ")}). In economy mode these would have been paid for, so **demo mode (SERV on every tick) stays the default**` : ""}.

| Tick | Truth | Dolphin | Quote check | SERV (recorded) | Economy result |
|---|---|---|---|---|---|
${dRows.map((d) => `| ${d.key} | ${d.bad ? "bad (staged)" : "good"} | ${d.dolphin} | ${d.quoteOk ? "ok" : "failed"} | ${d.servVerdict} | ${d.economy} |`).join("\n")}

### Reppo: independent verdicts on the disputed set

The disputed set is every tick Pawlr refused (${disputed.length}), plus ${controls.length} honest ticks as controls. Reppo got the agreed rule, the section text and the delivered output, **not** Pawlr's ruling. Mapping: \`ship\` → pass, \`block\` → fail, \`review\` → unsure.

- **Agreement with Pawlr on the disputed set: ${agree}/${disputedRows.length}.**
- Honest controls: ${rRows.filter((r) => r.set === "control").map((r) => `${r.key} → ${r.route ?? "no answer"}`).join(", ") || "none"}.
- Reppo credits used: ${reppoCredits}; latency p50 ${Math.round(quantile(rRows.map((r) => r.latencyMs), 0.5) / 1000)} s (all ${reppoSet.length} were submitted at once and queued; a single live dispute from the console took about 10 to 20 s).
- Where they differ: Reppo judges the text only. A **stale** tick is bad because its evidence timestamp is old, which Pawlr's code checks catch and which is not part of what Reppo reads, so Reppo ships it. Reppo sent the **empty** tick and one honest control to \`review\` (low confidence), which Pawlr maps to "unsure": the tick stays paused for a person, never paid automatically.

| Tick | Truth | Pawlr | Reppo route (score, confidence) | Reppo's reason |
|---|---|---|---|---|
${rRows.map((r) => `| ${r.key} | ${r.bad ? "bad (staged)" : "good"} | ${r.pawlr} | ${r.route ?? "none"} (${r.score ?? "-"}, ${r.confidence ?? "-"}) | ${esc(r.reason).slice(0, 220)} |`).join("\n")}

Raw data: [\`docs/benchmark-partners.jsonl\`](benchmark-partners.jsonl).
<!-- partners:end -->
`;
const md = readFileSync("docs/benchmark.md", "utf8");
const start = md.indexOf("<!-- partners:start -->");
const end = md.indexOf("<!-- partners:end -->");
const next = start >= 0 && end > start ? md.slice(0, start) + section + md.slice(end + "<!-- partners:end -->\n".length) : md.trimEnd() + "\n\n" + section;
writeFileSync("docs/benchmark.md", next);
writeFileSync(
  "docs/benchmark-partners.jsonl",
  [...dRows.map((d) => JSON.stringify({ kind: "dolphin", ...d })), ...rRows.map((r) => JSON.stringify({ kind: "reppo", ...r }))].join("\n") + "\n",
);
console.log(`\nDolphin: economy FA ${eco.fa}/${bad.length}, FR ${eco.fr}/${good.length}, $${dolphinUsd.toFixed(6)}. Reppo agreement ${agree}/${disputedRows.length}, ${reppoCredits} credits.`);
