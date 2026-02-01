import { getLanguagePack } from "./lang";
import { getForceProtectIndicesForProperNounMistranslation } from "./lang/de";

export interface Env {
  GOOGLE_API_KEY: string;
  CLIENT_KEY?: string;
  TRANSLATION_CACHE?: KVNamespace;
}

const DEBUG_BUILD = "bf-dev-answers-v7.4";
const CACHE_VERSION = "bf-dev-answers-v7.4";

/** v7.3.2: meta.protectedIndices are GLOBAL indices (1..n-1). Never include 0 (question). */
function toGlobalProtectedIndices(answerRelativeIndices: number[]): number[] {
  return answerRelativeIndices.map((ai) => ai + 1).filter((i) => i >= 1);
}

/** NON-NEGOTIABLE: any output containing placeholders forces fallback_original. */
const PLACEHOLDER_PATTERN = /PROTECT_|__PROTECT|PROT_\d/;
function containsPlaceholder(texts: string[]): boolean {
  return texts.some((t) => PLACEHOLDER_PATTERN.test(t ?? ""));
}

/** HTML entity pattern in output: &name; or &#NNN; or &#xHH; — indicates bad output. */
const HTML_ENTITY_IN_OUTPUT = /&(?:#\d+|#x[\da-fA-F]+|\w+);/;

/** Decode common OpenTDB HTML entities. Safe: numeric first, then named. */
function htmlDecode(text: string): string {
  if (typeof text !== "string" || !text.length) return text;
  let s = text;
  // Numeric: &#123; and &#x1F;
  s = s.replace(/&#(\d+);/g, (_, n) => {
    const code = parseInt(n, 10);
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : `&#${n};`;
  });
  s = s.replace(/&#x([\da-fA-F]+);/g, (_, hex) => {
    const code = parseInt(hex, 16);
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : `&#x${hex};`;
  });
  // Named (common OpenTDB + Latin)
  const named: Record<string, string> = {
    "&quot;": '"', "&apos;": "'", "&#39;": "'", "&amp;": "&", "&lt;": "<", "&gt;": ">",
    "&uuml;": "ü", "&Uuml;": "Ü", "&auml;": "ä", "&Auml;": "Ä", "&ouml;": "ö", "&Ouml;": "Ö",
    "&uacute;": "ú", "&eacute;": "é", "&iacute;": "í", "&oacute;": "ó", "&ntilde;": "ñ",
    "&nbsp;": " ", "&ldquo;": '"', "&rdquo;": '"', "&lsquo;": "'", "&rsquo;": "'",
  };
  for (const [ent, ch] of Object.entries(named)) s = s.split(ent).join(ch);
  return s;
}

/** True if any input contained entities we decoded. */
function wasHtmlDecoded(original: string[], decoded: string[]): boolean {
  if (original.length !== decoded.length) return false;
  return original.some((o, i) => o !== decoded[i]);
}

/** True if any string contains &...; pattern. */
function hasHtmlEntitiesInOutput(texts: string[]): boolean {
  return texts.some((t) => HTML_ENTITY_IN_OUTPUT.test(t ?? ""));
}

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

type Outcome = "ok_translated" | "fallback_original";

type TranslateBatchResponse = {
  translated: string[];
  meta: {
    build: string;
    outcome: Outcome;
    cacheHit: boolean;
    googleCalled: boolean;
    protectionApplied: boolean;
    postProcessed: boolean;
    postProcessRulesApplied: string[];
    issue: string | null;
    cacheStored: boolean;
    cacheStoreReason: "ok" | "skipped_bad_result" | "cache_hit" | "bypass";
    allowedUnchangedIndices?: number[];
    disallowedUnchangedIndices?: number[];
    badResultReasons?: string[];
    fallbackReason?: string;
    containsPlaceholder?: boolean;
    mixedLanguageDetected?: boolean;
    unchangedAnalysis?: { allowed: number; disallowed: number; ratio: number };
    protectedIndices?: number[];
    nonProtectedUnchangedIndices?: number[];
    unchangedNonProtectedRatio?: number;
    retryAttempted?: boolean;
    retrySucceeded?: boolean;
    htmlDecoded?: boolean;
    htmlEntitiesDetectedInOutput?: boolean;
    validationLevel?: "good" | "fallback" | "bad";
    fallbackUsed?: boolean;
    retryReason?: string;
    protectedIndicesInitial?: number[];
    protectedIndicesFinal?: number[];
  };
};

type ErrorResponse = { error: string };

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data, null, 2), { ...init, headers });
}

function badRequest(message: string): Response {
  return json({ error: message } satisfies ErrorResponse, { status: 400 });
}

function badRequestWithMeta(message: string): Response {
  return json(
    { error: message, meta: { issue: "bad_request" } },
    { status: 400 },
  );
}

function serverError(message: string): Response {
  return json({ error: message } satisfies ErrorResponse, { status: 500 });
}

function buildMetaBase(
  overrides: Partial<TranslateBatchResponse["meta"]> & { outcome: Outcome; issue: string | null; cacheStored: boolean; cacheStoreReason: TranslateBatchResponse["meta"]["cacheStoreReason"] }
): TranslateBatchResponse["meta"] {
  return {
    build: DEBUG_BUILD,
    outcome: overrides.outcome,
    cacheHit: overrides.cacheHit ?? false,
    googleCalled: overrides.googleCalled ?? false,
    protectionApplied: overrides.protectionApplied ?? false,
    postProcessed: overrides.postProcessed ?? false,
    postProcessRulesApplied: overrides.postProcessRulesApplied ?? [],
    issue: overrides.issue,
    cacheStored: overrides.cacheStored,
    cacheStoreReason: overrides.cacheStoreReason,
    ...overrides,
  };
}

function buildFallbackResponse(
  decodedTexts: string[],
  opts: {
    fallbackReason: string;
    containsPlaceholder: boolean;
    mixedLanguageDetected?: boolean;
    badResultReasons?: string[];
    unchangedAnalysis?: { allowed: number; disallowed: number; ratio: number };
    htmlDecoded?: boolean;
    retryAttempted?: boolean;
    retrySucceeded?: boolean;
  }
): Response {
  const meta = buildMetaBase({
    outcome: "fallback_original",
    issue: "fallback_original",
    cacheStored: false,
    cacheStoreReason: "skipped_bad_result",
    fallbackReason: opts.fallbackReason,
    containsPlaceholder: opts.containsPlaceholder,
    mixedLanguageDetected: opts.mixedLanguageDetected ?? false,
    badResultReasons: opts.badResultReasons,
    unchangedAnalysis: opts.unchangedAnalysis,
    htmlDecoded: opts.htmlDecoded,
    retryAttempted: opts.retryAttempted ?? false,
    retrySucceeded: opts.retrySucceeded ?? false,
    htmlEntitiesDetectedInOutput: false,
  });
  return json(
    { translated: decodedTexts, meta } satisfies TranslateBatchResponse,
    { status: 200 }
  );
}

/** v7.2 fallback: keep translated question, restore original answers — no mixed content. */
function sanitize(decodedTexts: string[], translated: string[]): string[] {
  const question = (translated[0] ?? "").trim() ? (translated[0] ?? "").trim() : (decodedTexts[0] ?? "").trim();
  const answers = decodedTexts.slice(1);
  return [question, ...answers];
}

const SOURCE_ALLOWLIST = new Set([
  "en", "de", "es", "fr", "it", "nl", "sv", "tr", "da", "fi", "no", "pl", "pt",
]);

function isValidLang(code: string): boolean {
  const c = code.trim().toLowerCase();
  return c.length >= 2 && c.length <= 5 && /^[a-z]{2}(-[a-z]{2})?$/.test(c);
}

function validateRequest(
  body: unknown,
): { ok: true; value: TranslateBatchRequest & { target: string; texts: string[] } } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Invalid JSON body." };
  const b = body as Record<string, unknown>;
  const targetRaw = typeof b.target === "string" ? b.target : "";
  const target = targetRaw.trim().toLowerCase();
  if (!target || !isValidLang(target)) return { ok: false, error: "target must be 2-5 characters (e.g. 'es', 'de', 'pt')." };
  const sourceRaw = typeof b.source === "string" ? b.source.trim().toLowerCase() : "";
  let source: string | undefined;
  if (sourceRaw && sourceRaw !== "auto") {
    if (!SOURCE_ALLOWLIST.has(sourceRaw)) {
      return { ok: false, error: "source must be 'auto' or one of: en, de, es, fr, it, nl, sv, tr, da, fi, no, pl, pt." };
    }
    source = sourceRaw;
  }
  if (!Array.isArray(b.texts)) return { ok: false, error: "texts must be an array." };
  const texts = b.texts;
  if (texts.length < 3 || texts.length > 20) return { ok: false, error: "texts must have at least 3 elements (question + 2 answers)." };
  const out: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    if (typeof t !== "string") return { ok: false, error: `texts[${i}] must be a string.` };
    if (t.length > 400) return { ok: false, error: `texts[${i}] exceeds 400 characters.` };
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

interface ProtectionResult {
  text: string;
  replacements: Array<{ token: string; original: string }>;
}

function applyProtection(text: string, counter: { value: number }): ProtectionResult {
  const replacements: Array<{ token: string; original: string }> = [];
  let protectedText = text;
  let tokenIndex = counter.value;
  protectedText = protectedText.replace(/"([^"]+)"/g, (match) => {
    const token = `__PROTECT_${tokenIndex++}__`;
    replacements.push({ token, original: match });
    return token;
  });
  protectedText = protectedText.replace(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b)/g, (match) => {
    if (match.split(/\s+/).length < 2) return match;
    const commonWords = /\b(The|A|An|Of|In|On|At|To|For|With|By)\b/i;
    if (commonWords.test(match) && match.split(/\s+/).length === 2) return match;
    const token = `__PROTECT_${tokenIndex++}__`;
    replacements.push({ token, original: match });
    return token;
  });
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
  return { text: protectedText, replacements };
}

function restoreProtection(text: string, replacements: Array<{ token: string; original: string }>): string {
  let restored = text;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const { token, original } = replacements[i];
    restored = restored.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), original);
  }
  return restored;
}

async function translateWithGoogleV2(
  params: Required<TranslateBatchRequest>,
  apiKey: string,
  protectedFullTextIndices: number[]
): Promise<{ translated: string[]; protectionApplied: boolean }> {
  const counter = { value: 0 };
  const protectedSet = new Set(protectedFullTextIndices);
  const protectedTexts: string[] = [];
  const allReplacements: Array<Array<{ token: string; original: string }>> = [];
  let answerPlaceholderIndex = 0;

  for (let i = 0; i < params.texts.length; i++) {
    const text = params.texts[i];
    if (protectedSet.has(i)) {
      const token = `PROT_${answerPlaceholderIndex + 1}`;
      answerPlaceholderIndex++;
      protectedTexts.push(token);
      allReplacements.push([]);
    } else {
      const result = applyProtection(text, counter);
      protectedTexts.push(result.text);
      allReplacements.push(result.replacements);
    }
  }

  const url = new URL("https://translation.googleapis.com/language/translate/v2");
  url.searchParams.set("key", apiKey);
  const payload: Record<string, unknown> = {
    q: protectedTexts,
    target: params.target,
    format: "text",
  };
  if (params.source != null && params.source !== "auto") {
    payload.source = params.source;
  }
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Google Translate error ${res.status}: ${text}`);
  let decoded: any;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new Error("Google Translate returned non-JSON response.");
  }
  const translations = decoded?.data?.translations;
  if (!Array.isArray(translations)) throw new Error("Google Translate response missing data.translations.");

  const out: string[] = translations.map((t: any, idx: number) => {
    const translated = typeof t?.translatedText === "string" ? t.translatedText : "";
    return restoreProtection(translated, allReplacements[idx] || []);
  });
  for (const i of protectedFullTextIndices) {
    out[i] = (params.texts[i] ?? "").trim();
  }
  const protectionApplied = protectedFullTextIndices.length > 0 || allReplacements.some((r) => r.length > 0);
  return { translated: out, protectionApplied };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    debugLoggingEnabled = request.headers.get("x-debug") === "1";

    if (request.method === "OPTIONS") return new Response(null, { status: 204 });
    if (request.method !== "POST" || url.pathname !== "/translateBatch") {
      return json({ error: "Not found." } satisfies ErrorResponse, { status: 404 });
    }

    if (env.CLIENT_KEY && env.CLIENT_KEY.trim().length > 0) {
      const provided = request.headers.get("X-Client-Key") ?? "";
      if (provided !== env.CLIENT_KEY) return json({ error: "Unauthorized." } satisfies ErrorResponse, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return badRequest("Invalid JSON.");
    }

    const validated = validateRequest(body);
    if (!validated.ok) return badRequestWithMeta(validated.error);
    const params = validated.value;

    if (!env.GOOGLE_API_KEY || env.GOOGLE_API_KEY.trim().length === 0) {
      return serverError("Missing GOOGLE_API_KEY secret.");
    }

    const targetLang = params.target.trim().toLowerCase();
    const sourceLang = (params.source || "auto").trim().toLowerCase();
    const pack = getLanguagePack(params.target);
    const decodedTexts = params.texts.map(htmlDecode);
    const htmlDecoded = wasHtmlDecoded(params.texts, decodedTexts);
    if (debugLoggingEnabled && htmlDecoded) logDebug("html entities found in input, decoded");
    const question = decodedTexts[0] ?? "";
    const answers = decodedTexts.slice(1);
    // Protection applies ONLY to answers (indices 1..n-1). Never to question (index 0).
    const protectedAnswerIndices = pack.getProtectedAnswerIndices(answers);
    const protectedFullTextIndices = protectedAnswerIndices.map((ai) => ai + 1).filter((i) => i >= 1);

    if (debugLoggingEnabled && protectedAnswerIndices.length > 0) {
      logDebug(`protected indices (global, never 0): ${JSON.stringify(toGlobalProtectedIndices(protectedAnswerIndices))}`);
    }

    const cacheKeyHash = await sha256Hex(decodedTexts.join("|"));
    const cacheKey = `${CACHE_VERSION}|${params.target}|${params.source ?? "auto"}|${cacheKeyHash}`;
    const bypassCache = request.headers.get("x-bypass-cache") === "1";
    let cacheHit = false;
    let googleCalled = false;

    if (!bypassCache && env.TRANSLATION_CACHE) {
      const cached = await env.TRANSLATION_CACHE.get(cacheKey);
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as {
            build?: string;
            translated?: string[];
            meta?: TranslateBatchResponse["meta"];
          };
          if (
            parsed &&
            typeof parsed === "object" &&
            parsed.build === CACHE_VERSION &&
            Array.isArray(parsed.translated) &&
            parsed.translated.length === decodedTexts.length &&
            parsed.translated.every((x) => typeof x === "string") &&
            parsed.meta &&
            typeof parsed.meta === "object"
          ) {
            cacheHit = true;
            const storedMeta = parsed.meta as TranslateBatchResponse["meta"];
            const rulesCount = Array.isArray(storedMeta.postProcessRulesApplied) ? storedMeta.postProcessRulesApplied.length : 0;
            logDebug(`CACHE_HIT key=${cacheKey} postProcessed=${!!storedMeta.postProcessed} rulesCount=${rulesCount}`);
            const translated = parsed.translated as string[];
            if (containsPlaceholder(translated)) {
              if (debugLoggingEnabled) logDebug("cache hit: placeholder in output → fallback_original");
              return buildFallbackResponse(decodedTexts, {
                fallbackReason: "placeholder_leak",
                containsPlaceholder: true,
                htmlDecoded,
              });
            }
            const noQuestion = (arr: number[] | undefined) => (arr ?? []).filter((i) => i >= 1);
            const resp: TranslateBatchResponse = {
              translated,
              meta: {
                ...storedMeta,
                build: DEBUG_BUILD,
                cacheHit: true,
                googleCalled: false,
                cacheStored: false,
                cacheStoreReason: "cache_hit",
                protectedIndices: noQuestion(storedMeta.protectedIndices),
                protectedIndicesInitial: noQuestion(storedMeta.protectedIndicesInitial),
                protectedIndicesFinal: noQuestion(storedMeta.protectedIndicesFinal),
              },
            };
            return json(resp, { status: 200 });
          }
          logDebug("CACHE_INVALIDATED: version mismatch or invalid payload structure.");
        } catch (err) {
          logDebug(`CACHE_INVALIDATED: failed to parse cache entry: ${String(err)}`);
        }
      } else {
        logDebug(`CACHE_MISS: key=${cacheKey}`);
      }
    }

    let retryAttempted = false;
    let retrySucceeded = false;
    let htmlEntitiesDetectedInOutput = false;

    async function runTranslate(protectedIndices: number[]): Promise<{
      translated: string[];
      protectionApplied: boolean;
      postProcessed: boolean;
      postProcessRulesApplied: string[];
    }> {
      const { translated: rawTranslated, protectionApplied } = await translateWithGoogleV2(
        { ...params, texts: decodedTexts },
        env.GOOGLE_API_KEY,
        protectedIndices,
      );
      let translated = [...rawTranslated];
      const postResult = pack.postProcessQuestion(translated[0] ?? "", question);
      translated[0] = postResult.text;
      const postProcessed = (rawTranslated[0] ?? "") !== postResult.text;
      const postProcessRulesApplied = postResult.rulesApplied;
      return { translated, protectionApplied, postProcessed, postProcessRulesApplied };
    }

    try {
      googleCalled = true;
      let run = await runTranslate(protectedFullTextIndices);
      let translated = run.translated;
      let protectionApplied = run.protectionApplied;
      let postProcessed = run.postProcessed;
      let postProcessRulesApplied = run.postProcessRulesApplied;

      let validationResult = pack.isBadTranslation(decodedTexts, translated, protectedAnswerIndices);
      if (hasHtmlEntitiesInOutput(translated)) {
        htmlEntitiesDetectedInOutput = true;
        if (debugLoggingEnabled) logDebug("html entities detected in output");
        validationResult = {
          ...validationResult,
          level: validationResult.level === "bad" ? "bad" : "fallback",
          reasons: [...validationResult.reasons, "html_entities_in_output"],
        };
      }
      if (containsPlaceholder(translated)) {
        if (debugLoggingEnabled) logDebug("placeholder in output → BAD");
        validationResult = {
          ...validationResult,
          level: "bad",
          reasons: [...validationResult.reasons, "placeholder_in_output"],
        };
      }

      let finalTranslated = translated;
      let finalValidationResult = validationResult;
      let finalProtectedIndices = [...protectedAnswerIndices];
      let retryReason: string | undefined;

      if (validationResult.level !== "bad" && pack.code === "de") {
        const forceProtect = getForceProtectIndicesForProperNounMistranslation(decodedTexts, translated, protectedAnswerIndices);
        if (forceProtect.length > 0 && debugLoggingEnabled) {
          logDebug(`v7.3.1 retry: proper_noun_translated, forceProtect=${JSON.stringify(forceProtect)}`);
        }
        if (forceProtect.length > 0) {
          retryAttempted = true;
          retryReason = "proper_noun_translated";
          const newProtected = [...new Set([...protectedAnswerIndices, ...forceProtect])];
          const retryFullIndices = newProtected.map((ai) => ai + 1).filter((i) => i >= 1);
          const retryRun = await runTranslate(retryFullIndices);
          const translatedRetry = retryRun.translated;
          if (!containsPlaceholder(translatedRetry)) {
            const validationResultRetry = pack.isBadTranslation(decodedTexts, translatedRetry, newProtected);
            if (validationResultRetry.level !== "bad") {
              finalTranslated = translatedRetry;
              finalValidationResult = validationResultRetry;
              finalProtectedIndices = newProtected;
              protectionApplied = retryRun.protectionApplied;
              postProcessed = retryRun.postProcessed;
              postProcessRulesApplied = retryRun.postProcessRulesApplied;
              if (debugLoggingEnabled) logDebug("v7.3.1 retry succeeded");
            }
          }
        }
      }

      const numAnswers = Math.max(1, decodedTexts.length - 1);
      const allowed = finalValidationResult.allowedUnchangedIndices.length;
      const disallowed = finalValidationResult.disallowedUnchangedIndices.length;
      const unchangedAnalysis = numAnswers > 0 ? { allowed, disallowed, ratio: (allowed + disallowed) / numAnswers } : undefined;
      const protectedSet = new Set(finalProtectedIndices);
      const allUnchangedIndices = [...new Set([...finalValidationResult.allowedUnchangedIndices, ...finalValidationResult.disallowedUnchangedIndices])];
      const nonProtectedUnchangedIndices = allUnchangedIndices.filter((i) => !protectedSet.has(i));
      const unchangedNonProtectedRatio = numAnswers > 0 ? nonProtectedUnchangedIndices.length / numAnswers : 0;

      if (finalValidationResult.level === "bad") {
        logDebug(`validation BAD: ${JSON.stringify(finalValidationResult.reasons)}`);
        logDebug("cache skipped (BAD)");
        return json(
          {
            translated: decodedTexts,
            meta: buildMetaBase({
              outcome: "fallback_original",
              issue: "bad_result",
              cacheStored: false,
              cacheStoreReason: "skipped_bad_result",
              cacheHit,
              googleCalled,
              protectionApplied,
              postProcessed,
              postProcessRulesApplied,
              validationLevel: "bad",
              fallbackUsed: false,
              badResultReasons: finalValidationResult.reasons,
              fallbackReason: finalValidationResult.reasons[0],
              unchangedAnalysis,
              protectedIndices: toGlobalProtectedIndices(finalProtectedIndices),
              nonProtectedUnchangedIndices: nonProtectedUnchangedIndices.map((ai) => ai + 1),
              unchangedNonProtectedRatio,
              htmlDecoded,
              containsPlaceholder: containsPlaceholder(finalTranslated),
              mixedLanguageDetected: finalValidationResult.reasons.includes("mixed_language_in_question"),
              retryAttempted,
              retryReason,
              protectedIndicesInitial: toGlobalProtectedIndices(protectedAnswerIndices),
              protectedIndicesFinal: toGlobalProtectedIndices(finalProtectedIndices),
            }),
          } satisfies TranslateBatchResponse,
          { status: 200 }
        );
      }

      let outputTranslated: string[];
      let fallbackUsed = false;

      if (finalValidationResult.level === "fallback") {
        if (debugLoggingEnabled) logDebug("fallback triggered");
        outputTranslated = sanitize(decodedTexts, finalTranslated);
        if (containsPlaceholder(outputTranslated)) {
          outputTranslated = decodedTexts;
        }
        fallbackUsed = true;
        if (debugLoggingEnabled) logDebug("sanitize applied");
        if (debugLoggingEnabled) logDebug("diversity restored");
      } else {
        outputTranslated = finalTranslated;
      }

      let didStore = false;
      const shouldStore =
        !bypassCache && googleCalled && !!env.TRANSLATION_CACHE && finalValidationResult.level !== "bad";
      if (shouldStore && env.TRANSLATION_CACHE) {
        const storedMeta: TranslateBatchResponse["meta"] = {
          build: DEBUG_BUILD,
          outcome: "ok_translated",
          cacheHit: false,
          googleCalled: true,
          protectionApplied,
          postProcessed,
          postProcessRulesApplied,
          issue: null,
          cacheStored: true,
          cacheStoreReason: "ok",
          allowedUnchangedIndices: finalValidationResult.allowedUnchangedIndices,
          disallowedUnchangedIndices: finalValidationResult.disallowedUnchangedIndices,
          unchangedAnalysis,
          protectedIndices: toGlobalProtectedIndices(finalProtectedIndices),
          nonProtectedUnchangedIndices: nonProtectedUnchangedIndices.map((ai) => ai + 1),
          unchangedNonProtectedRatio,
          htmlDecoded,
          validationLevel: finalValidationResult.level,
          fallbackUsed,
          retryAttempted,
          retryReason,
          protectedIndicesInitial: toGlobalProtectedIndices(protectedAnswerIndices),
          protectedIndicesFinal: toGlobalProtectedIndices(finalProtectedIndices),
        };
        const cachePayload = {
          build: CACHE_VERSION,
          translated: outputTranslated,
          meta: storedMeta,
        };
        await env.TRANSLATION_CACHE.put(
          cacheKey,
          JSON.stringify(cachePayload),
          { expirationTtl: 60 * 60 * 24 * 30 },
        );
        didStore = true;
        logDebug(`cache stored key=${cacheKey} postProcessed=${storedMeta.postProcessed} issue=${storedMeta.issue ?? "null"}`);
      }

      if (typeof didStore !== "boolean") {
        logDebug("cacheStored not boolean, forcing false");
        didStore = false;
      }
      const cacheStoreReason: TranslateBatchResponse["meta"]["cacheStoreReason"] = bypassCache
        ? "bypass"
        : didStore
          ? "ok"
          : "skipped_bad_result";

      const resp: TranslateBatchResponse = {
        translated: outputTranslated,
        meta: buildMetaBase({
          outcome: "ok_translated",
          issue: null,
          cacheStored: didStore,
          cacheStoreReason,
          cacheHit,
          googleCalled,
          protectionApplied,
          postProcessed,
          postProcessRulesApplied,
          allowedUnchangedIndices: finalValidationResult.allowedUnchangedIndices,
          disallowedUnchangedIndices: finalValidationResult.disallowedUnchangedIndices,
          unchangedAnalysis,
          protectedIndices: toGlobalProtectedIndices(finalProtectedIndices),
          nonProtectedUnchangedIndices: nonProtectedUnchangedIndices.map((ai) => ai + 1),
          unchangedNonProtectedRatio,
          retryAttempted,
          retrySucceeded: retryAttempted && finalProtectedIndices.length > protectedAnswerIndices.length,
          htmlDecoded,
          htmlEntitiesDetectedInOutput,
          containsPlaceholder: false,
          mixedLanguageDetected: false,
          validationLevel: finalValidationResult.level,
          fallbackUsed,
          retryReason,
          protectedIndicesInitial: toGlobalProtectedIndices(protectedAnswerIndices),
          protectedIndicesFinal: toGlobalProtectedIndices(finalProtectedIndices),
        }),
      };
      return json(resp, { status: 200 });
    } catch (e: any) {
      logDebug(`Translation failed: ${e?.message ?? String(e)}`);
      return serverError(e?.message ? String(e.message) : "Translation failed.");
    }
  },
};
