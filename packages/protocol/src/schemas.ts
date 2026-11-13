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

/** CLAUDE.md §7.4. `ok: null` means the stage did not run. */
export const Check = z.object({ ok: z.boolean().nullable(), detail: z.string() });
export type Check = z.infer<typeof Check>;

export const Verdict = z.enum(["pass", "fail", "unsure"]);
export type Verdict = z.infer<typeof Verdict>;

export const TickVerdict = z.object({
  sessionId: z.string(),
  tick: z.number().int().min(1),
  verdict: Verdict,
  decidedBy: z.enum(["code", "dolphin+serv", "serv", "serv+shadow", "dolphin", "reppo", "human"]),
  checks: z.object({
    presence: Check,
    integrity: Check,
    completion: Check,
    guard: Check,
    screen: Check.optional(),
    relevance: Check.optional(),
    quote: Check.optional(),
    shadow: Check.optional(),
  }),
  quote: z.string().nullable(),
  reason: z.string(),
  payment: z.object({ txHash: z.string().nullable(), amount: z.string(), network: z.string() }),
  cost: z.object({
    servTokens: z.number().optional(),
    servUsd: z.number().optional(),
    dolphinUsd: z.number().optional(),
    reppoCredits: z.number().optional(),
  }),
  promptVersion: z.string().nullable(),
  latencyMs: z.number(),
  createdAt: z.string(),
});
export type TickVerdict = z.infer<typeof TickVerdict>;

/** CLAUDE.md §7.5 */
export const Receipt = z.object({
  sessionId: z.string(),
  conditionsHash: hex64,
  ticksPaid: z.number().int(),
  ticksRefused: z.number().int(),
  ticksInReview: z.number().int(),
  totalPaid: decimal,
  maxLossBound: decimal,
  ticks: z.array(TickVerdict),
  startedAt: z.string(),
  endedAt: z.string(),
});
export type Receipt = z.infer<typeof Receipt>;

/** Header the buyer sends with each tick request: the agreed conditions hash. */
export const CONDITIONS_HASH_HEADER = "pawlr-conditions-hash";
