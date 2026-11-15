// Re-capture the explorer pages for this session's transactions once the indexer has decoded them.
import puppeteer from "puppeteer-core";
import fs from "node:fs";
const s = JSON.parse(fs.readFileSync(new URL("../session.json", import.meta.url)));
const b = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--no-sandbox"] });
for (const t of s.txs) {
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await p.goto(`https://testnet.kitescan.ai/tx/${t.tx}`, { waitUntil: "networkidle2", timeout: 120000 });
  await new Promise((r) => setTimeout(r, 5000));
  const txt = await p.evaluate(() => document.body.innerText);
  console.log(t.tick, /Tokens transferred/.test(txt) ? "decoded" : "NOT decoded");
  await p.screenshot({ path: new URL(`../public/shots/explorer-${t.tick}.png`, import.meta.url).pathname.slice(1) });
  await p.close();
}
await b.close();
