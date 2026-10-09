import type { Lang } from "../types.ts";

/** Inline node whose markup surrounds its content (emphasis, strong, delete, link). */
export interface Container {
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
}

export interface Span {
  start: number;
  end: number;
}

/**
 * Spoken text with, per UTF-16 unit, the source range it came from. Atomic pieces
 * (verbalized inline code, link hosts, file names) map every unit to the whole source
 * node and are never split.
 */
export class MappedText {
  text = "";
  readonly srcStart: number[] = [];
  readonly srcEnd: number[] = [];
  readonly atom: number[] = [];
  readonly containers: Container[] = [];
  private atoms = 0;

  push(text: string, start: number, end: number): void {
    this.text += text;
    for (let i = 0; i < text.length; i++) {
      this.srcStart.push(start);
      this.srcEnd.push(end);
      this.atom.push(-1);
    }
  }

  pushAtom(text: string, start: number, end: number): void {
    if (!text) return;
    const id = this.atoms++;
    this.text += text;
    for (let i = 0; i < text.length; i++) {
      this.srcStart.push(start);
      this.srcEnd.push(end);
      this.atom.push(id);
    }
  }

  /** Synthetic separator with no source. */
  pushSpace(): void {
    this.push(" ", -1, -1);
  }

  /** True when a cut before `index` would fall inside an atomic piece. */
  insideAtom(index: number): boolean {
    const before = this.atom[index - 1];
    return before !== undefined && before >= 0 && before === this.atom[index];
  }

  /** Source range covered by spoken units [from, to), extended over enclosing inline markup. */
  sourceRange(from: number, to: number): Span | undefined {
    let first = -1;
    let last = -1;
    for (let i = from; i < to; i++) {
      const start = this.srcStart[i] ?? -1;
      if (start < 0 || /\s/.test(this.text[i] ?? " ")) continue;
      if (first < 0) first = i;
      last = i;
    }
    if (first < 0) return undefined;
    let start = this.srcStart[first] ?? 0;
    let end = this.srcEnd[last] ?? start;
    for (let changed = true; changed; ) {
      changed = false;
      for (const c of this.containers) {
        if (start > c.start && start <= c.contentStart && end <= c.end) {
          start = c.start;
          changed = true;
        }
        if (end < c.end && end >= c.contentEnd && start >= c.start) {
          end = c.end;
          changed = true;
        }
      }
    }
    return end > start ? { start, end } : undefined;
  }
}

/**
 * Source offset of every unit of `value` (a parsed text node) inside `source[start, end)`.
 * Escapes, entities and stripped indentation make the two differ; each unit is matched
 * to the next equal source character, or to the current position when none is near.
 */
export function alignToSource(value: string, source: string, start: number, end: number): number[] {
  const offsets: number[] = [];
  let p = start;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const limit = Math.min(end, p + 16);
    let q = p;
    while (q < limit && source[q] !== ch) q++;
    if (q < limit) {
      offsets.push(q);
      p = q + 1;
    } else {
      offsets.push(Math.min(p, Math.max(start, end - 1)));
    }
  }
  return offsets;
}

const segmenters: Partial<Record<Lang, Intl.Segmenter>> = {};

/** Abbreviations after which a period does not end the sentence. */
const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|ex|p\.ex|vs|cf|approx|aprox|fig|Dr|Dra|Sr|Sra|Prof|Mr|Mrs|Ms|nº|pág)\.$/u;

/** Sentence spans of `m.text` (trimmed), never cutting atoms or after abbreviations. */
export function sentenceSpans(m: MappedText, lang: Lang): Span[] {
  const segmenter = (segmenters[lang] ??= new Intl.Segmenter(lang, { granularity: "sentence" }));
  const spans: Span[] = [];
  // Soft line breaks inside a paragraph are not sentence ends (ICU treats them as paragraph separators).
  for (const { index, segment } of segmenter.segment(m.text.replace(/[\r\n\u0085\u2028\u2029]/g, " "))) {
    const span = { start: index, end: index + segment.length };
    const prev = spans.at(-1);
    if (prev && shouldJoin(m, prev, span)) prev.end = span.end;
    else spans.push(span);
  }
  return spans.map((span) => trimSpan(m.text, span)).filter((span) => span.end > span.start);
}

function shouldJoin(m: MappedText, prev: Span, next: Span): boolean {
  const prevText = m.text.slice(prev.start, prev.end).trimEnd();
  const nextText = m.text.slice(next.start, next.end).trimStart();
  if (!/[\p{L}\p{N}]/u.test(prevText) || !/[\p{L}\p{N}]/u.test(nextText)) return true;
  if (m.insideAtom(next.start)) return true;
  return ABBREVIATION.test(prevText);
}

function trimSpan(text: string, span: Span): Span {
  let { start, end } = span;
  while (start < end && /\s/.test(text[start] ?? "")) start++;
  while (end > start && /\s/.test(text[end - 1] ?? "")) end--;
  return { start, end };
}

const CLAUSE_END = /[,;:)\u2014\u2013]/;

/** Splits `span` into pieces of at most `max` units: at clause boundaries, then words, then hard. */
export function splitLong(m: MappedText, span: Span, max: number): Span[] {
  const parts: Span[] = [];
  const limit = Math.max(20, max);
  let { start } = span;
  const { end } = span;
  while (end - start > limit) {
    const floor = start + Math.floor(limit * 0.3);
    const ceiling = start + limit;
    let cut = -1;
    for (let i = ceiling - 1; i >= floor && cut < 0; i--) {
      if (CLAUSE_END.test(m.text[i] ?? "") && /\s/.test(m.text[i + 1] ?? "") && !m.insideAtom(i + 1)) cut = i + 1;
    }
    for (let i = ceiling; i > floor && cut < 0; i--) {
      if (/\s/.test(m.text[i] ?? "") && !m.insideAtom(i)) cut = i;
    }
    for (let i = ceiling; i > start && cut < 0; i--) {
      if (/\s/.test(m.text[i] ?? "")) cut = i;
    }
    if (cut < 0) {
      cut = ceiling;
      if (/[\uDC00-\uDFFF]/.test(m.text[cut] ?? "")) cut--;
    }
    const piece = trimSpan(m.text, { start, end: cut });
    if (piece.end > piece.start) parts.push(piece);
    start = cut;
    while (start < end && /\s/.test(m.text[start] ?? "")) start++;
  }
  if (end > start) parts.push({ start, end });
  return parts;
}
