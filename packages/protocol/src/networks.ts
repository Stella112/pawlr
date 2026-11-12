/**
 * Kite networks Pawlr can charge on.
 *
 * Values copied from Kite's official template, gokite-ai/kite-x402-services
 * (templates/typescript-express/src/kite.ts, commit 893a275, Apache-2.0).
 * The live facilitator (https://facilitator.pieverse.io/v2/supported, checked
 * 2026-11-12) lists x402Version 2, scheme "exact" for both networks.
 */
export interface KiteChain {
  name: "mainnet" | "testnet";
  network: "eip155:2366" | "eip155:2368";
  rpcUrl: string;
  assetAddress: string;
  assetSymbol: string;
  assetDecimals: number;
  eip712Name: string;
  eip712Version: string;
  /** Block explorer base, from docs.gokite.ai/kite-chain/1-getting-started/tools. */
  explorerUrl: string;
}

export const KITE_MAINNET: KiteChain = {
  name: "mainnet",
  network: "eip155:2366",
  rpcUrl: "https://rpc.gokite.ai",
  assetAddress: "0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e",
  assetSymbol: "USDC.e",
  assetDecimals: 6,
  eip712Name: "Bridged USDC (Kite AI)",
  eip712Version: "2",
  explorerUrl: "https://kitescan.ai/",
};

export const KITE_TESTNET: KiteChain = {
  name: "testnet",
  network: "eip155:2368",
  rpcUrl: "https://rpc-testnet.gokite.ai",
  assetAddress: "0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A",
  assetSymbol: "pieUSD",
  assetDecimals: 18,
  eip712Name: "pieUSD",
  eip712Version: "1",
  explorerUrl: "https://testnet.kitescan.ai/",
};

export const FACILITATOR_URL = "https://facilitator.pieverse.io/v2";

export function kiteChainByName(name: string | undefined): KiteChain {
  switch ((name ?? "testnet").trim()) {
    case "mainnet":
      return KITE_MAINNET;
    case "":
    case "testnet":
      return KITE_TESTNET;
    default:
      throw new Error(`unknown KITE_NETWORK "${name}" (want testnet or mainnet)`);
  }
}

export function kiteChainByNetwork(network: string): KiteChain | undefined {
  return [KITE_MAINNET, KITE_TESTNET].find((c) => c.network === network);
}

/**
 * Decimal token amount ("0.001") to integer base units, using BigInt string
 * math (no floats). Same rule as the template's kiteMoneyParser.
 */
export function toBaseUnits(amount: string, decimals: number): bigint {
  const text = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`amount must be a non-negative decimal, got "${amount}"`);
  const [whole = "0", frac = ""] = text.split(".");
  if (frac.length > decimals) throw new Error(`amount ${text} has more than ${decimals} decimals`);
  return BigInt(whole + frac.padEnd(decimals, "0"));
}
