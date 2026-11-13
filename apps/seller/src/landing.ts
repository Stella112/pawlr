import type { SellerConfig } from "./config.js";

/** Landing page at "/". States only what is true of this deployment. */
export function landingPage(config: SellerConfig, version: string): string {
  const net = config.chain.name === "mainnet" ? "Kite mainnet" : "Kite testnet";
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pawlr</title>
<meta name="description" content="Pawlr: the catch that stops paying the moment delivery fails.">
<style>
  :root { --bg:#f7f6f2; --fg:#16181d; --muted:#5b616e; --card:#ffffff; --line:#e3e1da; --accent:#1f6f5c; --chip:#e8f2ee; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111317; --fg:#eceae4; --muted:#9aa0ab; --card:#191c22; --line:#2a2e36; --accent:#5cc6a7; --chip:#1d2b27; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width:760px; margin:0 auto; padding:56px 20px 64px; }
  .chip { display:inline-block; font-size:13px; padding:3px 10px; border-radius:999px; background:var(--chip); color:var(--accent); font-weight:600; }
  h1 { font-size:44px; line-height:1.1; margin:18px 0 8px; letter-spacing:-0.02em; }
  .tag { font-size:20px; color:var(--muted); margin:0 0 28px; }
  p { margin:0 0 14px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:20px 22px; margin:22px 0; }
  h2 { font-size:15px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:0 0 12px; }
  ol { margin:0; padding-left:20px; } li { margin:6px 0; }
  dl { display:grid; grid-template-columns:max-content 1fr; gap:6px 16px; margin:0; font-size:14px; }
  dt { color:var(--muted); } dd { margin:0; font-family:ui-monospace,Consolas,monospace; overflow-wrap:anywhere; }
  a { color:var(--accent); }
  .foot { font-size:13px; color:var(--muted); margin-top:28px; }
</style>
</head>
<body>
<main>
  <span class="chip">Live on ${esc(net)}</span>${config.settlementMode === "simulated" ? ' <span class="chip" style="background:#fdecc8;color:#7a4b00">Settlement: SIMULATED</span>' : ""}
  <h1>Pawlr</h1>
  <p class="tag">The catch that stops paying the moment delivery fails.</p>
  <p>Pawlr pays a service one tick at a time, checks each delivery against conditions both sides agreed, and stops paying the moment delivery fails. The most a buyer can lose is one tick.</p>

  <div class="card">
    <h2>How a tick works</h2>
    <ol>
      <li>Buyer and seller agree written Delivery Conditions; both hold the same hash.</li>
      <li>The buyer pays one tick over x402 on Kite, then receives the delivery with evidence.</li>
      <li>Code checks run first; SERV Reasoning rules on relevance and must quote the exact words it relied on.</li>
      <li>Pass: the next tick may be paid. Fail: the meter pauses. Unclear: it goes to review.</li>
    </ol>
    <p style="margin-top:12px;color:var(--muted);font-size:14px">With standard x402 a tick is paid, then judged, so a bad tick is paid once and stops every later payment.</p>
  </div>

  <div class="card">
    <h2>This seller</h2>
    <dl>
      <dt>Service</dt><dd>Document digest, one section summary per tick</dd>
      <dt>Network</dt><dd>${esc(config.chain.network)} (${esc(config.chain.assetSymbol)})</dd>
      <dt>Price</dt><dd>${esc(config.pricePerTick)} ${esc(config.chain.assetSymbol)} per tick</dd>
      <dt>Pays to</dt><dd>${esc(config.payTo)}</dd>
      <dt>Settlement</dt><dd>${config.settlementMode === "simulated" ? "SIMULATED: each payment is a real signed EIP-3009 authorization, verified by the seller; no tokens move on-chain" : "On-chain via the Pieverse facilitator"}</dd>
      <dt>Status</dt><dd><a href="/health">/health</a></dd>
      <dt>Version</dt><dd>${esc(version)}</dd>
    </dl>
  </div>

  <p class="foot">Built for the OpenServ SERV Hackathon, Kite track. Payments: x402 on Kite${config.settlementMode === "simulated" ? " (settlement SIMULATED on this deployment)" : " via the Pieverse facilitator"}. Judging: SERV Reasoning.</p>
</main>
</body>
</html>`;
}
