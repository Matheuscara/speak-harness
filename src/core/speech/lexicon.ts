import type { Lang } from "../types.ts";

export type LexiconEntries = Record<string, string>;
export type Lexicon = Record<Lang, LexiconEntries>;

const SPELLED_ACRONYMS: LexiconEntries = {
  TTL: "T T L",
  SQL: "S Q L",
  API: "A P I",
  APIs: "A P Is",
  CLI: "C L I",
  TUI: "T U I",
  UI: "U I",
  URL: "U R L",
  URLs: "U R Ls",
  HTTP: "H T T P",
  HTTPS: "H T T P S",
  PR: "P R",
  PRs: "P Rs",
  CI: "C I",
  npm: "N P M",
  OMP: "O M P",
  TS: "T S",
  "C#": "C sharp",
  "F#": "F sharp",
};

/** Built-in pronunciations. Whole-word, case-sensitive; user entries override them. */
export const BUILTIN_LEXICON: Lexicon = {
  en: {
    ...SPELLED_ACRONYMS,
    JSON: "jason",
    "e.g.": "for example",
    "i.e.": "that is",
    "etc.": "et cetera",
    "vs.": "versus",
  },
  "pt-BR": {
    ...SPELLED_ACRONYMS,
    JSON: "jêison",
    "por ex.": "por exemplo",
    "ex.": "por exemplo",
    "p.ex.": "por exemplo",
    "etc.": "etcétera",
    "vs.": "versus",
  },
};

/** Built-in lexicon with `user` entries merged over it (user wins). */
export function mergeLexicon(user: Partial<Lexicon> | undefined): Lexicon {
  return {
    en: { ...BUILTIN_LEXICON.en, ...user?.en },
    "pt-BR": { ...BUILTIN_LEXICON["pt-BR"], ...user?.["pt-BR"] },
  };
}

const WORD_CHAR = String.raw`[\p{L}\p{N}_]`;

/** Whole-word, case-sensitive replacer for one entry table. */
export function compileLexicon(entries: LexiconEntries): (text: string) => string {
  const keys = Object.keys(entries)
    .filter((key) => key.length > 0)
    .sort((a, b) => b.length - a.length);
  if (keys.length === 0) return (text) => text;
  const escaped = keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(?<!${WORD_CHAR})(?:${escaped.join("|")})(?!${WORD_CHAR})`, "gu");
  return (text) => text.replace(pattern, (match) => entries[match] ?? match);
}

/**
 * Normalizer for language detection: entries defined by exactly one language are
 * expanded (they are evidence for it); entries shared by every language are removed
 * (acronyms are not evidence either way).
 */
export function compileDetectionLexicon(lexicon: Lexicon): (text: string) => string {
  const langs = Object.keys(lexicon) as Lang[];
  const owners: Record<string, Lang[]> = {};
  for (const lang of langs) {
    for (const key of Object.keys(lexicon[lang])) (owners[key] ??= []).push(lang);
  }
  const entries: LexiconEntries = {};
  for (const [key, keyLangs] of Object.entries(owners)) {
    const only = keyLangs.length === 1 ? keyLangs[0] : undefined;
    entries[key] = only ? (lexicon[only][key] ?? " ") : " ";
  }
  return compileLexicon(entries);
}
