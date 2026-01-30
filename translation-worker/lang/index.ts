/**
 * Language pack registry for translation-worker v7.
 */

export type { LanguagePack } from "./types";
import { dePack } from "./de";
import { enPack } from "./en";
import { esPack } from "./es";
import type { LanguagePack } from "./types";

const PACKS: Map<string, LanguagePack> = new Map([
  ["de", dePack],
  ["en", enPack],
  ["es", esPack],
]);

export function getLanguagePack(code: string): LanguagePack {
  const normalized = (code || "").trim().toLowerCase().split("-")[0];
  return PACKS.get(normalized) ?? enPack;
}
