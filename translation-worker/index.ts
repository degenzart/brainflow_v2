import { getLanguagePack } from "./lang";

export interface Env {
  GOOGLE_API_KEY: string;
  CLIENT_KEY?: string;
  TRANSLATION_CACHE?: KVNamespace;
}

const DEBUG_BUILD = "bf-dev-answers-v7.2";
const CACHE_VERSION = "bf-dev-answers-v7.2";

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
  meta: {
    build: string;
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
  if (texts.length < 1 || texts.length > 20) return { ok: false, error: "texts must have 1..20 elements." };
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
    const question = params.texts[0] ?? "";
    const answers = params.texts.slice(1);
    const protectedAnswerIndices = pack.getProtectedAnswerIndices(answers);
    const protectedFullTextIndices = protectedAnswerIndices.map((ai) => ai + 1);

    if (debugLoggingEnabled && protectedAnswerIndices.length > 0) {
      logDebug(`protected indices (0-based answers): ${JSON.stringify(protectedAnswerIndices)}`);
    }

    const cacheKeyHash = await sha256Hex(params.texts.join("|"));
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
            parsed.translated.length === params.texts.length &&
            parsed.translated.every((x) => typeof x === "string")
          ) {
            cacheHit = true;
            logDebug(`CACHE_HIT: key=${cacheKey}`);
            let translated = parsed.translated as string[];
            let postProcessed = false;
            let postProcessRulesApplied: string[] = [];
            if (translated.length >= 1) {
              const post = pack.postProcessQuestion(translated[0] ?? "", question);
              translated = [post.text, ...translated.slice(1)];
              postProcessed = post.text !== (parsed.translated as string[])[0];
              postProcessRulesApplied = post.rulesApplied;
            }
            const resp: TranslateBatchResponse = {
              translated,
              meta: {
                build: DEBUG_BUILD,
                cacheHit: true,
                googleCalled: false,
                protectionApplied: parsed.meta?.protectionApplied ?? false,
                postProcessed,
                postProcessRulesApplied,
                issue: null,
                cacheStored: false,
                cacheStoreReason: "cache_hit",
                allowedUnchangedIndices: parsed.meta?.allowedUnchangedIndices,
                disallowedUnchangedIndices: parsed.meta?.disallowedUnchangedIndices,
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

    try {
      googleCalled = true;
      const { translated: rawTranslated, protectionApplied } = await translateWithGoogleV2(
        params,
        env.GOOGLE_API_KEY,
        protectedFullTextIndices,
      );

      let translated = [...rawTranslated];
      const postResult = pack.postProcessQuestion(translated[0] ?? "", question);
      translated[0] = postResult.text;
      const postProcessed = (rawTranslated[0] ?? "") !== postResult.text;
      const postProcessRulesApplied = postResult.rulesApplied;

      const badResult = pack.isBadTranslation(params.texts, translated, protectedAnswerIndices);

      if (badResult.bad) {
        logDebug(`bad_result reasons: ${JSON.stringify(badResult.reasons)}`);
        logDebug(`disallowed unchanged indices: ${JSON.stringify(badResult.disallowedUnchangedIndices)}`);
        logDebug(`cache skipped (bad_result)`);

        const resp: TranslateBatchResponse = {
          translated,
          meta: {
            build: DEBUG_BUILD,
            cacheHit,
            googleCalled,
            protectionApplied,
            postProcessed,
            postProcessRulesApplied,
            issue: "bad_result",
            cacheStored: false,
            cacheStoreReason: bypassCache ? "bypass" : "skipped_bad_result",
            allowedUnchangedIndices: badResult.allowedUnchangedIndices,
            disallowedUnchangedIndices: badResult.disallowedUnchangedIndices,
            badResultReasons: badResult.reasons,
          },
        };
        return json(resp, { status: 200 });
      }

      if (
        badResult.allowedUnchangedIndices.length > 0 &&
        badResult.disallowedUnchangedIndices.length === 0
      ) {
        logDebug("[v7.3] unchanged-only-protected → allowed");
      }

      let didStore = false;
      const shouldStore =
        !bypassCache && googleCalled && !!env.TRANSLATION_CACHE;
      if (shouldStore && env.TRANSLATION_CACHE) {
        await env.TRANSLATION_CACHE.put(
          cacheKey,
          JSON.stringify({
            build: CACHE_VERSION,
            translated,
            meta: {
              build: DEBUG_BUILD,
              cacheHit: false,
              googleCalled: true,
              protectionApplied,
              postProcessed,
              postProcessRulesApplied,
              issue: null,
              cacheStored: true,
              cacheStoreReason: "ok",
              allowedUnchangedIndices: badResult.allowedUnchangedIndices,
              disallowedUnchangedIndices: badResult.disallowedUnchangedIndices,
            },
          }),
          { expirationTtl: 60 * 60 * 24 * 30 },
        );
        didStore = true;
        logDebug(`cache stored: key=${cacheKey}`);
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
        translated,
        meta: {
          build: DEBUG_BUILD,
          cacheHit,
          googleCalled,
          protectionApplied,
          postProcessed,
          postProcessRulesApplied,
          issue: null,
          cacheStored: didStore,
          cacheStoreReason,
          allowedUnchangedIndices: badResult.allowedUnchangedIndices,
          disallowedUnchangedIndices: badResult.disallowedUnchangedIndices,
        },
      };
      return json(resp, { status: 200 });
    } catch (e: any) {
      logDebug(`Translation failed: ${e?.message ?? String(e)}`);
      return serverError(e?.message ? String(e.message) : "Translation failed.");
    }
  },
};
