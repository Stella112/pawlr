import { createWalletClient, defineChain, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { x402Facilitator } from "@x402/core/facilitator";
import type { FacilitatorClient } from "@x402/core/server";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import type { KiteChain } from "@pawlr/protocol";

/**
 * Pawlr's own facilitator: the OFFICIAL x402 facilitator code (@x402/core
 * x402Facilitator + @x402/evm exact facilitator scheme, v2.30.0) running
 * in-process, with a gas wallet that submits each EIP-3009
 * transferWithAuthorization on Kite testnet. Every settlement is a real
 * on-chain transaction with a real hash on testnet.kitescan.ai.
 *
 * Used because the hosted Pieverse facilitator settles only its listed
 * tokens, and the testnet one (pieUSD) has no public source.
 */
export function createSelfFacilitator(opts: { chain: KiteChain; privateKey: string; rpcUrl?: string }): { client: FacilitatorClient; address: string } {
  if (!/^0x[0-9a-fA-F]{64}$/.test(opts.privateKey)) throw new Error("FACILITATOR_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key");
  const rpcUrl = opts.rpcUrl ?? opts.chain.rpcUrl;
  const chainId = Number(opts.chain.network.split(":")[1]);
  const viemChain = defineChain({
    id: chainId,
    name: `Kite ${opts.chain.name}`,
    nativeCurrency: { name: "KITE", symbol: "KITE", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const account = privateKeyToAccount(opts.privateKey as `0x${string}`);
  const wallet = createWalletClient({ account, chain: viemChain, transport: http(rpcUrl) }).extend(publicActions);
  const signer = toFacilitatorEvmSigner({
    address: account.address,
    readContract: (a: any) => wallet.readContract(a),
    verifyTypedData: (a: any) => wallet.verifyTypedData(a),
    writeContract: (a: any) => wallet.writeContract(a),
    sendTransaction: (a: any) => wallet.sendTransaction(a),
    waitForTransactionReceipt: (a: any) => wallet.waitForTransactionReceipt(a),
    getCode: (a: any) => wallet.getCode(a),
  } as any);
  const fac = new x402Facilitator().register(opts.chain.network, new ExactEvmScheme(signer));
  return {
    address: account.address,
    client: {
      getSupported: async () => fac.getSupported() as any,
      verify: (p, r) => fac.verify(p, r),
      settle: (p, r) => fac.settle(p, r),
    },
  };
}
