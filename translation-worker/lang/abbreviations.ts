/**
 * v7.6: Shared known abbreviations (chemical symbols, etc.) for protection heuristics.
 * <=3 chars, all letters, in this set -> protect (Au, Ag, Fe, Pb, etc.).
 */

/** Chemical symbols + common 2–3 letter abbreviations that must not be translated. */
const KNOWN_ABBREVIATIONS = new Set([
  "au", "ag", "fe", "pb", "cu", "na", "k", "ca", "mg", "zn", "al", "si", "sn", "ni", "co", "mn",
  "cr", "ti", "v", "mo", "w", "u", "pt", "pd", "ir", "rh", "os", "ru", "re", "tc", "nb", "ta",
  "hf", "zr", "y", "sc", "la", "ac", "th", "pa", "np", "pu", "am", "cm", "bk", "cf", "es", "fm",
  "md", "no", "lr", "rf", "db", "sg", "bh", "hs", "mt", "ds", "rg", "cn", "nh", "fl", "mc", "lv", "ts", "og",
  "uk", "eu", "un", "bbc", "nba", "nfl", "nhl", "mlb", "fbi", "cia",
]);

export function isKnownAbbreviation(s: string): boolean {
  const t = (s ?? "").trim().toLowerCase();
  return t.length <= 3 && t.length >= 1 && /^[a-z]+$/.test(t) && KNOWN_ABBREVIATIONS.has(t);
}
