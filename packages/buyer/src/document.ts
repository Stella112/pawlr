import { sha256Hex } from "@pawlr/protocol";
import { keyTerms } from "@pawlr/verifier";

export interface Section {
  name: string;
  text: string;
  sourceHash: string;
  keyTerms: string[];
}

/**
 * Splits a Markdown document into named sections. Every heading line
 * (`#` to `######`) starts a section named after the heading text; the
 * section text is everything up to the next heading, trimmed. Text before the
 * first heading, and empty sections, are dropped. Hashes and key terms are
 * computed locally from the buyer's own copy.
 */
export function parseDocument(markdown: string): Section[] {
  const out: Section[] = [];
  let name: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join("\n").trim();
    if (name && text) out.push({ name, text, sourceHash: sha256Hex(text), keyTerms: keyTerms(text) });
  };
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      flush();
      name = m[1]!;
      buf = [];
    } else buf.push(line);
  }
  flush();
  const seen = new Set<string>();
  for (const s of out) {
    if (seen.has(s.name)) throw new Error(`duplicate section name "${s.name}"`);
    seen.add(s.name);
  }
  if (!out.length) throw new Error("document has no sections (use Markdown headings)");
  return out;
}
