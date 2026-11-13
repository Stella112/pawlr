import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DeliveryConditions, SessionSection, TickEvidence } from "@pawlr/protocol";

export type FailureMode = "junk" | "off-topic" | "stale" | "empty" | "injection" | "subtle";
export const FAILURE_MODES: FailureMode[] = ["junk", "off-topic", "stale", "empty", "injection", "subtle"];

export interface SessionRecord {
  conditions: DeliveryConditions;
  conditionsHash: string;
  sections: SessionSection[];
  lastServedTick: number;
  createdAt: string;
}

export interface FailureSwitch {
  mode: FailureMode;
  fromTick: number;
  setAt: string;
}

export interface TruthEntry {
  tick: number;
  at: string;
  /** "honest", or the staged failure mode actually applied (SIMULATED failure). */
  served: "honest" | FailureMode;
  requestedSection: string;
  /** Section whose text the output was really generated from (differs for "subtle"). */
  generatedFromSection: string | null;
  evidence: TickEvidence;
}

/** File-backed store under DATA_DIR. JSON / JSONL only (CLAUDE.md §6.1: no database). */
export class Store {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private path(...parts: string[]) {
    return join(this.dir, ...parts);
  }

  private readJson<T>(file: string): T | undefined {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined;
  }

  private writeJson(file: string, value: unknown) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, file);
  }

  private appendJsonl(file: string, value: unknown) {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(value) + "\n");
  }

  private readJsonl<T>(file: string): T[] {
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
  }

  getSession(id: string) {
    return this.readJson<SessionRecord>(this.path("sessions", `${id}.json`));
  }
  putSession(id: string, s: SessionRecord) {
    this.writeJson(this.path("sessions", `${id}.json`), s);
  }

  getFailure(id: string) {
    return this.readJson<FailureSwitch>(this.path("failure", `${id}.json`));
  }
  putFailure(id: string, f: FailureSwitch | null) {
    const file = this.path("failure", `${id}.json`);
    if (f) this.writeJson(file, f);
    else if (existsSync(file)) this.writeJson(file, null);
  }

  appendTruth(id: string, e: TruthEntry) {
    this.appendJsonl(this.path("truth", `${id}.jsonl`), e);
  }
  readTruth(id: string) {
    return this.readJsonl<TruthEntry>(this.path("truth", `${id}.jsonl`));
  }

  /** Evidence as served for a tick (read from the truth log). */
  getServedEvidence(id: string, tick: number): TickEvidence | undefined {
    return this.readTruth(id).find((e) => e.tick === tick)?.evidence;
  }

  recordSettlement(id: string, tick: number, settle: unknown) {
    this.appendJsonl(this.path("settlements", `${id}.jsonl`), { tick, at: new Date().toISOString(), settle });
  }
  getSettlement(id: string, tick: number) {
    return this.readJsonl<{ tick: number; settle: unknown }>(this.path("settlements", `${id}.jsonl`)).find((e) => e.tick === tick)?.settle as
      | { transaction?: string; network?: string; success?: boolean }
      | undefined;
  }

  addEvidence(id: string, tick: number, added: unknown) {
    const entry = { id: randomUUID(), tick, at: new Date().toISOString(), added };
    this.appendJsonl(this.path("added-evidence", `${id}.jsonl`), entry);
    return entry;
  }
  getAddedEvidence(id: string, tick: number) {
    return this.readJsonl<{ id: string; tick: number; at: string; added: unknown }>(this.path("added-evidence", `${id}.jsonl`)).filter(
      (e) => e.tick === tick,
    );
  }

  addRefundRequest(id: string, claim: unknown) {
    const entry = { requestId: randomUUID(), receivedAt: new Date().toISOString(), claim };
    this.appendJsonl(this.path("refund-requests", `${id}.jsonl`), entry);
    return entry;
  }
  getRefundRequests(id: string) {
    return this.readJsonl<{ requestId: string; receivedAt: string; claim: unknown }>(this.path("refund-requests", `${id}.jsonl`));
  }

  getCachedSummary(sourceHash: string) {
    return this.readJson<{ summary: string; model: string; createdAt: string }>(this.path("cache", "summaries", `${sourceHash}.json`));
  }
  putCachedSummary(sourceHash: string, v: { summary: string; model: string; createdAt: string }) {
    this.writeJson(this.path("cache", "summaries", `${sourceHash}.json`), v);
  }

  appendCost(entry: unknown) {
    this.appendJsonl(this.path("costs.jsonl"), entry);
  }
}
