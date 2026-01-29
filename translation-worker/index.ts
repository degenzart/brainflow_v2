export interface Env {
  GOOGLE_API_KEY: string;
  CLIENT_KEY?: string;
  TRANSLATION_CACHE?: KVNamespace;
}

// Build / cache version for this worker. Bump when translation logic changes.
const DEBUG_BUILD = "bf-dev-answers-v6";
const CACHE_VERSION = "bf-dev-answers-v6";

let debugLoggingEnabled = false;

function logDebug(message: string): void {
  if (!debugLoggingEnabled) return;
  // eslint-disable-next-line no-console
  console.log(`[${DEBUG_BUILD}] ${message}`);
}

type TranslateBatchRequest = {
  target: string;
  source?: string;
  texts: string[];
};

type TranslateBatchResponse = {
  translated: string[];
  meta?: {
    build: string;
    cacheHit: boolean;
    googleCalled: boolean;
    protectionApplied: boolean;
    issue?: string | null;
    questionChanged?: boolean;
    answersChangedCount?: number;
    answersAllowedUnchangedCount?: number;
    allowedUnchangedAnswersIndices?: number[];
    disallowedUnchangedAnswersIndices?: number[];
    postProcessed?: boolean;
    postProcessRulesApplied?: string[];
  };
};

type ErrorResponse = {
  error: string;
};

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data, null, 2), { ...init, headers });
}

function badRequest(message: string): Response {
  return json({ error: message } satisfies ErrorResponse, { status: 400 });
}

function serverError(message: string): Response {
  return json({ error: message } satisfies ErrorResponse, { status: 500 });
}

function isValidLang(code: string): boolean {
  const c = code.trim();
  return c.length >= 2 && c.length <= 5 && /^[a-zA-Z-]+$/.test(c);
}

function validateRequest(body: unknown): { ok: true; value: Required<TranslateBatchRequest> } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Invalid JSON body." };
  }
  const b = body as Record<string, unknown>;

  const target = typeof b.target === "string" ? b.target : "";
  if (!isValidLang(target)) {
    return { ok: false, error: "target must be 2-5 characters (e.g. 'es', 'de', 'pt')." };
  }

  const source = typeof b.source === "string" && b.source.trim() ? b.source : "auto";
  if (source !== "auto" && !isValidLang(source)) {
    return { ok: false, error: "source must be 'auto' or 2-5 characters." };
  }

  if (!Array.isArray(b.texts)) {
    return { ok: false, error: "texts must be an array." };
  }
  const texts = b.texts;
  if (texts.length < 1 || texts.length > 20) {
    return { ok: false, error: "texts must have 1..20 elements." };
  }

  const out: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    if (typeof t !== "string") {
      return { ok: false, error: `texts[${i}] must be a string.` };
    }
    if (t.length > 400) {
      return { ok: false, error: `texts[${i}] exceeds 400 characters.` };
    }
    out.push(t);
  }

  return { ok: true, value: { target, source, texts: out } };
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

// Heuristic: detect residual *English* words that should not appear in a translated question.
// Only applied to the QUESTION (index 0), not to answers (proper nouns may stay in English).
// Exclude cognates that are valid in German: band, album, track, song, etc.
const EN_RESIDUAL_WORDS = [
  "which",
  "what",
  "who",
  "where",
  "when",
  "how",
  "recorded",
  "record",
  "records",
  "recording",
  "does",
  "did",
  "do",
  "is",
  "are",
];

const EN_RESIDUAL_PATTERN = new RegExp(`\\b(${EN_RESIDUAL_WORDS.join("|")})\\b`, "i");

/** Only check the question text for English residuals; answers may stay unchanged (proper nouns). */
function containsEnglishResidualInQuestion(questionText: string): boolean {
  return EN_RESIDUAL_PATTERN.test(questionText);
}

// Terms that should be translated (e.g. country/region names). Unchanged answers matching these
// are considered disallowed and can trigger rejection so they get re-translated.
const KNOWN_TRANSLATABLE_TERMS = new Set([
  "europe", "asia", "africa", "america", "germany", "italy", "france", "spain", "austria",
  "england", "russia", "china", "japan", "brazil", "india", "australia", "canada", "mexico",
  "netherlands", "belgium", "switzerland", "sweden", "norway", "denmark", "finland", "poland",
  "greece", "portugal", "ireland", "scotland", "wales", "uk", "usa", "united states", "united kingdom",
]);

function isKnownTranslatableTerm(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return KNOWN_TRANSLATABLE_TERMS.has(normalized);
}

/** Language-agnostic: answer may stay unchanged if it looks like a proper noun/title, not a sentence. */
function isAnswerLikelyProperNoun(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 120) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 4) return false;
  if (/[?:]/.test(t)) return false;
  // Each word must start with uppercase or be all caps (e.g. "Radiohead", "OK Computer", "Prince")
  const hasTitleOrCaps = words.every((w) => /^[A-Z]/.test(w) || /^[A-Z]+$/.test(w));
  if (!hasTitleOrCaps) return false;
  // Must not be a known term we want translated (e.g. Italy → Italien)
  if (isKnownTranslatableTerm(t)) return false;
  return true;
}

/** Stricter: 1–3 words only. Used to decide "never send to Google" (e.g. Prince → Prinz). */
function isAnswerToProtectFromTranslation(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 120) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 3) return false;
  if (/[?:]/.test(t)) return false;
  const hasTitleOrCaps = words.every((w) => /^[A-Z]/.test(w) || /^[A-Z]+$/.test(w));
  if (!hasTitleOrCaps) return false;
  if (isKnownTranslatableTerm(t)) return false;
  return true;
}

// Updated by translateWithGoogleV2 to signal whether any protection was applied.
let lastProtectionApplied = false;
// Set when miniDeQuestionPostprocessor applies at least one rule (DE question only).
let lastPostProcessedApplied = false;
// Debug-only: which mini postprocess rules were applied (DE question only).
let lastPostProcessRulesApplied: string[] = [];

// Protection system for proper nouns (band names, album titles, track titles, etc.)
interface ProtectionResult {
  text: string;
  replacements: Array<{ token: string; original: string }>;
}

function applyProtection(text: string, counter: { value: number }): ProtectionResult {
  const replacements: Array<{ token: string; original: string }> = [];
  let protectedText = text;
  let tokenIndex = counter.value;

  // Pattern 1: Quoted titles (e.g., "Nine Inch Nails", "A Warm Place")
  protectedText = protectedText.replace(/"([^"]+)"/g, (match, content) => {
    const token = `__PROTECT_${tokenIndex++}__`;
    replacements.push({ token, original: match });
    return token;
  });

  // Pattern 2: TitleCase sequences (likely proper nouns: Band/Album/Track names)
  // Matches sequences like "Nine Inch Nails", "The Downward Spiral", "A Warm Place"
  // Must be 2+ words, each starting with uppercase, no lowercase-only words
  protectedText = protectedText.replace(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b)/g, (match) => {
    // Skip if it's a common word pattern or too short
    if (match.split(/\s+/).length < 2) return match;
    // Skip common words that shouldn't be protected
    const commonWords = /\b(The|A|An|Of|In|On|At|To|For|With|By)\b/i;
    if (commonWords.test(match) && match.split(/\s+/).length === 2) return match;
    
    const token = `__PROTECT_${tokenIndex++}__`;
    replacements.push({ token, original: match });
    return token;
  });

  // Pattern 3: Known band/album/track indicators followed by title (TitleCase or acronyms like "OK Computer")
  // Protects only the title; the indicator (album, band, …) is NOT protected so it gets translated.
  const titleWord = "(?:[A-Z][a-z]+|[A-Z]{2,})";
  protectedText = protectedText.replace(
    new RegExp(`\\b(album|track|song|band|artist|title|film|movie|game)\\s+(${titleWord}(?:\\s+${titleWord})+)`, "gi"),
    (match: string, indicator: string, title: string) => {
      const token = `__PROTECT_${tokenIndex++}__`;
      replacements.push({ token, original: title });
      return indicator + " " + token;
    },
  );

  counter.value = tokenIndex;
  if (replacements.length > 0) {
    logDebug(`PROTECTION_APPLIED count=${replacements.length}`);
  }
  return { text: protectedText, replacements };
}

function restoreProtection(text: string, replacements: Array<{ token: string; original: string }>): string {
  let restored = text;
  // Restore in reverse order to avoid token collisions
  for (let i = replacements.length - 1; i >= 0; i--) {
    const { token, original } = replacements[i];
    restored = restored.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), original);
  }
  return restored;
}

// Post-process German questions: ensure "Which ..." becomes "Welches/Welche/Welcher ..."
function postProcessGermanQuestion(question: string, originalQuestion: string): string {
  // Check if original starts with "Which"
  if (!/^Which\s+/i.test(originalQuestion)) {
    return question;
  }

  // If German translation doesn't start with interrogative, fix it
  if (!/^(Welches?|Welcher|Welche|Was|Wo|Wann|Wie|Warum)\s+/i.test(question)) {
    // Try to detect gender/number from context
    const lowerQuestion = question.toLowerCase();
    let interrogative = "Welches";
    
    // Heuristic: check for common patterns
    if (/\b(das|der|die)\s+/i.test(question)) {
      const article = question.match(/\b(das|der|die)\s+/i)?.[1]?.toLowerCase();
      if (article === "der") interrogative = "Welcher";
      else if (article === "die") interrogative = "Welche";
    }
    
    // Replace "Das/Der/Die ..." with interrogative
    question = question.replace(/^(Das|Der|Die)\s+/i, `${interrogative} `);
  }

  // Ensure question mark at the end
  if (!question.trim().endsWith("?")) {
    question = question.trim() + "?";
  }

  return question;
}

/** Replace common English residual verbs in a German question (hybrid fix). */
function replaceResidualVerbsInGermanQuestion(question: string): string {
  let q = question;
  const replacements: Array<[RegExp, string]> = [
    [/\breleased\b/gi, "veröffentlichte"],
    [/\brecorded\b/gi, "nahm auf"],
    [/\brelease\b/gi, "veröffentlichen"],
    [/\brecord\b/gi, "aufnehmen"],
  ];
  for (const [regex, replacement] of replacements) {
    q = q.replace(regex, replacement);
  }
  return q;
}

/**
 * Mini DE Question Postprocessor (safe rules only).
 * Applied ONLY to the question (index 0); never to answers.
 * No dependency on protectionApplied, cacheHit, or sourceLang.
 * Returns { text, applied, rulesApplied } with rule names for meta.
 */
function miniDeQuestionPostprocessor(question: string): { text: string; applied: boolean; rulesApplied: string[] } {
  if (!question.trim().endsWith("?")) {
    return { text: question, applied: false, rulesApplied: [] };
  }
  let q = question;
  const rulesApplied: string[] = [];

  const applyRule = (name: string, regex: RegExp, replacement: string) => {
    const next = q.replace(regex, replacement);
    if (next !== q) {
      rulesApplied.push(name);
      q = next;
    }
  };

  // Rule A (Genus-Fix): "Welches Band" → "Welche Band" at sentence start / with word boundary
  applyRule("de_gender_band", /\bWelches Band\b/g, "Welche Band");

  // Rule B (English rest "the album"): "the album" (case-insensitive) → "das Album"
  // Safe even if "nahm auf das Album" is already there (no double break)
  applyRule("de_replace_the_album", /\bthe album\b/gi, "das Album");

  // Rule C (Word order): "nahm auf das Album X" → "nahm das Album X auf"
  applyRule(
    "de_reorder_nahm_auf",
    /\bnahm auf das Album\s+([^?]+?)\s*\?/gi,
    "nahm das Album $1 auf?",
  );
  // Optional Perfekt: "Welche Band nahm das Album X auf?" → "Welche Band hat das Album X aufgenommen?"
  applyRule(
    "de_prefer_hat_aufgenommen",
    /^Welche Band nahm das Album\s+([^?]+?)\s+auf\?$/i,
    "Welche Band hat das Album $1 aufgenommen?",
  );

  const applied = rulesApplied.length > 0;
  return { text: q, applied, rulesApplied };
}

/**
 * Apply DE question postprocessing to translated[0] only.
 * Called whenever target === "de" and we have at least one result (Google path and cache path).
 * Never modifies answers (indices >= 1).
 */
function applyDeQuestionPostprocess(
  translated: string[],
  target: string,
  originalQuestion: string,
): { translated: string[]; postProcessed: boolean; rulesApplied: string[] } {
  if (target.toLowerCase() !== "de" || translated.length < 1) {
    return { translated, postProcessed: false, rulesApplied: [] };
  }
  const out = [...translated];
  const before = out[0];

  out[0] = postProcessGermanQuestion(out[0], originalQuestion);
  out[0] = replaceResidualVerbsInGermanQuestion(out[0]);
  const miniResult = miniDeQuestionPostprocessor(out[0]);
  out[0] = miniResult.text;

  const postProcessed = before !== out[0];
  const rulesApplied = miniResult.rulesApplied;

  if (debugLoggingEnabled) {
    logDebug(`DE_POSTPROCESS BEFORE: ${before}`);
    logDebug(`DE_POSTPROCESS AFTER:  ${out[0]}`);
    logDebug(`DE_POSTPROCESS rulesApplied: ${JSON.stringify(rulesApplied)}`);
  }

  return { translated: out, postProcessed, rulesApplied };
}

async function translateWithGoogleV2(params: Required<TranslateBatchRequest>, apiKey: string): Promise<string[]> {
  // Apply protection to all texts (question + answers)
  const counter = { value: 0 };
  lastProtectionApplied = false;
  lastPostProcessedApplied = false;
  lastPostProcessRulesApplied = [];
  const protectedTexts: string[] = [];
  const allReplacements: Array<Array<{ token: string; original: string }>> = [];
  /** Answers that must not be translated (e.g. Prince). We send a placeholder and restore original after. */
  const protectedAnswerSlots: Array<{ index: number; original: string }> = [];
  let answerTokenIndex = 0;

  for (let i = 0; i < params.texts.length; i++) {
    const text = params.texts[i];
    if (i >= 1 && isAnswerToProtectFromTranslation(text)) {
      const token = `__PROTECT_ANSWER_${answerTokenIndex++}__`;
      protectedTexts.push(token);
      allReplacements.push([]);
      protectedAnswerSlots.push({ index: i, original: text.trim() });
    } else {
      const protectedResult = applyProtection(text, counter);
      if (protectedResult.replacements.length > 0) {
        lastProtectionApplied = true;
      }
      protectedTexts.push(protectedResult.text);
      allReplacements.push(protectedResult.replacements);
    }
  }

  const url = new URL("https://translation.googleapis.com/language/translate/v2");
  url.searchParams.set("key", apiKey);

  const payload: Record<string, unknown> = {
    q: protectedTexts,
    source: params.source,
    target: params.target,
    format: "text",
  };

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Google Translate error ${res.status}: ${text}`);
  }

  let decoded: any;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new Error("Google Translate returned non-JSON response.");
  }

  const translations = decoded?.data?.translations;
  if (!Array.isArray(translations)) {
    throw new Error("Google Translate response missing data.translations.");
  }

  let out: string[] = translations.map((t: any, idx: number) => {
    const translated = typeof t?.translatedText === "string" ? t.translatedText : "";
    // Restore protected proper nouns
    return restoreProtection(translated, allReplacements[idx] || []);
  });

  // Restore answers that were never sent to Google (e.g. Prince) so they stay original
  for (const { index, original } of protectedAnswerSlots) {
    out[index] = original;
  }

  // DE postprocess: ALWAYS apply to question (index 0) when target === "de". Never touch answers.
  const deResult = applyDeQuestionPostprocess(out, params.target, params.texts[0]);
  if (deResult.translated !== out) {
    out[0] = deResult.translated[0];
  }
  lastPostProcessedApplied = deResult.postProcessed;
  lastPostProcessRulesApplied = deResult.rulesApplied;

  if (out.length !== params.texts.length) {
    // Still return what we got, but it's suspicious.
    // Caller will validate length.
  }
  return out;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Enable verbose logging only when explicitly requested.
    debugLoggingEnabled = request.headers.get("x-debug") === "1";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204 });
    }

    if (request.method !== "POST" || url.pathname !== "/translateBatch") {
      return json({ error: "Not found." } satisfies ErrorResponse, { status: 404 });
    }

    if (env.CLIENT_KEY && env.CLIENT_KEY.trim().length > 0) {
      const provided = request.headers.get("X-Client-Key") ?? "";
      if (provided !== env.CLIENT_KEY) {
        return json({ error: "Unauthorized." } satisfies ErrorResponse, { status: 401 });
      }
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return badRequest("Invalid JSON.");
    }

    const validated = validateRequest(body);
    if (!validated.ok) return badRequest(validated.error);
    const params = validated.value;

    if (!env.GOOGLE_API_KEY || env.GOOGLE_API_KEY.trim().length === 0) {
      return serverError("Missing GOOGLE_API_KEY secret.");
    }

    logDebug(
      `REQUEST: target=${params.target} source=${params.source} texts=${params.texts.length}`,
    );

    let cacheHit = false;
    let googleCalled = false;

    // Optional KV cache with build/version in key to avoid mixing old/new behavior
    const cacheKeyInput = `${CACHE_VERSION}\n${params.target}\n${params.texts.join("\n")}`;
    const cacheKey = await sha256Hex(cacheKeyInput);

    if (env.TRANSLATION_CACHE) {
      const cached = await env.TRANSLATION_CACHE.get(cacheKey);
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as { build?: string; translated?: unknown };
          if (
            parsed &&
            typeof parsed === "object" &&
            parsed.build === CACHE_VERSION &&
            Array.isArray(parsed.translated) &&
            (parsed.translated as unknown[]).every((x) => typeof x === "string")
          ) {
            let translatedFromCache = parsed.translated as string[];
            cacheHit = true;
            logDebug(`CACHE_HIT: key=${cacheKey}`);

            // DE postprocess ALWAYS applied to question (index 0) when target=de, so meta is consistent
            const targetLang = params.target.toLowerCase();
            if (targetLang === "de" && translatedFromCache.length >= 1) {
              const deResult = applyDeQuestionPostprocess(
                translatedFromCache,
                params.target,
                params.texts[0],
              );
              translatedFromCache = deResult.translated;
              lastPostProcessedApplied = deResult.postProcessed;
              lastPostProcessRulesApplied = deResult.rulesApplied;
            } else {
              lastPostProcessedApplied = false;
              lastPostProcessRulesApplied = [];
            }

            const resp: TranslateBatchResponse = {
              translated: translatedFromCache,
              meta: debugLoggingEnabled
                  ? {
                      build: DEBUG_BUILD,
                      cacheHit: true,
                      googleCalled: false,
                      protectionApplied: false,
                      postProcessed: lastPostProcessedApplied,
                      postProcessRulesApplied: lastPostProcessRulesApplied,
                      issue: null,
                    }
                  : undefined,
            };
            return json(resp, { status: 200 });
          }
          logDebug("CACHE_INVALIDATED: version mismatch or invalid payload structure.");
        } catch (err) {
          logDebug(`CACHE_INVALIDATED: failed to parse cache entry: ${String(err)}`);
          // ignore cache corruption and continue
        }
      } else {
        logDebug(`CACHE_MISS: key=${cacheKey}`);
      }
    }

    try {
      googleCalled = true;
      const translated = await translateWithGoogleV2(params, env.GOOGLE_API_KEY);

      // Validate translation set and detect potential issues
      let issue: string | null = null;
      let questionChanged = false;
      let answersChangedCount = 0;
      let answersAllowedUnchangedCount = 0;
      let allowedUnchangedAnswersIndices: number[] = [];
      let disallowedUnchangedAnswersIndices: number[] = [];

      if (!Array.isArray(translated) || translated.length !== params.texts.length) {
        issue = "UNEXPECTED_RESULT_LENGTH";
      } else {
        // Empty translations?
        const hasEmpty = translated.some((t) => typeof t !== "string" || !t.trim());
        if (hasEmpty) {
          issue = "EMPTY_TRANSLATION";
        }

        if (!issue) {
          const sourceLang = params.source.toLowerCase();
          const targetLang = params.target.toLowerCase();

          // Question analysis (index 0)
          const originalQuestion = params.texts[0].trim();
          const translatedQuestion = translated[0]?.trim() ?? "";
          if (
            targetLang !== sourceLang &&
            translatedQuestion &&
            translatedQuestion.toLowerCase() !== originalQuestion.toLowerCase()
          ) {
            questionChanged = true;
          }

          // Answers analysis (indices 1..n): distinguish allowed vs disallowed unchanged
          allowedUnchangedAnswersIndices = [];
          disallowedUnchangedAnswersIndices = [];

          if (translated.length > 1) {
            const originalAnswers = params.texts.slice(1);
            const translatedAnswers = translated.slice(1);

            for (let i = 0; i < originalAnswers.length; i++) {
              const orig = (originalAnswers[i] ?? "").trim();
              const trans = (translatedAnswers[i] ?? "").trim();

              if (!orig || !trans) continue;

              if (orig === trans) {
                // Unchanged: allow only if likely proper noun/title; disallow if known translatable term
                if (isAnswerLikelyProperNoun(orig)) {
                  allowedUnchangedAnswersIndices.push(i + 1); // 1-based index in meta
                  answersAllowedUnchangedCount++;
                } else {
                  disallowedUnchangedAnswersIndices.push(i + 1);
                  if (isKnownTranslatableTerm(orig)) {
                    issue = "MIXED_LANGUAGE_DETECTED"; // answer should have been translated (e.g. Italy)
                  }
                }
              } else {
                answersChangedCount++;
              }
            }
          }

          // MIXED_LANGUAGE_DETECTED only when:
          // (a) question has English residual AND not a valid hybrid, OR (b) disallowedUnchangedAnswersIndices.length > 0 (already set above)
          // Do NOT set Mixed when: questionChanged && disallowedUnchangedAnswersIndices.length === 0 && answersAllowedUnchangedCount > 0
          if (!issue && targetLang === "de") {
            const questionHasResidual = containsEnglishResidualInQuestion(translated[0] ?? "");
            if (questionHasResidual) {
              const acceptHybrid =
                questionChanged &&
                disallowedUnchangedAnswersIndices.length === 0 &&
                answersAllowedUnchangedCount > 0;
              if (!acceptHybrid) {
                issue = "MIXED_LANGUAGE_DETECTED";
              }
            }
          }

          // Frage nahezu identisch zum Original (keine relevanten Änderungen) → Fehler
          if (!issue && targetLang !== sourceLang && !questionChanged) {
            issue = "QUESTION_NOT_TRANSLATED";
          }
        }
      }

      if (issue) {
        logDebug(`MIXED_LANGUAGE_DETECTED or invalid translation: issue=${issue}`);
        logDebug(`CACHE_INVALIDATED for key=${cacheKey} reason=${issue}`);
        logDebug("FULL_RETRANSLATE_TRIGGERED (returning original texts, no cache write).");

        // Bei Fehlern fällt der Worker auf die Originaltexte zurück,
        // damit niemals gemischte/teilweise Übersetzungen persistiert werden.
        const resp: TranslateBatchResponse = {
          translated: params.texts,
          meta: debugLoggingEnabled
            ? {
                build: DEBUG_BUILD,
                cacheHit,
                googleCalled,
                protectionApplied: lastProtectionApplied,
                issue,
                questionChanged,
                answersChangedCount,
                answersAllowedUnchangedCount,
                allowedUnchangedAnswersIndices,
                disallowedUnchangedAnswersIndices,
                postProcessed: lastPostProcessedApplied,
                postProcessRulesApplied: lastPostProcessRulesApplied,
              }
            : undefined,
        };
        return json(resp, { status: 200 });
      }

      if (env.TRANSLATION_CACHE) {
        const payload = {
          build: CACHE_VERSION,
          translated,
        };
        await env.TRANSLATION_CACHE.put(cacheKey, JSON.stringify(payload), {
          // 30 days
          expirationTtl: 60 * 60 * 24 * 30,
        });
      }

      const resp: TranslateBatchResponse = {
        translated,
        meta: debugLoggingEnabled
          ? {
              build: DEBUG_BUILD,
              cacheHit,
              googleCalled,
              protectionApplied: lastProtectionApplied,
              issue: null,
              questionChanged,
              answersChangedCount,
              answersAllowedUnchangedCount,
              allowedUnchangedAnswersIndices,
              disallowedUnchangedAnswersIndices,
              postProcessed: lastPostProcessedApplied,
              postProcessRulesApplied: lastPostProcessRulesApplied,
            }
          : undefined,
      };
      return json(resp, { status: 200 });
    } catch (e: any) {
      logDebug(`Translation failed: ${e?.message ?? String(e)}`);
      return serverError(e?.message ? String(e.message) : "Translation failed.");
    }
  },
};

