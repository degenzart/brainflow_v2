/**
 * Language pack interface for translation-worker v7.
 * Protection and validation are language-specific; MUST NOT rely on uppercase-start alone.
 */

export interface LanguagePack {
  code: string;

  /** Post-process translated question only. Returns final text and rule names for meta. */
  postProcessQuestion(
    translatedQ: string,
    originalQ: string
  ): { text: string; rulesApplied: string[] };

  /**
   * Return 0-based indices into originalAnswers[] that must not be translated (re-injected after Google).
   * Protection MUST use strong signals only (ALL CAPS, digits, internal capitals, brand punctuation, etc.).
   * MUST NOT protect just because an answer starts with an uppercase letter (e.g. German nouns).
   */
  getProtectedAnswerIndices(originalAnswers: string[]): number[];

  /**
   * Whether this unchanged answer is allowed (names, brands, cognates like Europa).
   * Unchanged can be valid; do not reject solely because some answers are unchanged.
   */
  allowUnchangedAnswer(original: string, translated: string): boolean;

  /**
   * Validate translation. Return bad=true if mixed answers, protected changed, structural issues.
   * reasons[] for debug; allowedUnchangedIndices / disallowedUnchangedIndices are 0-based answer indices.
   */
  isBadTranslation(
    originalTexts: string[],
    translatedTexts: string[],
    protectedAnswerIndices: number[]
  ): {
    bad: boolean;
    reasons: string[];
    allowedUnchangedIndices: number[];
    disallowedUnchangedIndices: number[];
  };
}
