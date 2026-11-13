#!/usr/bin/env node
// pawlr run --doc file.md --ticks 8 --network testnet [--payer kpass|wallet] [--seller URL] [--data DIR]
// Needs SERV_API_KEY in the environment (node --env-file=.env ...). DOLPHIN_API_KEY adds the Dolphin screen;
// --mode economy lets a clean Dolphin pass (with a code-checked quote) settle a tick without SERV.
// --payer kpass (default): Kite Passport. --payer wallet: backup route, direct x402 from BUYER_PRIVATE_KEY.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { dolphinScreen, dolphinTransport, servTransport } from "@pawlr/verifier";
import { parseDocument } from "./document.js";
import { KpassPayer, type Payer } from "./payer.js";
import { WalletPayer } from "./walletPayer.js";
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
      payer: { type: "string", default: "kpass" },
      "simulate-failure": { type: "string" },
      mode: { type: "string", default: "demo" },
    },
  });
  if (positionals[0] !== "run" || !values.doc) {
    console.error("usage: pawlr run --doc file.md --ticks 8 --network testnet [--payer kpass|wallet] [--seller URL] [--data DIR]");
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

  // Demo only: stage a SIMULATED failure on the seller (mode@fromTick, e.g. injection@3). Needs ADMIN_PASSWORD.
  if (values["simulate-failure"]) {
    const [mode, from] = values["simulate-failure"].split("@");
    const pw = (process.env.ADMIN_PASSWORD ?? "").trim();
    if (!pw) throw new Error("--simulate-failure needs the seller's ADMIN_PASSWORD in .env");
    const r = await fetch(`${seller.baseUrl}/admin/failure`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${pw}` },
      body: JSON.stringify({ sessionId: conditions.sessionId, mode, fromTick: Number(from) }),
    });
    if (!r.ok) throw new Error(`could not stage the simulated failure: ${r.status} ${await r.text()}`);
    console.log(`SIMULATED FAILURE staged on the seller: "${mode}" from tick ${from} (the tick responses will not reveal it)`);
  }

  let payer: Payer;
  if (values.payer === "wallet") {
    const key = (process.env.BUYER_PRIVATE_KEY ?? "").trim();
    if (!key) throw new Error("--payer wallet needs BUYER_PRIVATE_KEY in .env (never commit or paste it)");
    const w = new WalletPayer({ privateKey: key, conditions });
    console.log(`Payer: direct x402 wallet ${w.address} (backup route; Kite Passport limits do not apply, Pawlr caps do)`);
    payer = w;
  } else if (values.payer === "kpass") {
    payer = new KpassPayer();
    console.log("Payer: Kite Passport (kpass)");
  } else throw new Error(`unknown --payer ${values.payer}`);

  const dataDir = values.data!;
  mkdirSync(dataDir, { recursive: true });
  const { receipt, stoppedBecause, receiptFile } = await runTicks(
    { seller, conditions, conditionsHash, sections, limits },
    {
      payer,
      dataDir,
      verifier: {
        serv: servTransport(process.env.SERV_API_KEY ?? ""),
        // Dolphin screen when DOLPHIN_API_KEY is set. --mode economy lets a clean Dolphin pass settle a tick.
        screen: process.env.DOLPHIN_API_KEY?.trim()
          ? dolphinScreen({
              transport: dolphinTransport(process.env.DOLPHIN_API_KEY.trim(), process.env.DOLPHIN_BASE_URL?.trim() || undefined),
              model: process.env.DOLPHIN_MODEL?.trim() || undefined,
            })
          : undefined,
        mode: values.mode === "economy" ? "economy" : "demo",
        onCost: (c) => appendFileSync(join(dataDir, "costs.jsonl"), JSON.stringify(c) + "\n"),
      },
    },
    {
      log: (l) => console.log(l),
      onTick: (v) =>
        v.payment.txHash &&
        console.log(`  tx: ${EXPLORER[network]}${v.payment.txHash}`),
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
