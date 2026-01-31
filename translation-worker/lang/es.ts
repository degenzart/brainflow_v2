/**
 * Spanish language pack: identity postprocess for now, same structure + mixed detection as DE.
 */

import type { LanguagePack } from "./types";

const KNOWN_BRAND_PATTERNS = [
  /\b(AC\/DC|U2|R.E\.M|OK Computer|NASA|BBC|NBA|NFL|IBM|HP|UK|USA)\b/i,
  /\b(iPhone|eBay|iPad|YouTube|Facebook|Google|Spotify|Netflix)\b/i,
];
// Country/region names that must be translated; do NOT protect these (mirror DE).
const KNOWN_TRANSLATABLE = new Set([
  "europe", "asia", "africa", "america", "germany", "italy", "france", "spain", "austria",
  "england", "russia", "china", "japan", "brazil", "india", "australia", "canada", "mexico",
  "netherlands", "belgium", "switzerland", "sweden", "norway", "denmark", "finland", "poland",
  "greece", "portugal", "ireland", "scotland", "wales", "uk", "usa", "united states", "united kingdom",
]);
// v7.3.2: Title-Case answers containing any of these are NOT protected (mirror DE).
const ES_GENERIC_WORDS = new Set([
  "artery", "vein", "vision", "disease", "syndrome", "flu", "war", "treaty", "empire", "kingdom",
  "republic", "revolution", "battle", "element", "symbol", "acid", "base", "muscle", "bone", "nerve",
  "pandemic", "virus", "river", "mountain", "capital", "president",
]);

/** v7.3.1: Case-insensitive. True if any token is in generic list. */
function containsGenericWordES(answer: string): boolean {
  const tokens = (answer ?? "").trim().split(/\s+/).filter(Boolean);
  return tokens.some((w) => ES_GENERIC_WORDS.has(normalize(w)));
}

function normalize(s: string): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function isPunctuationOnly(s: string): boolean {
  return /^[\s\p{P}\p{S}]*$/u.test((s ?? "").trim());
}

/** Exclude from "should-have-translated" mixed check: numeric, short, proper-noun-like. */
function isLikelyProperNounOrNumericOrShort(answer: string): boolean {
  const t = (answer ?? "").trim();
  if (!t) return true;
  if (t.length <= 3) return true;
  if (/^\d+$/.test(t) || /^(19|20)\d{2}$/.test(t)) return true;
  if (/^[A-Z0-9\s\p{P}]+$/u.test(t) && /[A-Z]{2,}/.test(t)) return true;
  if (/[a-z][A-Z]|[A-Z][a-z].*[A-Z]/.test(t)) return true;
  if (/\d/.test(t)) return true;
  if (/^[IVXLCDM]+$/i.test(t)) return true;
  if (/[.:\-]\w|\w[.:\-]/.test(t)) return true;
  return false;
}

/** v7.3: Protect only true proper nouns/IDs. No "starts with uppercase => protect". */
function shouldProtectAnswerES(answer: string): boolean {
  const t = (answer ?? "").trim();
  if (!t || t.length > 120) return false;
  if (containsGenericWordES(t)) return false;
  if (/\d/.test(t)) return true;
  if (/^[A-Z0-9\s\p{P}]+$/u.test(t) && /[A-Z]{2,}/.test(t)) return true;
  if (/\b[A-Z]{2,}(\.[A-Z]+)*\b/.test(t)) return true;
  if (/[_]|__|PROTECT_/.test(t)) return true;
  if (/^[0-9a-fA-F-]{8,}$/.test(t) || /^[A-Z0-9]{4,}-[A-Z0-9]+$/i.test(t)) return true;
  if (/[a-z][A-Z]|[A-Z][a-z].*[A-Z]/.test(t)) return true;
  if (/[.&\/\-']/.test(t)) return true;
  const tokens = t.split(/\s+/).filter(Boolean);
  if (tokens.length === 1 && /^[A-Za-z]{1,3}$/.test(tokens[0]!)) return true;
  if (tokens.length >= 2 && tokens.length <= 4 && tokens.every((w) => /^[A-Z]\p{L}*$/u.test(w))) {
    const hasGeneric = tokens.some((w) => ES_GENERIC_WORDS.has(normalize(w)));
    if (!hasGeneric) return true;
  }
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
    level: "good" | "fallback" | "bad";
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
      return { level: "bad", reasons, allowedUnchangedIndices, disallowedUnchangedIndices };
    }
    if (orig.length < 3) {
      reasons.push("fewer_than_two_answers");
      return { level: "bad", reasons, allowedUnchangedIndices, disallowedUnchangedIndices };
    }
    if (orig.length === 0) {
      return { level: "good", reasons: [], allowedUnchangedIndices, disallowedUnchangedIndices };
    }

    const questionEmpty = !(trans[0] ?? "").trim() || isPunctuationOnly(trans[0] ?? "");
    if (questionEmpty) {
      reasons.push("empty_question");
      return { level: "bad", reasons, allowedUnchangedIndices, disallowedUnchangedIndices };
    }
    const answersTrans = trans.slice(answerStartIdx);
    const allAnswersEmpty = answersTrans.length > 0 && answersTrans.every((t) => !(t ?? "").trim() || isPunctuationOnly(t ?? ""));
    if (allAnswersEmpty) {
      reasons.push("all_answers_empty");
      return { level: "bad", reasons, allowedUnchangedIndices, disallowedUnchangedIndices };
    }
    const someAnswerEmpty = answersTrans.some((t) => !(t ?? "").trim() || isPunctuationOnly(t ?? ""));
    if (someAnswerEmpty) reasons.push("partial_translations");

    for (let ai = 0; ai < orig.length - answerStartIdx; ai++) {
      if (!protectedSet.has(ai)) continue;
      const o = (orig[answerStartIdx + ai] ?? "").trim();
      const t = (trans[answerStartIdx + ai] ?? "").trim();
      if (o !== t) {
        reasons.push("protected_answer_changed");
        break;
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
        } else if (isLikelyProperNounOrNumericOrShort(o)) {
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

    const allUnchangedAnswerIndices = [...new Set([...allowedUnchangedIndices, ...disallowedUnchangedIndices])];
    const nonProtectedUnchangedCount = allUnchangedAnswerIndices.filter((ai) => !protectedSet.has(ai)).length;
    const totalAnswerCount = numNonProtectedAnswers;
    const unchangedNonProtectedRatio = totalAnswerCount > 0 ? nonProtectedUnchangedCount / totalAnswerCount : 0;
    if (unchangedNonProtectedRatio > 0.3) {
      reasons.push("too_many_unchanged_non_protected");
    }
    const allAnswersUnchanged = totalAnswerCount > 0 && allUnchangedAnswerIndices.length === totalAnswerCount;
    const atLeastOneNonProtected = allUnchangedAnswerIndices.some((ai) => !protectedSet.has(ai));
    if (allAnswersUnchanged && atLeastOneNonProtected) {
      reasons.push("all_answers_unchanged");
    }

    const badReasons = new Set([
      "length_mismatch", "fewer_than_two_answers", "empty_question", "all_answers_empty",
      "too_many_unchanged_non_protected", "all_answers_unchanged",
    ]);
    const hasBad = reasons.some((r) => badReasons.has(r));
    const level = hasBad ? "bad" : reasons.length > 0 ? "fallback" : "good";
    return { level, reasons, allowedUnchangedIndices, disallowedUnchangedIndices };
  },
};
