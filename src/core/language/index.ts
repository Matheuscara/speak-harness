import { francAll } from "franc-min";
import type { Lang } from "../types.ts";

/** ISO 639-3 codes used by franc for each supported language. */
const FRANC_CODES: Record<Lang, string> = { en: "eng", "pt-BR": "por" };

/** Texts shorter than this are undetermined. */
export const MIN_DETECT_LENGTH = 20;

export interface LanguageScore {
  lang: Lang;
  /** Normalized by franc: the best candidate scores 1, others in [0, 1]. */
  score: number;
}

/**
 * Scores `text` against `candidates`, best first. Empty when the text is too short
 * or no candidate can be determined.
 */
export function scoreLanguages(text: string, candidates: readonly Lang[]): LanguageScore[] {
  const value = text.replace(/\s+/g, " ").trim();
  if (value.length < MIN_DETECT_LENGTH || candidates.length === 0) return [];
  const byCode = new Map<string, Lang>();
  for (const lang of candidates) byCode.set(FRANC_CODES[lang], lang);
  const scores: LanguageScore[] = [];
  for (const [code, score] of francAll(value, { only: [...byCode.keys()], minLength: MIN_DETECT_LENGTH })) {
    const lang = byCode.get(code);
    if (lang) scores.push({ lang, score });
  }
  return scores;
}

/** Most probable language of `text` among `candidates`; `undefined` when undetermined (short text). */
export function detectLanguage(text: string, candidates: readonly Lang[]): Lang | undefined {
  return scoreLanguages(text, candidates)[0]?.lang;
}

/**
 * Very frequent function words per language. Technical prose borrows English nouns and
 * verbs, never these, so they guard against one borrowed term flipping a block.
 */
const FUNCTION_WORDS: Record<Lang, readonly string[]> = {
  en: [
    "the", "of", "to", "in", "on", "for", "with", "is", "are", "was", "were", "be", "been", "and", "or", "it", "its",
    "this", "that", "these", "those", "not", "you", "your", "if", "when", "then", "from", "by", "at", "can", "will",
    "should", "would", "there", "here", "which", "what", "how", "but", "also", "than", "into", "only", "after",
    "before", "each", "about", "just", "we", "they", "has", "have", "does",
  ],
  "pt-BR": [
    "o", "os", "de", "do", "da", "dos", "das", "em", "na", "nos", "nas", "um", "uma", "uns", "umas", "com", "para",
    "pra", "pela", "pelo", "por", "que", "não", "é", "e", "se", "mas", "isso", "isto", "esse", "essa", "este", "esta",
    "está", "estão", "são", "ao", "aos", "à", "às", "também", "mais", "como", "quando", "porque", "ou", "já", "foi",
    "ser", "ter", "tem", "você", "vocês", "aqui", "depois", "antes", "então", "ainda", "muito", "sem", "sobre", "cada",
    "onde", "seu", "sua",
  ],
};

const FUNCTION_WORD_LANGS: Record<string, Lang> = {};
for (const lang of Object.keys(FUNCTION_WORDS) as Lang[]) {
  for (const word of FUNCTION_WORDS[lang]) FUNCTION_WORD_LANGS[word] = lang;
}

/** Count of function words of each language in `text`. */
export function functionWordVotes(text: string): Record<Lang, number> {
  const votes: Record<Lang, number> = { en: 0, "pt-BR": 0 };
  for (const word of text.toLowerCase().split(/[^\p{L}]+/u)) {
    const lang = FUNCTION_WORD_LANGS[word];
    if (lang) votes[lang]++;
  }
  return votes;
}

/** franc score gap (best = 1, minus runner-up) that switches language when function words agree. */
export const SWITCH_MARGIN = 0.1;
/** franc score gap that switches language even when function words disagree. */
export const STRONG_SWITCH_MARGIN = 0.35;

/**
 * Language of a block that follows a block in `previous`. Undetermined (short) text keeps
 * `previous`. Switching needs franc to prefer another language by `SWITCH_MARGIN` and more of
 * its function words than `previous`'s, or by `STRONG_SWITCH_MARGIN` alone.
 */
export function chooseBlockLanguage(text: string, previous: Lang, candidates: readonly Lang[]): Lang {
  const [best, runnerUp] = scoreLanguages(text, candidates);
  if (!best || best.lang === previous) return previous;
  const gap = best.score - (runnerUp?.score ?? 0);
  if (gap >= STRONG_SWITCH_MARGIN) return best.lang;
  const votes = functionWordVotes(text);
  return gap >= SWITCH_MARGIN && votes[best.lang] > votes[previous] ? best.lang : previous;
}
