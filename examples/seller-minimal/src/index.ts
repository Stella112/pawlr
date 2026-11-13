// Add Pawlr to an x402 service: agreed conditions, evidence on every tick, refund inbox.
import { serve } from "@hono/node-server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { Store, createPublicApp, createSelfFacilitator, createTickService, httpTickForwarder, loadConfig, type Summarizer } from "@pawlr/seller";

const config = loadConfig(process.env); // KITE_NETWORK, SELLER_PAY_TO, PRICE_PER_TICK, ADMIN_PASSWORD, ...
const store = new Store(config.dataDir);

// Your service: produce one tick's deliverable. Here, the first two sentences of the section.
const myService: Summarizer = {
  async summarize(_name, text) {
    return text.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
  },
};

const facilitator =
  config.settlementMode === "self"
    ? createSelfFacilitator({ chain: config.chain, privateKey: config.facilitatorPrivateKey, rpcUrl: config.rpcUrl }).client
    : new HTTPFacilitatorClient({ url: config.facilitatorUrl });

const ticks = createTickService({ store, summarizer: myService });
serve({ fetch: ticks.fetch, port: config.internalPort, hostname: "127.0.0.1" });

const app = createPublicApp({ config, store, facilitator, forwardTick: httpTickForwarder(config.internalPort) });
serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (i) => console.log(`Pawlr seller on http://localhost:${i.port}`));
