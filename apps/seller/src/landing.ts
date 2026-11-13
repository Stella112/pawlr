import { readFileSync } from "node:fs";

/**
 * Landing page at "/": a plain-language explainer of Pawlr. Live facts
 * (price, network, settlement) are read client-side from /health, so the page
 * never states anything the running service does not report.
 */
const PAGE = readFileSync(new URL("../public/landing.html", import.meta.url), "utf8");

export function landingPage(): string {
  return PAGE;
}
