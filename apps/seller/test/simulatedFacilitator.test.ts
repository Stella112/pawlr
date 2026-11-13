import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { KITE_TESTNET } from "@pawlr/protocol";
import { ConfigError, loadConfig, SimulatedFacilitator } from "../src/index.js";

/**
 * The simulated facilitator must accept exactly what a real one would verify:
 * payloads are signed here by the OFFICIAL x402 client (@x402/evm exact,
 * EIP-3009) with throwaway keys. Nothing touches a chain.
 */

const PAY_TO = "0x803376Fb273cBC5B5dceb74741f47EF595699d8E";
const req: PaymentRequirements = {
  scheme: "exact",
  network: KITE_TESTNET.network,
  asset: KITE_TESTNET.assetAddress,
  amount: "1000000000000000",
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: { name: KITE_TESTNET.eip712Name, version: KITE_TESTNET.eip712Version },
};

async function signed(r: PaymentRequirements = req, key = generatePrivateKey()): Promise<PaymentPayload> {
  const out = await new ExactEvmScheme(privateKeyToAccount(key)).createPaymentPayload(2, r);
  return { x402Version: 2, accepted: r, payload: out.payload as Record<string, unknown> };
}

describe("SimulatedFacilitator (SIMULATED settlement, real signature checks)", () => {
  it("verifies a genuine EIP-3009 authorization and settles with a SIMULATED- id, never a chain hash", async () => {
    const f = new SimulatedFacilitator(KITE_TESTNET);
    const p = await signed();
    expect((await f.verify(p, req)).isValid).toBe(true);
    const s = await f.settle(p, req);
    expect(s.success).toBe(true);
    expect(s.transaction).toMatch(/^SIMULATED-[0-9a-f]{32}$/);
    expect(s.transaction).not.toMatch(/^0x/);
  });

  it("rejects a reused nonce (replay), as the token contract would", async () => {
    const f = new SimulatedFacilitator(KITE_TESTNET);
    const p = await signed();
    expect((await f.settle(p, req)).success).toBe(true);
    expect((await f.verify(p, req)).isValid).toBe(false);
    expect((await f.settle(p, req)).success).toBe(false);
  });

  it("rejects a different amount, payee, asset or network than the requirements", async () => {
    const f = new SimulatedFacilitator(KITE_TESTNET);
    const p = await signed();
    expect((await f.verify(p, { ...req, amount: "2000000000000000" })).isValid).toBe(false);
    expect((await f.verify(p, { ...req, payTo: "0x" + "11".repeat(20) })).isValid).toBe(false);
    expect((await f.verify(p, { ...req, asset: "0x" + "22".repeat(20) })).isValid).toBe(false);
    expect((await f.verify(p, { ...req, network: "eip155:2366" })).isValid).toBe(false);
  });

  it("rejects a tampered authorization (signature no longer recovers to the payer)", async () => {
    const f = new SimulatedFacilitator(KITE_TESTNET);
    const p = await signed();
    const auth = (p.payload as any).authorization;
    const forged = { ...p, payload: { ...p.payload, authorization: { ...auth, from: privateKeyToAccount(generatePrivateKey()).address } } };
    expect((await f.verify(forged, req)).isValid).toBe(false);
  });

  it("rejects an expired authorization", async () => {
    const p = await signed();
    const later = new SimulatedFacilitator(KITE_TESTNET, () => Date.now() + 120_000);
    expect((await later.verify(p, req)).isValid).toBe(false);
  });

  it("is refused on mainnet", () => {
    const base = { SELLER_PAY_TO: PAY_TO, PRICE_PER_TICK: "0.001", ADMIN_PASSWORD: "a-long-enough-password!" };
    expect(loadConfig({ ...base, KITE_NETWORK: "testnet", SETTLEMENT_MODE: "simulated" }).settlementMode).toBe("simulated");
    expect(() => loadConfig({ ...base, KITE_NETWORK: "mainnet", SETTLEMENT_MODE: "simulated" })).toThrow(ConfigError);
  });
});
