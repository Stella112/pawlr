import { createHash } from "node:crypto";

/**
 * Canonical JSON (CLAUDE.md §7.1): object keys sorted recursively, no
 * whitespace, UTF-8. Arrays keep their order. `undefined` object fields are
 * dropped (as JSON.stringify does), so optional fields that are absent and
 * fields set to undefined hash the same.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortDeep(v);
    }
    return out;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("canonicalJson: non-finite numbers cannot be hashed");
  }
  return value;
}

/** SHA-256 of the UTF-8 bytes of `text`, as lowercase hex. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** conditionsHash = sha256Hex(canonicalJson(conditions)). */
export function hashConditions(conditions: unknown): string {
  return sha256Hex(canonicalJson(conditions));
}
