// Deploys Pawlr Test USD (testnet-only EIP-3009 token) to Kite testnet and mints test funds.
// Run: node --env-file=.env scripts/deploy-token.mjs [--token 0x...] <recipient>:<amount pUSD> ...
// The gas wallet (FACILITATOR_PRIVATE_KEY) deploys and becomes the token owner. Keys are never printed.
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, http } from "../packages/buyer/node_modules/viem/_esm/index.js";
import { privateKeyToAccount } from "../packages/buyer/node_modules/viem/_esm/accounts/index.js";

const RPC = "https://rpc-testnet.gokite.ai"; // Kite docs, network-information
const chain = defineChain({ id: 2368, name: "KiteAI Testnet", nativeCurrency: { name: "KITE", symbol: "KITE", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const artifact = JSON.parse(readFileSync(new URL("../contracts/out/PawlrTestUSD.sol/PawlrTestUSD.json", import.meta.url), "utf8"));
const key = process.env.FACILITATOR_PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? "")) throw new Error("FACILITATOR_PRIVATE_KEY missing");
const account = privateKeyToAccount(key);
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account, chain, transport: http(RPC) });

const args = process.argv.slice(2);
let token = null;
if (args[0] === "--token") {
  token = args[1];
  args.splice(0, 2);
}
if (!token) {
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object });
  const rc = await pub.waitForTransactionReceipt({ hash });
  token = rc.contractAddress;
  console.log(`deployed Pawlr Test USD at ${token}\n  tx ${hash} (status ${rc.status}, gas ${rc.gasUsed})`);
}
const [name, version, decimals, owner] = await Promise.all(
  ["name", "version", "decimals", "owner"].map((fn) => pub.readContract({ address: token, abi: artifact.abi, functionName: fn })),
);
console.log(`on-chain: name="${name}" version="${version}" decimals=${decimals} owner=${owner}`);

for (const a of args) {
  const [to, amt] = a.split(":");
  const units = BigInt(Math.round(Number(amt) * 1e6));
  const hash = await wallet.writeContract({ address: token, abi: artifact.abi, functionName: "mint", args: [to, units] });
  const rc = await pub.waitForTransactionReceipt({ hash });
  const bal = await pub.readContract({ address: token, abi: artifact.abi, functionName: "balanceOf", args: [to] });
  console.log(`minted ${amt} pUSD to ${to}: tx ${hash} (${rc.status}); balance ${Number(bal) / 1e6} pUSD`);
}
console.log(`gas wallet KITE left: ${Number(await pub.getBalance({ address: account.address })) / 1e18}`);
