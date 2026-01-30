/**
 * English language pack: identity, allowUnchangedAnswer always true, isBadTranslation mostly structural.
 */

import type { LanguagePack } from "./types";

function normalize(s: string): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function isPunctuationOnly(s: string): boolean {
  return /^[\s\p{P}\p{S}]*$/u.test((s ?? "").trim());
}

export const enPack: LanguagePack = {
  code: "en",

  postProcessQuestion(translatedQ: string, _originalQ: string): { text: string; rulesApplied: string[] } {
    return { text: translatedQ ?? "", rulesApplied: [] };
  },

  getProtectedAnswerIndices(_originalAnswers: string[]): number[] {
    return [];
  },

  allowUnchangedAnswer(_original: string, _translated: string): boolean {
    return true;
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
      if (normalize(o) === normalize(t)) allowedUnchangedIndices.push(ai);
    }

    const bad = reasons.length > 0;
    return { bad, reasons, allowedUnchangedIndices, disallowedUnchangedIndices };
  },
};
