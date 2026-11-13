import { sha256Hex } from "@pawlr/protocol";
import type { Store } from "./store.js";

/** Produces the deliverable for one tick: here, a 1 to 3 sentence summary of one document section. Plug in any producer. */
export interface Summarizer {
  summarize(sectionName: string, text: string): Promise<string>;
}

/** Caches deliverables by section hash so a re-run never pays the producer twice for the same section. */
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
