/**
 * German language pack: postprocess, protection (strong signals only), allowUnchanged, isBadTranslation.
 * MUST NOT protect answers just because they start with uppercase (German nouns).
 */

import type { LanguagePack } from "./types";

// English fragments that must not appear in a translated DE question. Exclude cognates valid in German (e.g. "Album", "Band", "Computer").
const EN_RESIDUAL_IN_QUESTION = [
  "which", "what", "who", "where", "when", "how", "the", "recorded", "record",
  "records", "recording", "does", "did", "do", "is", "are",
];
const EN_RESIDUAL_PATTERN = new RegExp(`\\b(${EN_RESIDUAL_IN_QUESTION.join("|")})\\b`, "i");
// "the album" as phrase (English) — "das Album" is correct German and must not trigger
const EN_THE_ALBUM_PATTERN = /\bthe\s+album\b/i;

// Strong signals only: known brands/names (small list). Not "starts with uppercase".
const KNOWN_BRAND_NAME_PATTERNS = [
  /\b(AC\/DC|U2|R.E\.M|OK Computer|NASA|BBC|NBA|NFL|IBM|HP|UK|USA)\b/i,
  /\b(iPhone|eBay|iPad|YouTube|Facebook|Google|Spotify|Netflix)\b/i,
];
// Country/region names that must be translated; do NOT protect these.
const KNOWN_TRANSLATABLE = new Set([
  "europe", "asia", "africa", "america", "germany", "italy", "france", "spain", "austria",
  "england", "russia", "china", "japan", "brazil", "india", "australia", "canada", "mexico",
  "netherlands", "belgium", "switzerland", "sweden", "norway", "denmark", "finland", "poland",
  "greece", "portugal", "ireland", "scotland", "wales", "uk", "usa", "united states", "united kingdom",
]);

function normalize(s: string): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function isPunctuationOnly(s: string): boolean {
  return /^[\s\p{P}\p{S}]*$/u.test((s ?? "").trim());
}

/** English function-word fragments that must not appear in a translated DE question. */
const EN_FRAGMENT_PATTERNS = [
  /\bis\s+the\b/i, /\bwith\s+/i, /\bwhich\b/i, /\bin\s+the\b/i,
  /\bno\s+breaks\b/i, /\bline-up\b/i, /\bthe\s+album\b/i,
  /\brecorded\b/i, /\breleased\b/i, /\bwhat\b/i, /\bwho\b/i, /\bwhere\b/i, /\bwhen\b/i, /\bhow\b/i,
];
function detectEnglishFragments(text: string): boolean {
  const t = (text ?? "").trim();
  return EN_FRAGMENT_PATTERNS.some((re) => re.test(t));
}

/** German-only signals: stopwords or umlauts. */
const DE_SIGNAL = /\b(Welche?|Welcher|der|die|das|und|ist|sind|hat|haben|für|von|mit|auf|nach)\b|ä|ö|ü|ß/i;
/** Extract runs of 5+ ASCII letter-words from text. */
function getLongAsciiWordRuns(text: string): string[] {
  const lower = (text ?? "").toLowerCase();
  const runs: string[] = [];
  const wordRun = /[a-z]{2,}(?:\s+[a-z]{2,}){4,}/g;
  let m: RegExpExecArray | null;
  while ((m = wordRun.exec(lower)) !== null) {
    runs.push(m[0]);
  }
  return runs;
}

/** High-signal: translated question has both German AND long English fragment from original. */
function detectMixedLanguageInQuestion(translatedQ: string, originalQ: string): boolean {
  const t = (translatedQ ?? "").trim();
  const o = (originalQ ?? "").trim();
  if (!t || !o) return false;
  if (!DE_SIGNAL.test(t)) return false;
  const originalRuns = getLongAsciiWordRuns(o);
  for (const run of originalRuns) {
    if (t.toLowerCase().includes(run)) return true;
  }
  return false;
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

/** Strong signals only. NOT uppercase-start alone (German nouns!). */
function shouldProtectAnswerDE(answer: string): boolean {
  const t = (answer ?? "").trim();
  if (!t || t.length > 120) return false;

  // ALL CAPS (e.g. NASA)
  if (/^[A-Z0-9\s\p{P}]+$/u.test(t) && /[A-Z]{2,}/.test(t)) return true;

  // Contains digits (e.g. 1999, 2Pac, MK2)
  if (/\d/.test(t)) return true;

  // Internal capitals (e.g. iPhone, eBay)
  if (/[a-z][A-Z]|[A-Z][a-z].*[A-Z]/.test(t)) return true;

  // Punctuation typical for names/brands: . & / - '
  if (/[.&\/\-']/.test(t)) return true;

  const tokens = t.split(/\s+/).filter(Boolean);
  // Multi-word answers (2+ words) — very often names/titles
  if (tokens.length >= 2) return true;

  // Short token(s) length <= 3, uppercase/letters (U2, AC/DC covered by punctuation)
  if (tokens.length === 1 && /^[A-Za-z]{1,3}$/.test(tokens[0]!)) return true;

  // Single-word capitalized brand/band names (e.g. Oasis, Prince, Muse, Lúcio) — 4–12 chars, exclude translatable terms
  if (tokens.length === 1 && t.length >= 4 && t.length <= 12) {
    if (/^[A-Z][a-z]+$/.test(t) && !KNOWN_TRANSLATABLE.has(normalize(t))) return true;
    if (/^[A-Z]\p{L}+$/u.test(t) && !KNOWN_TRANSLATABLE.has(normalize(t))) return true;
  }

  // Known brand/name regex
  for (const re of KNOWN_BRAND_NAME_PATTERNS) {
    if (re.test(t)) return true;
  }

  return false;
}

/** Unchanged is allowed if proper noun / brand / cognate (e.g. Europa). */
function allowUnchangedAnswerDE(original: string, translated: string): boolean {
  const o = (original ?? "").trim();
  const t = (translated ?? "").trim();
  if (!o || !t || normalize(o) !== normalize(t)) return false;
  // Same strong signals as protection
  if (shouldProtectAnswerDE(o)) return true;
  // Multiword title-case (each word starts with uppercase)
  const words = o.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && words.every((w) => /^[A-Z]/.test(w))) return true;
  // Single word, only letters, length >= 4 (covers Europa, cognates)
  if (words.length === 1 && /^[A-Za-z]+$/.test(o) && o.length >= 4) return true;
  return false;
}

export const dePack: LanguagePack = {
  code: "de",

  postProcessQuestion(translatedQ: string, originalQ: string): { text: string; rulesApplied: string[] } {
    let q = translatedQ ?? "";
    const rulesApplied: string[] = [];

    const applyRule = (name: string, regex: RegExp, replacement: string) => {
      const next = q.replace(regex, replacement);
      if (next !== q) {
        rulesApplied.push(name);
        q = next;
      }
    };

    if (/^Which\s+/i.test(originalQ ?? "")) {
      if (!/^(Welches?|Welcher|Welche|Was|Wo|Wann|Wie|Warum)\s+/i.test(q) && /\b(das|der|die)\s+/i.test(q)) {
        const article = q.match(/\b(das|der|die)\s+/i)?.[1]?.toLowerCase();
        if (article === "der") q = q.replace(/^(Das|Der|Die)\s+/i, "Welcher ");
        else if (article === "die") q = q.replace(/^(Das|Der|Die)\s+/i, "Welche ");
        else q = q.replace(/^(Das|Der|Die)\s+/i, "Welches ");
        rulesApplied.push("de_which_interrogative");
      }
    }

    // Only add question mark when original was a question (avoids Italy -> Italien?)
    if ((originalQ ?? "").trim().endsWith("?") && !q.trim().endsWith("?")) {
      q = q.trim() + "?";
      rulesApplied.push("de_ensure_question_mark");
    }

    const verbReplacements: Array<[RegExp, string]> = [
      [/\breleased\b/gi, "veröffentlichte"],
      [/\brecorded\b/gi, "nahm auf"],
      [/\brelease\b/gi, "veröffentlichen"],
      [/\brecord\b/gi, "aufnehmen"],
    ];
    for (const [regex, replacement] of verbReplacements) {
      const next = q.replace(regex, replacement);
      if (next !== q) {
        rulesApplied.push("de_replace_residual_verbs");
        q = next;
      }
    }

    applyRule("de_gender_band", /\bWelches Band\b/g, "Welche Band");
    applyRule("de_replace_the_album", /\bthe album\b/gi, "das Album");
    applyRule("de_reorder_nahm_auf", /\bnahm auf das Album\s+([^?]+?)\s*\?/gi, "nahm das Album $1 auf?");
    applyRule(
      "de_prefer_hat_aufgenommen",
      /^Welche Band nahm das Album\s+([^?]+?)\s+auf\?$/i,
      "Welche Band hat das Album $1 aufgenommen?"
    );

    // Strip stray English interrogatives (e.g. "von Which Overwatch" -> "von Overwatch")
    let before = q;
    q = q.replace(/\b(von|of)\s+(Which|What|Who|Where|When|How)\s+/gi, "$1 ");
    if (q !== before) rulesApplied.push("de_strip_von_which");
    before = q;
    q = q.replace(/\b(Which|What|Who|Where|When|How)\b/gi, "").replace(/\s+/g, " ").trim();
    if (q !== before) rulesApplied.push("de_strip_stray_english_interrogatives");
    q = q.replace(/\s+(von|of)\s*\?/gi, "?").replace(/\s+/g, " ").trim();

    return { text: q, rulesApplied };
  },

  getProtectedAnswerIndices(originalAnswers: string[]): number[] {
    const indices: number[] = [];
    for (let i = 0; i < (originalAnswers ?? []).length; i++) {
      if (shouldProtectAnswerDE(originalAnswers[i] ?? "")) indices.push(i);
    }
    return indices;
  },

  allowUnchangedAnswer(original: string, translated: string): boolean {
    return allowUnchangedAnswerDE(original, translated);
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
    if (someAnswerEmpty) {
      reasons.push("partial_translations");
    }

    for (let ai = 0; ai < orig.length - answerStartIdx; ai++) {
      const i = answerStartIdx + ai;
      if (!protectedSet.has(ai)) continue;
      const o = (orig[i] ?? "").trim();
      const t = (trans[i] ?? "").trim();
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
        } else if (allowUnchangedAnswerDE(o, t)) {
          allowedUnchangedIndices.push(ai);
        } else if (isLikelyProperNounOrNumericOrShort(o)) {
          allowedUnchangedIndices.push(ai);
        } else {
          disallowedUnchangedIndices.push(ai);
        }
      }
    }

    if (detectEnglishFragments(trans[0] ?? "")) {
      reasons.push("question_contains_english_fragments");
    }
    if (detectMixedLanguageInQuestion(trans[0] ?? "", orig[0] ?? "")) {
      reasons.push("mixed_language_in_question");
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

    if (EN_RESIDUAL_PATTERN.test(trans[0] ?? "") || EN_THE_ALBUM_PATTERN.test(trans[0] ?? "")) {
      reasons.push("partial_sentence_source_fragments");
    }
    if (/Welches Band/i.test(trans[0] ?? "")) {
      reasons.push("de_welches_band");
    }

    const badReasons = new Set(["length_mismatch", "fewer_than_two_answers", "empty_question", "all_answers_empty"]);
    const hasBad = reasons.some((r) => badReasons.has(r));
    const level = hasBad ? "bad" : reasons.length > 0 ? "fallback" : "good";
    return { level, reasons, allowedUnchangedIndices, disallowedUnchangedIndices };
  },
};
