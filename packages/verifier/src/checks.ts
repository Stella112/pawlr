import { sha256Hex, type Check, type DeliveryConditions, type TickEvidence } from "@pawlr/protocol";
import { keyTerms, matchedKeyTerms, splitSentences } from "./text.js";

export const CLOCK_SKEW_MS = 30_000;

export interface Expected {
  sessionId: string;
  /** Last tick that passed. The evidence must be for lastTick + 1. */
  lastTick: number;
  conditionsHash: string;
}

/** Stage 1, code: right session, right tick, fresh, under the agreed hash. */
export function presenceCheck(ev: TickEvidence, exp: Expected, conditions: DeliveryConditions, nowMs: number): Check {
  if (ev.sessionId !== exp.sessionId) return { ok: false, detail: `sessionId ${ev.sessionId} is not ${exp.sessionId}` };
  if (ev.tick !== exp.lastTick + 1) return { ok: false, detail: `tick ${ev.tick} is not the expected ${exp.lastTick + 1}` };
  if (ev.conditionsHash !== exp.conditionsHash) return { ok: false, detail: "conditionsHash does not match the agreed hash" };
  const ts = Date.parse(ev.timestamp);
  if (Number.isNaN(ts)) return { ok: false, detail: `timestamp "${ev.timestamp}" is not a date` };
  if (ts > nowMs + CLOCK_SKEW_MS) return { ok: false, detail: `timestamp is ${Math.round((ts - nowMs) / 1000)} s in the future (allowed skew 30 s)` };
  const ageS = (nowMs - ts) / 1000;
  if (ageS > conditions.presence.maxAgeSeconds) return { ok: false, detail: `evidence is ${Math.round(ageS)} s old (limit ${conditions.presence.maxAgeSeconds} s)` };
  return { ok: true, detail: `tick ${ev.tick}, ${Math.max(0, Math.round(ageS))} s old, hash matches` };
}

/** Stage 2, code: the section is the agreed one, and the output is what was hashed. */
export function integrityCheck(ev: TickEvidence, conditions: DeliveryConditions): Check {
  const agreed = conditions.document.sections.find((s) => s.name === ev.sectionName);
  if (!agreed) return { ok: false, detail: `section "${ev.sectionName}" is not in the agreed document` };
  if (agreed.sourceHash !== ev.sourceHash) return { ok: false, detail: `sourceHash for "${ev.sectionName}" differs from the buyer's copy` };
  if (sha256Hex(ev.output) !== ev.outputHash) return { ok: false, detail: "sha256(output) does not equal outputHash" };
  return { ok: true, detail: "section hash and output hash match" };
}

/** Stage 3, code: non-empty, 1 to 3 sentences, at least minKeyTerms of the section's key terms. */
export function completionCheck(ev: TickEvidence, sectionText: string, conditions: DeliveryConditions): Check {
  const { minSentences, maxSentences, minKeyTerms } = conditions.completion;
  if (!ev.output.trim()) return { ok: false, detail: "output is empty" };
  const n = splitSentences(ev.output).length;
  if (n < minSentences || n > maxSentences) return { ok: false, detail: `output has ${n} sentences (allowed ${minSentences} to ${maxSentences})` };
  const terms = keyTerms(sectionText);
  const need = Math.min(minKeyTerms, terms.length);
  const hit = matchedKeyTerms(ev.output, terms);
  if (hit.length < need) return { ok: false, detail: `output has ${hit.length} of the section's key terms (need ${need}): found [${hit.join(", ")}] of [${terms.join(", ")}]` };
  return { ok: true, detail: `${n} sentence(s); key terms found: ${hit.join(", ")}` };
}
