# Pawlr: write-up (OpenServ SERV Hackathon Edition 02)

**Track:** Kite
**Live:** https://pawlr.vercel.app (landing page) · https://pawlr.vercel.app/dashboard (dashboard)
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
- The seller is built from Kite's official x402 template (`gokite-ai/kite-x402-services`) with `@x402/hono` on Kite testnet (`eip155:2368`).
- **Every paid tick settles on-chain on Kite testnet**, with a real transaction on testnet.kitescan.ai. Settlement runs the official x402 facilitator code (`@x402/core` + `@x402/evm`) with a gas wallet funded from Kite's faucet.
- The token is **Pawlr Test USD**, our own testnet-only EIP-3009 token, because pieUSD (the testnet token Kite's x402 setup lists) has no public source.
- Kite Passport is wired in (spending session with per-payment and total caps, approved with a passkey; payment per tick with an idempotency key), but Passport refused our host because it is not in Kite's service catalog. The live demo pays with the official x402 client from a wallet, with Pawlr's own per-tick and per-session caps.

## Dolphin and Reppo
- **Dolphin** (`deepseek-ai/DeepSeek-V4.1-Flash`) screens every tick that passes the code checks with the same structured ruling, quote-checked by code. A fail or unsure always goes to SERV. In economy mode a clean Dolphin pass settles the tick: on the benchmark evidence this kept 0 false accepts and 0 false rejects and cut judging cost per tick from about $0.00095 to $0.00006.
- **Reppo** gives an independent verdict on a disputed tick from the console: its evaluator panel's route (`ship` / `review` / `block`) maps to pass / unsure / fail, and only a pass resumes payments. On the benchmark's disputed ticks Reppo agreed with Pawlr 4 of 6 times; the differences (a stale timestamp it cannot see, an empty output it sent to review) are listed in the benchmark.

## Creativity
A ratchet's pawl for agent payments: written, hashed delivery conditions, code-first checks, and a model that must quote its evidence turn "pay and hope" into "pay, check, and stop at the first bad tick".

## User readiness
Live seller and console on public https; real on-chain testnet payments; one-click demo with a staged failure; receipts with "maximum possible loss: 1 tick"; refund requests in one step; 100+ automated tests, including real on-chain settlement on a local chain; a full live-versus-simulated table in the README.

## Revenue potential
A small fee per verified tick, charged to buyers who want the guarantee and sellers who want the trust badge, plus an open protocol and SDK that any x402 service can add, so every verified tick across the ecosystem can run through Pawlr.

## Proof
Benchmark from real testnet runs (docs/benchmark.md): every staged failure caught at the first bad tick, exactly one bad tick paid per scenario, 0 false accepts and 0 false rejects with code + SERV, and with code + Dolphin + SERV in economy mode; code alone would have paid the hidden-instruction tick that SERV caught. Reppo agreed with Pawlr on 4 of 6 disputed ticks.

## Not built (stated plainly)
Kite Passport payments are built but blocked by Kite's catalog allowlist. Mainnet has not been run. The SDK packages are consumed from the repo, not published to npm.
