// Captures the dashboard's Kite Passport card (the live, owner-approved session).
import puppeteer from "puppeteer-core";
const b = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--no-sandbox"] });
const p = await b.newPage();
await p.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
await p.goto("https://pawlr.vercel.app/dashboard", { waitUntil: "networkidle2", timeout: 120000 });
await new Promise((r) => setTimeout(r, 1500));
await p.click("#draftBtn");
await new Promise((r) => setTimeout(r, 4000));
const el = await p.$("#ppBox");
await el.scrollIntoView();
await new Promise((r) => setTimeout(r, 800));
await el.screenshot({ path: "public/shots/passport-card.png" });
console.log("ok");
await b.close();
