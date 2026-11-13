#!/usr/bin/env node
// pawlr run --doc file.md --ticks 8 --network testnet [--seller URL] [--data DIR]
// Needs SERV_API_KEY in the environment (node --env-file=.env ...).
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { servTransport } from "@pawlr/verifier";
import { parseDocument } from "./document.js";
import { KpassPayer } from "./payer.js";
import { agreeSession, buildConditions, fetchSellerInfo, loadSpendLimits, runTicks } from "./run.js";

const DEFAULT_SELLER = "https://pawlr.vercel.app";
const EXPLORER = { testnet: "https://testnet.kitescan.ai/tx/", mainnet: "https://kitescan.ai/tx/" };

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      doc: { type: "string" },
      ticks: { type: "string", default: "5" },
      network: { type: "string", default: "testnet" },
      seller: { type: "string", default: DEFAULT_SELLER },
      data: { type: "string", default: "data" },
      "session-id": { type: "string" },
    },
  });
  if (positionals[0] !== "run" || !values.doc) {
    console.error("usage: pawlr run --doc file.md --ticks 8 --network testnet [--seller URL] [--data DIR]");
    process.exit(2);
  }
  const network = values.network === "mainnet" ? "mainnet" : "testnet";
  if (network === "mainnet" && process.env.PAWLR_GO_MAINNET !== "yes") {
    console.error("mainnet refused: set PAWLR_GO_MAINNET=yes only after the owner has said \"go mainnet\"");
    process.exit(1);
  }
  const limits = loadSpendLimits(process.env, network);
  const seller = await fetchSellerInfo(values.seller!);
  const expectedNet = network === "mainnet" ? "eip155:2366" : "eip155:2368";
  if (seller.network !== expectedNet) throw new Error(`seller is on ${seller.network}, not ${expectedNet}`);

  const sections = parseDocument(readFileSync(values.doc, "utf8"));
  const conditions = buildConditions(seller, sections, { maxTicks: Number(values.ticks), maxSpend: limits.maxSpend, sessionId: values["session-id"] });
  console.log(`Conditions for ${conditions.sessionId}: ${sections.length} sections, ${conditions.maxTicks} ticks at ${conditions.pricePerTick}, cap ${conditions.maxSpend}`);
  const conditionsHash = await agreeSession(seller, conditions, sections);
  console.log(`Agreed. conditionsHash ${conditionsHash}`);

  const dataDir = values.data!;
  mkdirSync(dataDir, { recursive: true });
  const { receipt, stoppedBecause, receiptFile } = await runTicks(
    { seller, conditions, conditionsHash, sections, limits },
    {
      payer: new KpassPayer(),
      dataDir,
      verifier: { serv: servTransport(process.env.SERV_API_KEY ?? ""), onCost: (c) => appendFileSync(join(dataDir, "costs.jsonl"), JSON.stringify(c) + "\n") },
    },
    {
      log: (l) => console.log(l),
      onTick: (v) => v.payment.txHash && console.log(`  tx: ${EXPLORER[network]}${v.payment.txHash}`),
    },
  );
  console.log(`\nStopped: ${stoppedBecause}`);
  console.log(`Paid ${receipt.ticksPaid} tick(s), total ${receipt.totalPaid}. Failed ${receipt.ticksRefused}, in review ${receipt.ticksInReview}.`);
  console.log(`Maximum possible loss: 1 tick (${receipt.maxLossBound}). Receipt: ${receiptFile}`);
}

main().catch((err) => {
  console.error(`pawlr: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
