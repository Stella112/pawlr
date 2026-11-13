import { randomUUID } from "node:crypto";
import { hashConditions, requireAsset, toBaseUnits, type DeliveryConditions, type Receipt, type TickEvidence, type TickVerdict } from "@pawlr/protocol";
import type { ChatTransport, VerifierDeps } from "@pawlr/verifier";
import {
  Ledger,
  agreeSession,
  buildConditions,
  draftClaim,
  fetchSellerInfo,
  parseDocument,
  runTicks,
  sendClaim,
  type Payer,
  type Section,
  type SellerInfo,
  type SpendLimits,
} from "@pawlr/buyer";

export type Status = "draft" | "running" | "paused" | "review" | "done" | "stopped" | "error";

export interface TickView {
  tick: number;
  verdict: TickVerdict;
  sectionName?: string;
  output?: string;
}

export interface ConsoleSession {
  id: string;
  createdAt: string;
  conditions: DeliveryConditions;
  conditionsHash: string;
  sections: Section[];
  failure: { mode: string; fromTick: number } | null;
  status: Status;
  ticks: TickView[];
  log: string[];
  receipt?: Receipt & { stoppedBecause?: string };
  stoppedBecause?: string;
  refund?: { requestId: string; receivedAt: string; note: string; amountOwed: string; ticks: number[] };
  error?: string;
}

export interface ManagerDeps {
  sellerUrl: string;
  dataDir: string;
  payer: (conditions: DeliveryConditions) => Payer;
  payerLabel: string;
  serv: ChatTransport;
  verifier: Omit<VerifierDeps, "serv">;
  limits: SpendLimits;
  adminPassword: string;
  fetch?: typeof fetch;
  maxStartsPerHour?: number;
}

export const FAILURE_MODES = ["junk", "off-topic", "stale", "empty", "injection", "subtle"];
export const MAX_TICKS = 8;
const MAX_DOC_CHARS = 20_000;
const MAX_SECTIONS = 12;

export class SessionManager {
  private sessions = new Map<string, ConsoleSession>();
  private starts: number[] = [];
  private seller: SellerInfo | null = null;
  constructor(private deps: ManagerDeps) {}

  private f() {
    return this.deps.fetch ?? fetch;
  }

  async sellerInfo(): Promise<SellerInfo> {
    if (!this.seller) this.seller = await fetchSellerInfo(this.deps.sellerUrl, this.f());
    return this.seller;
  }

  get(id: string) {
    return this.sessions.get(id);
  }

  /** Step 1: show the conditions and their hash before anything is agreed. */
  async draft(markdown: string, ticks: number, failure: { mode: string; fromTick: number } | null, password = ""): Promise<ConsoleSession> {
    // The SIMULATED FAILURE switch is admin-only (agent.md §12).
    if (failure && password !== this.deps.adminPassword) throw new UserError("the simulated failure switch needs the admin password");
    if (markdown.length > MAX_DOC_CHARS) throw new UserError(`document is over ${MAX_DOC_CHARS} characters`);
    const sections = parseDocument(markdown);
    if (sections.length > MAX_SECTIONS) throw new UserError(`document has more than ${MAX_SECTIONS} sections`);
    if (!Number.isInteger(ticks) || ticks < 1 || ticks > MAX_TICKS) throw new UserError(`ticks must be 1 to ${MAX_TICKS}`);
    if (failure && (!FAILURE_MODES.includes(failure.mode) || !Number.isInteger(failure.fromTick) || failure.fromTick < 1)) throw new UserError("bad simulated failure");
    const seller = await this.sellerInfo();
    // The agreed cap is exactly ticks × price (never above the console's overall MAX_SPEND).
    const d = requireAsset(seller.network, seller.assetAddress).decimals;
    const perSession = BigInt(ticks) * toBaseUnits(seller.pricePerTick, d);
    const cap = perSession < toBaseUnits(this.deps.limits.maxSpend, d) ? perSession : toBaseUnits(this.deps.limits.maxSpend, d);
    const capText = (() => { const t = cap.toString().padStart(d + 1, "0"); const w = t.slice(0, -d) || "0"; const fr = t.slice(-d).replace(/0+$/, ""); return fr ? `${w}.${fr}` : w; })();
    const conditions = buildConditions(seller, sections, { maxTicks: ticks, maxSpend: capText, sessionId: `pawlr-${randomUUID().slice(0, 12)}` });
    const s: ConsoleSession = {
      id: conditions.sessionId,
      createdAt: new Date().toISOString(),
      conditions,
      conditionsHash: hashConditions(conditions),
      sections,
      failure,
      status: "draft",
      ticks: [],
      log: [],
    };
    this.sessions.set(s.id, s);
    return s;
  }

  /** Step 2: agree with the seller, optionally stage the SIMULATED failure, then run the ticks in the background. */
  async start(id: string): Promise<ConsoleSession> {
    const s = this.sessions.get(id);
    if (!s) throw new UserError("unknown session");
    if (s.status !== "draft") throw new UserError("session already started");
    const now = Date.now();
    this.starts = this.starts.filter((t) => now - t < 3_600_000);
    if (this.starts.length >= (this.deps.maxStartsPerHour ?? 30)) throw new UserError("demo limit reached for this hour; try again later");
    this.starts.push(now);

    const seller = await this.sellerInfo();
    const agreed = await agreeSession(seller, s.conditions, s.sections, this.f());
    if (agreed !== s.conditionsHash) throw new Error("conditions hash mismatch");
    s.log.push(`Agreed with the seller. conditionsHash ${agreed}`);
    if (s.failure) {
      const r = await this.f()(`${seller.baseUrl}/admin/failure`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.deps.adminPassword}` },
        body: JSON.stringify({ sessionId: s.id, mode: s.failure.mode, fromTick: s.failure.fromTick }),
      });
      if (!r.ok) throw new Error(`could not stage the simulated failure (${r.status})`);
      s.log.push(`SIMULATED FAILURE staged: "${s.failure.mode}" from tick ${s.failure.fromTick}`);
    }
    void this.run(s);
    return s;
  }

  private async run(s: ConsoleSession) {
    s.status = "running";
    try {
      const seller = await this.sellerInfo();
      const res = await runTicks(
        { seller, conditions: s.conditions, conditionsHash: s.conditionsHash, sections: s.sections, limits: this.deps.limits },
        { payer: this.deps.payer(s.conditions), verifier: { ...this.deps.verifier, serv: this.deps.serv }, fetch: this.f(), dataDir: this.deps.dataDir },
        {
          log: (l) => s.log.push(l),
          onTick: (v: TickVerdict, ev?: TickEvidence) => {
            s.ticks = s.ticks.filter((t) => t.tick !== v.tick);
            s.ticks.push({ tick: v.tick, verdict: v, sectionName: ev?.sectionName, output: ev?.output });
            s.ticks.sort((a, b) => a.tick - b.tick);
          },
        },
      );
      s.receipt = { ...res.receipt, stoppedBecause: res.stoppedBecause };
      s.stoppedBecause = res.stoppedBecause;
      const last = res.receipt.ticks[res.receipt.ticks.length - 1];
      s.status = last?.verdict === "fail" ? "paused" : last?.verdict === "unsure" ? "review" : res.stoppedBecause === "all ticks done" ? "done" : "stopped";
    } catch (err) {
      s.status = "error";
      s.error = err instanceof Error ? err.message : String(err);
      s.log.push(`error: ${s.error}`);
    }
  }

  /** Human review of an unclear tick. Approve resumes the meter; reject pauses it. Needs the admin password. */
  async review(id: string, tick: number, decision: "approve" | "reject", password: string) {
    if (!password || password !== this.deps.adminPassword) throw new UserError("wrong admin password");
    const s = this.sessions.get(id);
    if (!s || s.status !== "review") throw new UserError("session is not in review");
    const t = s.ticks.find((x) => x.tick === tick);
    if (!t || t.verdict.verdict !== "unsure") throw new UserError("that tick is not in review");
    const decided: TickVerdict = {
      ...t.verdict,
      verdict: decision === "approve" ? "pass" : "fail",
      decidedBy: "human",
      reason: `${decision === "approve" ? "Approved" : "Rejected"} by a human reviewer. Earlier: ${t.verdict.reason}`,
    };
    new Ledger(this.deps.dataDir, s.id, s.conditionsHash).update(tick, { verdict: decided });
    t.verdict = decided;
    s.log.push(`tick ${tick}: ${decision}d by a human reviewer`);
    if (decision === "approve") void this.run(s);
    else s.status = "paused";
    return s;
  }

  async claim(id: string, ticks: number[]) {
    const s = this.sessions.get(id);
    if (!s?.receipt) throw new UserError("no receipt yet");
    if (!ticks.length) throw new UserError("pick at least one tick");
    const paid = new Set(s.receipt.ticks.map((t) => t.tick));
    if (!ticks.every((t) => paid.has(t))) throw new UserError("you can only claim ticks that were paid");
    return draftClaim({ conditions: s.conditions, conditionsHash: s.conditionsHash, ticks, verdicts: s.receipt.ticks }, this.deps.serv);
  }

  async sendClaim(id: string, claim: Parameters<typeof sendClaim>[1]) {
    const s = this.sessions.get(id);
    if (!s) throw new UserError("unknown session");
    const r = await sendClaim((await this.sellerInfo()).baseUrl, claim, this.f());
    s.refund = { ...r, amountOwed: claim.amountOwed, ticks: claim.ticks };
    return r;
  }
}

export class UserError extends Error {}
