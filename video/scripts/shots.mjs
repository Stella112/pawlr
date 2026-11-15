// Captures real footage for the demo: the live landing page, a real dashboard session on Kite testnet
// (staged injection from tick 3), and that session's own transactions on the Kite testnet explorer.
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "public", "shots") + path.sep;
fs.mkdirSync(out, { recursive: true });
const SITE = "https://pawlr.vercel.app";
const API = SITE + "/console/api";
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--no-sandbox"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(url, w = 1440, h = 900, dpr = 2) {
  const p = await browser.newPage();
  await p.setViewport({ width: w, height: h, deviceScaleFactor: dpr });
  await p.goto(url, { waitUntil: "networkidle2", timeout: 120000 });
  await sleep(2000);
  return p;
}
const shot = (p, name) => p.screenshot({ path: out + name + ".png" });
const el = async (p, sel, name) => {
  const h = await p.$(sel);
  if (!h) return console.log("missing", sel);
  await h.scrollIntoView();
  await sleep(500);
  await h.screenshot({ path: out + name + ".png" });
  console.log("shot", name);
};

// Landing page
let p = await open(SITE);
await shot(p, "landing-hero");
await p.close();

// Dashboard: a real session with a staged injection from tick 3
p = await open(SITE + "/dashboard");
let sessionId = null;
p.on("response", async (r) => {
  if (r.request().method() === "POST" && /\/sessions$/.test(r.url())) {
    try { sessionId = (await r.json()).id; } catch {}
  }
});
await p.evaluate(() => {
  const t = document.getElementById("ticks");
  t.value = "5";
  t.dispatchEvent(new Event("input", { bubbles: true }));
  const f = document.getElementById("failOn");
  f.click();
});
await sleep(600);
await p.evaluate(() => {
  document.querySelector('.mode[data-m="injection"]')?.click();
  const s = document.getElementById("failFrom");
  s.value = "3";
  s.dispatchEvent(new Event("change", { bubbles: true }));
});
await sleep(500);
await el(p, "#s1", "dash-setup");
await p.click("#draftBtn");
await sleep(4000);
await el(p, "#s2", "dash-rules");
await p.click("#startBtn");
console.log("session", sessionId);
let n = 0;
let s;
for (let i = 0; i < 120; i++) {
  await sleep(2000);
  s = await (await fetch(`${API}/sessions/${sessionId}`)).json();
  if (s.ticks.length > n) {
    n = s.ticks.length;
    await sleep(800);
    await el(p, "#s3", `dash-live-${n}`);
  }
  if (!["running", "draft"].includes(s.status)) break;
}
await sleep(2500);
console.log("status", s.status);
await el(p, "#s3", "dash-live-final");
const cards = await p.$$("#tickList > *");
for (let i = 0; i < cards.length; i++) {
  await cards[i].scrollIntoView();
  await sleep(400);
  await cards[i].screenshot({ path: out + `tick-${i + 1}.png` });
}
await el(p, "#s4", "dash-summary");
// Recover: draft the claim and send it to the seller's refund inbox
await p.click("#claimBtn");
for (let i = 0; i < 30; i++) {
  await sleep(2000);
  if (await p.evaluate(() => !document.getElementById("sendRow")?.classList.contains("hidden") && document.getElementById("claimBox")?.textContent.trim().length > 0)) break;
}
await sleep(800);
await el(p, "#s4", "dash-claim");
await p.click("#sendBtn").catch(() => {});
await sleep(5000);
await el(p, "#s4", "dash-refund");
await p.close();

// Explorer: this session's own transactions
const txs = s.ticks.map((t) => ({ tick: t.tick, verdict: t.verdict.verdict, tx: t.verdict.payment.txHash, quote: t.verdict.quote, reason: t.verdict.reason, decidedBy: t.verdict.decidedBy }));
fs.writeFileSync(path.join(root, "session.json"), JSON.stringify({ sessionId, status: s.status, maxTicks: s.conditions.maxTicks, conditionsHash: s.conditionsHash, txs }, null, 1));
for (const t of txs) {
  if (!t.tx) continue;
  p = await open(`https://testnet.kitescan.ai/tx/${t.tx}`, 1440, 900, 2);
  await sleep(4000);
  await shot(p, `explorer-${t.tick}`);
  console.log("explorer", t.tick, t.tx);
  await p.close();
}
await browser.close();
console.log(JSON.stringify(txs, null, 1));
