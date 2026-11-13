// The demo seller is built on the @pawlr/seller SDK; it adds the SERV summarizer and the landing page.
export * from "@pawlr/seller";
export { ServSummarizer, SUMMARY_SYSTEM_PROMPT } from "./summarizer.js";
export { landingPage } from "./landing.js";
