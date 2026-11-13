import { buildRulingRequest, parseResponse, type ChatTransport, type RawResponse } from "./serv.js";
import type { ScreenClient } from "./verify.js";

/**
 * Dolphin first-pass relevance screen (agent.md §9 step 5).
 *
 * Source: https://dphn.ai/docs/dphn-api (read 2026-11-14, docs/integration-notes.md §4):
 * base URL https://lighthouse.dphn.ai/run/text-v/v1, "OpenAI-compatible", `Authorization: Bearer`,
 * POST /chat/completions, model `deepseek-ai/DeepSeek-V4.1-Flash` at $0.01 in / $0.07 out per
 * million tokens. Errors: 401 bad key, 402 insufficient credits, 404 unknown model, 429 slow down.
 * Captured live (fixtures/dolphin/d1, d2): strict `response_format` json_schema is honoured and
 * `usage.prompt_tokens` / `usage.completion_tokens` are returned.
 *
 * The screen only proposes. Its quote is re-checked by code, a fail or unsure always escalates
 * to SERV, and only economy mode lets a clean pass settle a tick.
 */

export const DOLPHIN_BASE_URL = "https://lighthouse.dphn.ai/run/text-v/v1";
export const DOLPHIN_DEFAULT_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash";

/** USD per token, from dphn.ai/docs/dphn-api. Models without a listed price report usd: undefined. */
const PRICES: Record<string, { in: number; out: number }> = {
  "deepseek-ai/DeepSeek-V4.1-Flash": { in: 0.01 / 1e6, out: 0.07 / 1e6 },
};

export function dolphinTransport(apiKey: string, baseUrl = DOLPHIN_BASE_URL, fetchImpl: typeof fetch = fetch): ChatTransport {
  if (!apiKey) throw new Error("DOLPHIN_API_KEY is required");
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return async (body) => {
    const started = Date.now();
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep text */
      }
      return { status: res.status, body: parsed, latencyMs: Date.now() - started };
    } catch (err) {
      return { status: null, body: String(err), latencyMs: Date.now() - started };
    }
  };
}

/** Builds the screen request: the same prompt and `pawlr_ruling` schema as SERV, without the SERV-only tools. */
export function buildScreenRequest(input: Parameters<typeof buildRulingRequest>[0], model: string) {
  const { tools: _servOnly, ...body } = buildRulingRequest(input, { model, shadow: false });
  return body;
}

export function dolphinScreen(opts: {
  transport: ChatTransport;
  model?: string;
  sleep?: (ms: number) => Promise<void>;
}): ScreenClient {
  const model = opts.model || DOLPHIN_DEFAULT_MODEL;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  return async (input) => {
    const body = buildScreenRequest(input, model);
    let raw: RawResponse = await opts.transport(body);
    let parsed = parseResponse(raw);
    let latencyMs = raw.latencyMs;
    let promptTokens = 0;
    let completionTokens = 0;
    const add = (r: RawResponse) => {
      const u = (r.body as { usage?: { prompt_tokens?: number; completion_tokens?: number } } | null)?.usage;
      if (typeof u?.prompt_tokens === "number") promptTokens += u.prompt_tokens;
      if (typeof u?.completion_tokens === "number") completionTokens += u.completion_tokens;
    };
    add(raw);
    if (parsed.kind === "error" && parsed.retryable) {
      // One retry on 429 / 5xx / network error, as for SERV. Dolphin's docs ask for backoff on 429.
      await sleep(1500);
      raw = await opts.transport(body);
      parsed = parseResponse(raw);
      latencyMs += raw.latencyMs;
      add(raw);
    }
    // A Dolphin refusal is just "no usable ruling": it escalates to SERV like any other non-ruling.
    if (parsed.kind === "guard-refusal") parsed = { kind: "refusal", refusal: parsed.refusal };
    const price = PRICES[model];
    return {
      parsed,
      latencyMs,
      model,
      promptTokens,
      completionTokens,
      status: raw.status,
      usd: price ? promptTokens * price.in + completionTokens * price.out : undefined,
    };
  };
}
