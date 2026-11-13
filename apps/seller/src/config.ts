import { FACILITATOR_URL, type KiteChain, chainWithAsset, kiteChainByName, requireAsset, toBaseUnits } from "@pawlr/protocol";

export interface SellerConfig {
  chain: KiteChain;
  payTo: string;
  /** Decimal price per tick in token units, e.g. "0.001". */
  pricePerTick: string;
  adminPassword: string;
  /** Public port: free session routes and the paid x402 paywall. */
  port: number;
  /** Bind address for the public port. 127.0.0.1 when a reverse proxy (Caddy) fronts it. */
  host: string;
  /** Internal tick service port, bound to 127.0.0.1 only. */
  internalPort: number;
  facilitatorUrl: string;
  /** "facilitator": on-chain via the hosted Pieverse facilitator. "self": on-chain via Pawlr's own facilitator (official x402 code + gas wallet), testnet only. */
  settlementMode: "facilitator" | "self";
  /** Gas wallet key for settlementMode "self". */
  facilitatorPrivateKey: string;
  /** RPC for settlementMode "self" (defaults to the chain's RPC). */
  rpcUrl: string;
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
 * Reads seller config from env. Mainnet guards (agent.md §2.3, §4): refuse a
 * placeholder receiving address, a price above $0.05 per tick, or an admin
 * password shorter than 16 characters.
 */
export function loadConfig(env: Record<string, string | undefined>): SellerConfig {
  const get = (k: string, fallback = "") => (env[k] ?? "").trim() || fallback;
  let chain = kiteChainByName(get("KITE_NETWORK", "testnet"));
  // Optional: price ticks in another registered token on the same network (e.g. Pawlr Test USD on testnet).
  const assetOverride = get("SETTLEMENT_ASSET");
  if (assetOverride) {
    try {
      chain = chainWithAsset(chain, requireAsset(chain.network, assetOverride));
    } catch (err) {
      throw new ConfigError(`SETTLEMENT_ASSET: ${(err as Error).message}`);
    }
  }
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

  const settlementMode = get("SETTLEMENT_MODE", "facilitator");
  if (settlementMode !== "facilitator" && settlementMode !== "self") throw new ConfigError("SETTLEMENT_MODE must be facilitator or self");
  if (chain.name === "mainnet" && settlementMode === "self") throw new ConfigError("mainnet refused: SETTLEMENT_MODE=self is testnet only");
  const facilitatorPrivateKey = get("FACILITATOR_PRIVATE_KEY");
  if (settlementMode === "self" && !/^0x[0-9a-fA-F]{64}$/.test(facilitatorPrivateKey)) throw new ConfigError("SETTLEMENT_MODE=self needs FACILITATOR_PRIVATE_KEY (gas wallet)");

  const port = Number(get("PORT", "8080"));
  const internalPort = Number(get("INTERNAL_TICK_PORT", "8081"));
  if (port === internalPort) throw new ConfigError("PORT and INTERNAL_TICK_PORT must differ");

  return {
    chain,
    payTo,
    pricePerTick,
    adminPassword,
    port,
    host: get("HOST", "0.0.0.0"),
    internalPort,
    facilitatorUrl: get("FACILITATOR_URL", FACILITATOR_URL),
    settlementMode,
    facilitatorPrivateKey,
    rpcUrl: get("KITE_RPC_URL", chain.rpcUrl),
    dataDir: get("DATA_DIR", "data"),
    publicBaseUrl: get("PUBLIC_BASE_URL"),
    servApiKey: get("SERV_API_KEY"),
    servModel: get("SERV_MODEL", "gpt-5.4-mini"),
  };
}
