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
  mode?:
    | "full"
    | "skip"
    | "mixed"
    | "mixed_city"
    | "mixed_country"
    | "mixed_studio"
    | "mixed_company"
    | "mixed_keep_answers"
    | "mixed_answers";
  rule?: string;
  build?: string;
  unitFixApplied?: boolean;
  unitFixHits?: number;
  unitFixMode?: "mi_to_km" | "km_to_mi" | "none";
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

function wantsDebug(request: Request): boolean {
  const v = request.headers.get("x-debug") ?? request.headers.get("X-Debug") ?? "";
  return v.trim() === "1";
}

function primaryLang(code: string): string {
  return code.trim().toLowerCase().replace(/_/g, "-").split("-")[0];
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

// --- Protect tokens (Acronyms / Names) ---
//
// MVP protection:
// - Dotted acronyms: T.A.R.D.I.S.  (pattern like ([A-Z].){2,})
// - Block acronyms: NASA, FBI, DNA (pattern like \b[A-Z]{2,}\b)
// - Simple name sequences: "Albert Einstein", "New York" (2+ Capitalized words)
//
// Approach: replace protected spans with stable placeholders before Google Translate,
// then restore placeholders in the translated output.
type ProtectedResult = {
  text: string;
  replacements: Map<string, string>;
};

function makePlaceholder(i: number): string {
  // Intentionally "ugly" & stable; should not be translated.
  return `__BF_KEEP_${i}__`;
}

function getProtectedRanges(input: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];

  // Dotted acronyms: T.A.R.D.I.S. / U.S.A.
  const dotted = /(?:\b[A-Z]\.){2,}[A-Z]?\.?/g;
  for (const m of input.matchAll(dotted)) {
    if (m.index == null) continue;
    ranges.push({ start: m.index, end: m.index + m[0].length });
  }

  // Block acronyms: NASA / FBI / DNA
  const block = /\b[A-Z]{2,}\b/g;
  for (const m of input.matchAll(block)) {
    if (m.index == null) continue;
    ranges.push({ start: m.index, end: m.index + m[0].length });
  }

  // Name / proper noun sequences: 2+ capitalized words, optionally allowing small connector words.
  //
  // Examples we want to keep as a single protected unit:
  // - Ostrava of Boletaria
  // - Mordecai the Hunter
  // - Welcome to Miami
  // - The Next Generation
  //
  // Keep it conservative: requires at least two capitalized words overall.
  const names =
    /\b\p{Lu}[\p{L}]+(?:[-'][\p{Lu}][\p{L}]+)?(?:\s+(?:(?:of|the|to|von|van|de|del|da|di|la|le|du)\s+)?\p{Lu}[\p{L}]+(?:[-'][\p{Lu}][\p{L}]+)?)+\b/gu;
  for (const m of input.matchAll(names)) {
    if (m.index == null) continue;
    ranges.push({ start: m.index, end: m.index + m[0].length });
  }

  if (ranges.length <= 1) return ranges;

  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [];
  let cur = ranges[0];
  for (let i = 1; i < ranges.length; i++) {
    const r = ranges[i];
    if (r.start <= cur.end) {
      cur = { start: cur.start, end: Math.max(cur.end, r.end) };
    } else {
      merged.push(cur);
      cur = r;
    }
  }
  merged.push(cur);
  return merged;
}

function applyProtection(input: string, counter: { value: number }): ProtectedResult {
  const ranges = getProtectedRanges(input);
  if (ranges.length === 0) return { text: input, replacements: new Map() };

  const replacements = new Map<string, string>();
  let out = "";
  let last = 0;
  for (const r of ranges) {
    out += input.slice(last, r.start);
    const original = input.slice(r.start, r.end);
    const placeholder = makePlaceholder(counter.value++);
    replacements.set(placeholder, original);
    out += placeholder;
    last = r.end;
  }
  out += input.slice(last);
  return { text: out, replacements };
}

function restoreProtection(translated: string, replacements: Map<string, string>): string {
  let out = translated;
  for (const [ph, original] of replacements.entries()) {
    out = out.split(ph).join(original);
  }
  return out;
}

function hasAnyAcronym(text: string): boolean {
  const dotted = /(?:\b[A-Z]\.){2,}[A-Z]?\.?/;
  const block = /\b[A-Z]{2,}\b/;
  return dotted.test(text) || block.test(text);
}

// --- "What does ... stand for?" / "Wofür steht ...?" special case ---
function isStandForQuestion(text: string): boolean {
  const t = text.toLowerCase();
  const en = t.includes("what does") && t.includes("stand for");
  const de = t.includes("wofür steht") || t.includes("wofur steht"); // tolerate missing umlaut
  return en || de;
}

function extractFirstAcronym(text: string): string | null {
  const dotted = text.match(/(?:\b[A-Z]\.){2,}[A-Z]?\.?/);
  if (dotted && dotted[0]) return dotted[0];
  const block = text.match(/\b[A-Z]{2,}\b/);
  if (block && block[0]) return block[0];
  return null;
}

function buildCanonicalStandForQuestion(acronym: string, lang: string): string {
  const l = lang.split("_")[0].toLowerCase().trim();
  if (l === "de") return `Wofür steht ${acronym}?`;
  if (l === "en") return `What does ${acronym} stand for?`;
  // Fallback: keep English canonical template (will be translated in worker via a tiny call)
  return `What does ${acronym} stand for?`;
}

function stripToTranslatableSignal(text: string): string {
  // Remove placeholders, whitespace, punctuation; keep letters/digits only.
  return text
    .replace(/__BF_KEEP_\d+__/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

function isWhichOfTheFollowingProperNounQuestion(q: string): boolean {
  const t = q.toLowerCase().trim().replace(/\s+/g, " ");
  if (!t) return false;
  const lead = t.includes("which of the following") || t.includes("which of these");
  if (!lead) return false;

  const keywords = [
    "character",
    "title",
    "album",
    "song",
    "track",
    "studio",
    "company",
    "country",
    "city",
    "name",
    "video game",
    "game",
    "rapper",
    "band",
    "artist",
  ];
  return keywords.some((k) => t.includes(k));
}

// Mixed-mode (question only) for character/name MC questions.
// Keep answers unchanged to protect proper nouns.
//
// Tests (curl against wrangler dev):
// - Destiny character (answers must remain identical):
// curl -sS -X POST http://localhost:8787/translateBatch -H 'Content-Type: application/json' -H 'x-debug: 1' --data '{"target":"de","source":"en","texts":["Which of the following characters is from the video game Destiny?","Cayde-6","Geralt of Rivia","Master Chief","Lara Croft"]}'
// Expect: mode=mixed_answers, answers unchanged
//
// - Proper noun phrases should stay intact under full-translate (placeholder protection):
// curl -sS -X POST http://localhost:8787/translateBatch -H 'Content-Type: application/json' -H 'x-debug: 1' --data '{"target":"de","source":"en","texts":["Ostrava of Boletaria is a character from which game?","Demon\'s Souls","Dark Souls","Bloodborne"]}'
// curl -sS -X POST http://localhost:8787/translateBatch -H 'Content-Type: application/json' -H 'x-debug: 1' --data '{"target":"de","source":"en","texts":["Mordecai the Hunter is a character from which game?","Borderlands","Destiny","Halo"]}'
function isCharacterAnswersPassthroughQuestion(q: string): boolean {
  const qRaw = q ?? "";
  const t = qRaw.toLowerCase().trim().replace(/\s+/g, " ");
  if (!t) return false;

  // Trigger (robust, not too broad):
  // - contains "which of the following"
  // - contains "character" or "characters"
  // - contains "from" OR "video game" OR "game"
  const lead = t.includes("which of the following");
  if (!lead) return false;

  const hasCharacter = t.includes("character") || t.includes("characters");
  if (!hasCharacter) return false;

  const hasFromOrGame = t.includes("from") || t.includes("video game") || t.includes("game");
  return hasFromOrGame;
}

function usesImperial(targetLang: string): boolean {
  // Our MVP definition: English => imperial; everything else => metric.
  return primaryLang(targetLang) === "en";
}

type UnitFixResult = {
  translated: string[];
  hits: number;
  mode: "mi_to_km" | "km_to_mi" | "none";
};

function _parseLocaleNumber(raw: string): { value: number; hadDecimal: boolean } | null {
  // Robust parsing for inputs like:
  // - 26.2
  // - 26,2
  // - 1,234.5
  // - 1.234,5
  const s0 = raw.trim();
  if (!s0) return null;

  const hadDecimal = /[.,]\d+/.test(s0);

  // Remove spaces and apostrophes (common thousands separators).
  let s = s0.replace(/[\s']/g, "");

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");

  if (lastComma !== -1 && lastDot !== -1) {
    // Choose decimal separator by whichever appears last.
    if (lastComma > lastDot) {
      // comma decimal, dots thousands
      s = s.replace(/\./g, "").replace(/,/g, ".");
    } else {
      // dot decimal, commas thousands
      s = s.replace(/,/g, "");
    }
  } else if (lastComma !== -1) {
    // comma decimal (or thousands); assume decimal if comma is followed by digits at end.
    s = s.replace(/,/g, ".");
  } else {
    // dot decimal or plain integer -> keep as is
  }

  const v = Number.parseFloat(s);
  if (!Number.isFinite(v)) return null;
  return { value: v, hadDecimal };
}

function _formatNumber(value: number, decimals: number, lang: string): string {
  const fixed = value.toFixed(decimals);
  if (lang === "de") return fixed.replace(".", ",");
  return fixed;
}

function unitConversionPostprocessMiles({
  translated,
  targetLang,
  applyIndices,
}: {
  translated: string[];
  targetLang: string;
  applyIndices: { start: number; end: number }; // [start, end)
}): UnitFixResult {
  const tgt = primaryLang(targetLang);
  if (!tgt) return { translated, hits: 0, mode: "none" };

  const imperial = usesImperial(targetLang);
  const mode: UnitFixResult["mode"] = imperial ? "km_to_mi" : "mi_to_km";

  // Match number + unit (miles): "26.2 miles", "26,2 mile", "5 mi"
  const reMiles = /\b(\d[\d\s'.,]*)\s*(miles?|mile|mi)\b/gi;
  // Match number + unit (km): "42.2 km", "42,2 km", "5km", "10 km"
  // Avoid matching "km/h" etc.
  const reKm = /\b(\d[\d\s'.,]*)\s*km\b(?!\s*\/)/gi;

  const out = translated.slice();
  let hits = 0;

  for (let i = applyIndices.start; i < applyIndices.end && i < out.length; i++) {
    const s = out[i];
    if (typeof s !== "string" || s.length === 0) continue;

    if (imperial) {
      // km -> miles for EN (imperial)
      out[i] = s.replace(reKm, (full, numRaw) => {
        const parsed = _parseLocaleNumber(String(numRaw));
        if (!parsed) return full;

        const km = parsed.value;
        const miles = km / 1.609344;

        const milesStr = _formatNumber(miles, 1, "en");
        const kmStr = _formatNumber(km, 1, "en");

        hits++;
        return `${milesStr} miles (${kmStr} km)`;
      });
    } else {
      // miles -> km for metric targets (incl. DE special formatting)
      out[i] = s.replace(reMiles, (full, numRaw) => {
        const parsed = _parseLocaleNumber(String(numRaw));
        if (!parsed) return full;

        const miles = parsed.value;
        const km = miles * 1.609344;

        // Consistent: km always 1 decimal. Miles: keep 0 decimals if input had none, else 1.
        const milesDecimals = parsed.hadDecimal ? 1 : 0;
        const milesStr = _formatNumber(miles, milesDecimals, tgt);
        const kmStr = _formatNumber(km, 1, tgt);

        hits++;

        if (tgt === "de") {
          // Option B for DE.
          return `${milesStr} Meilen (${kmStr} km)`;
        }

        // Option A for others (metric default).
        return `${kmStr} km`;
      });
    }
  }

  return { translated: out, hits, mode };
}

// --- Template-based mixed-mode (question only; answers untouched) ---
//
// Goal: avoid translating proper-noun answers (e.g. "Glass" -> "Glas") by translating ONLY the question,
// and for EN<->DE build a clean template without a Google call.
//
// Manual curl tests (run against wrangler dev; answers must remain unchanged):
// 1) City (EN -> DE) "Mirror’s Edge Catalyst"
// curl -sS -X POST http://localhost:8787/translateBatch -H 'Content-Type: application/json' -H 'x-debug: 1' --data '{"target":"de","source":"en","texts":["Mirror’s Edge Catalyst is set in which city?","Glass","The City","New Eden","Downtown"]}'
//
// 2) Studio (EN -> DE) "Cowboy Bebop"
// curl -sS -X POST http://localhost:8787/translateBatch -H 'Content-Type: application/json' -H 'x-debug: 1' --data '{"target":"de","source":"en","texts":["Which studio produced Cowboy Bebop?","Bones","Madhouse","Pierrot","Sunrise"]}'
//
// 3) Company (EN -> DE) "Minecraft"
// curl -sS -X POST http://localhost:8787/translateBatch -H 'Content-Type: application/json' -H 'x-debug: 1' --data '{"target":"de","source":"en","texts":["Which company developed Minecraft?","Mojang","Nintendo","Sony"]}'
//
// 4) Country (EN -> DE) "Nintendo"
// curl -sS -X POST http://localhost:8787/translateBatch -H 'Content-Type: application/json' -H 'x-debug: 1' --data '{"target":"de","source":"en","texts":["Which country is Nintendo from?","Japan","USA","Germany"]}'
type TemplateType = "city" | "studio" | "company" | "country";

function normalizeForMatching(input: string): string {
  return input.trim().replace(/\s+/g, " ").toLowerCase();
}

function stripOuterQuotes(s: string): string {
  let out = s.trim();
  // strip a single pair of common quotes
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
    ["‘", "’"],
    ["«", "»"],
    ["„", "“"],
  ];
  for (const [l, r] of pairs) {
    if (out.startsWith(l) && out.endsWith(r) && out.length >= 2) {
      out = out.slice(1, -1).trim();
      break;
    }
  }
  return out;
}

function stripEdgeQuotes(s: string): string {
  // Removes leading/trailing quote characters even if unpaired (common with pasted smart-quotes).
  let out = s.trim();
  const edge = /^[\"'“”‘’«»„]+|[\"'“”‘’«»„]+$/g;
  for (let i = 0; i < 3; i++) {
    const next = out.replace(edge, "").trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

function detectCityEntity(q: string): string | null {
  const qTrim = q.trim();
  if (!qTrim) return null;
  const qNorm = qTrim.toLowerCase().replace(/\s+/g, " ");

  // Match against normalized string (as requested).
  const patterns = [
    /^(.+?)\s+is\s+set\s+in\s+which\s+city\??$/i, // A
    /^(.+?)\s+is\s+set\s+in\s+what\s+city\??$/i, // B
    /^in\s+which\s+city\s+is\s+(.+?)\s+set\??$/i, // C
    /^which\s+city\s+is\s+(.+?)\s+set\s+in\??$/i, // D
  ];

  for (const re of patterns) {
    if (!qNorm.match(re)) continue;
    // Re-run the same regex on the original string to extract the true substring.
    const qOrig = qTrim.replace(/\s+/g, " ");
    const m = qOrig.match(re);
    if (!m) continue;
    const entityRaw = (m[1] ?? "").trim();
    const entity = stripEdgeQuotes(stripOuterQuotes(entityRaw));
    if (!entity) return null;
    return entity;
  }

  return null;
}

function detectTemplateQuestion(q: string): null | { type: TemplateType; entity: string } {
  const qTrim = q.trim();
  if (!qTrim) return null;

  // Normalize only for matching (keep original for entity extraction).
  // Note: requests may include “smart quotes” around the whole question, e.g. “...?”.
  const qNorm = qTrim.toLowerCase().replace(/\s+/g, " ");

  const qNormMatch = stripEdgeQuotes(qNorm);
  const qTrimMatch = stripEdgeQuotes(qTrim.replace(/\s+/g, " "));

  // Patterns are intentionally conservative; if unsure -> null (fallback to normal flow).
  const patterns: Array<{ type: TemplateType; re: RegExp; entityGroup: number }> = [
    // CITY (EN)
    // Explicit variants requested (A-D); entity group is the captured title.
    { type: "city", re: /^(.+?)\s+is\s+set\s+in\s+which\s+city\??$/i, entityGroup: 1 }, // A
    { type: "city", re: /^(.+?)\s+is\s+set\s+in\s+what\s+city\??$/i, entityGroup: 1 }, // B
    { type: "city", re: /^in\s+which\s+city\s+is\s+(.+?)\s+set\??$/i, entityGroup: 1 }, // C
    { type: "city", re: /^which\s+city\s+is\s+(.+?)\s+set\s+in\??$/i, entityGroup: 1 }, // D
    // Extra: past tense variant (kept)
    { type: "city", re: /^(.+?)\s+was\s+set\s+in\s+(?:which|what)\s+city\??$/i, entityGroup: 1 },
    { type: "city", re: /^(.+?)\s+(?:takes|took)\s+place\s+in\s+(?:which|what)\s+city\??$/i, entityGroup: 1 },
    { type: "city", re: /^where\s+does\s+(.+?)\s+take\s+place\??$/i, entityGroup: 1 },
    // STUDIO (EN)
    { type: "studio", re: /^which\s+studio\s+(?:produced|made|animated)\s+(.+?)\??$/i, entityGroup: 1 },
    { type: "studio", re: /^(.+?)\s+was\s+produced\s+by\s+which\s+studio\??$/i, entityGroup: 1 },
    // COMPANY (EN)
    { type: "company", re: /^which\s+company\s+(?:developed|made|created)\s+(.+?)\??$/i, entityGroup: 1 },
    { type: "company", re: /^(.+?)\s+was\s+(?:developed|made|created)\s+by\s+which\s+company\??$/i, entityGroup: 1 },
    // COUNTRY (EN)
    { type: "country", re: /^in\s+which\s+country\s+is\s+(.+?)\s+located\??$/i, entityGroup: 1 },
    { type: "country", re: /^(.+?)\s+is\s+located\s+in\s+which\s+country\??$/i, entityGroup: 1 },
    { type: "country", re: /^which\s+country\s+is\s+(.+?)\s+from\??$/i, entityGroup: 1 },
  ];

  // Quick prefilter to avoid running many regexes on unrelated questions.
  if (
    !(
      qNormMatch.includes("which city") ||
      qNormMatch.includes("what city") ||
      qNormMatch.includes("take place") ||
      qNormMatch.includes("is set") ||
      qNormMatch.includes("which studio") ||
      qNormMatch.includes("which company") ||
      qNormMatch.includes("which country") ||
      qNormMatch.includes("in which country") ||
      qNormMatch.includes("located in")
    )
  ) {
    return null;
  }

  for (const p of patterns) {
    // Match on normalized string (robust whitespace / outer quotes),
    // but extract entity from the original string (qTrim), not qNorm.
    const normMatch = qNormMatch.match(p.re);
    if (!normMatch) continue;

    // Re-match on original (whitespace-collapsed) to get the real substring.
    const origMatch = qTrimMatch.match(p.re);
    if (!origMatch) continue;

    const entityRaw = origMatch[p.entityGroup] ?? "";
    const entity = stripOuterQuotes(entityRaw);
    if (!entity) return null;
    return { type: p.type, entity };
  }

  return null;
}

function modeForType(t: TemplateType): TranslateBatchResponse["mode"] {
  switch (t) {
    case "city":
      return "mixed_city";
    case "studio":
      return "mixed_studio";
    case "company":
      return "mixed_company";
    case "country":
      return "mixed_country";
  }
}

function buildLocalTemplate(type: TemplateType, entity: string, source: string, target: string): string | null {
  const s = primaryLang(source);
  const t = primaryLang(target);

  // EN -> DE (zero Google calls)
  if (s === "en" && t === "de") {
    switch (type) {
      case "city":
        return `In welcher Stadt ist ${entity} angesiedelt?`;
      case "studio":
        return `Welches Studio produzierte ${entity}?`;
      case "company":
        return `Welche Firma entwickelte ${entity}?`;
      case "country":
        return `In welchem Land liegt ${entity}?`;
    }
  }

  // DE -> EN (zero Google calls) - only when we are sure we matched an EN template question.
  if (s === "de" && t === "en") {
    switch (type) {
      case "city":
        return `In which city is ${entity} set?`;
      case "studio":
        return `Which studio produced ${entity}?`;
      case "company":
        return `Which company developed ${entity}?`;
      case "country":
        return `In which country is ${entity} located?`;
    }
  }

  return null;
}

function buildEnglishBaseTemplate(type: TemplateType, entityPlaceholder: string): string {
  switch (type) {
    case "city":
      return `${entityPlaceholder} is set in which city?`;
    case "studio":
      return `Which studio produced ${entityPlaceholder}?`;
    case "company":
      return `Which company developed ${entityPlaceholder}?`;
    case "country":
      return `In which country is ${entityPlaceholder} located?`;
  }
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
    const debug = wantsDebug(request);
    const debugBuild = "bf-dev-answers-v1";

    const withBuild = (resp: TranslateBatchResponse): TranslateBatchResponse =>
      debug ? { ...resp, build: debugBuild } : resp;

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

    // Special case (B): "stand for / wofür steht" + acronym => mixed translation
    // - Translate only the fixed phrase/template (smallest possible), keep answers original.
    try {
      const question = params.texts[0] ?? "";
      if (question && isStandForQuestion(question) && hasAnyAcronym(question)) {
        const acronym = extractFirstAcronym(question);
        if (acronym) {
          const canonical = buildCanonicalStandForQuestion(acronym, params.target);

          // For DE/EN we can avoid Google entirely (zero cost).
          const t = params.target.split("_")[0].toLowerCase().trim();
          let mixedQuestion = canonical;
          if (t !== "de" && t !== "en") {
            // Tiny call: translate the canonical English template, keeping the acronym protected.
            const counter = { value: 1 };
            const protectedQ = applyProtection(canonical, counter);
            const tiny = await translateWithGoogleV2(
              { target: params.target, source: params.source, texts: [protectedQ.text] },
              env.GOOGLE_API_KEY,
            );
            if (Array.isArray(tiny) && typeof tiny[0] === "string" && tiny[0].length > 0) {
              mixedQuestion = restoreProtection(tiny[0], protectedQ.replacements);
            } else {
              // If unsure, fall back to the original question (never crash).
              mixedQuestion = question;
            }
          }

          const translated = [mixedQuestion, ...params.texts.slice(1)];
          const unitFixed = unitConversionPostprocessMiles({
            translated,
            targetLang: params.target,
            applyIndices: { start: 1, end: translated.length },
          });
          const resp: TranslateBatchResponse = debug
            ? {
                translated: unitFixed.translated,
                mode: "mixed",
                unitFixApplied: unitFixed.hits > 0,
                unitFixHits: unitFixed.hits,
                unitFixMode: unitFixed.mode,
              }
            : { translated: unitFixed.translated };
          return json(withBuild(resp), { status: 200 });
        }
      }
    } catch {
      // If anything goes wrong, continue with normal translation flow.
    }

    // Bulletproof City template (EN -> DE): MUST run before cache/full-translate.
    // Only translate the question via fixed template; keep answers original; zero Google calls.
    try {
      const t = primaryLang(params.target);
      const s = primaryLang(params.source);
      if (t === "de" && s === "en") {
        const q0 = params.texts[0] ?? "";
        const entity = q0 ? detectCityEntity(q0) : null;
        if (entity) {
          const translatedQuestion = `In welcher Stadt ist ${entity} angesiedelt?`;
          const translated = [translatedQuestion, ...params.texts.slice(1)];
          const unitFixed = unitConversionPostprocessMiles({
            translated,
            targetLang: params.target,
            applyIndices: { start: 1, end: translated.length },
          });
          const resp: TranslateBatchResponse = debug
            ? {
                translated: unitFixed.translated,
                mode: "mixed_city",
                unitFixApplied: unitFixed.hits > 0,
                unitFixHits: unitFixed.hits,
                unitFixMode: unitFixed.mode,
              }
            : { translated: unitFixed.translated };
          return json(withBuild(resp), { status: 200 });
        }
      }
    } catch {
      // Never crash; fall through to normal flow.
    }

    // NEW SPECIAL MODE: mixed_answers for “Which of the following … character … (video) game …”
    // Must run before cache + before any full-translate path.
    // - Translate ONLY the question (1 Google call, keep-token protection applies)
    // - Keep answers 1:1 original
    try {
      const texts = params.texts;
      const qRaw = String(texts[0] ?? "");
      const q = qRaw.toLowerCase().replace(/\s+/g, " ").trim();
      const isWhichOfFollowing = q.includes("which of the following");
      const isCharacterQuestion = q.includes("character");
      const mentionsGame = q.includes("video game") || q.includes(" game") || q.includes("from");

      if (texts.length >= 4 && qRaw && isWhichOfFollowing && isCharacterQuestion && mentionsGame) {
        let translatedQuestion = qRaw;
        try {
          const counter = { value: 1 };
          const protectedQ = applyProtection(qRaw, counter);
          const tiny = await translateWithGoogleV2(
            { target: params.target, source: params.source, texts: [protectedQ.text] },
            env.GOOGLE_API_KEY,
          );
          if (Array.isArray(tiny) && typeof tiny[0] === "string" && tiny[0].length > 0) {
            translatedQuestion = restoreProtection(tiny[0], protectedQ.replacements);
          }
        } catch {
          translatedQuestion = qRaw;
        }

        const translated = [translatedQuestion, ...texts.slice(1)];
        const unitFixed = unitConversionPostprocessMiles({
          translated,
          targetLang: params.target,
          applyIndices: { start: 1, end: translated.length },
        });
        const resp: TranslateBatchResponse = debug
          ? {
              translated: unitFixed.translated,
              mode: "mixed_answers",
              rule: "mixed_answers_character",
              unitFixApplied: unitFixed.hits > 0,
              unitFixHits: unitFixed.hits,
              unitFixMode: unitFixed.mode,
            }
          : { translated: unitFixed.translated };
        return json(withBuild(resp), { status: 200 });
      }
    } catch {
      // Never crash; fall through to normal flow.
    }

    // Optional KV cache
    const cacheKeyInput = `${params.target}\n${params.source}\n${params.texts.join("\n")}`;
    const cacheKey = await sha256Hex(cacheKeyInput);

    if (env.TRANSLATION_CACHE) {
      const cached = await env.TRANSLATION_CACHE.get(cacheKey);
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
            const resp: TranslateBatchResponse = debug ? { translated: parsed, mode: "full" } : { translated: parsed };
            return json(withBuild(resp), { status: 200 });
          }
        } catch {
          // ignore cache corruption and continue
        }
      }
    }

    try {
      // Protect (A): acronyms / name sequences via placeholders.
      const counter = { value: 1 };
      const protectedPerText: ProtectedResult[] = params.texts.map((t) => applyProtection(t, counter));
      const protectedTexts = protectedPerText.map((x) => x.text);

      // Cost brake (C): if there's essentially nothing translatable, skip Google entirely.
      const hasSignal = protectedTexts.some((t) => stripToTranslatableSignal(t).length > 0);
      if (!hasSignal) {
        const translated = params.texts.slice();
        if (env.TRANSLATION_CACHE) {
          await env.TRANSLATION_CACHE.put(cacheKey, JSON.stringify(translated), {
            expirationTtl: 60 * 60 * 24 * 30,
          });
        }
        const resp: TranslateBatchResponse = debug ? { translated, mode: "skip" } : { translated };
        return json(withBuild(resp), { status: 200 });
      }

      // Mixed-mode: MC questions about identity/proper nouns.
      // Translate ONLY the question; keep answers exactly as provided.
      const mcQuestion = params.texts[0] ?? "";
      if (mcQuestion && isWhichOfTheFollowingProperNounQuestion(mcQuestion)) {
        let translatedQuestion = mcQuestion;
        try {
          const protectedQ = protectedTexts[0] ?? mcQuestion;
          const tiny = await translateWithGoogleV2(
            { target: params.target, source: params.source, texts: [protectedQ] },
            env.GOOGLE_API_KEY,
          );
          if (Array.isArray(tiny) && typeof tiny[0] === "string" && tiny[0].length > 0) {
            const rep = protectedPerText[0]?.replacements ?? new Map();
            translatedQuestion = restoreProtection(tiny[0], rep);
          }
        } catch {
          translatedQuestion = mcQuestion;
        }

        const translated = [translatedQuestion, ...params.texts.slice(1)];
        if (env.TRANSLATION_CACHE) {
          await env.TRANSLATION_CACHE.put(cacheKey, JSON.stringify(translated), {
            expirationTtl: 60 * 60 * 24 * 30,
          });
        }
        const unitFixed = unitConversionPostprocessMiles({
          translated,
          targetLang: params.target,
          applyIndices: { start: 1, end: translated.length },
        });
        const resp: TranslateBatchResponse = debug
          ? {
              translated: unitFixed.translated,
              mode: "mixed_keep_answers",
              unitFixApplied: unitFixed.hits > 0,
              unitFixHits: unitFixed.hits,
              unitFixMode: unitFixed.mode,
            }
          : { translated: unitFixed.translated };
        return json(withBuild(resp), { status: 200 });
      }

      // Template-based mixed-mode: translate ONLY the question; answers are proper nouns and must stay as-is.
      const questionOriginal = params.texts[0] ?? "";
      const detected = questionOriginal ? detectTemplateQuestion(questionOriginal) : null;
      if (questionOriginal && detected) {
        const { type, entity } = detected;
        const local = buildLocalTemplate(type, entity, params.source, params.target);
        let newQuestion = local ?? questionOriginal;

        // For non-EN<->DE targets: translate a stable English base template with an entity placeholder,
        // then restore the entity (no answer translation; exactly 1 mini-call).
        if (!local) {
          const entityToken = "__bf_entity__";
          const base = buildEnglishBaseTemplate(type, entityToken);
          try {
            const tiny = await translateWithGoogleV2(
              { target: params.target, source: "en", texts: [base] },
              env.GOOGLE_API_KEY,
            );
            if (Array.isArray(tiny) && typeof tiny[0] === "string" && tiny[0].length > 0) {
              const out = tiny[0];
              if (out.includes(entityToken)) {
                newQuestion = out.split(entityToken).join(entity);
              } else {
                // If placeholder got altered, keep original question to avoid nonsense.
                newQuestion = questionOriginal;
              }
            } else {
              newQuestion = questionOriginal;
            }
          } catch {
            newQuestion = questionOriginal;
          }
        }

        const translated = [newQuestion, ...params.texts.slice(1)];
        if (env.TRANSLATION_CACHE) {
          await env.TRANSLATION_CACHE.put(cacheKey, JSON.stringify(translated), {
            expirationTtl: 60 * 60 * 24 * 30,
          });
        }
        const mode = modeForType(type);
        const unitFixed = unitConversionPostprocessMiles({
          translated,
          targetLang: params.target,
          applyIndices: { start: 1, end: translated.length },
        });
        const resp: TranslateBatchResponse = debug
          ? {
              translated: unitFixed.translated,
              mode,
              unitFixApplied: unitFixed.hits > 0,
              unitFixHits: unitFixed.hits,
              unitFixMode: unitFixed.mode,
            }
          : { translated: unitFixed.translated };
        return json(withBuild(resp), { status: 200 });
      }

      const translatedRaw = await translateWithGoogleV2(
        { target: params.target, source: params.source, texts: protectedTexts },
        env.GOOGLE_API_KEY,
      );
      if (!Array.isArray(translatedRaw) || translatedRaw.length !== params.texts.length) {
        return serverError("Google Translate returned unexpected result length.");
      }

      // Restore placeholders
      const translated = translatedRaw.map((t, i) => {
        const rep = protectedPerText[i]?.replacements ?? new Map();
        return restoreProtection(typeof t === "string" ? t : "", rep);
      });

      const unitFixed = unitConversionPostprocessMiles({
        translated,
        targetLang: params.target,
        applyIndices: { start: 0, end: translated.length },
      });

      if (env.TRANSLATION_CACHE) {
        await env.TRANSLATION_CACHE.put(cacheKey, JSON.stringify(unitFixed.translated), {
          // 30 days
          expirationTtl: 60 * 60 * 24 * 30,
        });
      }

      const resp: TranslateBatchResponse = debug
        ? {
            translated: unitFixed.translated,
            mode: "full",
            unitFixApplied: unitFixed.hits > 0,
            unitFixHits: unitFixed.hits,
            unitFixMode: unitFixed.mode,
          }
        : { translated: unitFixed.translated };
      return json(withBuild(resp), { status: 200 });
    } catch (e: any) {
      return serverError(e?.message ? String(e.message) : "Translation failed.");
    }
  },
};

