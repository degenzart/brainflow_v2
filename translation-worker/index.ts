export interface Env {
  GOOGLE_API_KEY: string;
  CLIENT_KEY?: string;
  TRANSLATION_CACHE?: KVNamespace;
}

type TranslateBatchRequest = {
  target: string;
  source?: string;
  texts: string[];
};

type TranslateBatchResponse = {
  translated: string[];
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

async function translateWithGoogleV2(params: Required<TranslateBatchRequest>, apiKey: string): Promise<string[]> {
  const url = new URL("https://translation.googleapis.com/language/translate/v2");
  url.searchParams.set("key", apiKey);

  const payload: Record<string, unknown> = {
    q: params.texts,
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

  const out: string[] = translations.map((t: any) => (typeof t?.translatedText === "string" ? t.translatedText : ""));
  if (out.length !== params.texts.length) {
    // Still return what we got, but it's suspicious.
    // Caller will validate length.
  }
  return out;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

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

    // Optional KV cache
    const cacheKeyInput = `${params.target}\n${params.texts.join("\n")}`;
    const cacheKey = await sha256Hex(cacheKeyInput);

    if (env.TRANSLATION_CACHE) {
      const cached = await env.TRANSLATION_CACHE.get(cacheKey);
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
            const resp: TranslateBatchResponse = { translated: parsed };
            return json(resp, { status: 200 });
          }
        } catch {
          // ignore cache corruption and continue
        }
      }
    }

    try {
      const translated = await translateWithGoogleV2(params, env.GOOGLE_API_KEY);
      if (!Array.isArray(translated) || translated.length !== params.texts.length) {
        return serverError("Google Translate returned unexpected result length.");
      }

      if (env.TRANSLATION_CACHE) {
        await env.TRANSLATION_CACHE.put(cacheKey, JSON.stringify(translated), {
          // 30 days
          expirationTtl: 60 * 60 * 24 * 30,
        });
      }

      const resp: TranslateBatchResponse = { translated };
      return json(resp, { status: 200 });
    } catch (e: any) {
      return serverError(e?.message ? String(e.message) : "Translation failed.");
    }
  },
};

