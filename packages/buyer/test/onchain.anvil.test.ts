import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { registerAsset } from "@pawlr/protocol";
import type { ChatTransport, RawResponse } from "@pawlr/verifier";
import { CachedSummarizer, Store, createPublicApp, createSelfFacilitator, createTickService, loadConfig } from "../../../apps/seller/src/index.js";
import { admin, fakeSummarizer } from "../../../apps/seller/test/helpers.js";
import { WalletPayer, agreeSession, buildConditions, fetchSellerInfo, loadSpendLimits, parseDocument, runTicks } from "../src/index.js";

/**
 * REAL on-chain settlement on a local chain (anvil, chain id 2368 like Kite
 * testnet): the compiled Pawlr Test USD contract is deployed, the seller
 * settles through the OFFICIAL x402 facilitator code with a gas wallet, the
 * buyer pays with the official x402 client, and balances are read back from
 * the chain. Only the SERV judge is a test double here.
 * Skipped when Foundry's anvil is not installed.
 */
const hasAnvil = spawnSync("anvil", ["--version"], { shell: true }).status === 0;
const PORT = 8547;
const RPC = `http://127.0.0.1:${PORT}`;
// Anvil's well-known public development keys (never used outside a local chain).
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const GAS_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const artifact = JSON.parse(readFileSync(new URL("../../../contracts/out/PawlrTestUSD.sol/PawlrTestUSD.json", import.meta.url), "utf8"));
const chain = defineChain({ id: 2368, name: "anvil-kite", nativeCurrency: { name: "KITE", symbol: "KITE", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });

const BASE = "http://seller.test";
const DOC = `# Refunds
Customers may request a refund within 30 days of purchase. Refunds are paid to the original payment method within 14 days of approval.

# Shipping
Shipping is free on orders over 50 dollars. Standard delivery takes 3 to 5 business days, and express delivery takes 1 to 2 business days.
`;
const honest = JSON.parse(readFileSync(new URL("../../verifier/test/fixtures/captured/honest.json", import.meta.url), "utf8"));
const judge: ChatTransport = async (body: any): Promise<RawResponse> => {
  const out = /<seller_output>([\s\S]*)<\/seller_output>/.exec(body.messages[1].content)![1]!;
  const inj = /ignore previous instructions/i.exec(out);
  const ruling = inj ? { verdict: "fail", quote: out.slice(inj.index, inj.index + 28), reason: "Instruction aimed at the judge." } : { verdict: "pass", quote: out.slice(0, 30), reason: "Summarises the section." };
  const b = structuredClone(honest.recorded[0].response.body);
  b.choices[0].message.content = JSON.stringify(ruling);
  return { status: 200, body: b, latencyMs: 1 };
};

let anvil: ChildProcess | undefined;
let token: `0x${string}`;
const balanceOf = (a: string) => pub.readContract({ address: token, abi: artifact.abi, functionName: "balanceOf", args: [a] }) as Promise<bigint>;

describe.skipIf(!hasAnvil)("on-chain settlement (anvil)", () => {
  beforeAll(async () => {
    anvil = spawn("anvil", ["--chain-id", "2368", "--port", String(PORT), "--silent"], { shell: true });
    for (let i = 0; i < 60; i++) {
      try {
        await pub.getBlockNumber();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    const deployer = createWalletClient({ account: privateKeyToAccount(DEPLOYER_KEY), chain, transport: http(RPC) });
    const hash = await deployer.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object });
    token = (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
    registerAsset({ network: "eip155:2368", address: token, symbol: "pUSD", decimals: 6, eip712Name: "Pawlr Test USD", eip712Version: "1" });
  }, 60_000);
  afterAll(() => {
    anvil?.kill();
  });

  async function world(buyerKey: `0x${string}`, payTo: string) {
    const dataDir = mkdtempSync(join(tmpdir(), "pawlr-anvil-"));
    const config = loadConfig({
      KITE_NETWORK: "testnet",
      SELLER_PAY_TO: payTo,
      PRICE_PER_TICK: "0.001",
      ADMIN_PASSWORD: "test-admin-password-0123",
      DATA_DIR: dataDir,
      SETTLEMENT_ASSET: token,
      SETTLEMENT_MODE: "self",
      FACILITATOR_PRIVATE_KEY: GAS_KEY,
      KITE_RPC_URL: RPC,
    });
    const store = new Store(dataDir);
    const tickApp = createTickService({ store, summarizer: new CachedSummarizer(fakeSummarizer().summarizer, store, "test-double") });
    const app = createPublicApp({
      config,
      store,
      facilitator: createSelfFacilitator({ chain: config.chain, privateKey: GAS_KEY, rpcUrl: RPC }).client,
      forwardTick: async (b) => tickApp.request("/internal/tick", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }),
    });
    const f = ((input: any, init?: any) => app.request(input instanceof Request ? input : String(input).replace(BASE, ""), init)) as typeof fetch;
    const seller = { ...(await fetchSellerInfo(BASE, f)), baseUrl: BASE };
    const sections = parseDocument(DOC);
    const limits = loadSpendLimits({ MAX_SPEND: "0.01", MAX_PER_TICK: "0.001" }, "testnet");
    const conditions = buildConditions(seller, sections, { maxTicks: 4, maxSpend: limits.maxSpend });
    const conditionsHash = await agreeSession(seller, conditions, sections, f);
    const payer = new WalletPayer({ privateKey: buyerKey, conditions, fetchImpl: f });
    const go = () => runTicks({ seller, conditions, conditionsHash, sections, limits }, { payer, verifier: { serv: judge, sleep: async () => {} }, fetch: f, dataDir });
    return { app, conditions, go, seller };
  }

  it("settles every paid tick on-chain: real tx hashes, real balance changes", async () => {
    const buyerKey = generatePrivateKey();
    const buyer = privateKeyToAccount(buyerKey).address;
    const payTo = privateKeyToAccount(generatePrivateKey()).address;
    const deployer = createWalletClient({ account: privateKeyToAccount(DEPLOYER_KEY), chain, transport: http(RPC) });
    await pub.waitForTransactionReceipt({ hash: await deployer.writeContract({ address: token, abi: artifact.abi, functionName: "mint", args: [buyer, 1_000_000n] }) });

    const w = await world(buyerKey, payTo);
    expect(w.seller.assetAddress.toLowerCase()).toBe(token.toLowerCase());
    const r = await w.go();
    expect(r.receipt.ticks.map((t) => t.verdict)).toEqual(["pass", "pass", "pass", "pass"]);
    for (const t of r.receipt.ticks) {
      expect(t.payment.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      const rc = await pub.getTransactionReceipt({ hash: t.payment.txHash as `0x${string}` });
      expect(rc.status).toBe("success");
    }
    expect(await balanceOf(buyer)).toBe(1_000_000n - 4n * 1000n);
    expect(await balanceOf(payTo)).toBe(4n * 1000n);
  }, 60_000);

  it("staged injection from tick 2: exactly one bad tick settles on-chain, then nothing more", async () => {
    const buyerKey = generatePrivateKey();
    const buyer = privateKeyToAccount(buyerKey).address;
    const payTo = privateKeyToAccount(generatePrivateKey()).address;
    const deployer = createWalletClient({ account: privateKeyToAccount(DEPLOYER_KEY), chain, transport: http(RPC) });
    await pub.waitForTransactionReceipt({ hash: await deployer.writeContract({ address: token, abi: artifact.abi, functionName: "mint", args: [buyer, 1_000_000n] }) });

    const w = await world(buyerKey, payTo);
    await w.app.request("/admin/failure", admin({ sessionId: w.conditions.sessionId, mode: "injection", fromTick: 2 }));
    const r = await w.go();
    expect(r.receipt.ticks.map((t) => t.verdict)).toEqual(["pass", "fail"]);
    expect(await balanceOf(payTo)).toBe(2n * 1000n);
    expect(await balanceOf(buyer)).toBe(1_000_000n - 2n * 1000n);
  }, 60_000);

  it("a buyer with no funds is not charged and nothing settles", async () => {
    const payTo = privateKeyToAccount(generatePrivateKey()).address;
    const w = await world(generatePrivateKey(), payTo);
    const r = await w.go();
    expect(r.receipt.ticksPaid).toBe(0);
    expect(r.stoppedBecause).toMatch(/not-charged/);
    expect(await balanceOf(payTo)).toBe(0n);
  }, 60_000);
});
