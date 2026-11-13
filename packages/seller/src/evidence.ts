import { sha256Hex, type TickEvidence } from "@pawlr/protocol";
import type { SessionRecord } from "./store.js";

/**
 * Framework-free: builds the TickEvidence (agent.md §7.3) a seller returns
 * with one tick. Use it from any HTTP framework; the Hono app in server.ts
 * uses it too.
 */
export function createTickEvidence(input: {
  session: Pick<SessionRecord, "conditions" | "conditionsHash">;
  tick: number;
  /** Index into conditions.document.sections of the section this tick delivers. */
  sectionIndex: number;
  /** The deliverable. Untrusted from the buyer's point of view. */
  output: string;
  timestampMs?: number;
}): TickEvidence {
  const section = input.session.conditions.document.sections[input.sectionIndex];
  if (!section) throw new Error(`no section ${input.sectionIndex} in the agreed document`);
  return {
    sessionId: input.session.conditions.sessionId,
    tick: input.tick,
    timestamp: new Date(input.timestampMs ?? Date.now()).toISOString(),
    sectionName: section.name,
    sourceHash: section.sourceHash,
    outputHash: sha256Hex(input.output),
    conditionsHash: input.session.conditionsHash,
    output: input.output,
  };
}
