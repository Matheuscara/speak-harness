// Piper model-format helpers (pure): eSpeak IPA → phoneme ids. See DESIGN.md "Piper engine".

export type PhonemeIdMap = Readonly<Record<string, readonly number[]>>;

const BOS = "^";
const EOS = "$";
const PAD = "_";

/**
 * Splits eSpeak IPA into sentences, keeping each terminator (`.` `?` `!`) with its sentence.
 * Whitespace is collapsed; clause punctuation (`,`) stays inside the sentence.
 */
export function splitPhonemeSentences(ipa: string): string[] {
  const text = ipa.replace(/\s+/g, " ").trim();
  if (!text) return [];
  return text
    .split(/(?<=[.?!])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * Maps one phonemized sentence to ids: `^ _` + (`id(p) _` per phoneme) + `$`, phonemes being the
 * NFD codepoints of `phonemes`. Phonemes missing from `idMap` are dropped and returned in `missing`.
 */
export function phonemesToIds(phonemes: string, idMap: PhonemeIdMap): { ids: number[]; missing: string[] } {
  const required = (symbol: string): readonly number[] => {
    const ids = idMap[symbol];
    if (!ids) throw new Error(`Piper phoneme_id_map has no "${symbol}"`);
    return ids;
  };
  const pad = required(PAD);
  const ids: number[] = [...required(BOS), ...pad];
  const missing: string[] = [];
  for (const phoneme of phonemes.normalize("NFD")) {
    const mapped = Object.hasOwn(idMap, phoneme) ? idMap[phoneme] : undefined;
    if (!mapped) {
      if (!missing.includes(phoneme)) missing.push(phoneme);
      continue;
    }
    ids.push(...mapped, ...pad);
  }
  ids.push(...required(EOS));
  return { ids, missing };
}

/** Scales `pcm` in place so its peak is 1 (silence below 0.01 is left quiet, as Piper does). */
export function peakNormalize(pcm: Float32Array): Float32Array {
  let peak = 0;
  for (const sample of pcm) peak = Math.max(peak, Math.abs(sample));
  const scale = 1 / Math.max(0.01, peak);
  for (let i = 0; i < pcm.length; i++) pcm[i] = pcm[i]! * scale;
  return pcm;
}
