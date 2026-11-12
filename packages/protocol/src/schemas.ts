import { z } from "zod";

export const PROTOCOL_VERSION = "pawlr/1" as const;

const decimal = z.string().regex(/^\d+(\.\d+)?$/, "decimal string");
const hex64 = z.string().regex(/^[0-9a-f]{64}$/, "lowercase sha256 hex");
const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "0x address");

/** CLAUDE.md §7.2 */
export const DeliveryConditions = z.object({
  version: z.literal(PROTOCOL_VERSION),
  sessionId: z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/),
  task: z.string().min(1),
  seller: z.object({ payTo: evmAddress, endpoint: z.string().url() }),
  network: z.enum(["eip155:2366", "eip155:2368"]),
  asset: z.string().min(1),
  pricePerTick: decimal,
  maxTicks: z.number().int().min(1).max(1000),
  maxSpend: decimal,
  presence: z.object({ maxAgeSeconds: z.number().int().min(1) }),
  completion: z.object({
    minSentences: z.literal(1),
    maxSentences: z.literal(3),
    minKeyTerms: z.literal(3),
  }),
  relevance: z.object({ rule: z.string().min(1) }),
  document: z.object({
    sections: z.array(z.object({ name: z.string().min(1), sourceHash: hex64 })).min(1),
  }),
});
export type DeliveryConditions = z.infer<typeof DeliveryConditions>;

/** CLAUDE.md §7.3. `output` is untrusted text. */
export const TickEvidence = z.object({
  sessionId: z.string(),
  tick: z.number().int().min(1),
  timestamp: z.string(),
  sectionName: z.string(),
  sourceHash: hex64,
  outputHash: hex64,
  conditionsHash: hex64,
  output: z.string(),
});
export type TickEvidence = z.infer<typeof TickEvidence>;

/** Section text the buyer sends with the session so the seller can summarise it. */
export const SessionSection = z.object({ name: z.string().min(1), text: z.string().min(1) });
export type SessionSection = z.infer<typeof SessionSection>;

/** Body of POST /sessions. */
export const CreateSessionRequest = z.object({
  conditions: DeliveryConditions,
  sections: z.array(SessionSection).min(1),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

/** Body of POST /sessions/:id/refund-requests (the Recover claim, CLAUDE.md §10.2). */
export const RefundClaim = z.object({
  sessionId: z.string(),
  conditionsHash: hex64,
  ticks: z.array(z.number().int().min(1)).min(1),
  amountOwed: decimal,
  summary: z.string().min(1),
  evidence: z.array(z.object({ tick: z.number().int().min(1), quote: z.string(), reason: z.string() })),
});
export type RefundClaim = z.infer<typeof RefundClaim>;

/** Body of POST /sessions/:id/evidence/:tick (seller adds evidence to a disputed tick). */
export const AddedEvidence = z.object({
  note: z.string().min(1).max(4000),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type AddedEvidence = z.infer<typeof AddedEvidence>;

/** Header the buyer sends with each tick request: the agreed conditions hash. */
export const CONDITIONS_HASH_HEADER = "pawlr-conditions-hash";
