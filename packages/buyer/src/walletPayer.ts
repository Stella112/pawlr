import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { requireAsset, toBaseUnits, type DeliveryConditions } from "@pawlr/protocol";
import type { Payer, PayRequest, PayResult } from "./payer.js";

/**
 * Backup payer: pays the seller directly over x402 from a plain wallet
 * (no Kite Passport). Uses the official x402 client (@x402/fetch,
 * @x402/evm exact scheme, EIP-3009 signatures: no on-chain approval, the
 * facilitator pays gas). APIs read from node_modules, v2.30.0.
 *
 * Safety: a payment policy pins what the wallet will sign to the agreed
 * payee, network, asset and maximum amount, so even a 402 that changes
 * between Pawlr's own check and the payment cannot be signed. Pawlr's
 * MAX_SPEND / MAX_PER_TICK caps and the ledger still apply in the run loop.
 * Kite Passport spending limits do NOT apply on this route.
 */
export class WalletPayer implements Payer {
  readonly address: string;
  private fetchWithPay: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

  constructor(opts: { privateKey: string; conditions: DeliveryConditions; fetchImpl?: typeof fetch }) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(opts.privateKey)) throw new Error("BUYER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key");
    const account = privateKeyToAccount(opts.privateKey as `0x${string}`);
    this.address = account.address;
    const c = opts.conditions;
    const maxUnits = toBaseUnits(c.pricePerTick, requireAsset(c.network, c.asset).decimals);

    const client = new x402Client()
      .register(c.network, new ExactEvmScheme(account))
      // The client's built-in spend controls refuse unknown tokens by default (Kite's pieUSD / USDC.e
      // are not on its default list). Allow only the agreed asset, capped per payment at pricePerTick.
      .setSpendControls({ allowedAssets: [{ network: c.network, asset: c.asset, maxAmountPerPayment: maxUnits.toString() }] })
      .registerPolicy((_v, reqs) =>
        reqs.filter(
          (r) =>
            r.network === c.network &&
            r.payTo.toLowerCase() === c.seller.payTo.toLowerCase() &&
            r.asset.toLowerCase() === c.asset.toLowerCase() &&
            BigInt(r.amount) <= maxUnits,
        ),
      );
    this.fetchWithPay = wrapFetchWithPayment(opts.fetchImpl ?? fetch, client);
  }

  async pay(req: PayRequest): Promise<PayResult> {
    let res: Response;
    try {
      res = await this.fetchWithPay(req.url, { headers: req.headers });
    } catch (err) {
      // Thrown before or while creating the payment (e.g. policy refused every option): nothing was sent.
      return { kind: "not-charged", errorCode: "client_refused", message: String((err as Error)?.message ?? err), raw: null };
    }
    const header = res.headers.get("payment-response");
    let txHash: string | null = null;
    if (header) {
      try {
        txHash = (decodePaymentResponseHeader(header) as { transaction?: string }).transaction ?? null;
      } catch {
        /* keep null */
      }
    }
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (res.ok) return { kind: "paid", status: res.status, body, raw: body, txHash };
    // The seller settles only when it answers < 400 (Kite template rule), so an error status means not charged.
    return { kind: "not-charged", errorCode: `http_${res.status}`, message: typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300), raw: body };
  }
}
