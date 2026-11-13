# buyer-minimal: pay a Pawlr seller tick by tick

`src/index.ts` (18 lines of code) agrees Delivery Conditions with a Pawlr seller, checks the seller's x402 payment terms against them, and with `--pay` pays and judges two ticks, stopping at the first bad one.

## Run it (free: agreement and terms only)

From the repository root:

```bash
pnpm install && pnpm build
```

```bash
cd examples/buyer-minimal && node dist/index.js ../../docs/demo-document.md
```

Against the live seller (`https://pawlr.vercel.app`) this prints the agreed session, its conditions hash, the 402 terms (0.001 Pawlr Test USD per tick on Kite testnet) and `match the agreement: true`. Set `SELLER_URL` to use another seller, for example `examples/seller-minimal`.

## Pay and judge (`--pay`)

```bash
BUYER_PRIVATE_KEY=0x... SERV_API_KEY=... node dist/index.js ../../docs/demo-document.md --pay
```

Needs a wallet holding the seller's token on Kite testnet (for the live seller: Pawlr Test USD, minted by its owner) and a SERV Reasoning API key. Each tick prints its verdict, reason and transaction hash. Never commit or paste keys; put them in `.env` and run with `node --env-file=.env`.
