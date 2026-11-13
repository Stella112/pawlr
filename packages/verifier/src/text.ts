/**
 * Deterministic text helpers used by the code checks. No model is involved.
 */

/** Collapse every run of whitespace to one space and trim. The only normalisation the quote rule allows. */
export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Sentence splitter (documented, agent.md §9 step 3).
 *
 * A sentence is a run of text ending in one or more of `.`, `!` or `?`
 * that is followed by whitespace or the end of the text. Text after the last
 * terminal mark counts as one more sentence if it contains a letter or digit.
 * A period not followed by whitespace (as in "3.5" or "e.g.x") does not end a
 * sentence. Abbreviations followed by a space ("Dr. Smith") do split; that is
 * a known, accepted limitation for 1 to 3 sentence summaries.
 */
export function splitSentences(text: string): string[] {
  const t = normalizeWhitespace(text);
  if (!t) return [];
  const out: string[] = [];
  const re = /[^]*?[.!?]+(?=\s|$)/y;
  let i = 0;
  while (i < t.length) {
    re.lastIndex = i;
    const m = re.exec(t);
    if (!m) break;
    out.push(m[0].trim());
    i = re.lastIndex;
    while (t[i] === " ") i++;
  }
  const rest = t.slice(i).trim();
  if (/[\p{L}\p{N}]/u.test(rest)) out.push(rest);
  return out.filter((s) => /[\p{L}\p{N}]/u.test(s));
}

export const STOPWORDS = new Set(
  (
    "a about above after again against all also am an and any are as at be because been before being below between both but by " +
    "can could did do does doing down during each few for from further had has have having he her here hers herself him himself " +
    "his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours " +
    "ourselves out over own same she should so some such than that the their theirs them themselves then there these they this " +
    "those through to too under until up very was we were what when where which while who whom why will with would you your " +
    "yours yourself yourselves may must shall might within without unless upon via per one two three section"
  ).split(" "),
);

/** Number of key terms taken from a section (top-N by frequency). */
export const KEY_TERM_COUNT = 8;

/**
 * Light, documented normalisation of a token: lowercase; a trailing "s" is
 * dropped for tokens longer than 4 letters that do not end in "ss" (so
 * "refunds" and "refund" match). Nothing else.
 */
export function stem(token: string): string {
  const t = token.toLowerCase();
  return t.length > 4 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t;
}

export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t)).map(stem);
}

/**
 * Key terms of a section, computed by the buyer from its own copy:
 * tokens as above, ranked by frequency, ties broken by first appearance,
 * top KEY_TERM_COUNT kept.
 */
export function keyTerms(sectionText: string, n = KEY_TERM_COUNT): string[] {
  const counts = new Map<string, { n: number; first: number }>();
  tokens(sectionText).forEach((t, i) => {
    const c = counts.get(t);
    if (c) c.n++;
    else counts.set(t, { n: 1, first: i });
  });
  return [...counts.entries()]
    .sort((a, b) => b[1].n - a[1].n || a[1].first - b[1].first)
    .slice(0, n)
    .map(([t]) => t);
}

/** Key terms (from `terms`) that occur as tokens in `text`. */
export function matchedKeyTerms(text: string, terms: string[]): string[] {
  const have = new Set(tokens(text));
  return terms.filter((t) => have.has(t));
}

/**
 * The quote-or-hold rule (agent.md §9 step 7): the quote must be non-empty
 * and an exact substring of the seller output or of the section text, after
 * whitespace normalisation only.
 */
export function checkQuote(quote: unknown, sellerOutput: string, sectionText: string): { ok: boolean; foundIn: "output" | "section" | null; detail: string } {
  if (typeof quote !== "string" || !normalizeWhitespace(quote)) return { ok: false, foundIn: null, detail: "quote missing or empty" };
  const q = normalizeWhitespace(quote);
  if (normalizeWhitespace(sellerOutput).includes(q)) return { ok: true, foundIn: "output", detail: "quote found in seller output" };
  if (normalizeWhitespace(sectionText).includes(q)) return { ok: true, foundIn: "section", detail: "quote found in section text" };
  return { ok: false, foundIn: null, detail: "quote not found in seller output or section text" };
}
