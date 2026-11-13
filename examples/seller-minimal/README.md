# seller-minimal: add Pawlr to an x402 service

`src/index.ts` (18 lines of code) turns any "produce one tick's deliverable" function into a Pawlr seller: agreed conditions, an x402 paywall on Kite, evidence on every tick, invalid ticks refused before payment, and a refund inbox.

## Run it

From the repository root:

```bash
pnpm install && pnpm build
```

```bash
cd examples/seller-minimal
```

```bash
KITE_NETWORK=testnet SELLER_PAY_TO=0xYourWalletAddress PRICE_PER_TICK=0.001 ADMIN_PASSWORD=choose-a-password PORT=8090 INTERNAL_TICK_PORT=8091 node dist/index.js
```

It prints `Pawlr seller on http://localhost:8090`. By default it uses the hosted Pieverse facilitator and pieUSD on Kite testnet. For on-chain settlement with your own EIP-3009 token, add `SETTLEMENT_MODE=self SETTLEMENT_ASSET=<registered token> FACILITATOR_PRIVATE_KEY=<gas wallet key>`.

## Try it with the buyer example

In a second terminal, from `examples/buyer-minimal`:

```bash
SELLER_URL=http://localhost:8090 node dist/index.js ../../docs/demo-document.md
```

You should see `Agreed pawlr-…`, the seller's 402 terms and `match the agreement: true`. Nothing is paid.

## What to change

Replace `myService.summarize` with your own service. Everything else (hashing, evidence, the paywall, the routes) comes from `@pawlr/seller`.
