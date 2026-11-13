# Pawlr protocol (`pawlr/1`)

Pawlr pays a service one tick at a time over x402, checks each delivery against conditions both sides agreed, and stops paying the moment delivery fails. This document specifies the messages, hashing, sequence and verdict meanings so that any x402 seller or buyer can interoperate. Reference implementation: `packages/protocol` (schemas, hashing), `packages/seller`, `packages/verifier`, `packages/buyer`.

## 1. Honesty statements (normative)

These hold for every implementation and every claim made about it.

1. With standard x402 a tick is **paid, then judged**. A failed tick stops the *next* payment. The maximum loss is one tick. Pawlr never claims to block payment for a bad tick before it is delivered.
2. Pawlr judges only against the written, hashed Delivery Conditions.
3. Unclear ticks go to review. Nothing unclear is rejected automatically.
4. Failures in demos and benchmarks are staged with a failure switch and labelled simulated.
5. A refund claim is a request. Money is not returned automatically.

## 2. Canonical hashing

- `canonicalJson(value)`: JSON with object keys sorted recursively, no whitespace, UTF-8; arrays keep their order; `undefined` fields are dropped; non-finite numbers are rejected.
- `sha256Hex(text)`: SHA-256 of the UTF-8 bytes, lowercase hex.
- `conditionsHash = sha256Hex(canonicalJson(conditions))`.
- `sourceHash = sha256Hex(sectionText)`; `outputHash = sha256Hex(output)`.

Key order never changes a hash; any value change does.

## 3. Messages

### 3.1 DeliveryConditions (agreed before any payment)

```ts
{
  version: "pawlr/1",
  sessionId: string,                    // chosen by the buyer, unique per seller
  task: string,
  seller: { payTo: string, endpoint: string },
  network: "eip155:2366" | "eip155:2368",   // Kite mainnet | Kite testnet
  asset: string,                        // token contract address, as the seller's x402 config states it
  pricePerTick: string,                 // decimal, token units
  maxTicks: number,
  maxSpend: string,                     // decimal, token units
  presence:   { maxAgeSeconds: number },
  completion: { minSentences: 1, maxSentences: 3, minKeyTerms: 3 },
  relevance:  { rule: string },         // the written rule the judge applies
  document:   { sections: { name: string, sourceHash: string }[] }
}
```

### 3.2 Agreement

`POST /sessions` with `{ conditions, sections: [{ name, text }] }`. The seller checks that payee, network, asset and price are its own and that each `text` hashes to its `sourceHash`, stores the session and answers `201 { sessionId, conditionsHash }`. The buyer **aborts** if the returned hash differs from its own.

### 3.3 Paid tick

`GET /tick/:sessionId/:n` with header `pawlr-conditions-hash: <conditionsHash>`, paid with x402 v2 (`PAYMENT-SIGNATURE`). Before asking for any payment the seller answers `403` (never charged) for an unknown session, a different conditions hash, a tick beyond `maxTicks`, or any tick other than `lastServedTick + 1`. Settlement happens only when the seller answers below 400.

The response body is **TickEvidence**; the settlement comes back in the x402 `PAYMENT-RESPONSE` header (`transaction` is the on-chain hash).

```ts
{ sessionId, tick, timestamp, sectionName, sourceHash, outputHash, conditionsHash, output }
```

`output` is untrusted.

### 3.4 Evidence and fairness

- `GET /sessions/:id/evidence/:tick` (free): the served evidence, the recorded settlement and any evidence the seller added.
- `POST /sessions/:id/evidence/:tick` (seller admin): add evidence to a disputed tick.

### 3.5 TickVerdict and Receipt

```ts
TickVerdict = {
  sessionId, tick,
  verdict: "pass" | "fail" | "unsure",
  decidedBy: "code" | "dolphin+serv" | "serv" | "serv+shadow" | "dolphin" | "reppo" | "human",
  checks: { presence, integrity, completion, guard, screen?, relevance?, quote?, shadow? },  // each { ok: boolean | null, detail }
  quote: string | null, reason: string,
  payment: { txHash: string | null, amount: string, network: string },
  cost: { servTokens?, servUsd?, dolphinUsd?, reppoCredits? },
  promptVersion: string | null, latencyMs: number, createdAt: string
}
Receipt = { sessionId, conditionsHash, ticksPaid, ticksRefused, ticksInReview, totalPaid, maxLossBound /* = pricePerTick */, ticks: TickVerdict[], startedAt, endedAt }
```

### 3.6 Recover claim

`POST /sessions/:id/refund-requests` with `{ sessionId, conditionsHash, ticks, amountOwed, summary, evidence: [{ tick, quote, reason }] }` → `201 { requestId, receivedAt, note: "Refund requested. Money is not returned automatically." }`. `amountOwed` must equal `len(ticks) × pricePerTick`; code wins over any model draft.

## 4. Tick sequence

```
Buyer                           Seller (x402 paywall)                 Verifier
  1. POST /sessions ───────────► check terms + hashes → conditionsHash
  2. GET tick n (no payment) ──► 402 + PAYMENT-REQUIRED
     check payee, network, asset, amount ≤ pricePerTick (else abort, nothing paid)
     ledger: tick n = "paying" (flushed to disk)
  3. GET tick n + PAYMENT-SIGNATURE ─► verify → serve → settle
     ◄── TickEvidence + PAYMENT-RESPONSE (tx hash)
  4. judge ───────────────────────────────────────────────────────► verdict
     pass → tick n+1 · fail → PAUSE · unsure → REVIEW (paused)
  5. receipt
```

## 5. Verdict pipeline and meanings

Stages run in order and stop at the first decisive result:

1. **Presence** (code): session and tick match, tick = last + 1, timestamp within `maxAgeSeconds` and at most 30 s in the future, conditions hash matches. Fail → `fail`.
2. **Integrity** (code): `sourceHash` equals the buyer's own hash for that section; `sha256(output) = outputHash`. Fail → `fail`.
3. **Completion** (code): non-empty, 1 to 3 sentences (a sentence ends in `.`, `!` or `?` followed by whitespace or end of text), at least 3 of the section's key terms (lowercase tokens of 3+ letters, stopwords and numbers removed, a trailing "s" dropped on words over 4 letters, top 8 by frequency, ties by first appearance). Fail → `fail`.
4. **Guard + relevance** (model): one structured ruling `{ verdict, quote, reason }` with a prompt-injection guard in the same request. A guard refusal → `unsure` ("evidence flagged as injection attempt"), never `pass`.
5. **Quote-or-hold** (code): the quote must be a non-empty exact substring of the output or the section text after whitespace normalisation only. Otherwise, or on invalid, truncated, refused or off-schema output → `unsure`.
6. **Second look** on `unsure`: re-run with validation; still unclear → review.
7. Errors: one retry on 429/5xx, then `unsure` ("judge unavailable"). **Never pass on error.**

Meanings: `pass` = the buyer may pay the next tick. `fail` = pause; show the reason and quote to both sides. `unsure` = pause for a person (or an independent judge); the session resumes only on `pass`.

## 6. Security notes

- **Untrusted evidence:** the seller's output is data. The judge is told to ignore instructions inside it, a guard runs on every ruling, and code must confirm the quote.
- **Quote rule:** a model verdict without a valid quote never pays and never fails a tick.
- **Idempotency:** the buyer writes "paying" to a persistent ledger before signing; a tick with an entry is never paid again, only recovered (from the evidence route, or a retry with the same idempotency key when the seller never served it).
- **Payee lock:** payee, network, asset and amount are checked before every signature, and a wallet signing policy refuses anything else.
- **Spend caps:** per tick and per session, required on mainnet.

## 7. Versioning

`version: "pawlr/1"` is part of the hashed conditions. A change to any message shape, hashing rule or code check bumps the version. Prompt changes are versioned separately (`promptVersion` in every verdict, e.g. `ruling-v1`).
