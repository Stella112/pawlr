import { readFileSync } from "node:fs";
import type { DeliveryConditions } from "@pawlr/protocol";

/**
 * SERV Reasoning client and response parser.
 * Shapes from docs.openserv.ai and live captures (docs/integration-notes.md §1):
 * - POST https://inference-api.openserv.ai/v1/chat/completions, Bearer key, system message required.
 * - PromptGuard hit: HTTP 200, message.content null, message.refusal string, usage all 0 (probe p3).
 * - response_format + serv_prompt_guard work in one request (probe p5).
 * - Shadow Agent outcome is not exposed in the response (probe p6).
 */

export const SERV_CHAT_URL = "https://inference-api.openserv.ai/v1/chat/completions";
export const PRICE_IN_PER_TOKEN = 1.0 / 1e6; // gpt-5.4-mini (models.md)
export const PRICE_OUT_PER_TOKEN = 6.0 / 1e6;

export const PROMPT_VERSION = "ruling-v1";
export const RULING_SYSTEM_PROMPT = readFileSync(new URL("../prompts/ruling-v1.txt", import.meta.url), "utf8").trim();

export const SHADOW_HINT =
  "The verdict must quote exact words that appear in the seller output or the section text, and must be pass only if the output summarises that section.";

export const RULING_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "pawlr_ruling",
    strict: true,
    schema: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["pass", "fail", "unsure"] },
        quote: { type: "string" },
        reason: { type: "string" },
      },
      required: ["verdict", "quote", "reason"],
      additionalProperties: false,
    },
  },
} as const;

const GUARD_TOOL = { type: "function", function: { name: "serv_prompt_guard" } } as const;
const SHADOW_TOOL = {
  type: "function",
  function: {
    name: "serv_shadow_agent",
    parameters: {
      type: "object",
      properties: {
        hint: { type: "string", default: SHADOW_HINT },
        max_iterations: { type: "integer", default: 3 },
      },
    },
  },
} as const;

export interface JudgeInput {
  conditions: DeliveryConditions;
  sectionName: string;
  sectionText: string;
  sellerOutput: string;
}

export function buildRulingRequest(input: JudgeInput, opts: { model: string; shadow: boolean }) {
  const rule = { task: input.conditions.task, relevance: input.conditions.relevance, completion: input.conditions.completion };
  return {
    model: opts.model,
    temperature: 0, // accepted by gpt-5.4-mini (probe p1)
    messages: [
      { role: "system", content: RULING_SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `<conditions>${JSON.stringify(rule)}</conditions>\n` +
          `<section name=${JSON.stringify(input.sectionName)}>${input.sectionText}</section>\n` +
          `<seller_output>${input.sellerOutput}</seller_output>`,
      },
    ],
    response_format: RULING_FORMAT,
    tools: opts.shadow ? [GUARD_TOOL, SHADOW_TOOL] : [GUARD_TOOL],
  };
}

/** Raw HTTP result. `status: null` means the request never got a response (network error). */
export interface RawResponse {
  status: number | null;
  body: unknown;
  latencyMs: number;
  requestId?: string;
}

/** Anything that can send a chat-completions body and return the raw response. Real or recorded. */
export type ChatTransport = (body: unknown) => Promise<RawResponse>;

export function servTransport(apiKey: string, fetchImpl: typeof fetch = fetch): ChatTransport {
  if (!apiKey) throw new Error("SERV_API_KEY is required");
  return async (body) => {
    const started = Date.now();
    try {
      const res = await fetchImpl(SERV_CHAT_URL, {
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
      return { status: res.status, body: parsed, latencyMs: Date.now() - started, requestId: res.headers.get("x-openserv-request-id") ?? undefined };
    } catch (err) {
      return { status: null, body: String(err), latencyMs: Date.now() - started };
    }
  };
}

export type Parsed =
  | { kind: "ruling"; verdict: "pass" | "fail" | "unsure"; quote: string; reason: string }
  | { kind: "guard-refusal"; refusal: string }
  | { kind: "refusal"; refusal: string }
  | { kind: "invalid"; detail: string }
  | { kind: "error"; status: number | null; retryable: boolean; detail: string };

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  usd: number;
}

export function usageOf(raw: RawResponse): Usage | null {
  const u = (raw.body as { usage?: { prompt_tokens?: number; completion_tokens?: number } } | null)?.usage;
  if (!u || typeof u.prompt_tokens !== "number" || typeof u.completion_tokens !== "number") return null;
  return { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens, usd: u.prompt_tokens * PRICE_IN_PER_TOKEN + u.completion_tokens * PRICE_OUT_PER_TOKEN };
}

/** Turns a raw response into exactly one outcome. Never throws. */
export function parseResponse(raw: RawResponse): Parsed {
  if (raw.status === null) return { kind: "error", status: null, retryable: true, detail: `network error: ${String(raw.body).slice(0, 200)}` };
  if (raw.status === 429 || raw.status >= 500) return { kind: "error", status: raw.status, retryable: true, detail: `HTTP ${raw.status}` };
  if (raw.status >= 400) {
    const msg = (raw.body as { error?: { message?: string } } | null)?.error?.message;
    return { kind: "error", status: raw.status, retryable: false, detail: `HTTP ${raw.status}${msg ? `: ${msg}` : ""}` };
  }
  const body = raw.body as {
    choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[];
    usage?: { total_tokens?: number };
  } | null;
  const choice = body?.choices?.[0];
  if (!choice?.message) return { kind: "invalid", detail: "no choices[0].message in response" };
  const { content, refusal } = choice.message;
  if (content == null && typeof refusal === "string" && refusal.length > 0) {
    // Guard refusals are answered by SERV itself: no model call, so zero tokens (probe p3).
    return body?.usage?.total_tokens === 0 ? { kind: "guard-refusal", refusal } : { kind: "refusal", refusal };
  }
  if (choice.finish_reason === "length") return { kind: "invalid", detail: "response truncated (finish_reason length)" };
  if (typeof content !== "string") return { kind: "invalid", detail: "message.content is not a string" };
  let j: unknown;
  try {
    j = JSON.parse(content);
  } catch {
    return { kind: "invalid", detail: "message.content is not valid JSON" };
  }
  const r = j as { verdict?: unknown; quote?: unknown; reason?: unknown };
  if (!["pass", "fail", "unsure"].includes(r?.verdict as string) || typeof r.quote !== "string" || typeof r.reason !== "string") {
    return { kind: "invalid", detail: "ruling JSON is off-schema" };
  }
  return { kind: "ruling", verdict: r.verdict as "pass" | "fail" | "unsure", quote: r.quote, reason: r.reason };
}
