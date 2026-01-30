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

    for (let ai = 0; ai < orig.length - answerStartIdx; ai++) {
      if (!protectedSet.has(ai)) continue;
      const o = (orig[answerStartIdx + ai] ?? "").trim();
      const t = (trans[answerStartIdx + ai] ?? "").trim();
      if (o !== t) {
        reasons.push("protected_answer_changed");
        return { level: "fallback", reasons, allowedUnchangedIndices, disallowedUnchangedIndices };
      }
    }

    for (let ai = 0; ai < orig.length - answerStartIdx; ai++) {
      const o = (orig[answerStartIdx + ai] ?? "").trim();
      const t = (trans[answerStartIdx + ai] ?? "").trim();
      if (!o || !t) continue;
      if (normalize(o) === normalize(t)) allowedUnchangedIndices.push(ai);
    }

    const level = reasons.length > 0 ? "fallback" : "good";
    return { level, reasons, allowedUnchangedIndices, disallowedUnchangedIndices };
  },
};
