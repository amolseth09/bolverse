/** Mirrors backend/app/languages.py. Clients also refresh this from GET /languages. */
export interface Language {
  code: string;
  name: string;
  native: string;
  hello: string;
  region?: string;
  latin?: boolean;
  /** false when the server can't take speech input for this language (type instead) */
  speechInput?: boolean;
}

import { GENERATED_LANGUAGES, REGIONS } from "./languages.generated";

/** 64 languages, generated from backend/app/languages.py so apps and server always agree. */
export const LANGUAGES: Language[] = GENERATED_LANGUAGES;
export { REGIONS };

const DEFAULT = "en-US";

export function findLang(code?: string | null): Language {
  return LANGUAGES.find((l) => l.code === code) ?? LANGUAGES.find((l) => l.code === DEFAULT)!;
}

/** A sensible "other" language: the preferred one if valid and different, else English/Spanish. */
export function otherThan(code: string, preferred?: string | null): string {
  if (preferred && preferred !== code && LANGUAGES.some((l) => l.code === preferred)) return preferred;
  return code === DEFAULT ? "es-ES" : DEFAULT;
}

/** Match device/browser locales (e.g. ["hi-IN", "en-GB"]) to a supported language. */
export function detectLang(locales: readonly string[]): string {
  for (const raw of locales) {
    const p = raw.toLowerCase();
    const exact = LANGUAGES.find((l) => l.code.toLowerCase() === p);
    if (exact) return exact.code;
    const base = LANGUAGES.find((l) => l.code.split("-")[0] === p.split("-")[0]);
    if (base) return base.code;
  }
  return DEFAULT;
}
