/**
 * Spanish language pack: identity postprocess for now, same structure + mixed detection as DE.
 */

import type { LanguagePack } from "./types";

const KNOWN_BRAND_PATTERNS = [
  /\b(AC\/DC|U2|R.E\.M|OK Computer|NASA|BBC|NBA|NFL|IBM|HP|UK|USA)\b/i,
  /\b(iPhone|eBay|iPad|YouTube|Facebook|Google|Spotify|Netflix)\b/i,
];

function normalize(s: string): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function isPunctuationOnly(s: string): boolean {
  return /^[\s\p{P}\p{S}]*$/u.test((s ?? "").trim());
}

function shouldProtectAnswerES(answer: string): boolean {
  const t = (answer ?? "").trim();
  if (!t || t.length > 120) return false;
  if (/^[A-Z0-9\s\p{P}]+$/u.test(t) && /[A-Z]{2,}/.test(t)) return true;
  if (/\d/.test(t)) return true;
  if (/[a-z][A-Z]|[A-Z][a-z].*[A-Z]/.test(t)) return true;
  if (/[.&\/\-']/.test(t)) return true;
  const tokens = t.split(/\s+/).filter(Boolean);
  if (tokens.length === 1 && /^[A-Za-z]{1,3}$/.test(tokens[0]!)) return true;
  for (const re of KNOWN_BRAND_PATTERNS) {
    if (re.test(t)) return true;
  }
  return false;
}

function allowUnchangedAnswerES(original: string, translated: string): boolean {
  const o = (original ?? "").trim();
  const t = (translated ?? "").trim();
  if (!o || !t || normalize(o) !== normalize(t)) return false;
  if (shouldProtectAnswerES(o)) return true;
  const words = o.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && words.every((w) => /^[A-Z]/.test(w))) return true;
  if (words.length === 1 && /^[A-Za-z]+$/.test(o) && o.length >= 4) return true;
  return false;
}

export const esPack: LanguagePack = {
  code: "es",

  postProcessQuestion(translatedQ: string, _originalQ: string): { text: string; rulesApplied: string[] } {
    return { text: translatedQ ?? "", rulesApplied: [] };
  },

  getProtectedAnswerIndices(originalAnswers: string[]): number[] {
    const indices: number[] = [];
    for (let i = 0; i < (originalAnswers ?? []).length; i++) {
      if (shouldProtectAnswerES(originalAnswers[i] ?? "")) indices.push(i);
    }
    return indices;
  },

  allowUnchangedAnswer(original: string, translated: string): boolean {
    return allowUnchangedAnswerES(original, translated);
  },

  isBadTranslation(
    originalTexts: string[],
    translatedTexts: string[],
    protectedAnswerIndices: number[]
  ): {
    bad: boolean;
    reasons: string[];
    allowedUnchangedIndices: number[];
    disallowedUnchangedIndices: number[];
  } {
    const reasons: string[] = [];
    const allowedUnchangedIndices: number[] = [];
    const disallowedUnchangedIndices: number[] = [];
    const orig = originalTexts ?? [];
    const trans = translatedTexts ?? [];
    const protectedSet = new Set(protectedAnswerIndices ?? []);
    const answerStartIdx = 1;

    if (orig.length !== trans.length) {
      reasons.push("length_mismatch");
      return { bad: true, reasons, allowedUnchangedIndices, disallowedUnchangedIndices };
    }
    if (orig.length === 0) {
      return { bad: false, reasons: [], allowedUnchangedIndices, disallowedUnchangedIndices };
    }

    for (let i = 0; i < trans.length; i++) {
      const t = (trans[i] ?? "").trim();
      if (!t || isPunctuationOnly(trans[i] ?? "")) {
        reasons.push("empty_or_punctuation_only");
        return { bad: true, reasons, allowedUnchangedIndices, disallowedUnchangedIndices };
      }
    }

    for (let ai = 0; ai < orig.length - answerStartIdx; ai++) {
      if (!protectedSet.has(ai)) continue;
      const o = (orig[answerStartIdx + ai] ?? "").trim();
      const t = (trans[answerStartIdx + ai] ?? "").trim();
      if (o !== t) {
        reasons.push("protected_answer_changed");
        return { bad: true, reasons, allowedUnchangedIndices, disallowedUnchangedIndices };
      }
    }

    for (let ai = 0; ai < orig.length - answerStartIdx; ai++) {
      const o = (orig[answerStartIdx + ai] ?? "").trim();
      const t = (trans[answerStartIdx + ai] ?? "").trim();
      if (!o || !t) continue;
      if (normalize(o) === normalize(t)) {
        if (protectedSet.has(ai)) {
          allowedUnchangedIndices.push(ai);
        } else if (allowUnchangedAnswerES(o, t)) {
          allowedUnchangedIndices.push(ai);
        } else {
          disallowedUnchangedIndices.push(ai);
        }
      }
    }

    const numNonProtectedAnswers = orig.length - answerStartIdx;
    const hasUnprotectedUnchanged = disallowedUnchangedIndices.length > 0;
    if (hasUnprotectedUnchanged) {
      const someOtherChanged = trans.slice(answerStartIdx).some((t, ai) => {
        const o = orig[answerStartIdx + ai] ?? "";
        return normalize(o) !== normalize(t);
      });
      if (someOtherChanged) reasons.push("mixed_answers");
      else if (
        numNonProtectedAnswers > 0 &&
        allowedUnchangedIndices.length + disallowedUnchangedIndices.length >= Math.ceil(0.3 * numNonProtectedAnswers)
      ) {
        reasons.push("too_many_unchanged");
      }
    }

    const bad = reasons.length > 0;
    return { bad, reasons, allowedUnchangedIndices, disallowedUnchangedIndices };
  },
};
