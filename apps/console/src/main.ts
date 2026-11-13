// Entry point: node --env-file=.env apps/console/dist/main.js
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { KpassPayer, WalletPayer, loadSpendLimits } from "@pawlr/buyer";
import { servTransport } from "@pawlr/verifier";
import { createConsoleApp } from "./app.js";
import { SessionManager } from "./sessions.js";

const env = (k: string, d = "") => (process.env[k] ?? "").trim() || d;
const sellerUrl = env("SELLER_URL", "https://pawlr.vercel.app");
const dataDir = env("CONSOLE_DATA_DIR", "data/console");
const payerKind = env("CONSOLE_PAYER", "wallet");
const adminPassword = env("ADMIN_PASSWORD");
if (!adminPassword) throw new Error("ADMIN_PASSWORD is required (review actions and the simulated failure switch)");
mkdirSync(dataDir, { recursive: true });

const key = env("BUYER_PRIVATE_KEY");
if (payerKind === "wallet" && !key) throw new Error("CONSOLE_PAYER=wallet needs BUYER_PRIVATE_KEY");
const limits = loadSpendLimits(process.env, "testnet");

const mgr = new SessionManager({
  sellerUrl,
  dataDir,
  payer: (conditions) => (payerKind === "kpass" ? new KpassPayer() : new WalletPayer({ privateKey: key, conditions })),
  payerLabel: payerKind,
  serv: servTransport(env("SERV_API_KEY")),
  verifier: { onCost: (c) => appendFileSync(join(dataDir, "costs.jsonl"), JSON.stringify(c) + "\n") },
  limits,
  adminPassword,
  maxStartsPerHour: Number(env("CONSOLE_MAX_STARTS_PER_HOUR", "30")),
});

await mgr.sellerInfo();
// Read the seller's own settlement label (fetchSellerInfo keeps only payment fields).
const health = (await (await fetch(`${sellerUrl}/health`)).json()) as { settlement?: string };
const app = createConsoleApp(mgr, {
  sellerUrl,
  payerLabel: payerKind === "kpass" ? "Kite Passport (kpass)" : "Direct x402 wallet (EIP-3009 signatures)",
  settlement: String(health.settlement ?? "unknown"),
  explorer: "https://testnet.kitescan.ai/tx/",
});
const port = Number(env("CONSOLE_PORT", "8820"));
serve({ fetch: app.fetch, port, hostname: env("CONSOLE_HOST", "127.0.0.1") }, (i) => console.log(`pawlr-console on :${i.port}/console (seller ${sellerUrl}, payer ${payerKind})`));
