import { createHash } from "node:crypto";
import { getAddress, verifyTypedData } from "viem";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import type { KiteChain } from "@pawlr/protocol";

/**
 * SIMULATED SETTLEMENT. Used only when SETTLEMENT_MODE=simulated.
 *
 * Why: real x402 settlement on Kite needs pieUSD (testnet) or USDC.e
 * (mainnet). pieUSD has no public source (fixed supply, no mint), Kite's
 * faucets do not dispense it, Permit2 is not deployed on Kite testnet, and
 * Kite Passport refuses hosts outside its catalog. See docs/integration-notes.md.
 *
 * What is REAL here: the buyer signs a genuine EIP-3009
 * TransferWithAuthorization, and this class verifies it exactly as a
 * facilitator would: the EIP-712 signature recovers to `from`, the payee,
 * amount, network, asset and time window match, and each nonce is used once.
 *
 * What is SIMULATED: no transaction is broadcast and no tokens move.
 * settle() returns a transaction id starting with "SIMULATED-", never a
 * chain hash, so nothing can mistake it for an on-chain payment.
 *
 * Typed-data shape copied from @x402/evm 2.30.0 (exact/client/eip3009 and
 * authorizationTypes), so it checks exactly what the official client signs.
 */
const authorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

interface Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export const SIMULATED_TX_PREFIX = "SIMULATED-";

export class SimulatedFacilitator implements FacilitatorClient {
  private usedNonces = new Set<string>();
  private settled = new Set<string>();

  constructor(private chain: KiteChain, private now: () => number = Date.now) {}

  async getSupported(): Promise<SupportedResponse> {
    return { kinds: [{ x402Version: 2, scheme: "exact", network: this.chain.network }], extensions: [], signers: {} };
  }

  private async check(payload: PaymentPayload, req: PaymentRequirements): Promise<{ ok: true; auth: Authorization } | { ok: false; reason: string }> {
    const p = payload.payload as { authorization?: Authorization; signature?: `0x${string}` };
    const a = p.authorization;
    if (!a || typeof p.signature !== "string") return { ok: false, reason: "missing authorization or signature" };
    if (req.scheme !== "exact" || req.network !== this.chain.network) return { ok: false, reason: "wrong scheme or network" };
    if (req.asset.toLowerCase() !== this.chain.assetAddress.toLowerCase()) return { ok: false, reason: "wrong asset" };
    let to: string;
    try {
      to = getAddress(a.to);
      getAddress(a.from);
    } catch {
      return { ok: false, reason: "bad address" };
    }
    if (to !== getAddress(req.payTo)) return { ok: false, reason: "payee does not match" };
    if (a.value !== req.amount) return { ok: false, reason: "amount does not match" };
    const nowS = Math.floor(this.now() / 1000);
    if (BigInt(a.validAfter) > BigInt(nowS) || BigInt(a.validBefore) <= BigInt(nowS)) return { ok: false, reason: "authorization outside its time window" };
    const name = req.extra?.name as string | undefined;
    const version = req.extra?.version as string | undefined;
    if (!name || !version) return { ok: false, reason: "missing EIP-712 domain" };
    const valid = await verifyTypedData({
      address: getAddress(a.from),
      domain: { name, version, chainId: Number(this.chain.network.split(":")[1]), verifyingContract: getAddress(req.asset) },
      types: authorizationTypes,
      primaryType: "TransferWithAuthorization",
      message: {
        from: getAddress(a.from),
        to,
        value: BigInt(a.value),
        validAfter: BigInt(a.validAfter),
        validBefore: BigInt(a.validBefore),
        nonce: a.nonce as `0x${string}`,
      },
      signature: p.signature,
    }).catch(() => false);
    if (!valid) return { ok: false, reason: "signature does not recover to the payer" };
    return { ok: true, auth: a };
  }

  async verify(payload: PaymentPayload, req: PaymentRequirements): Promise<VerifyResponse> {
    const r = await this.check(payload, req);
    if (!r.ok) return { isValid: false, invalidReason: "invalid_payload", invalidMessage: `SIMULATED facilitator: ${r.reason}` };
    const key = `${r.auth.from.toLowerCase()}:${r.auth.nonce}`;
    if (this.usedNonces.has(key)) return { isValid: false, invalidReason: "invalid_payload", invalidMessage: "SIMULATED facilitator: nonce already used" };
    return { isValid: true, payer: getAddress(r.auth.from) };
  }

  async settle(payload: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    const r = await this.check(payload, req);
    if (!r.ok) return { success: false, errorReason: "invalid_payload", errorMessage: r.reason, transaction: "", network: req.network };
    const key = `${r.auth.from.toLowerCase()}:${r.auth.nonce}`;
    if (this.usedNonces.has(key)) return { success: false, errorReason: "invalid_payload", errorMessage: "nonce already used", transaction: "", network: req.network };
    this.usedNonces.add(key);
    const id = SIMULATED_TX_PREFIX + createHash("sha256").update(String((payload.payload as any).signature)).digest("hex").slice(0, 32);
    this.settled.add(id);
    return { success: true, transaction: id, network: req.network, payer: getAddress(r.auth.from), amount: req.amount };
  }
}
