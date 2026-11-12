import OpenAI from "openai";
import { sha256Hex } from "@pawlr/protocol";
import type { Store } from "./store.js";

/** Produces a 1 to 3 sentence summary of one document section. */
export interface Summarizer {
  summarize(sectionName: string, text: string): Promise<string>;
}

// SERV Reasoning, OpenAI-compatible (docs.openserv.ai/serv-reasoning/api/chat-completions.md).
const SERV_BASE_URL = "https://inference-api.openserv.ai/v1";
const PRICE_IN = 1.0 / 1e6; // gpt-5.4-mini, USD per input token (models.md)
const PRICE_OUT = 6.0 / 1e6; // USD per output token

export const SUMMARY_SYSTEM_PROMPT =
  "You summarise one section of a document. Write 1 to 3 plain sentences that state the section's main points " +
  "using its own key terms. Use only the section text. Output the summary only, with no heading or preamble.";

export class ServSummarizer implements Summarizer {
  private client: OpenAI;
  constructor(apiKey: string, private model: string, private store: Store) {
    if (!apiKey) throw new Error("SERV_API_KEY is required for summaries");
    this.client = new OpenAI({ apiKey, baseURL: SERV_BASE_URL });
  }

  async summarize(sectionName: string, text: string): Promise<string> {
    const started = Date.now();
    const res = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      messages: [
        { role: "system", content: SUMMARY_SYSTEM_PROMPT },
        { role: "user", content: `<section name=${JSON.stringify(sectionName)}>${text}</section>` },
      ],
    });
    const summary = res.choices[0]?.message?.content?.trim();
    const u = res.usage;
    this.store.appendCost({
      at: new Date().toISOString(),
      who: "seller",
      purpose: "summary",
      provider: "serv",
      model: res.model,
      latencyMs: Date.now() - started,
      promptTokens: u?.prompt_tokens,
      completionTokens: u?.completion_tokens,
      usd: u ? u.prompt_tokens * PRICE_IN + u.completion_tokens * PRICE_OUT : null,
    });
    if (!summary) throw new Error("SERV returned no summary");
    return summary;
  }
}

/** Caches summaries by section hash so a re-run never pays SERV twice for the same section. */
export class CachedSummarizer implements Summarizer {
  constructor(private inner: Summarizer, private store: Store, private model: string) {}

  async summarize(sectionName: string, text: string): Promise<string> {
    const key = sha256Hex(text);
    const hit = this.store.getCachedSummary(key);
    if (hit) return hit.summary;
    const summary = await this.inner.summarize(sectionName, text);
    this.store.putCachedSummary(key, { summary, model: this.model, createdAt: new Date().toISOString() });
    return summary;
  }
}
