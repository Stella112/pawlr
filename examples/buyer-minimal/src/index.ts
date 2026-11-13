// A Pawlr buyer: agree conditions, check the seller's x402 terms, then (with --pay) pay and judge tick by tick.
import { readFileSync } from "node:fs";
import { servTransport } from "@pawlr/verifier";
import { WalletPayer, agreeSession, buildConditions, checkChallenge, fetchSellerInfo, loadSpendLimits, parseDocument, readChallenge, runTicks } from "@pawlr/buyer";

const seller = await fetchSellerInfo(process.env.SELLER_URL ?? "https://pawlr.vercel.app");
const sections = parseDocument(readFileSync(process.argv[2] ?? "../../docs/demo-document.md", "utf8"));
const limits = loadSpendLimits({ MAX_SPEND: "0.002", MAX_PER_TICK: seller.pricePerTick }, "testnet");
const conditions = buildConditions(seller, sections, { maxTicks: 2, maxSpend: limits.maxSpend });

const conditionsHash = await agreeSession(seller, conditions, sections); // aborts if the seller's hash differs
console.log(`Agreed ${conditions.sessionId}, conditions hash ${conditionsHash}`);

const offers = await readChallenge(`${seller.baseUrl}/tick/${conditions.sessionId}/1`, conditionsHash); // free
console.log("402 terms:", offers[0], "→ match the agreement:", checkChallenge(offers, conditions).ok);

if (process.argv.includes("--pay")) {
  const payer = new WalletPayer({ privateKey: process.env.BUYER_PRIVATE_KEY!, conditions });
  const verifier = { serv: servTransport(process.env.SERV_API_KEY!) };
  const { receipt, stoppedBecause } = await runTicks({ seller, conditions, conditionsHash, sections, limits }, { payer, verifier, dataDir: "data" });
  for (const t of receipt.ticks) console.log(`tick ${t.tick}: ${t.verdict} (${t.reason}) tx ${t.payment.txHash}`);
  console.log(`${stoppedBecause}. Paid ${receipt.totalPaid}; most you could lose: 1 tick (${receipt.maxLossBound}).`);
}
