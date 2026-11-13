import { readFileSync } from "node:fs";
import { Hono } from "hono";
import type { ConsoleSession } from "./sessions.js";
import { FAILURE_MODES, MAX_TICKS, SessionManager, UserError } from "./sessions.js";

const PAGE = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const DEMO_DOC = readFileSync(new URL("../public/demo-document.md", import.meta.url), "utf8");

export interface ConsoleInfo {
  sellerUrl: string;
  payerLabel: string;
  settlement: string;
  assetSymbol: string;
  explorer: string;
}

/** Public view of a session. Never includes secrets. */
function view(s: ConsoleSession) {
  return {
    id: s.id,
    status: s.status,
    conditions: s.conditions,
    conditionsHash: s.conditionsHash,
    failure: s.failure,
    ticks: s.ticks,
    log: s.log.slice(-60),
    receipt: s.receipt ?? null,
    stoppedBecause: s.stoppedBecause ?? null,
    refund: s.refund ?? null,
    error: s.error ?? null,
  };
}

/** Console API under /console (served at https://pawlr.vercel.app/console). */
export function createConsoleApp(mgr: SessionManager, info: ConsoleInfo) {
  const app = new Hono().basePath("/console");

  app.onError((err, c) => {
    if (err instanceof UserError) return c.json({ error: err.message }, 400);
    console.error(err);
    return c.json({ error: err.message }, 500);
  });

  app.get("/", (c) => c.html(PAGE));
  app.get("/api/info", async (c) => {
    const seller = await mgr.sellerInfo();
    return c.json({ ...info, seller, demoDocument: DEMO_DOC, failureModes: FAILURE_MODES, maxTicks: MAX_TICKS });
  });

  app.post("/api/sessions", async (c) => {
    const b = await c.req.json<{ markdown?: string; ticks?: number; failure?: { mode: string; fromTick: number } | null }>();
    const s = await mgr.draft(String(b.markdown ?? ""), Number(b.ticks ?? 5), b.failure ?? null);
    return c.json(view(s), 201);
  });
  app.post("/api/sessions/:id/start", async (c) => c.json(view(await mgr.start(c.req.param("id")))));
  app.get("/api/sessions/:id", (c) => {
    const s = mgr.get(c.req.param("id"));
    return s ? c.json(view(s)) : c.json({ error: "unknown session" }, 404);
  });
  app.post("/api/sessions/:id/review", async (c) => {
    const b = await c.req.json<{ tick: number; decision: "approve" | "reject"; password: string }>();
    return c.json(view(await mgr.review(c.req.param("id"), Number(b.tick), b.decision, String(b.password ?? ""))));
  });
  app.post("/api/sessions/:id/claim", async (c) => {
    const b = await c.req.json<{ ticks: number[] }>();
    return c.json(await mgr.claim(c.req.param("id"), (b.ticks ?? []).map(Number)));
  });
  app.post("/api/sessions/:id/claim/send", async (c) => {
    const b = await c.req.json<{ claim: any }>();
    return c.json(await mgr.sendClaim(c.req.param("id"), b.claim));
  });
  return app;
}
