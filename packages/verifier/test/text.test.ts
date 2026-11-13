import { describe, expect, it } from "vitest";
import { checkQuote, keyTerms, matchedKeyTerms, splitSentences } from "../src/index.js";

describe("splitSentences", () => {
  it.each([
    ["", 0],
    ["   ", 0],
    ["One sentence.", 1],
    ["No final stop", 1],
    ["First. Second! Third?", 3],
    ["One. Two. Three. Four.", 4],
    ["Prices rose 3.5 percent. Then fell.", 2],
    ["Wait... really?! Yes.", 3], // documented rule: an ellipsis followed by a space ends a sentence
    ["...", 0],
  ])("%j has %i sentences", (text, n) => {
    expect(splitSentences(text)).toHaveLength(n);
  });
});

describe("keyTerms", () => {
  const section = "Customers may request a refund within 30 days. Refunds are paid to the original payment method. Refund requests need an order number.";

  it("ranks by frequency, merges plural forms, drops stopwords and numbers", () => {
    const terms = keyTerms(section);
    expect(terms[0]).toBe("refund"); // refund, Refunds, Refund
    expect(terms).not.toContain("the");
    expect(terms).not.toContain("30");
    expect(terms.length).toBeLessThanOrEqual(8);
  });

  it("is deterministic", () => {
    expect(keyTerms(section)).toEqual(keyTerms(section));
  });

  it("counts 2 versus 3 matched terms", () => {
    const terms = keyTerms(section);
    expect(matchedKeyTerms("A refund for customers.", terms)).toHaveLength(2);
    expect(matchedKeyTerms("A refund for customers via payment.", terms)).toHaveLength(3);
  });
});

describe("checkQuote (quote-or-hold rule)", () => {
  const out = "Approved refunds go to the original payment method within 14 days.";
  const sec = "Refunds are paid to the original\n payment method within 14 days of approval.";

  it("accepts an exact substring of the seller output", () => {
    expect(checkQuote("original payment method within 14 days", out, sec)).toMatchObject({ ok: true, foundIn: "output" });
  });
  it("accepts a substring of the section after whitespace normalisation only", () => {
    expect(checkQuote("paid to the original payment   method", out, sec)).toMatchObject({ ok: true, foundIn: "section" });
  });
  it("rejects a missing or empty quote", () => {
    expect(checkQuote("", out, sec).ok).toBe(false);
    expect(checkQuote("   ", out, sec).ok).toBe(false);
    expect(checkQuote(undefined, out, sec).ok).toBe(false);
  });
  it("rejects an invented quote and any change beyond whitespace", () => {
    expect(checkQuote("refunds are instant", out, sec).ok).toBe(false);
    expect(checkQuote("Original payment method within 14 days", out, sec).ok).toBe(false); // case differs
    expect(checkQuote("original payment method within 14 days.", "x", "y").ok).toBe(false);
  });
});
