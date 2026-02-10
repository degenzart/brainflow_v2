import { getLanguagePack } from "./lang";
import { containsEnglishFragments, forceRewriteGermanQuestion, getForceProtectIndicesForProperNounMistranslation, getStumpfGermanRewrite } from "./lang/de";

export interface Env {
  GOOGLE_API_KEY: string;
  CLIENT_KEY?: string;
  TRANSLATION_CACHE?: KVNamespace;
  /** v3: project ID (e.g. my-project). If set with GOOGLE_V3_LOCATION and GOOGLE_SERVICE_ACCOUNT_JSON, v3 is used. */
  GOOGLE_V3_PROJECT_ID?: string;
  /** v3: region for translate + glossary (e.g. us-central1). Must match glossary location. */
  GOOGLE_V3_LOCATION?: string;
  /** v3: full JSON key of the service account (client_email + private_key). */
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  /** v3: optional glossary ID (e.g. brainflow-en-de-main). Must exist in GOOGLE_V3_LOCATION. */
  GOOGLE_V3_GLOSSARY?: string;
  /** Optional per-day request limit; empty/undefined = off. */
  TRANSLATE_DAILY_REQ_LIMIT?: string;
  /** Optional per-day character limit; empty/undefined = off. */
  TRANSLATE_DAILY_CHAR_LIMIT?: string;
  /** Optional engine override: "v3" | "v2" | unset = auto (v3 if configured). */
  TRANSLATE_ENGINE?: string;
}

const DEBUG_BUILD = "bf-dev-answers-v7.8";
const CACHE_VERSION = "bf-dev-answers-v7.8";

/** v7.3.2: meta.protectedIndices are GLOBAL indices (1..n-1). Never include 0 (question). */
function toGlobalProtectedIndices(answerRelativeIndices: number[]): number[] {
  return answerRelativeIndices.map((ai) => ai + 1).filter((i) => i >= 1);
}

/** NON-NEGOTIABLE: any output containing placeholders forces fallback_original. */
const PLACEHOLDER_PATTERN = /__BFPROT_|__PROTECT_|PROT_\d/;
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

/** v7.7: EN-fragment detector for DE questions. True if at least 2 common EN tokens found (case-insensitive). */
const EN_FRAGMENTS_IN_DE_QUESTION = [
  "the", "a", "an", "features", "feature", "character", "which", "season", "episode", "game", "band", "album", "recorded", "released",
];
function containsEnglishFragmentsInGermanQuestion(q: string): boolean {
  const t = (q ?? "").trim().toLowerCase();
  if (!t) return false;
  const words = t.split(/\s+/).map((w) => w.replace(/[^\w]/g, ""));
  let count = 0;
  for (const token of EN_FRAGMENTS_IN_DE_QUESTION) {
    if (words.some((w) => w === token)) count++;
    if (count >= 2) return true;
  }
  return false;
}

/**
 * v7.5: Rewrite question for retry to reduce gaming/pop-culture fallbacks.
 * Returns rewritten question or null if no rule matched. Case-insensitive. Only rewrites texts[0].
 */
function rewriteQuestionForRetry(q: string): string | null {
  let out = (q ?? "").trim();
  if (!out) return null;
  const original = out;
  // Gaming / media patterns (more specific first)
  out = out.replace(/^.+\s+features the character (.+?)\s*\??\s*$/i, (_, name) => "In which video game does " + (name as string).trim() + " appear?");
  if (out === original) out = out.replace(/which game has an open world/gi, "which video game has an open-world environment");
  if (out === original) out = out.replace(/which game features/gi, "which video game includes");
  if (out === original) out = out.replace(/which game has\b/gi, "which video game has");
  if (out === original) out = out.replace(/playable character/gi, "main character");
  if (out === original) out = out.replace(/boss fight/gi, "main enemy");
  if (out === original) out = out.replace(/side quest/gi, "optional mission");
  if (out === original) out = out.replace(/\bopen world\b/gi, "open-world game");
  if (out === original) out = out.replace(/season pass/gi, "downloadable content");
  if (out === original) out = out.replace(/\bDLC\b/gi, "downloadable content");
  if (out === original) out = out.replace(/\bfeatures\b/gi, "includes");
  if (out === original) out = out.replace(/appears in/gi, "is in");
  if (out === original) out = out.replace(/who features/gi, "who appears");
  out = out.replace(/\s+/g, " ").trim();
  if (!out.endsWith("?")) out = out + "?";
  return out !== original ? out : null;
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
    rewriteApplied?: boolean;
    /** Which engine handled the request. */
    engine?: "v2" | "v3";
    /** Env TRANSLATE_ENGINE value seen (or "auto"). For debugging. */
    engineRequested?: string;
    /** v3: whether glossary was requested for this call (en->de + glossary configured). */
    glossaryRequested?: boolean;
    /** v3: whether glossary translations were actually used by Google. */
    glossaryUsed?: boolean;
    /** Local EN→DE glossary fallback was applied for unchanged segments. */
    localGlossaryApplied?: boolean;
    /** Indices (0-based) where local glossary replacement was applied. */
    localGlossaryAppliedIndices?: number[];
    /** Optional per-day quota info when limits are configured. */
    quota?: {
      req: number;
      chars: number;
      limitReq: number | null;
      limitChars: number | null;
    };
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

/** Parse optional positive integer from env-style string; returns null when unset/invalid. */
function parseOptionalInt(raw: string | undefined): number | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
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
  const target = String((body?.target ?? body?.targetLang ?? '')).trim();
  if (!target || !isValidLang(target)) return { ok: false, error: "target must be 2-5 characters (e.g. 'es', 'de', 'pt')." };
  const sourceRaw = String((body?.source ?? body?.sourceLang ?? '')).trim().toLowerCase();
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
    const token = `__BFPROT_${tokenIndex++}__`;
    replacements.push({ token, original: match });
    return token;
  });
  protectedText = protectedText.replace(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b)/g, (match) => {
    if (match.split(/\s+/).length < 2) return match;
    const commonWords = /\b(The|A|An|Of|In|On|At|To|For|With|By)\b/i;
    if (commonWords.test(match) && match.split(/\s+/).length === 2) return match;
    const token = `__BFPROT_${tokenIndex++}__`;
    replacements.push({ token, original: match });
    return token;
  });
  const titleWord = "(?:[A-Z][a-z]+|[A-Z]{2,})";
  protectedText = protectedText.replace(
    new RegExp(`\\b(album|track|song|band|artist|title|film|movie|game)\\s+(${titleWord}(?:\\s+${titleWord})+)`, "gi"),
    (match: string, indicator: string, title: string) => {
      const token = `__BFPROT_${tokenIndex++}__`;
      replacements.push({ token, original: title });
      return indicator + " " + token;
    },
  );
  counter.value = tokenIndex;
  return { text: protectedText, replacements };
}

function restoreProtection(text: string, replacements: Array<{ token: string; original: string }>): string {
  let restored = text;
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (let i = replacements.length - 1; i >= 0; i--) {
    const { token, original } = replacements[i];
    restored = restored.replace(new RegExp(escapeRe(token), "g"), original);
    const legacyToken = token.replace("__BFPROT_", "__PROTECT_");
    if (legacyToken !== token) {
      restored = restored.replace(new RegExp(escapeRe(legacyToken), "g"), original);
    }
  }
  return restored;
}

/** Strip BFID suffix from end of text so glossary can match; suffix is re-appended after translation. */
function stripBFID(text: string): { clean: string; suffix: string } {
  const m = (text ?? "").match(/^(.+?)(\s*BFID:\d+)\s*$/);
  if (m) return { clean: m[1].trimEnd(), suffix: m[2] };
  return { clean: (text ?? "").trim(), suffix: "" };
}

/** Local EN→DE glossary fallback when Google returns unchanged; key = normalized EN, value = DE. */
const LOCAL_GLOSSARY_EN_DE: Record<string, string> = {
  "delivery driver": "Lieferfahrer",
  "taxi driver": "Taxifahrer",
  "square inches": "Quadratzoll",
  god: "Gott",
};

function normKey(s: string): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function applyLocalGlossaryFallbackOne(s: string): string | null {
  const key = normKey(s);
  return key ? (LOCAL_GLOSSARY_EN_DE[key] ?? null) : null;
}

// --- v3: Service Account JWT + Cloud Translation API v3 (glossary optional) ---
interface GoogleServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/i, "")
    .replace(/-----END PRIVATE KEY-----/i, "")
    .replace(/\s/g, "");
  const binary = atob(base64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

function b64UrlEncode(input: ArrayBuffer): string {
  const bytes = new Uint8Array(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signJwtRs256(
  payload: string,
  privateKeyPem: string
): Promise<string> {
  const header = JSON.stringify({ alg: "RS256", typ: "JWT" });
  const headerB64 = b64UrlEncode(new TextEncoder().encode(header).buffer);
  const payloadB64 = b64UrlEncode(new TextEncoder().encode(payload).buffer);
  const toSign = `${headerB64}.${payloadB64}`;

  const keyBuf = pemToArrayBuffer(privateKeyPem);
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBuf,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(toSign)
  );
  const sigB64 = b64UrlEncode(sig);
  return `${toSign}.${sigB64}`;
}

async function getGoogleAccessTokenFromServiceAccount(sa: GoogleServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/cloud-translation",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  });
  const jwt = await signJwtRs256(payload, sa.private_key);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Google OAuth error ${res.status}: ${text}`);
  const data = JSON.parse(text) as { access_token?: string };
  if (!data.access_token) throw new Error("Google OAuth: missing access_token");
  return data.access_token;
}

function envRequired(name: string, value: string | undefined): string {
  if (value == null || String(value).trim() === "") throw new Error(`Missing env: ${name}`);
  return value.trim();
}

async function translateWithGoogleV3(
  params: Required<TranslateBatchRequest>,
  env: Env,
  protectedFullTextIndices: number[]
): Promise<{
  translated: string[];
  protectionApplied: boolean;
  glossaryRequested: boolean;
  glossaryUsed: boolean;
  glossaryFallbackUsed?: boolean;
}> {
  const projectId = envRequired("GOOGLE_V3_PROJECT_ID", env.GOOGLE_V3_PROJECT_ID);
  const location = envRequired("GOOGLE_V3_LOCATION", env.GOOGLE_V3_LOCATION);
  const jsonRaw = envRequired("GOOGLE_SERVICE_ACCOUNT_JSON", env.GOOGLE_SERVICE_ACCOUNT_JSON);
  let sa: GoogleServiceAccount;
  try {
    sa = JSON.parse(jsonRaw) as GoogleServiceAccount;
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is invalid JSON");
  }
  if (!sa.client_email || !sa.private_key) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON must contain client_email and private_key");

  const debug95021 = params.texts.some((t) => String(t).includes("BFID:95021"));

  const counter = { value: 0 };
  const protectedSet = new Set(protectedFullTextIndices);
  const protectedTexts: string[] = [];
  const allReplacements: Array<Array<{ token: string; original: string }>> = [];
  const bfidSuffixes: string[] = [];
  let answerPlaceholderIndex = 0;

  for (let i = 0; i < params.texts.length; i++) {
    const raw = params.texts[i] ?? "";
    const { clean, suffix } = stripBFID(raw);
    bfidSuffixes.push(suffix);
    if (protectedSet.has(i)) {
      protectedTexts.push(`PROT_${answerPlaceholderIndex + 1}`);
      answerPlaceholderIndex++;
      allReplacements.push([]);
    } else {
      const result = applyProtection(clean, counter);
      protectedTexts.push(result.text);
      allReplacements.push(result.replacements);
    }
  }

  const accessToken = await getGoogleAccessTokenFromServiceAccount(sa);
  const url = `https://translate.googleapis.com/v3/projects/${projectId}/locations/${location}:translateText`;
  const sourceLanguageCode = String(params.source ?? "en").trim().toLowerCase();
  const targetLanguageCode = String(params.target ?? "").trim().toLowerCase();
  // Glossary name from env (GOOGLE_V3_GLOSSARY).
  const glossaryName = String(env.GOOGLE_V3_GLOSSARY ?? "").trim();

  const body: Record<string, unknown> = {
    contents: protectedTexts,
    mimeType: "text/plain",
    sourceLanguageCode,
    targetLanguageCode,
  };

  // Hard rule: for v3 EN→DE, always attach glossary when env is set. No heuristics; protection/validation run after the response.
  const glossaryRequested =
    glossaryName.length > 0 && sourceLanguageCode === "en" && targetLanguageCode === "de";
  if (glossaryRequested) {
    body.glossaryConfig = {
      glossary: `projects/${projectId}/locations/${location}/glossaries/${glossaryName}`,
    };
  }

  if (debug95021) {
    const engineRequested = (String(env.TRANSLATE_ENGINE ?? "").trim() || "auto").toLowerCase();
    console.log("BFID95021 v3 request", {
      sourceLanguageCode,
      targetLanguageCode,
      engineRequested,
      glossaryRequested,
      glossaryName: glossaryName || "(empty)",
      contents: body.contents,
    });
  }

  let res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  let text = await res.text();
  let glossaryFallbackUsed = false;
  if (
    !res.ok &&
    res.status === 404 &&
    glossaryRequested &&
    (text.includes("Glossary not found") || text.includes("Failed to initialize a glossary"))
  ) {
    console.warn("glossary missing -> fallback to free translate");
    glossaryFallbackUsed = true;
    const bodyWithoutGlossary: Record<string, unknown> = {
      contents: body.contents,
      mimeType: body.mimeType,
      sourceLanguageCode: body.sourceLanguageCode,
      targetLanguageCode: body.targetLanguageCode,
    };
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(bodyWithoutGlossary),
    });
    text = await res.text();
  }
  if (!res.ok) throw new Error(`Google Translate v3 error ${res.status}: ${text}`);
  let decoded: {
    translations?: Array<{ translatedText?: string }>;
    glossaryTranslations?: Array<{ translatedText?: string }>;
  };
  try {
    decoded = JSON.parse(text) as {
      translations?: Array<{ translatedText?: string }>;
      glossaryTranslations?: Array<{ translatedText?: string }>;
    };
  } catch {
    throw new Error("Google Translate v3 returned non-JSON response.");
  }

  if (debug95021) {
    console.log("BFID95021 v3 response", {
      keys: Object.keys(decoded || {}),
      translationsLen: decoded?.translations?.length ?? 0,
      glossaryTranslationsLen: decoded?.glossaryTranslations?.length ?? 0,
      firstTranslation: decoded?.translations?.[0]?.translatedText,
      firstGlossaryTranslation: decoded?.glossaryTranslations?.[0]?.translatedText,
    });
  }

  const baseTranslations = decoded?.translations;
  const glossaryTranslations = decoded?.glossaryTranslations;
  const glossaryUsed = Array.isArray(glossaryTranslations) && glossaryTranslations.length > 0;
  const chosen = glossaryUsed ? glossaryTranslations : baseTranslations;
  if (!Array.isArray(chosen)) throw new Error("Google Translate v3 response missing translations.");

  const out: string[] = chosen.map((t: { translatedText?: string }, idx: number) => {
    const translated = typeof t?.translatedText === "string" ? t.translatedText : "";
    return translated;
  });
  for (let i = 0; i < out.length; i++) {
    out[i] = restoreProtection(out[i], allReplacements[i] || []);
    out[i] = out[i] + (bfidSuffixes[i] ?? "");
  }
  for (const i of protectedFullTextIndices) {
    out[i] = (params.texts[i] ?? "").trim();
  }
  const protectionApplied = protectedFullTextIndices.length > 0 || allReplacements.some((r) => r.length > 0);
  return {
    translated: out,
    protectionApplied,
    glossaryRequested,
    glossaryUsed,
    ...(glossaryFallbackUsed ? { glossaryFallbackUsed: true } : {}),
  };
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
    return translated;
  });
  for (let i = 0; i < out.length; i++) {
    out[i] = restoreProtection(out[i], allReplacements[i] || []);
  }
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
    const protectedAnswerIndices: number[] = [];
    const protectedFullTextIndices: number[] = [];

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
    let rewriteApplied = false;
    let htmlEntitiesDetectedInOutput = false;

    const enginePref = String(env.TRANSLATE_ENGINE ?? "").trim().toLowerCase();
    const forceV3 = enginePref === "v3";
    const forceV2 = enginePref === "v2";
    const v3Configured =
      env.GOOGLE_V3_PROJECT_ID != null &&
      String(env.GOOGLE_V3_PROJECT_ID).trim() !== "" &&
      env.GOOGLE_V3_LOCATION != null &&
      String(env.GOOGLE_V3_LOCATION).trim() !== "" &&
      env.GOOGLE_SERVICE_ACCOUNT_JSON != null &&
      String(env.GOOGLE_SERVICE_ACCOUNT_JSON).trim() !== "";
    const useV3 = forceV3 || (!forceV2 && v3Configured);

    let engine: "v2" | "v3" | undefined;
    let glossaryRequested = false;
    let glossaryUsed = false;
    let glossaryFallbackUsed = false;

    async function runTranslate(protectedIndices: number[]): Promise<{
      translated: string[];
      protectionApplied: boolean;
      postProcessed: boolean;
      postProcessRulesApplied: string[];
      localGlossaryAppliedIndices: number[];
    }> {
      let rawTranslated: string[];
      let protectionApplied: boolean;
      let glossaryRequestedThisRun = false;
      if (useV3) {
        const result = await translateWithGoogleV3(
          { target: params.target, source: params.source ?? "en", texts: decodedTexts },
          env,
          protectedIndices
        );
        rawTranslated = result.translated;
        protectionApplied = result.protectionApplied;
        glossaryRequestedThisRun = result.glossaryRequested;
        engine = "v3";
        glossaryRequested = glossaryRequested || result.glossaryRequested;
        glossaryUsed = glossaryUsed || result.glossaryUsed;
        glossaryFallbackUsed = glossaryFallbackUsed || (result.glossaryFallbackUsed === true);
      } else {
        const result = await translateWithGoogleV2(
          { ...params, texts: decodedTexts },
          env.GOOGLE_API_KEY,
          protectedIndices,
        );
        rawTranslated = result.translated;
        protectionApplied = result.protectionApplied;
        engine = "v2";
      }
      const localAppliedIndices: number[] = [];
      const glossaryActive =
        useV3 &&
        glossaryRequestedThisRun &&
        (params.source ?? "en").trim().toLowerCase() === "en" &&
        params.target.trim().toLowerCase() === "de";
      if (glossaryActive) {
        for (let i = 0; i < rawTranslated.length; i++) {
          if (protectedIndices.includes(i)) continue;
          const origClean = stripBFID(decodedTexts[i] ?? "").clean;
          const transClean = stripBFID(rawTranslated[i] ?? "").clean;
          if (origClean !== transClean) continue;
          const localHit = applyLocalGlossaryFallbackOne(origClean);
          if (localHit != null) {
            rawTranslated[i] = localHit + stripBFID(decodedTexts[i] ?? "").suffix;
            localAppliedIndices.push(i);
          }
        }
      }
      let translated = [...rawTranslated];
      const postResult = pack.postProcessQuestion(translated[0] ?? "", question);
      translated[0] = postResult.text;
      const postProcessed = (rawTranslated[0] ?? "") !== postResult.text;
      const postProcessRulesApplied = postResult.rulesApplied;
      return { translated, protectionApplied, postProcessed, postProcessRulesApplied, localGlossaryAppliedIndices: localAppliedIndices };
    }

    /** v7.5: Run translate with custom texts (e.g. rewritten question). Only question may differ; answers unchanged. */
    async function runTranslateWithTexts(texts: string[], fullProtectedIndices: number[]): Promise<{
      translated: string[];
      protectionApplied: boolean;
      postProcessed: boolean;
      postProcessRulesApplied: string[];
      localGlossaryAppliedIndices: number[];
    }> {
      let rawTranslated: string[];
      let protectionApplied: boolean;
      let glossaryRequestedThisRun = false;
      if (useV3) {
        const result = await translateWithGoogleV3(
          { target: params.target, source: params.source ?? "en", texts },
          env,
          fullProtectedIndices
        );
        rawTranslated = result.translated;
        protectionApplied = result.protectionApplied;
        glossaryRequestedThisRun = result.glossaryRequested;
        engine = "v3";
        glossaryRequested = glossaryRequested || result.glossaryRequested;
        glossaryUsed = glossaryUsed || result.glossaryUsed;
        glossaryFallbackUsed = glossaryFallbackUsed || (result.glossaryFallbackUsed === true);
      } else {
        const result = await translateWithGoogleV2(
          { target: params.target, source: params.source, texts },
          env.GOOGLE_API_KEY,
          fullProtectedIndices,
        );
        rawTranslated = result.translated;
        protectionApplied = result.protectionApplied;
        engine = "v2";
      }
      const localAppliedIndices: number[] = [];
      const glossaryActive =
        useV3 &&
        glossaryRequestedThisRun &&
        (params.source ?? "en").trim().toLowerCase() === "en" &&
        params.target.trim().toLowerCase() === "de";
      if (glossaryActive) {
        for (let i = 0; i < rawTranslated.length; i++) {
          if (fullProtectedIndices.includes(i)) continue;
          const origClean = stripBFID(texts[i] ?? "").clean;
          const transClean = stripBFID(rawTranslated[i] ?? "").clean;
          if (origClean !== transClean) continue;
          const localHit = applyLocalGlossaryFallbackOne(origClean);
          if (localHit != null) {
            rawTranslated[i] = localHit + stripBFID(texts[i] ?? "").suffix;
            localAppliedIndices.push(i);
          }
        }
      }
      let translated = [...rawTranslated];
      const postResult = pack.postProcessQuestion(translated[0] ?? "", texts[0] ?? "");
      translated[0] = postResult.text;
      const postProcessed = (rawTranslated[0] ?? "") !== postResult.text;
      const postProcessRulesApplied = postResult.rulesApplied;
      return { translated, protectionApplied, postProcessed, postProcessRulesApplied, localGlossaryAppliedIndices: localAppliedIndices };
    }

    // Optional per-day quota (best-effort, cache-based).
    const charCount = decodedTexts.join("").length;
    const limitReq = parseOptionalInt(env.TRANSLATE_DAILY_REQ_LIMIT);
    const limitChars = parseOptionalInt(env.TRANSLATE_DAILY_CHAR_LIMIT);
    let quotaMeta: { req: number; chars: number; limitReq: number | null; limitChars: number | null } | undefined;

    if ((limitReq !== null || limitChars !== null) && "caches" in globalThis && typeof caches !== "undefined") {
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const quotaKey = new Request(`https://bf-quota.local/bf-quota-${today}`, { method: "GET" });
      let prevReq = 0;
      let prevChars = 0;
      try {
        const cached = await caches.default.match(quotaKey);
        if (cached) {
          const txt = await cached.text();
          try {
            const parsed = JSON.parse(txt) as { req?: number; chars?: number };
            if (typeof parsed.req === "number") prevReq = parsed.req;
            if (typeof parsed.chars === "number") prevChars = parsed.chars;
          } catch {
            // ignore parse errors, treat as zero
          }
        }
      } catch {
        // ignore cache errors; quota becomes best-effort
      }
      const nextReq = prevReq + 1;
      const nextChars = prevChars + charCount;
      const wouldExceedReq = limitReq !== null && nextReq > limitReq;
      const wouldExceedChars = limitChars !== null && nextChars > limitChars;
      quotaMeta = { req: nextReq, chars: nextChars, limitReq, limitChars };
      if (wouldExceedReq || wouldExceedChars) {
        return json(
          { error: "quota_exceeded", meta: { quota: quotaMeta } },
          { status: 429 },
        );
      }
      try {
        await caches.default.put(
          quotaKey,
          new Response(JSON.stringify({ req: nextReq, chars: nextChars }), {
            headers: { "content-type": "application/json" },
          }),
        );
      } catch {
        // ignore cache write errors
      }
    }

    try {
      googleCalled = true;
      let run = await runTranslate(protectedFullTextIndices);
      if (engine === "v3") {
        console.log(
          `ENGINE=v3 glossaryRequested=${glossaryRequested} glossaryUsed=${glossaryUsed} source=${sourceLang} target=${targetLang}`,
        );
      }
      let translated = run.translated;
      let protectionApplied = run.protectionApplied;
      let postProcessed = run.postProcessed;
      let postProcessRulesApplied = run.postProcessRulesApplied;

      // v7.6: If DE and translated question still has English fragments, retry by translating ONLY the question.
      if (pack.code === "de" && containsEnglishFragments(translated[0] ?? "")) {
        try {
          const singleQuestionRun = await runTranslateWithTexts([question], []);
          const post = pack.postProcessQuestion(singleQuestionRun.translated[0] ?? "", question);
          if (!containsEnglishFragments(post.text)) {
            translated = [post.text, ...translated.slice(1)];
            if (debugLoggingEnabled) logDebug("v7.6 single-question retry: English fragments removed");
          }
        } catch (e) {
          if (debugLoggingEnabled) logDebug(`v7.6 single-question retry failed: ${(e as Error)?.message ?? String(e)}`);
        }
      }

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
      let finalLocalGlossaryAppliedIndices = run.localGlossaryAppliedIndices ?? [];
      let finalValidationResult = validationResult;
      let finalProtectedIndices = [...protectedAnswerIndices];
      let retryReason: string | undefined;

      if (validationResult.level !== "bad" && pack.code === "de") {
        const forceProtect = getForceProtectIndicesForProperNounMistranslation(
          decodedTexts,
          translated,
          protectedAnswerIndices,
          glossaryUsed
        );
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
              finalLocalGlossaryAppliedIndices = retryRun.localGlossaryAppliedIndices ?? [];
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

      // v7.5: Question rewrite retry — only when fallback (not bad), no placeholder/html/protection failure, retry once.
      if (
        finalValidationResult.level === "fallback" &&
        !containsPlaceholder(finalTranslated) &&
        !htmlEntitiesDetectedInOutput
      ) {
        const rewritten = rewriteQuestionForRetry(question);
        if (rewritten !== null) {
          retryAttempted = true;
          retryReason = "rewrite_question";
          if (debugLoggingEnabled) logDebug(`v7.5 retry: rewrite_question ${JSON.stringify({ original: question, rewritten })}`);
          const rewrittenTexts = [rewritten, ...decodedTexts.slice(1)];
          try {
            const rewriteRun = await runTranslateWithTexts(rewrittenTexts, protectedFullTextIndices);
            if (!containsPlaceholder(rewriteRun.translated) && !hasHtmlEntitiesInOutput(rewriteRun.translated)) {
              const validationRewrite = pack.isBadTranslation(decodedTexts, rewriteRun.translated, protectedAnswerIndices);
              if (validationRewrite.level === "good") {
                finalTranslated = rewriteRun.translated;
                finalLocalGlossaryAppliedIndices = rewriteRun.localGlossaryAppliedIndices ?? [];
                finalValidationResult = validationRewrite;
                protectionApplied = rewriteRun.protectionApplied;
                postProcessed = rewriteRun.postProcessed;
                postProcessRulesApplied = rewriteRun.postProcessRulesApplied;
                rewriteApplied = true;
                if (debugLoggingEnabled) logDebug("v7.5 retry succeeded");
              } else {
                if (debugLoggingEnabled) logDebug("v7.5 retry failed → fallback");
              }
            } else {
              if (debugLoggingEnabled) logDebug("v7.5 retry failed → fallback");
            }
          } catch {
            if (debugLoggingEnabled) logDebug("v7.5 retry failed → fallback");
          }
        }
      }

      // When ONLY protection (no glossary) is active, do not treat too_many_unchanged_non_protected as bad (e.g. Curly terms).
      // If a glossary is active, too_many_unchanged_non_protected should remain BAD so that existing retry mechanics can trigger.
      const glossaryActive = glossaryRequested === true;
      if (protectionApplied && !glossaryActive) {
        const reasonsFiltered = finalValidationResult.reasons.filter((r) => r !== "too_many_unchanged_non_protected");
        const badReasonsSet = new Set([
          "length_mismatch",
          "fewer_than_two_answers",
          "empty_question",
          "all_answers_empty",
          "too_many_unchanged_non_protected",
          "all_answers_unchanged",
          "question_has_english_fragments",
        ]);
        const hasBad = reasonsFiltered.some((r) => badReasonsSet.has(r));
        const level = hasBad ? "bad" : reasonsFiltered.length > 0 ? "fallback" : "good";
        finalValidationResult = {
          ...finalValidationResult,
          reasons: reasonsFiltered,
          level,
        };
      }

      // v7.8: When glossary was requested and used, never allow unchanged (non-protected) — force glossary application.
      const answerStartIdx = 1;
      const protectedSetForGlossary = new Set(finalProtectedIndices);
      if (glossaryRequested && glossaryUsed) {
        const allowedSet = new Set(finalValidationResult.allowedUnchangedIndices);
        const disallowedSet = new Set(finalValidationResult.disallowedUnchangedIndices);
        for (let ai = 0; ai < decodedTexts.length - answerStartIdx; ai++) {
          if (protectedSetForGlossary.has(ai)) continue;
          const orig = (decodedTexts[answerStartIdx + ai] ?? "").trim();
          const trans = (finalTranslated[answerStartIdx + ai] ?? "").trim();
          if (orig === trans) {
            allowedSet.delete(ai);
            disallowedSet.add(ai);
          }
        }
        const newAllowed = [...allowedSet];
        const newDisallowed = [...disallowedSet];
        finalValidationResult = {
          ...finalValidationResult,
          allowedUnchangedIndices: newAllowed,
          disallowedUnchangedIndices: newDisallowed,
        };
        if (newDisallowed.length > 0) {
          finalValidationResult = {
            ...finalValidationResult,
            level: "bad",
            reasons: [...finalValidationResult.reasons, "glossary_unchanged_disallowed"],
          };
        }
      }

      // v7.8: One retry when glossary disallowed unchanged or too_many_unchanged_non_protected — re-translate (no rewrite), then re-apply glossary rule.
      const glossaryRetryReasons = ["glossary_unchanged_disallowed", "too_many_unchanged_non_protected"];
      const shouldGlossaryRetry =
        glossaryRequested &&
        glossaryUsed &&
        finalValidationResult.level === "bad" &&
        (finalValidationResult.disallowedUnchangedIndices.length > 0 ||
          glossaryRetryReasons.some((r) => finalValidationResult.reasons.includes(r)));
      if (shouldGlossaryRetry) {
        retryAttempted = true;
        const glossaryRetryFullIndices = finalProtectedIndices.map((ai) => ai + 1);
        try {
          const glossaryRetryRun = await runTranslate(glossaryRetryFullIndices);
          const retryTranslated = glossaryRetryRun.translated;
          if (!containsPlaceholder(retryTranslated)) {
            const validationRetry = pack.isBadTranslation(decodedTexts, retryTranslated, finalProtectedIndices);
            let retryAllowed = [...validationRetry.allowedUnchangedIndices];
            let retryDisallowed = [...validationRetry.disallowedUnchangedIndices];
            if (glossaryRequested && glossaryUsed) {
              const retryAllowedSet = new Set(retryAllowed);
              const retryDisallowedSet = new Set(retryDisallowed);
              for (let ai = 0; ai < decodedTexts.length - answerStartIdx; ai++) {
                if (protectedSetForGlossary.has(ai)) continue;
                const orig = (decodedTexts[answerStartIdx + ai] ?? "").trim();
                const trans = (retryTranslated[answerStartIdx + ai] ?? "").trim();
                if (orig === trans) {
                  retryAllowedSet.delete(ai);
                  retryDisallowedSet.add(ai);
                }
              }
              retryAllowed = [...retryAllowedSet];
              retryDisallowed = [...retryDisallowedSet];
            }
            if (retryDisallowed.length < finalValidationResult.disallowedUnchangedIndices.length) {
              finalTranslated = retryTranslated;
              finalLocalGlossaryAppliedIndices = glossaryRetryRun.localGlossaryAppliedIndices ?? [];
              finalValidationResult = {
                ...validationRetry,
                allowedUnchangedIndices: retryAllowed,
                disallowedUnchangedIndices: retryDisallowed,
                level: retryDisallowed.length > 0 ? "bad" : validationRetry.level,
                reasons:
                  retryDisallowed.length > 0
                    ? [...validationRetry.reasons, "glossary_unchanged_disallowed"]
                    : validationRetry.reasons,
              };
              if (debugLoggingEnabled) logDebug("v7.8 glossary retry: improved result");
            }
          }
        } catch (e) {
          if (debugLoggingEnabled) logDebug(`v7.8 glossary retry failed: ${(e as Error)?.message ?? String(e)}`);
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
        const glossaryRetryReasonsForMeta = ["glossary_unchanged_disallowed", "too_many_unchanged_non_protected"];
        const retryAttemptedForBad =
          retryAttempted ||
          glossaryRetryReasonsForMeta.some((r) => finalValidationResult.reasons.includes(r));
        // v7.6: When bad_result due to question_has_english_fragments, use stumpf German rewrite so we never return mixed question.
        let badTranslated = decodedTexts;
        if (finalValidationResult.reasons.includes("question_has_english_fragments")) {
          const stumpf = getStumpfGermanRewrite(question);
          if (stumpf !== null) {
            badTranslated = [stumpf, ...decodedTexts.slice(1)];
            if (debugLoggingEnabled) logDebug(`v7.6 stumpf rewrite applied: ${stumpf}`);
          }
        }
        return json(
          {
            translated: badTranslated,
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
              retryAttempted: retryAttemptedForBad,
              retryReason,
              rewriteApplied: false,
              protectedIndicesInitial: toGlobalProtectedIndices(protectedAnswerIndices),
              protectedIndicesFinal: toGlobalProtectedIndices(finalProtectedIndices),
              engineRequested: enginePref || "auto",
              localGlossaryApplied: (finalLocalGlossaryAppliedIndices?.length ?? 0) > 0,
              localGlossaryAppliedIndices: finalLocalGlossaryAppliedIndices ?? [],
            }),
          } satisfies TranslateBatchResponse,
          { status: 200 }
        );
      }

      let outputTranslated: string[];
      let fallbackUsed = false;
      let usedForcedRewrite = false;
      let forcedRewriteRule: string | undefined;
      let mixedLanguageDetectedForMeta = false;

      if (finalValidationResult.level === "fallback") {
        const transQuestion = finalTranslated[0] ?? "";
        const mixedFromValidation = finalValidationResult.reasons.includes("mixed_language_in_question");
        const mixedFromFragments = pack.code === "de" && containsEnglishFragmentsInGermanQuestion(transQuestion);
        const mixedLanguageDetected = mixedFromValidation || mixedFromFragments;
        mixedLanguageDetectedForMeta = mixedLanguageDetected;
        const retrySucceeded = rewriteApplied;
        const rewriteRetryFailed = retryAttempted && retryReason === "rewrite_question" && !retrySucceeded;
        const shouldForceRewrite = pack.code === "de" && (mixedLanguageDetected || rewriteRetryFailed);
        if (shouldForceRewrite) {
          const { text: forcedQuestion, rule } = forceRewriteGermanQuestion(question);
          const forcedOutput = [forcedQuestion, ...decodedTexts.slice(1)];
          if (!containsPlaceholder(forcedOutput)) {
            outputTranslated = forcedOutput;
            rewriteApplied = true;
            fallbackUsed = false;
            usedForcedRewrite = true;
            forcedRewriteRule = rule;
            mixedLanguageDetectedForMeta = false;
            if (debugLoggingEnabled) logDebug(`v7.7 forced rewrite: ${forcedQuestion}`);
          } else {
            outputTranslated = sanitize(decodedTexts, finalTranslated);
            if (containsPlaceholder(outputTranslated)) outputTranslated = decodedTexts;
            fallbackUsed = true;
          }
        } else {
          if (debugLoggingEnabled) logDebug("fallback triggered");
          outputTranslated = sanitize(decodedTexts, finalTranslated);
          if (containsPlaceholder(outputTranslated)) outputTranslated = decodedTexts;
          fallbackUsed = true;
          if (debugLoggingEnabled) logDebug("sanitize applied");
        }
      } else {
        outputTranslated = finalTranslated;
      }

      let didStore = false;
      const effectiveValidationLevel = usedForcedRewrite ? "good" : finalValidationResult.level;
      const effectiveFallbackUsed = usedForcedRewrite ? false : fallbackUsed || glossaryFallbackUsed;
      const effectivePostProcessRulesApplied = forcedRewriteRule
        ? [...postProcessRulesApplied, forcedRewriteRule]
        : postProcessRulesApplied;
      const shouldStore =
        !bypassCache && googleCalled && !!env.TRANSLATION_CACHE && finalValidationResult.level !== "bad" && !usedForcedRewrite;
      if (shouldStore && env.TRANSLATION_CACHE) {
        const storedMeta: TranslateBatchResponse["meta"] = {
          build: DEBUG_BUILD,
          outcome: "ok_translated",
          cacheHit: false,
          googleCalled: true,
          protectionApplied,
          postProcessed,
          postProcessRulesApplied: effectivePostProcessRulesApplied,
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
          validationLevel: effectiveValidationLevel,
          fallbackUsed: effectiveFallbackUsed,
          retryAttempted,
          retryReason,
          rewriteApplied,
          protectedIndicesInitial: toGlobalProtectedIndices(protectedAnswerIndices),
          protectedIndicesFinal: toGlobalProtectedIndices(finalProtectedIndices),
          engine,
          engineRequested: enginePref || "auto",
          glossaryRequested,
          glossaryUsed,
          localGlossaryApplied: (finalLocalGlossaryAppliedIndices?.length ?? 0) > 0,
          localGlossaryAppliedIndices: finalLocalGlossaryAppliedIndices ?? [],
          quota: quotaMeta,
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
          postProcessRulesApplied: effectivePostProcessRulesApplied,
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
          mixedLanguageDetected: mixedLanguageDetectedForMeta,
          validationLevel: effectiveValidationLevel,
          fallbackUsed: effectiveFallbackUsed,
          retryReason,
          rewriteApplied,
          protectedIndicesInitial: toGlobalProtectedIndices(protectedAnswerIndices),
          protectedIndicesFinal: toGlobalProtectedIndices(finalProtectedIndices),
          engine,
          engineRequested: enginePref || "auto",
          glossaryRequested,
          glossaryUsed,
          localGlossaryApplied: (finalLocalGlossaryAppliedIndices?.length ?? 0) > 0,
          localGlossaryAppliedIndices: finalLocalGlossaryAppliedIndices ?? [],
          quota: quotaMeta,
        }),
      };
      return json(resp, { status: 200 });
    } catch (e: any) {
      logDebug(`Translation failed: ${e?.message ?? String(e)}`);
      return serverError(e?.message ? String(e.message) : "Translation failed.");
    }
  },
};
