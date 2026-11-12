import { timingSafeEqual, createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import { paymentMiddlewareFromHTTPServer, x402HTTPResourceServer, x402ResourceServer } from "@x402/hono";
import type { FacilitatorClient } from "@x402/core/server";
import type { AssetAmount, Network } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  AddedEvidence,
  CONDITIONS_HASH_HEADER,
  CreateSessionRequest,
  RefundClaim,
  hashConditions,
  sha256Hex,
  toBaseUnits,
} from "@pawlr/protocol";
import type { SellerConfig } from "./config.js";
import { FAILURE_MODES, type FailureMode, type Store } from "./store.js";

export const SELLER_VERSION = "0.1.0";
export const TICK_ROUTE = "GET /tick/:sessionId/:n";

/** Forwards a verified, paid tick request to the localhost-only tick service. */
export type TickForwarder = (body: { sessionId: string; tick: number }) => Promise<Response>;

export function httpTickForwarder(internalPort: number): TickForwarder {
  return (body) =>
    fetch(`http://127.0.0.1:${internalPort}/internal/tick`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
}

function sameSecret(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function decimalEquals(a: string, b: string): boolean {
  try {
    return toBaseUnits(a, 18) === toBaseUnits(b, 18);
  } catch {
    return false;
  }
}

/**
 * Builds the public app: free session routes and the paid x402 tick route on
 * one port. Paywall wiring follows Kite's official template
 * (gokite-ai/kite-x402-services, templates/typescript-express/src/index.ts),
 * using @x402/hono instead of @x402/express.
 */
export function createPublicApp(opts: {
  config: SellerConfig;
  store: Store;
  facilitator: FacilitatorClient;
  forwardTick: TickForwarder;
  syncFacilitatorOnStart?: boolean;
}) {
  const { config, store, facilitator, forwardTick } = opts;
  const chain = config.chain;

  // Kite money parser, same rule as the template's kiteMoneyParser: decimal
  // string to base units with BigInt, pinned to the Kite asset and EIP-712 domain.
  const moneyParser = async (amount: string | number, network: Network): Promise<AssetAmount | null> => {
    if (network !== chain.network) return null;
    const text = typeof amount === "number" ? amount.toFixed(chain.assetDecimals) : amount.trim().replace(/^\$/, "");
    return {
      asset: chain.assetAddress,
      amount: toBaseUnits(text, chain.assetDecimals).toString(),
      extra: { name: chain.eip712Name, version: chain.eip712Version },
    };
  };

  const resourceServer = new x402ResourceServer(facilitator).register(
    chain.network,
    new ExactEvmScheme().registerMoneyParser(moneyParser),
  );

  const routes = {
    [TICK_ROUTE]: {
      accepts: {
        scheme: "exact",
        price: `$${config.pricePerTick}`,
        network: chain.network,
        payTo: config.payTo,
        maxTimeoutSeconds: 60,
      },
      description: "Pawlr document digest: one section summary per paid tick",
      mimeType: "application/json",
    },
  };

  // Reject invalid tick requests BEFORE any payment is requested or verified
  // (403, never charged): unknown session, wrong conditions hash, out-of-order tick.
  const httpServer = new x402HTTPResourceServer(resourceServer, routes).onProtectedRequest(async (ctx) => {
    const m = /^\/tick\/([^/]+)\/(\d+)$/.exec(ctx.path);
    if (!m) return { abort: true, reason: "bad tick path" };
    const session = store.getSession(m[1]!);
    if (!session) return { abort: true, reason: "unknown session" };
    const given = ctx.adapter.getHeader(CONDITIONS_HASH_HEADER) ?? "";
    if (given !== session.conditionsHash) return { abort: true, reason: "conditions hash does not match the agreed hash" };
    const n = Number(m[2]);
    if (n > session.conditions.maxTicks) return { abort: true, reason: "tick beyond maxTicks" };
    if (n !== session.lastServedTick + 1) return { abort: true, reason: `expected tick ${session.lastServedTick + 1}` };
    return undefined;
  });

  const app = new Hono();

  const requireAdmin = (c: Context) => {
    const auth = c.req.header("authorization") ?? "";
    const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    return given.length > 0 && sameSecret(given, config.adminPassword);
  };

  app.get("/health", (c) =>
    c.json({
      ok: true,
      service: "pawlr-seller",
      version: SELLER_VERSION,
      network: chain.network,
      asset: chain.assetSymbol,
      assetAddress: chain.assetAddress,
      pricePerTick: config.pricePerTick,
      payTo: config.payTo,
    }),
  );

  // ── Free: agree a session ────────────────────────────────────────────────
  app.post("/sessions", async (c) => {
    const parsed = CreateSessionRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid session request", issues: parsed.error.issues.slice(0, 5) }, 400);
    const { conditions, sections } = parsed.data;
    const problems: string[] = [];
    if (conditions.seller.payTo.toLowerCase() !== config.payTo.toLowerCase()) problems.push("seller.payTo does not match this seller");
    if (conditions.network !== chain.network) problems.push(`network must be ${chain.network}`);
    if (conditions.asset.toLowerCase() !== chain.assetAddress.toLowerCase()) problems.push(`asset must be ${chain.assetAddress}`);
    if (!decimalEquals(conditions.pricePerTick, config.pricePerTick)) problems.push(`pricePerTick must be ${config.pricePerTick}`);
    const agreed = conditions.document.sections;
    if (agreed.length !== sections.length) problems.push("sections do not match document.sections");
    sections.forEach((s, i) => {
      const a = agreed[i];
      if (!a || a.name !== s.name) problems.push(`section ${i + 1} name does not match`);
      else if (a.sourceHash !== sha256Hex(s.text)) problems.push(`section "${s.name}" text does not match its sourceHash`);
    });
    if (store.getSession(conditions.sessionId)) problems.push("sessionId already used");
    if (problems.length) return c.json({ error: "conditions refused", problems }, 422);

    const conditionsHash = hashConditions(conditions);
    store.putSession(conditions.sessionId, {
      conditions,
      conditionsHash,
      sections,
      lastServedTick: 0,
      createdAt: new Date().toISOString(),
    });
    return c.json({ sessionId: conditions.sessionId, conditionsHash }, 201);
  });

  // ── Paid: one tick (x402) ────────────────────────────────────────────────
  app.use("/tick/*", paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, opts.syncFacilitatorOnStart ?? true));
  app.get("/tick/:sessionId/:n", async (c) => {
    // Reached only after the paywall verified a payment. A status >= 400 here
    // means the middleware does not settle, so the buyer is not charged.
    let res: Response;
    try {
      res = await forwardTick({ sessionId: c.req.param("sessionId"), tick: Number(c.req.param("n")) });
    } catch (err) {
      return c.json({ error: "tick service unreachable", detail: String(err) }, 502);
    }
    const body = await res.json().catch(() => ({ error: "bad tick service response" }));
    return c.json(body, res.ok ? 200 : res.status >= 400 ? (res.status as 400) : 502);
  });

  // ── Free: read served evidence for a tick, plus anything the seller added ─
  app.get("/sessions/:id/evidence/:tick", (c) => {
    const id = c.req.param("id");
    const tick = Number(c.req.param("tick"));
    const evidence = store.getServedEvidence(id, tick);
    if (!evidence) return c.json({ error: "no evidence for that tick" }, 404);
    return c.json({ evidence, added: store.getAddedEvidence(id, tick) });
  });

  // ── Admin: seller adds evidence to a disputed tick ───────────────────────
  app.post("/sessions/:id/evidence/:tick", async (c) => {
    if (!requireAdmin(c)) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    const tick = Number(c.req.param("tick"));
    if (!store.getServedEvidence(id, tick)) return c.json({ error: "no served tick to add evidence to" }, 404);
    const parsed = AddedEvidence.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid evidence" }, 400);
    return c.json(store.addEvidence(id, tick, parsed.data), 201);
  });

  // ── Free: refund inbox (Recover). Money is not returned automatically. ───
  app.post("/sessions/:id/refund-requests", async (c) => {
    const id = c.req.param("id");
    const session = store.getSession(id);
    if (!session) return c.json({ error: "unknown session" }, 404);
    const parsed = RefundClaim.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid claim" }, 400);
    if (parsed.data.sessionId !== id || parsed.data.conditionsHash !== session.conditionsHash) {
      return c.json({ error: "claim does not match this session" }, 422);
    }
    const entry = store.addRefundRequest(id, parsed.data);
    return c.json({ requestId: entry.requestId, receivedAt: entry.receivedAt, note: "Refund requested. Money is not returned automatically." }, 201);
  });

  // ── Admin (demo only): SIMULATED failure switch ──────────────────────────
  app.post("/admin/failure", async (c) => {
    if (!requireAdmin(c)) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json<{ sessionId?: string; mode?: string; fromTick?: number }>().catch(() => null);
    if (!body?.sessionId || !store.getSession(body.sessionId)) return c.json({ error: "unknown session" }, 404);
    if (body.mode === "off") {
      store.putFailure(body.sessionId, null);
      return c.json({ sessionId: body.sessionId, simulatedFailure: "off" });
    }
    if (!FAILURE_MODES.includes(body.mode as FailureMode)) return c.json({ error: `mode must be one of ${FAILURE_MODES.join(", ")}, or off` }, 400);
    if (!Number.isInteger(body.fromTick) || (body.fromTick as number) < 1) return c.json({ error: "fromTick must be a positive integer" }, 400);
    const sw = { mode: body.mode as FailureMode, fromTick: body.fromTick as number, setAt: new Date().toISOString() };
    store.putFailure(body.sessionId, sw);
    return c.json({ sessionId: body.sessionId, simulatedFailure: sw });
  });

  // Truth log for the benchmark and demo (admin only: it reveals the switch).
  app.get("/admin/truth/:id", (c) => {
    if (!requireAdmin(c)) return c.json({ error: "unauthorized" }, 401);
    return c.json(store.readTruth(c.req.param("id")));
  });

  return app;
}
