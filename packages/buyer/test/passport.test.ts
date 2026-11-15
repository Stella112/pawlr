import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PassportGuard, PassportLimitedPayer, parseSession, type PassportSession } from "../src/passport.js";
import type { Payer } from "../src/payer.js";

// Shape copied from Kite's bundled reference (request-session/references/commands.md, "Approved Output"),
// plus execution_constraints from form-session-delegation/references/delegation-schema.md.
const APPROVED = {
  request_id: "req_abc123",
  session_id: "session_xyz789",
  session: {
    id: "session_xyz789",
    status: "active",
    expires_at: "2026-11-20T13:00:00Z",
    delegation: {
      task: { summary: "Pay Pawlr's digest service per tick." },
      payment_policy: { max_amount_per_tx: "0.0010000", max_total_amount: "0.003" },
      execution_constraints: { x402: { scope_mode: "scoped", allowed_endpoints: [{ method: "GET", host: "pawlr.vercel.app", path_prefix: "/tick/" }] } },
    },
    usage: { spent_total: "0.00", reserved_total: "0.00" },
  },
  status: "success",
};
const now = () => Date.parse("2026-11-15T21:00:00Z");
const URL1 = "https://pawlr.vercel.app/tick/s1/1";
const tmp = () => join(mkdtempSync(join(tmpdir(), "pawlr-pp-")), "passport.json");
const session = () => parseSession(APPROVED) as PassportSession;
const paid: Payer = { pay: async () => ({ kind: "paid", status: 200, body: {}, raw: {}, txHash: "0xabc" }) };

describe("parseSession", () => {
  it("reads the documented approved output and normalises amounts", () => {
    const s = session();
    expect(s.sessionId).toBe("session_xyz789");
    expect(s.maxPerTx).toBe("0.001");
    expect(s.maxTotal).toBe("0.003");
    expect(s.allowedEndpoints[0].host).toBe("pawlr.vercel.app");
  });
  it("returns null for a pending reply", () => {
    expect(parseSession({ status: "pending", request_id: "req_1" })).toBeNull();
  });
});

describe("PassportGuard", () => {
  it("allows a payment inside every limit", () => {
    expect(new PassportGuard(session(), tmp(), now).reserve(URL1, "0.001")).toBeNull();
  });
  it("refuses above the per-payment cap", () => {
    expect(new PassportGuard(session(), tmp(), now).reserve(URL1, "0.002")?.refused).toBe("session_rule_exceeded");
  });
  it("refuses after expiry", () => {
    const g = new PassportGuard(session(), tmp(), () => Date.parse("2026-11-21T00:00:00Z"));
    expect(g.reserve(URL1, "0.001")?.refused).toBe("session_expired");
  });
  it("refuses an endpoint the session did not approve", () => {
    expect(new PassportGuard(session(), tmp(), now).reserve("https://evil.example/tick/s1/1", "0.001")?.refused).toBe("session_endpoint_forbidden");
  });
  it("counts reservations so concurrent runs cannot pass the total cap", () => {
    const g = new PassportGuard(session(), tmp(), now);
    expect(g.reserve(URL1, "0.001")).toBeNull();
    expect(g.reserve(URL1, "0.001")).toBeNull();
    expect(g.reserve(URL1, "0.001")).toBeNull();
    expect(g.reserve(URL1, "0.001")?.refused).toBe("session_total_exceeded");
  });
  it("persists spend across restarts", () => {
    const f = tmp();
    const g = new PassportGuard(session(), f, now);
    g.reserve(URL1, "0.001");
    g.settle("0.001", true);
    expect(JSON.parse(readFileSync(f, "utf8")).spentUnits).toBe("1000");
    expect(new PassportGuard(session(), f, now).spent).toBe("0.001");
  });
  it("releases a reservation that was not charged", () => {
    const g = new PassportGuard(session(), tmp(), now);
    for (let i = 0; i < 3; i++) {
      g.reserve(URL1, "0.001");
      g.settle("0.001", false);
    }
    expect(g.spent).toBe("0");
    expect(g.reserve(URL1, "0.001")).toBeNull();
  });
});

describe("PassportLimitedPayer", () => {
  it("never calls the wallet when Passport refuses", async () => {
    const inner = { pay: vi.fn() };
    const p = new PassportLimitedPayer(inner as unknown as Payer, new PassportGuard(session(), tmp(), now), "0.002");
    const r = await p.pay({ url: URL1, headers: {}, idempotencyKey: "k" });
    expect(r.kind).toBe("not-charged");
    expect(inner.pay).not.toHaveBeenCalled();
  });
  it("records spend after a paid tick", async () => {
    const g = new PassportGuard(session(), tmp(), now);
    await new PassportLimitedPayer(paid, g, "0.001").pay({ url: URL1, headers: {}, idempotencyKey: "k" });
    expect(g.spent).toBe("0.001");
  });
});
