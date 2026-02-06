/**
 * German language pack: postprocess, protection (v7.6 only non-translatables), allowUnchanged, isBadTranslation.
 * MUST NOT protect answers just because they start with uppercase (German nouns).
 */

import { isKnownAbbreviation } from "./abbreviations";
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
// v7.6: Generic nouns — any phrase containing any of these is NOT protected (translate: Quotation mark, Greater-than sign, etc.).
const DE_GENERIC_NOUNS = new Set([
  "artery", "vein", "vision", "disease", "syndrome", "flu", "war", "treaty", "empire", "kingdom",
  "republic", "revolution", "battle", "element", "symbol", "acid", "base", "muscle", "bone", "nerve",
  "pandemic", "virus", "river", "mountain", "capital", "president",
  "mark", "sign", "season", "episode", "character", "game", "album", "city", "country",
]);
// v7.4: Do NOT protect common German articles/pronouns when they appear alone.
const DE_ALONE_ARTICLE = new Set(["der", "die", "das", "ein", "eine"]);

/** v7.6: Case-insensitive. True if any token is in generic-nouns list. */
function containsGenericNoun(answer: string): boolean {
  const tokens = (answer ?? "").trim().split(/\s+/).filter(Boolean);
  return tokens.some((w) => DE_GENERIC_NOUNS.has(normalize(w)));
}

// v7.3.1: Common German nouns that indicate proper noun mistranslation (e.g. Eleven -> Elf).
const COMMON_GERMAN_NOUNS = new Set([
  "elf", "bär", "könig", "königin", "prinz", "prinzessin", "mann", "frau", "kind", "junge", "mädchen",
  "stadt", "land", "fluss", "berg", "see", "baum", "tier", "vogel", "fisch", "buch", "film", "spiel",
]);

function looksLikeProperNoun(answer: string): boolean {
  const t = (answer ?? "").trim();
  if (!t || /\d/.test(t)) return false;
  const tokens = t.split(/\s+/).filter(Boolean);
  if (tokens.length < 1 || tokens.length > 3) return false;
  return tokens.every((w) => /^[A-Z]\p{L}*$/u.test(w));
}

function isCommonGermanNounTranslation(translated: string): boolean {
  const t = (translated ?? "").trim().toLowerCase();
  if (!t || t.length > 30) return false;
  const token = t.split(/\s+/)[0];
  if (!token) return false;
  return COMMON_GERMAN_NOUNS.has(normalize(token)) || (token.length <= 5 && /^[a-zäöüß]+$/.test(token));
}

/** v7.3.1: Returns 0-based answer indices to force-protect on retry (proper noun mistranslated to common DE noun). */
export function getForceProtectIndicesForProperNounMistranslation(
  originalTexts: string[],
  translatedTexts: string[],
  protectedAnswerIndices: number[]
): number[] {
  const orig = originalTexts ?? [];
  const trans = translatedTexts ?? [];
  const protectedSet = new Set(protectedAnswerIndices ?? []);
  const answerStartIdx = 1;
  const force: number[] = [];
  for (let ai = 0; ai < orig.length - answerStartIdx; ai++) {
    if (protectedSet.has(ai)) continue;
    const o = (orig[answerStartIdx + ai] ?? "").trim();
    const t = (trans[answerStartIdx + ai] ?? "").trim();
    if (!o || !t) continue;
    if (!looksLikeProperNoun(o)) continue;
    if (normalize(o) === normalize(t)) continue;
    if (isCommonGermanNounTranslation(t)) force.push(ai);
  }
  return force;
}

function normalize(s: string): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function isPunctuationOnly(s: string): boolean {
  return /^[\s\p{P}\p{S}]*$/u.test((s ?? "").trim());
}

/** v7.4: True if the question was clearly translated (different from original, not just punctuation). */
function questionMeaningfullyChanged(origQ: string, transQ: string): boolean {
  const o = (origQ ?? "").trim();
  const t = (transQ ?? "").trim();
  if (!t || isPunctuationOnly(t)) return false;
  return normalize(o) !== normalize(t);
}

/** v7.6: True if question text is clearly German — do not flag english fragments when this holds. */
export function isClearlyGerman(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  const lower = t.toLowerCase();
  const deFunction = /\b(welche|welcher|welches|was|wann|wo|warum|wie|in welchem|in welcher)\b/i;
  const deVerbsNouns = /\b(kommt|taucht|bedeutet|steht für|figur|staffel)\b/i;
  const umlauts = /[äöüÄÖÜß]/;
  const articles = /\b(das|der|die)\b/i;
  return deFunction.test(t) || deVerbsNouns.test(lower) || umlauts.test(t) || articles.test(t);
}

/** v7.6: True if original question is about code/HTML — disable english-fragment failure for these. */
export function isCodeOrHtmlQuestion(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  return /HTML/i.test(t) || /[<>]/.test(t) || /&(#|quot|amp|lt|gt|apos)/i.test(t) || /[{};]/.test(t) || /&#\d/.test(t);
}

/** v7.6: English tokens that must not appear in a translated DE question (stumpf but robust). */
const EN_FRAGMENT_TOKENS = new Set([
  "features", "character", "which", "what", "the", "of", "in", "season", "episode", "game", "album",
  "recorded", "appears", "stands", "for", "who", "where", "when", "how", "does", "did", "do", "is", "are",
  "with", "record", "records", "recording", "released", "release",
]);
/** v7.6: Compute ratio of words that are English fragments (0..1). */
function englishFragmentRatio(text: string): number {
  const t = (text ?? "").trim();
  if (!t) return 0;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  let count = 0;
  for (const w of words) {
    const key = normalize(w).replace(/[^\w]/g, "");
    if (key.length > 0 && EN_FRAGMENT_TOKENS.has(key)) count++;
  }
  return count / words.length;
}
/** v7.6: True if translated question still contains English fragments (DE target). */
export function containsEnglishFragments(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  const words = t.split(/\s+/).filter(Boolean);
  return words.some((w) => {
    const key = normalize(w).replace(/[^\w]/g, "");
    return key.length > 0 && EN_FRAGMENT_TOKENS.has(key);
  });
}
/** Legacy: pattern-based check used in validation. */
const EN_FRAGMENT_PATTERNS = [
  /\bis\s+the\b/i, /\bwith\s+/i, /\bwhich\b/i, /\bin\s+the\b/i,
  /\bno\s+breaks\b/i, /\bline-up\b/i, /\bthe\s+album\b/i,
  /\brecorded\b/i, /\breleased\b/i, /\bwhat\b/i, /\bwho\b/i, /\bwhere\b/i, /\bwhen\b/i, /\bhow\b/i,
];
function detectEnglishFragments(text: string): boolean {
  const t = (text ?? "").trim();
  return EN_FRAGMENT_PATTERNS.some((re) => re.test(t)) || containsEnglishFragments(t);
}

/** v7.6: Deterministic German rewrite when bad_result due to question_has_english_fragments (stumpf but no mixed). */
export function getStumpfGermanRewrite(originalQuestion: string): string | null {
  const q = (originalQuestion ?? "").trim();
  if (!q) return null;
  const m1 = q.match(/^\s*Which\s+game\s+features\s+the\s+character\s+(.+?)\s*\??\s*$/i);
  if (m1) return "In welchem Spiel kommt die Figur " + (m1[1] as string).trim() + " vor?";
  const m2 = q.match(/^\s*Which\s+character\s+appears\s+in\s+(.+?)\s*\??\s*$/i);
  if (m2) return "Welche Figur kommt in " + (m2[1] as string).trim() + " vor?";
  return null;
}

/** v7.7: Forced German rewrite for game questions when mixed-language fallback would occur. Always returns a string. */
export function forceRewriteGameQuestion(original: string): string {
  const q = (original ?? "").trim();
  if (!q) return "In welchem Spiel kommt diese Figur vor?";
  const m = q.match(/the\s+character\s+([A-Za-z0-9\s'\u00C0-\u024F-]+?)\s*\??\s*$/i)
    || q.match(/character\s+([A-Za-z0-9\s'\u00C0-\u024F-]+?)\s*\??\s*$/i);
  const entity = m ? (m[1] as string).trim() : null;
  if (entity && entity.length > 0 && entity.length <= 80) {
    return "In welchem Spiel kommt die Figur " + entity + " vor?";
  }
  return "In welchem Spiel kommt diese Figur vor?";
}

const DE_FORCE_REWRITE_RULE = "de_force_rewrite_template";

/** v7.7: Forced German rewrite with rule name for meta.postProcessRulesApplied. Minimal, safe templates. */
export function forceRewriteGermanQuestion(originalQuestion: string): { text: string; rule: string } {
  const q = (originalQuestion ?? "").trim();
  if (!q) return { text: "Worum geht es in dieser Frage?", rule: DE_FORCE_REWRITE_RULE };
  const hasWhichGame = /which\s+game/i.test(q);
  const hasCharacter = /character/i.test(q);
  const charMatch = q.match(/the\s+character\s+([A-Za-z0-9\s'\u00C0-\u024F-]+?)\s*\??\s*$/i)
    || q.match(/character\s+([A-Za-z0-9\s'\u00C0-\u024F-]+?)\s*\??\s*$/i);
  const entity = charMatch ? (charMatch[1] as string).trim() : null;
  if (hasWhichGame && hasCharacter && entity && entity.length > 0 && entity.length <= 80) {
    return { text: "In welchem Spiel kommt die Figur " + entity + " vor?", rule: DE_FORCE_REWRITE_RULE };
  }
  if (/which/i.test(q) && hasCharacter) {
    return { text: "Welche Figur kommt in diesem Spiel vor?", rule: DE_FORCE_REWRITE_RULE };
  }
  return { text: "Worum geht es in dieser Frage?", rule: DE_FORCE_REWRITE_RULE };
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

/**
 * v7.6: Protect ONLY non-translatables. Generic multi-word Title Case (Quotation mark, Greater-than sign) is NOT protected.
 * Protect TRUE: digits, ALL CAPS >=2, chemical/math/code token, short mixed alnum (Xbox360), <=3 chars in known abbreviations.
 * Protect FALSE: generic nouns (mark, sign, symbol, season, episode, character, game, album, city, country, etc.), single-word Title Case.
 */
function shouldProtectAnswerDE(answer: string): boolean {
  const t = (answer ?? "").trim();
  if (!t || t.length > 120) return false;

  if (t.split(/\s+/).filter(Boolean).length === 1 && DE_ALONE_ARTICLE.has(normalize(t))) return false;
  if (containsGenericNoun(t)) return false;

  if (/\d/.test(t)) return true;
  if (/^[A-Z]{2,}$/.test(t)) return true;
  if (/^[A-Z]{2,}(\.[A-Z]+)*$/.test(t)) return true;

  // Chemical/math/code: _ / \ : @ # . = + - (with alnum), or 0x, or IPv4
  if (/[_/\\:@#.=+-]/.test(t) && /\w/.test(t)) return true;
  if (/0x/i.test(t)) return true;
  if (/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(t)) return true;

  const tokens = t.split(/\s+/).filter(Boolean);
  if (tokens.length === 1) {
    const w = tokens[0]!;
    if (w.length <= 3 && /^[A-Za-z]+$/.test(w) && isKnownAbbreviation(w)) return true;
    if (/[a-zA-Z].*[0-9]|[0-9].*[a-zA-Z]/.test(w) && w.length <= 20) return true; // Xbox360, iPhone12
  }

  if (/[a-z][A-Z]/.test(t)) return true;
  if (/[A-Z]{2,}[a-z]/.test(t)) return true;
  if (tokens.length >= 2 && /[A-Z]/.test(t) && !containsGenericNoun(t)) return true;

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

    // v7.6: Only flag english fragments when question is NOT clearly German and NOT code/HTML, and ratio >= 0.35.
    const transQuestion = trans[0] ?? "";
    const origQuestion = orig[0] ?? "";
    if (isCodeOrHtmlQuestion(origQuestion)) {
      reasons.push("code_question"); // debug hint only; not in badReasons
    } else if (!isClearlyGerman(transQuestion)) {
      const ratio = englishFragmentRatio(transQuestion);
      if (ratio >= 0.35 && (detectEnglishFragments(transQuestion) || containsEnglishFragments(transQuestion))) {
        reasons.push("question_contains_english_fragments");
        reasons.push("question_has_english_fragments");
      }
    }
    if (detectMixedLanguageInQuestion(transQuestion, origQuestion)) {
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

    const allUnchangedAnswerIndices = [...new Set([...allowedUnchangedIndices, ...disallowedUnchangedIndices])];
    const nonProtectedUnchangedCount = allUnchangedAnswerIndices.filter((ai) => !protectedSet.has(ai)).length;
    const totalAnswerCount = numNonProtectedAnswers;
    const unchangedNonProtectedRatio = totalAnswerCount > 0 ? nonProtectedUnchangedCount / totalAnswerCount : 0;
    // v7.4: Only reject for too_many_unchanged_non_protected when question did NOT change meaningfully.
    const questionChanged = questionMeaningfullyChanged(orig[0] ?? "", trans[0] ?? "");
    if (!questionChanged && unchangedNonProtectedRatio > 0.3) {
      reasons.push("too_many_unchanged_non_protected");
    }
    const allAnswersUnchanged = totalAnswerCount > 0 && allUnchangedAnswerIndices.length === totalAnswerCount;
    const atLeastOneNonProtected = allUnchangedAnswerIndices.some((ai) => !protectedSet.has(ai));
    if (!questionChanged && allAnswersUnchanged && atLeastOneNonProtected) {
      reasons.push("all_answers_unchanged");
    }

    if (EN_RESIDUAL_PATTERN.test(trans[0] ?? "") || EN_THE_ALBUM_PATTERN.test(trans[0] ?? "")) {
      reasons.push("partial_sentence_source_fragments");
    }
    if (/Welches Band/i.test(trans[0] ?? "")) {
      reasons.push("de_welches_band");
    }

    const badReasons = new Set([
      "length_mismatch", "fewer_than_two_answers", "empty_question", "all_answers_empty",
      "too_many_unchanged_non_protected", "all_answers_unchanged", "question_has_english_fragments",
    ]);
    const hasBad = reasons.some((r) => badReasons.has(r));
    const level = hasBad ? "bad" : reasons.length > 0 ? "fallback" : "good";
    return { level, reasons, allowedUnchangedIndices, disallowedUnchangedIndices };
  },
};
