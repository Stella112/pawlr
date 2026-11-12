import { FACILITATOR_URL, type KiteChain, kiteChainByName, toBaseUnits } from "@pawlr/protocol";

export interface SellerConfig {
  chain: KiteChain;
  payTo: string;
  /** Decimal price per tick in token units, e.g. "0.001". */
  pricePerTick: string;
  adminPassword: string;
  /** Public port: free session routes and the paid x402 paywall. */
  port: number;
  /** Internal tick service port, bound to 127.0.0.1 only. */
  internalPort: number;
  facilitatorUrl: string;
  dataDir: string;
  publicBaseUrl: string;
  servApiKey: string;
  servModel: string;
}

export const MAX_MAINNET_PRICE = "0.05";
export const MIN_MAINNET_PASSWORD = 16;

const PLACEHOLDER_ADDRESSES = new Set([
  "0x0000000000000000000000000000000000000000",
  "0xyourkitewallet",
  "0xyourservicewalletaddress",
]);

export class ConfigError extends Error {}

/**
 * Reads seller config from env. Mainnet guards (CLAUDE.md §2.3, §4): refuse a
 * placeholder receiving address, a price above $0.05 per tick, or an admin
 * password shorter than 16 characters.
 */
export function loadConfig(env: Record<string, string | undefined>): SellerConfig {
  const get = (k: string, fallback = "") => (env[k] ?? "").trim() || fallback;
  const chain = kiteChainByName(get("KITE_NETWORK", "testnet"));
  const payTo = get("SELLER_PAY_TO");
  const pricePerTick = get("PRICE_PER_TICK", "0.001");
  const adminPassword = get("ADMIN_PASSWORD");

  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) throw new ConfigError("SELLER_PAY_TO must be a 0x address (40 hex chars)");
  // Refused on every network: payments to a placeholder address would be lost, test money included.
  if (PLACEHOLDER_ADDRESSES.has(payTo.toLowerCase())) throw new ConfigError("SELLER_PAY_TO is a placeholder address; set your real Kite wallet");
  if (!/^\d+(\.\d+)?$/.test(pricePerTick)) throw new ConfigError("PRICE_PER_TICK must be a decimal string, e.g. 0.001");
  let priceUnits: bigint;
  try {
    priceUnits = toBaseUnits(pricePerTick, chain.assetDecimals);
  } catch (err) {
    throw new ConfigError(`PRICE_PER_TICK ${pricePerTick} is not valid for ${chain.assetSymbol}: ${(err as Error).message}`);
  }
  if (priceUnits <= 0n) throw new ConfigError("PRICE_PER_TICK must be above zero");
  if (!adminPassword) throw new ConfigError("ADMIN_PASSWORD is required");

  if (chain.name === "mainnet") {
    if (toBaseUnits(pricePerTick, 18) > toBaseUnits(MAX_MAINNET_PRICE, 18)) {
      throw new ConfigError(`mainnet refused: PRICE_PER_TICK ${pricePerTick} is above ${MAX_MAINNET_PRICE}`);
    }
    if (adminPassword.length < MIN_MAINNET_PASSWORD) {
      throw new ConfigError(`mainnet refused: ADMIN_PASSWORD must be at least ${MIN_MAINNET_PASSWORD} characters`);
    }
  }

  const port = Number(get("PORT", "8080"));
  const internalPort = Number(get("INTERNAL_TICK_PORT", "8081"));
  if (port === internalPort) throw new ConfigError("PORT and INTERNAL_TICK_PORT must differ");

  return {
    chain,
    payTo,
    pricePerTick,
    adminPassword,
    port,
    internalPort,
    facilitatorUrl: get("FACILITATOR_URL", FACILITATOR_URL),
    dataDir: get("DATA_DIR", "data"),
    publicBaseUrl: get("PUBLIC_BASE_URL"),
    servApiKey: get("SERV_API_KEY"),
    servModel: get("SERV_MODEL", "gpt-5.4-mini"),
  };
}
