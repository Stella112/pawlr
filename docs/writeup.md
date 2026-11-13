# Pawlr: write-up (OpenServ SERV Hackathon Edition 02)

**Track:** Kite
**Live:** https://pawlr.vercel.app (seller) · https://pawlr.vercel.app/console (console)
**Code:** https://github.com/Stella112/pawlr

## What it does
Pawlr: the catch that stops paying the moment delivery fails. It pays a service one tick at a time over x402 on Kite, checks each delivery against conditions both sides agreed and hashed, and stops paying the moment delivery fails. With pay-then-verify a bad tick is paid once and caught; no later tick is paid. The most a buyer can lose is one tick. When a tick fails, Recover drafts one refund request with the evidence attached and sends it to the seller.

## How it uses SERV Reasoning
- **Structured ruling on every tick that passes the code checks:** `gpt-5.4-mini` through SERV with a strict JSON schema (`pawlr_ruling`: verdict, quote, reason) and a versioned prompt.
- **PromptGuard** in the same request, because the seller's output is untrusted. A guard refusal sends the tick to review and can never pass it.
- **Quote-or-hold:** the ruling must quote words that appear exactly in the seller output or the agreed section. Code checks it. No valid quote means review: the model alone can never pay or fail a tick.
- **Shadow Agent** re-rules unclear ticks before they go to human review.
- **Recover:** SERV drafts the refund claim (`pawlr_claim`) from the receipt; code re-checks the amount and the quotes and wins on any mismatch.
- **Seller side:** SERV writes the section summaries the seller sells, cached per section.
- Code runs first and model second; every call's tokens and cost are logged. In our live runs a ruling cost about $0.001.

## Kite integration
- The seller is built from Kite's official x402 template (`gokite-ai/kite-x402-services`), with `@x402/hono`, the Pieverse facilitator's Kite networks and pieUSD/USDC.e terms.
- Kite Passport: the buyer creates a spending session with per-payment and total caps, approved with a passkey, and pays each tick with `kpass session execute` and an idempotency key.
- **Honest status:** Kite Passport refused to pay our host because it is not in Kite's service catalog (`payment_target_forbidden`). Testnet pieUSD has no public source, and Permit2 is not deployed on Kite testnet. So the live demo pays with a direct x402 wallet (real EIP-3009 signatures), and the seller verifies each signature but **settlement is simulated**: no tokens move. It is labelled everywhere. Real settlement is one setting away once Kite allowlists the host or the wallet is funded.

## Creativity
A ratchet's pawl for agent payments: written, hashed delivery conditions, code-first checks, and a model that must quote its evidence turn "pay and hope" into "pay, check, and stop at the first bad tick".

## User readiness
Live seller and console on public https; one-click demo with a staged failure; receipts with "maximum possible loss: 1 tick"; refund requests in one step; 106 automated tests; a full live-versus-simulated table in the README.

## Revenue potential
A small fee per verified tick, charged to buyers who want the guarantee and sellers who want the trust badge, plus an open protocol and SDK that any x402 service can add, so every verified tick across the ecosystem can run through Pawlr.

## Not built (stated plainly)
Dolphin screening and Reppo disputes (API details were not available in time), the benchmark, and the SDK packages and examples. On-chain settlement is simulated on this deployment.
