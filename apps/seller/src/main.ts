// Entry point: node --env-file=.env apps/seller/dist/main.js
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { CachedSummarizer, ConfigError, Store, createPublicApp, createSelfFacilitator, createTickService, httpTickForwarder, loadConfig } from "@pawlr/seller";
import { landingPage } from "./landing.js";
import { ServSummarizer } from "./summarizer.js";

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`pawlr-seller refused to start: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const store = new Store(config.dataDir);
const summarizer = new CachedSummarizer(new ServSummarizer(config.servApiKey, config.servModel, store), store, config.servModel);

// Internal tick service: localhost only.
const tickApp = createTickService({ store, summarizer });
serve({ fetch: tickApp.fetch, port: config.internalPort, hostname: "127.0.0.1" });

// Public port: free session routes + paid x402 paywall.
const app = createPublicApp({
  config,
  store,
  // "self": official x402 facilitator code in-process, settling on-chain from the gas wallet (testnet only).
  facilitator:
    config.settlementMode === "self"
      ? createSelfFacilitator({ chain: config.chain, privateKey: config.facilitatorPrivateKey, rpcUrl: config.rpcUrl }).client
      : new HTTPFacilitatorClient({ url: config.facilitatorUrl }),
  forwardTick: httpTickForwarder(config.internalPort),
});
// The demo's landing page sits in front of the SDK's routes.
const site = new Hono();
site.get("/", (c) => c.html(landingPage()));
site.route("/", app);
const cfg = config;
serve({ fetch: site.fetch, port: cfg.port, hostname: cfg.host }, (info) => {
  console.log(
    `pawlr-seller on :${info.port} (${cfg.chain.network}, settlement ${cfg.settlementMode === "self" ? "self-facilitated (on-chain)" : "Pieverse facilitator (on-chain)"}, ${cfg.pricePerTick} ${cfg.chain.assetSymbol} per tick to ${cfg.payTo}); tick service on 127.0.0.1:${cfg.internalPort}`,
  );
});
