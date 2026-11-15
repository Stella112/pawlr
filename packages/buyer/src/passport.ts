import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { toBaseUnits } from "@pawlr/protocol";
import type { Payer, PayRequest, PayResult } from "./payer.js";

/**
 * Kite Passport as the authorisation layer.
 *
 * A person creates a Passport spending session (per-payment cap, total cap,
 * expiry, allowed endpoint) and approves it in the browser with their passkey.
 * Pawlr reads the approved session back from Kite and enforces its limits on
 * every tick before the payment is signed.
 *
 * Why Passport does not execute the payment itself here: `kpass session
 * execute` refuses any host outside Kite's executable catalog
 * (`payment_target_forbidden` / `host_not_in_executable_catalog`, captured
 * 2026-11-13), and Pawlr's seller is not listed yet. The payment itself goes
 * out over standard x402 from the buyer wallet (WalletPayer). So Kite approves
 * the limits; Pawlr enforces them. Kite's own reference says endpoint scopes
 * are "recorded with the session; not enforced on paid calls today", so Pawlr
 * enforces the endpoint too.
 *
 * Commands and output fields: `kpass session create --help`, `kpass session
 * status --help` (kpass 6.13.x) and Kite's bundled references
 * ~/.kpass/skills/request-session/references/commands.md ("Approved Output")
 * and ~/.kpass/skills/form-session-delegation/references/delegation-schema.md.
 */

export interface PassportSession {
  sessionId: string;
  status: string;
  expiresAt: string;
  taskSummary: string;
  maxPerTx: string;
  maxTotal: string | null;
  currency: string;
  allowedEndpoints: { method: string; host: string; path_prefix: string }[];
  /** Spend Kite has recorded on the session (Kite only sees payments it executes, so 0 on this route). */
  kiteSpentTotal: string | null;
}

export interface PassportRequest {
  requestId: string;
  approvalUrl: string;
  userMessage: string;
  expiresAt?: string;
}

const DEFAULT_KPASS = join(homedir(), ".kpass", "bin", process.platform === "win32" ? "kpass.exe" : "kpass");

function run(bin: string, args: string[], prefix: string[] = [], timeoutMs = 60_000): Promise<{ code: number; json: any; text: string }> {
  return new Promise((resolve) => {
    execFile(bin, [...prefix, ...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const text = `${stdout ?? ""}`.trim() || `${stderr ?? ""}`.trim();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0;
      resolve({ code, json, text });
    });
  });
}

/** "0.0010000" -> "0.001" so amounts never carry more decimals than the token. */
const norm = (v: unknown) => {
  const t = String(v).trim();
  return t.includes(".") ? t.replace(/0+$/, "").replace(/\.$/, "") : t;
};

/** Reads a session object as documented under "Approved Output". */
export function parseSession(json: any): PassportSession | null {
  const s = json?.session;
  if (!s || typeof s !== "object") return null;
  const pp = s.delegation?.payment_policy ?? {};
  const eps = s.delegation?.execution_constraints?.x402?.allowed_endpoints;
  const id = json.session_id ?? s.id;
  if (!id || !pp.max_amount_per_tx) return null;
  return {
    sessionId: String(id),
    status: String(s.status ?? "unknown"),
    expiresAt: String(s.expires_at ?? ""),
    taskSummary: String(s.delegation?.task?.summary ?? ""),
    maxPerTx: norm(pp.max_amount_per_tx),
    maxTotal: pp.max_total_amount != null ? norm(pp.max_total_amount) : null,
    currency: String(pp.currency ?? "USD"),
    allowedEndpoints: Array.isArray(eps) ? eps : [],
    kiteSpentTotal: s.usage?.spent_total != null ? String(s.usage.spent_total) : null,
  };
}

export class PassportClient {
  constructor(private opts: { bin?: string; prefixArgs?: string[] } = {}) {}

  private kpass(args: string[], timeoutMs?: number) {
    return run(this.opts.bin ?? DEFAULT_KPASS, [...args, "--output", "json"], this.opts.prefixArgs, timeoutMs);
  }

  /** Starts a separate, passkey-approved spending session. Nothing is spent. */
  async request(p: { taskSummary: string; maxPerTx: string; maxTotal: string; ttlSeconds: number; endpoint: { method: string; host: string; pathPrefix: string } }): Promise<PassportRequest> {
    const delegation = {
      task: { summary: p.taskSummary },
      payment_policy: { max_amount_per_tx: p.maxPerTx, max_total_amount: p.maxTotal, ttl_seconds: p.ttlSeconds },
      execution_constraints: { x402: { scope_mode: "scoped", allowed_endpoints: [{ method: p.endpoint.method, host: p.endpoint.host, path_prefix: p.endpoint.pathPrefix }] } },
    };
    const { json, text } = await this.kpass(["session", "create", "--separate", "--no-browser", "--no-reuse", "--no-interactive", "--delegation", JSON.stringify(delegation)]);
    if (!json?.request_id || !json?.approval_url) throw new Error(`kpass session create failed: ${json?.error ?? text.slice(0, 300)}`);
    return { requestId: json.request_id, approvalUrl: json.approval_url, userMessage: json.user_message ?? "", expiresAt: json.expires_at };
  }

  /** One status check (no waiting). Returns the session once approved. */
  async status(requestId: string): Promise<{ state: "approved" | "pending" | "rejected" | "error"; session: PassportSession | null; raw: any }> {
    const { code, json, text } = await this.kpass(["session", "status", "--request-id", requestId, "--no-interactive"]);
    const session = parseSession(json);
    if (code === 0 && json?.status === "success" && session) return { state: "approved", session, raw: json };
    if (code === 3 || /reject|denied|expired/i.test(json?.error_code ?? "")) return { state: "rejected", session: null, raw: json ?? text };
    if (code === 0) return { state: "pending", session: null, raw: json ?? text };
    return { state: "error", session: null, raw: json ?? text };
  }
}

export type GuardRefusal = "passport_missing" | "session_expired" | "session_rule_exceeded" | "session_total_exceeded" | "session_endpoint_forbidden";

/**
 * Enforces an approved Passport session's limits on another payer.
 * Spend under the session is kept in a small JSON file so it survives restarts
 * and is shared by every run that uses the same session. Reservation happens
 * synchronously before the inner payer is called, so concurrent runs cannot
 * overshoot the total cap.
 */
export class PassportGuard {
  private spentUnits = 0n;
  private reservedUnits = 0n;
  readonly decimals = 6;

  constructor(
    readonly session: PassportSession,
    private file: string,
    private now: () => number = Date.now,
  ) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      if (saved.sessionId === session.sessionId) this.spentUnits = BigInt(saved.spentUnits ?? "0");
    } catch {
      /* new session */
    }
  }

  get spent(): string {
    const d = 10n ** BigInt(this.decimals);
    const whole = this.spentUnits / d;
    const frac = (this.spentUnits % d).toString().padStart(this.decimals, "0").replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : `${whole}`;
  }

  /** Why a payment of `amount` to `url` would be refused, or null if allowed. Reserves on success. */
  reserve(url: string, amount: string): { refused: GuardRefusal; message: string } | null {
    const s = this.session;
    if (s.status !== "active") return { refused: "session_expired", message: `Passport session ${s.sessionId} is ${s.status}` };
    if (!s.expiresAt || this.now() >= Date.parse(s.expiresAt)) return { refused: "session_expired", message: `Passport session ${s.sessionId} expired at ${s.expiresAt}` };
    const amt = toBaseUnits(amount, this.decimals);
    if (amt > toBaseUnits(s.maxPerTx, this.decimals)) return { refused: "session_rule_exceeded", message: `${amount} is above the Passport per-payment cap of ${s.maxPerTx}` };
    if (s.maxTotal != null && this.spentUnits + this.reservedUnits + amt > toBaseUnits(s.maxTotal, this.decimals))
      return { refused: "session_total_exceeded", message: `would pass the Passport total cap of ${s.maxTotal} (spent ${this.spent})` };
    if (s.allowedEndpoints.length) {
      const u = new URL(url);
      const ok = s.allowedEndpoints.some((e) => e.host.toLowerCase() === u.host.toLowerCase() && u.pathname.startsWith(e.path_prefix) && (!e.method || e.method.toUpperCase() === "GET"));
      if (!ok) return { refused: "session_endpoint_forbidden", message: `${u.host}${u.pathname} is not an endpoint this Passport session approved` };
    }
    this.reservedUnits += amt;
    return null;
  }

  settle(amount: string, charged: boolean) {
    const amt = toBaseUnits(amount, this.decimals);
    this.reservedUnits -= amt;
    if (charged) {
      this.spentUnits += amt;
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ sessionId: this.session.sessionId, spentUnits: this.spentUnits.toString(), updatedAt: new Date(this.now()).toISOString() }));
    }
  }
}

/** Wraps a payer so every payment must fit inside the approved Passport session first. */
export class PassportLimitedPayer implements Payer {
  constructor(
    private inner: Payer,
    private guard: PassportGuard,
    private amount: string,
  ) {}

  async pay(req: PayRequest): Promise<PayResult> {
    const no = this.guard.reserve(req.url, this.amount);
    if (no) return { kind: "not-charged", errorCode: no.refused, message: no.message, raw: { passportSessionId: this.guard.session.sessionId } };
    let res: PayResult;
    try {
      res = await this.inner.pay(req);
    } catch (err) {
      // Unknown outcome: count it as spent so the cap stays safe.
      this.guard.settle(this.amount, true);
      throw err;
    }
    this.guard.settle(this.amount, res.kind !== "not-charged");
    return res;
  }
}
