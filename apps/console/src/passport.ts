import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassportClient, PassportGuard, type PassportSession } from "@pawlr/buyer";

/**
 * The console's Kite Passport state: one owner-approved spending session that
 * every dashboard run is checked against. The owner (admin password) requests a
 * session; Kite returns an approval link; the owner approves it with their
 * passkey; the console polls Kite until it is active and then enforces its
 * limits through PassportGuard. See packages/buyer/src/passport.ts for why
 * the payment itself goes out over x402 from the buyer wallet.
 */
export interface PassportView {
  state: "none" | "pending" | "active" | "expired" | "rejected";
  sessionId: string | null;
  maxPerTx: string | null;
  maxTotal: string | null;
  currency: string | null;
  expiresAt: string | null;
  taskSummary: string | null;
  allowedEndpoint: string | null;
  spentViaPawlr: string | null;
  requestedAt: string | null;
  approvedAt: string | null;
  checkedAt: string | null;
}

interface Saved {
  requestId?: string;
  approvalUrl?: string;
  requestedAt?: string;
  approvedAt?: string;
  rejected?: boolean;
  session?: PassportSession;
}

export class ConsolePassport {
  private saved: Saved = {};
  private guard: PassportGuard | null = null;
  private checkedAt: string | null = null;
  private file: string;

  constructor(
    private client: PassportClient,
    private dir: string,
    private cfg: { host: string; pathPrefix: string; maxPerTx: string; maxTotal: string; ttlSeconds: number },
  ) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "current.json");
    try {
      this.saved = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      /* none yet */
    }
    if (this.saved.session) this.guard = new PassportGuard(this.saved.session, join(dir, `spend-${this.saved.session.sessionId}.json`));
  }

  private save() {
    writeFileSync(this.file, JSON.stringify(this.saved, null, 1));
  }

  /** Owner only. Starts a new Passport session request and returns Kite's approval link. */
  async request() {
    const r = await this.client.request({
      taskSummary: `Pawlr: pay ${this.cfg.host} one tick at a time, at most ${this.cfg.maxPerTx} per tick`,
      maxPerTx: this.cfg.maxPerTx,
      maxTotal: this.cfg.maxTotal,
      ttlSeconds: this.cfg.ttlSeconds,
      endpoint: { method: "GET", host: this.cfg.host, pathPrefix: this.cfg.pathPrefix },
    });
    this.saved = { ...this.saved, requestId: r.requestId, approvalUrl: r.approvalUrl, requestedAt: new Date().toISOString(), approvedAt: undefined, rejected: false };
    this.save();
    return { approvalUrl: r.approvalUrl, requestId: r.requestId, userMessage: r.userMessage };
  }

  /** Asks Kite once whether the pending request was approved. */
  async refresh() {
    if (!this.saved.requestId || this.saved.approvedAt || this.saved.rejected) return this.view();
    const st = await this.client.status(this.saved.requestId);
    this.checkedAt = new Date().toISOString();
    if (st.state === "approved" && st.session) {
      this.saved.session = st.session;
      this.saved.approvedAt = this.checkedAt;
      this.guard = new PassportGuard(st.session, join(this.dir, `spend-${st.session.sessionId}.json`));
      this.save();
    } else if (st.state === "rejected") {
      this.saved.rejected = true;
      this.save();
    }
    return this.view();
  }

  /** The guard for a new run, or null if no approved, unexpired session exists. */
  activeGuard(): PassportGuard | null {
    const v = this.view();
    return v.state === "active" ? this.guard : null;
  }

  view(): PassportView {
    const s = this.saved.session;
    const pendingNewer = this.saved.requestId && !this.saved.approvedAt && !this.saved.rejected;
    let state: PassportView["state"] = "none";
    if (s) state = s.status === "active" && Date.now() < Date.parse(s.expiresAt) ? "active" : "expired";
    if (state !== "active" && pendingNewer) state = "pending";
    if (state === "none" && this.saved.rejected) state = "rejected";
    const ep = s?.allowedEndpoints[0];
    return {
      state,
      sessionId: s?.sessionId ?? null,
      maxPerTx: s?.maxPerTx ?? null,
      maxTotal: s?.maxTotal ?? null,
      currency: s?.currency ?? null,
      expiresAt: s?.expiresAt ?? null,
      taskSummary: s?.taskSummary ?? null,
      allowedEndpoint: ep ? `${ep.method} ${ep.host}${ep.path_prefix}` : null,
      spentViaPawlr: this.guard?.spent ?? null,
      requestedAt: this.saved.requestedAt ?? null,
      approvedAt: this.saved.approvedAt ?? null,
      checkedAt: this.checkedAt,
    };
  }

  /** Approval link, for the owner only. */
  approvalUrl() {
    return this.saved.approvedAt ? null : (this.saved.approvalUrl ?? null);
  }
}
