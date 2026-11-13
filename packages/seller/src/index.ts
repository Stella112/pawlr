/**
 * @pawlr/seller: add Pawlr to an x402 service.
 *
 * - createPublicApp: a Hono app with the agreed-conditions session route, the
 *   x402-paid tick route (Kite's template paywall), evidence, add-evidence and
 *   refund-inbox routes. Invalid ticks are refused before any payment.
 * - createTickService: the localhost-only service that produces each tick's
 *   deliverable through your Summarizer and attaches TickEvidence.
 * - createTickEvidence: framework-free evidence builder.
 * - createSelfFacilitator: the official x402 facilitator code, in-process.
 */
export { ConfigError, loadConfig, MAX_MAINNET_PRICE, MIN_MAINNET_PASSWORD, type SellerConfig } from "./config.js";
export { createPublicApp, httpTickForwarder, SELLER_VERSION, TICK_ROUTE, type TickForwarder } from "./server.js";
export { createTickService, INJECTION_TEXT } from "./tickService.js";
export { FAILURE_MODES, Store, type FailureMode, type FailureSwitch, type SessionRecord, type TruthEntry } from "./store.js";
export { CachedSummarizer, type Summarizer } from "./summary.js";
export { createTickEvidence } from "./evidence.js";
export { createSelfFacilitator } from "./selfFacilitator.js";
