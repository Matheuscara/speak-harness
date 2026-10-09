import type { Code, Nodes, PhrasingContent, RootContent, Table } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { chooseBlockLanguage, detectLanguage } from "../language/index.ts";
import { LANGS, type Config, type Lang, type SegmentKind, type SpeechOptions, type SpeechScript, type SpeechSegment } from "../types.ts";
import { compileDetectionLexicon, compileLexicon, mergeLexicon } from "./lexicon.ts";
import { codeBlockCue, codeLanguageName, quoteCue, tableRow, tableSummary } from "./localize.ts";
import { alignToSource, MappedText, sentenceSpans, splitLong, type Span } from "./mapped.ts";
import { cleanSpokenText, isSpeakable, speakTextEntity, TEXT_ENTITY, urlHost, verbalizeInlineCode } from "./text.ts";

const PAUSE = {
  heading: 600,
  thematicBreak: 600,
  paragraph: 400,
  listItem: 250,
  sentence: 200,
  /** Between pieces of one sentence split for length. */
  chunk: 60,
  cue: 350,
  quoteCue: 150,
  tableRow: 250,
};

type TextKind = Extract<SegmentKind, "heading" | "sentence" | "list-item" | "quote">;

type Unit =
  | { type: "text"; kind: TextKind; nodes: PhrasingContent[]; span: Span; pause: number; prefix?: string; quote?: Span }
  | { type: "code"; node: Code; span: Span; quote?: Span }
  | { type: "table"; node: Table; span: Span; quote?: Span }
  | { type: "break" };

function spanOf(node: Nodes): Span {
  return { start: node.position?.start.offset ?? 0, end: node.position?.end.offset ?? 0 };
}

function collectUnits(root: RootContent[], quoteCues: boolean): Unit[] {
  const units: Unit[] = [];
  let pendingQuote: Span | undefined;
  const add = (unit: Exclude<Unit, { type: "break" }>): void => {
    if (pendingQuote) {
      unit.quote = pendingQuote;
      pendingQuote = undefined;
    }
    units.push(unit);
  };
  const walk = (nodes: RootContent[], quoted: boolean): void => {
    for (const node of nodes) {
      switch (node.type) {
        case "heading":
          add({ type: "text", kind: "heading", nodes: node.children, span: spanOf(node), pause: PAUSE.heading });
          break;
        case "paragraph":
          add({ type: "text", kind: quoted ? "quote" : "sentence", nodes: node.children, span: spanOf(node), pause: PAUSE.paragraph });
          break;
        case "list":
          node.children.forEach((item, i) => {
            const number = node.ordered ? (node.start ?? 1) + i : undefined;
            item.children.forEach((child, j) => {
              if (child.type !== "paragraph") return walk([child], quoted);
              const first = j === 0;
              add({
                type: "text",
                kind: "list-item",
                nodes: child.children,
                span: { start: first ? spanOf(item).start : spanOf(child).start, end: spanOf(child).end },
                pause: PAUSE.listItem,
                prefix: first && number !== undefined ? `${number}.` : undefined,
              });
            });
          });
          break;
        case "code":
          add({ type: "code", node, span: spanOf(node) });
          break;
        case "table":
          add({ type: "table", node, span: spanOf(node) });
          break;
        case "blockquote":
          if (quoteCues && !pendingQuote) pendingQuote = spanOf(node);
          walk(node.children, true);
          break;
        case "thematicBreak":
          units.push({ type: "break" });
          break;
        case "html":
        case "definition":
        case "footnoteDefinition":
        case "yaml":
          break;
        default:
          if ("children" in node) walk(node.children as RootContent[], quoted);
      }
    }
  };
  walk(root, false);
  return units;
}

/** Plain text of inline nodes for language detection: no inline code, URLs, paths or images. */
function detectionText(nodes: PhrasingContent[]): string {
  let text = "";
  for (const node of nodes) {
    if (node.type === "text") text += node.value.replace(TEXT_ENTITY, " ");
    else if (node.type === "break") text += " ";
    else if (node.type === "inlineCode" || node.type === "image" || node.type === "imageReference") text += " ";
    else if ("children" in node) text += detectionText(node.children);
  }
  return text;
}

function linkLabel(nodes: PhrasingContent[]): string {
  return nodes.map((node) => ("value" in node ? node.value : "children" in node ? linkLabel(node.children) : "")).join("");
}

interface BuildContext {
  markdown: string;
  lang: Lang;
}

function pushText(m: MappedText, value: string, span: Span, markdown: string): void {
  const offsets = alignToSource(value, markdown, span.start, span.end);
  let last = 0;
  const pushPlain = (from: number, to: number): void => {
    for (let i = from; i < to; i++) {
      const offset = offsets[i] ?? span.start;
      m.push(value[i] ?? "", offset, offset + 1);
    }
  };
  for (const match of value.matchAll(TEXT_ENTITY)) {
    const from = match.index;
    const to = from + match[0].length;
    pushPlain(last, from);
    m.pushAtom(speakTextEntity(match), offsets[from] ?? span.start, (offsets[to - 1] ?? span.start) + 1);
    last = to;
  }
  pushPlain(last, value.length);
}

function buildInline(nodes: PhrasingContent[], m: MappedText, ctx: BuildContext): void {
  for (const node of nodes) {
    const span = spanOf(node);
    switch (node.type) {
      case "text":
        pushText(m, node.value, span, ctx.markdown);
        break;
      case "inlineCode":
        m.pushAtom(verbalizeInlineCode(node.value, ctx.lang), span.start, span.end);
        break;
      case "image":
      case "imageReference":
        m.pushAtom(node.alt ?? "", span.start, span.end);
        break;
      case "break":
        m.pushSpace();
        break;
      case "html":
      case "footnoteReference":
        break;
      case "link": {
        const label = linkLabel(node.children);
        const url = node.url;
        const autolink =
          label === url || `http://${label}` === url || `https://${label}` === url || /^(?:https?:\/\/|www\.)\S+$/.test(label);
        if (`mailto:${label}` === url) {
          m.pushAtom(label, span.start, span.end);
        } else if (autolink) {
          m.pushAtom(urlHost(url) ?? urlHost(`http://${label}`) ?? "", span.start, span.end);
        } else {
          addContainer(m, span, node.children);
          buildInline(node.children, m, ctx);
        }
        break;
      }
      default:
        // emphasis, strong, delete, linkReference: markup around children.
        addContainer(m, span, node.children);
        buildInline(node.children, m, ctx);
    }
  }
}

function addContainer(m: MappedText, span: Span, children: PhrasingContent[]): void {
  const first = children[0];
  const last = children.at(-1);
  if (!first || !last) return;
  m.containers.push({ ...span, contentStart: spanOf(first).start, contentEnd: spanOf(last).end });
}

interface Draft {
  text: string;
  display: Span;
  kind: SegmentKind;
  lang: Lang;
  pauseAfterMs: number;
}

interface Plan {
  drafts: Draft[][];
  /** Unit and language of each block, by block index. */
  blocks: Array<{ unit: Unit; lang: Lang }>;
  dominantLang: Lang;
}

function plan(markdown: string, options: SpeechOptions): Plan {
  const tree = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const units = collectUnits(tree.children, options.quoteCue);
  const lexicon = mergeLexicon(options.lexicon);
  const normalizers: Record<Lang, (text: string) => string> = {
    en: compileLexicon(lexicon.en),
    "pt-BR": compileLexicon(lexicon["pt-BR"]),
  };
  const forDetection = compileDetectionLexicon(lexicon);
  const detect = new Map<Unit, string>();
  for (const unit of units) if (unit.type === "text") detect.set(unit, forDetection(detectionText(unit.nodes)));

  const dominantLang = options.autoLanguage
    ? (detectLanguage([...detect.values()].join("\n"), LANGS) ?? options.defaultLang)
    : options.defaultLang;

  const normalize = (text: string, lang: Lang): string => cleanSpokenText(normalizers[lang](text));
  const max = options.maxSegmentChars;
  const result: Plan = { drafts: [], blocks: [], dominantLang };
  let lang = dominantLang;
  let carriedQuote: Span | undefined;
  for (const unit of units) {
    if (unit.type === "break") {
      const last = result.drafts.at(-1)?.at(-1);
      if (last) last.pauseAfterMs = Math.max(last.pauseAfterMs, PAUSE.thematicBreak);
      continue;
    }
    const text = detect.get(unit);
    if (options.autoLanguage && text !== undefined) lang = chooseBlockLanguage(text, lang, LANGS);
    const drafts: Draft[] =
      unit.type === "text"
        ? textDrafts(unit, lang, markdown, max, normalize)
        : unit.type === "code"
          ? plainDrafts(codeBlockCue(lang, codeLanguageName(unit.node.lang), codeLines(unit.node)), unit.span, "cue", lang, PAUSE.cue, max, normalize)
          : options.tables === "rows"
            ? tableRowDrafts(unit.node, lang, markdown, max, normalize)
            : plainDrafts(tableSummary(lang, tableCells(unit.node, 0, lang, markdown, normalize)), unit.span, "table", lang, PAUSE.cue, max, normalize);
    const quote = unit.quote ?? carriedQuote;
    if (drafts.length === 0) {
      carriedQuote = quote;
      continue;
    }
    carriedQuote = undefined;
    if (quote) drafts.unshift({ text: quoteCue(lang), display: quote, kind: "cue", lang, pauseAfterMs: PAUSE.quoteCue });
    result.drafts.push(drafts);
    result.blocks.push({ unit, lang });
  }
  return result;
}

function codeLines(node: Code): number {
  return node.value.length === 0 ? 0 : node.value.split(/\r?\n/).length;
}

type Normalize = (text: string, lang: Lang) => string;

function textDrafts(unit: Extract<Unit, { type: "text" }>, lang: Lang, markdown: string, max: number, normalize: Normalize): Draft[] {
  const m = new MappedText();
  buildInline(unit.nodes, m, { markdown, lang });
  const sentences = unit.kind === "heading" ? [{ start: 0, end: m.text.length }] : sentenceSpans(m, lang);
  const pieces: Array<{ text: string; span: Span; sentenceEnd: boolean }> = [];
  for (const sentence of sentences) {
    const parts = splitLong(m, sentence, max);
    parts.forEach((part, i) => {
      const text = normalize(m.text.slice(part.start, part.end), lang);
      if (isSpeakable(text)) pieces.push({ text, span: part, sentenceEnd: i === parts.length - 1 });
    });
  }
  return pieces.map((piece, i) => {
    const first = i === 0;
    const last = i === pieces.length - 1;
    const mapped = m.sourceRange(piece.span.start, piece.span.end) ?? unit.span;
    const display = { start: first ? unit.span.start : mapped.start, end: last ? unit.span.end : mapped.end };
    return {
      text: first && unit.prefix ? `${unit.prefix} ${piece.text}` : piece.text,
      display: display.end > display.start ? display : unit.span,
      kind: unit.kind,
      lang,
      pauseAfterMs: last ? unit.pause : piece.sentenceEnd ? PAUSE.sentence : PAUSE.chunk,
    };
  });
}

/** Drafts for generated text that maps to one source range, split for length at words. */
function plainDrafts(text: string, span: Span, kind: SegmentKind, lang: Lang, pause: number, max: number, normalize: Normalize): Draft[] {
  const spoken = normalize(text, lang);
  if (!isSpeakable(spoken)) return [];
  const m = new MappedText();
  m.push(spoken, span.start, span.end);
  const parts = splitLong(m, { start: 0, end: spoken.length }, max);
  return parts.map((part, i) => ({
    text: spoken.slice(part.start, part.end),
    display: span,
    kind,
    lang,
    pauseAfterMs: i === parts.length - 1 ? pause : PAUSE.chunk,
  }));
}

function tableCells(table: Table, row: number, lang: Lang, markdown: string, normalize: Normalize): string[] {
  return (table.children[row]?.children ?? []).map((cell) => {
    const m = new MappedText();
    buildInline(cell.children, m, { markdown, lang });
    return normalize(m.text, lang);
  });
}

function tableRowDrafts(table: Table, lang: Lang, markdown: string, max: number, normalize: Normalize): Draft[] {
  const header = table.children[0];
  if (!header) return [];
  const drafts = plainDrafts(tableSummary(lang, tableCells(table, 0, lang, markdown, normalize)), spanOf(header), "table", lang, PAUSE.tableRow, max, normalize);
  for (let row = 1; row < table.children.length; row++) {
    const node = table.children[row];
    if (!node) continue;
    const text = tableRow(lang, row, tableCells(table, row, lang, markdown, normalize));
    drafts.push(...plainDrafts(text, spanOf(node), "table", lang, PAUSE.tableRow, max, normalize));
  }
  const last = drafts.at(-1);
  if (last) last.pauseAfterMs = PAUSE.cue;
  return drafts;
}

function toScript(messageKey: string, drafts: Draft[][], blockIndexes: number[], blocks: number, dominantLang: Lang): SpeechScript {
  const segments: SpeechSegment[] = [];
  drafts.forEach((block, i) => {
    for (const draft of block) segments.push({ index: segments.length, ...draft, blockIndex: blockIndexes[i] ?? i });
  });
  return { messageKey, segments, blocks, dominantLang };
}

/** Markdown → spoken segments with per-block language and source ranges for highlight. */
export function buildSpeechScript(messageKey: string, markdown: string, options: SpeechOptions): SpeechScript {
  const result = plan(markdown, options);
  return toScript(messageKey, result.drafts, result.drafts.map((_, i) => i), result.drafts.length, result.dominantLang);
}

/** Header and every row of the table at `blockIndex` (for `read-table`); `undefined` if that block is not a table. */
export function buildTableScript(messageKey: string, markdown: string, blockIndex: number, options: SpeechOptions): SpeechScript | undefined {
  const result = plan(markdown, options);
  const block = result.blocks[blockIndex];
  if (block?.unit.type !== "table") return undefined;
  const lexicon = mergeLexicon(options.lexicon);
  const normalizer = compileLexicon(lexicon[block.lang]);
  const drafts = tableRowDrafts(block.unit.node, block.lang, markdown, options.maxSegmentChars, (text) => cleanSpokenText(normalizer(text)));
  return toScript(messageKey, [drafts], [blockIndex], result.drafts.length, result.dominantLang);
}

export function speechOptionsFromConfig(config: Config, defaultLang: Lang): SpeechOptions {
  return {
    tables: config.reading.tables,
    quoteCue: config.reading.quoteCue,
    autoLanguage: config.voices.autoLanguage,
    defaultLang,
    lexicon: { en: { ...config.lexicon.en }, "pt-BR": { ...config.lexicon["pt-BR"] } },
    maxSegmentChars: config.reading.maxSegmentChars,
  };
}
