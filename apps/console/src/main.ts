// Entry point: node --env-file=.env apps/console/dist/main.js
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { KpassPayer, WalletPayer, loadSpendLimits } from "@pawlr/buyer";
import { dolphinScreen, dolphinTransport, reppoClient, servTransport, type CostEntry } from "@pawlr/verifier";
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
const onCost = (c: CostEntry) => appendFileSync(join(dataDir, "costs.jsonl"), JSON.stringify(c) + "\n");
// Optional partners: each is used only when its key is set.
const dolphinModel = env("DOLPHIN_MODEL", "deepseek-ai/DeepSeek-V4.1-Flash");
const screen = env("DOLPHIN_API_KEY")
  ? dolphinScreen({ transport: dolphinTransport(env("DOLPHIN_API_KEY"), env("DOLPHIN_BASE_URL", "https://lighthouse.dphn.ai/run/text-v/v1")), model: dolphinModel })
  : undefined;
const reppo = env("REPPO_API_KEY") ? reppoClient(env("REPPO_API_KEY"), env("REPPO_BASE_URL", "https://eval.reppo.xyz/api/v1")) : undefined;
const mode = env("PAWLR_VERIFY_MODE", "demo") === "economy" ? "economy" : "demo";

const mgr = new SessionManager({
  sellerUrl,
  dataDir,
  payer: (conditions) => (payerKind === "kpass" ? new KpassPayer() : new WalletPayer({ privateKey: key, conditions })),
  payerLabel: payerKind,
  serv: servTransport(env("SERV_API_KEY")),
  verifier: { onCost, screen, mode },
  reppo,
  onCost,
  limits,
  adminPassword,
  maxStartsPerHour: Number(env("CONSOLE_MAX_STARTS_PER_HOUR", "30")),
});

await mgr.sellerInfo();
// Read the seller's own settlement label (fetchSellerInfo keeps only payment fields).
const health = (await (await fetch(`${sellerUrl}/health`)).json()) as { settlement?: string; asset?: string };
const app = createConsoleApp(mgr, {
  sellerUrl,
  payerLabel: payerKind === "kpass" ? "Kite Passport (kpass)" : "Direct x402 wallet (EIP-3009 signatures)",
  settlement: String(health.settlement ?? "unknown"),
  assetSymbol: String(health.asset ?? "token"),
  explorer: "https://testnet.kitescan.ai/tx/",
  reppo: Boolean(reppo),
  dolphin: screen ? `${dolphinModel} (${mode} mode)` : null,
});
const port = Number(env("CONSOLE_PORT", "8820"));
serve({ fetch: app.fetch, port, hostname: env("CONSOLE_HOST", "127.0.0.1") }, (i) => console.log(`pawlr-console on :${i.port}/console (seller ${sellerUrl}, payer ${payerKind}, dolphin ${screen ? mode : "off"}, reppo ${reppo ? "on" : "off"})`));
