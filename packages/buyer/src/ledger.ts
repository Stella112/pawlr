import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TickEvidence, TickVerdict } from "@pawlr/protocol";

/**
 * Persistent payment ledger, one file per session: data/ledger/<sessionId>.json.
 *
 * The "paying" entry is written and flushed to disk BEFORE any payment is
 * sent. If the process dies after that, the next run finds the entry and
 * recovers by the same idempotency key instead of paying again
 * (CLAUDE.md §2.3, §10.1).
 */

export type TickState = "paying" | "paid" | "uncertain" | "not-charged";

export interface LedgerEntry {
  tick: number;
  state: TickState;
  key: string;
  url: string;
  startedAt: string;
  paidAt?: string;
  txHash?: string | null;
  note?: string;
  evidence?: TickEvidence;
  verdict?: TickVerdict;
}

export interface LedgerFile {
  sessionId: string;
  conditionsHash: string;
  ticks: Record<string, LedgerEntry>;
}

export class Ledger {
  readonly file: string;
  private data: LedgerFile;

  constructor(dataDir: string, sessionId: string, conditionsHash: string) {
    this.file = join(dataDir, "ledger", `${sessionId}.json`);
    if (existsSync(this.file)) {
      this.data = JSON.parse(readFileSync(this.file, "utf8"));
      if (this.data.conditionsHash !== conditionsHash) throw new Error(`ledger ${this.file} belongs to a different conditionsHash`);
    } else {
      this.data = { sessionId, conditionsHash, ticks: {} };
      this.flush();
    }
  }

  get(tick: number): LedgerEntry | undefined {
    return this.data.ticks[String(tick)];
  }

  all(): LedgerEntry[] {
    return Object.values(this.data.ticks).sort((a, b) => a.tick - b.tick);
  }

  /** The one place a tick moves to "paying". Throws if the tick already has an entry. */
  beginPayment(tick: number, url: string): LedgerEntry {
    if (this.get(tick)) throw new Error(`tick ${tick} already has a ledger entry; refusing to start a second payment`);
    const entry: LedgerEntry = { tick, state: "paying", key: `pawlr-${this.data.sessionId}-${tick}`, url, startedAt: new Date().toISOString() };
    this.data.ticks[String(tick)] = entry;
    this.flush();
    return entry;
  }

  update(tick: number, patch: Partial<LedgerEntry>) {
    const cur = this.get(tick);
    if (!cur) throw new Error(`no ledger entry for tick ${tick}`);
    this.data.ticks[String(tick)] = { ...cur, ...patch };
    this.flush();
  }

  private flush() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    const fd = openSync(tmp, "r+");
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, this.file);
  }
}
