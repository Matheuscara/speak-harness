// Markdown → reader layout. Every visible character keeps the source offset it came from, so a speech
// segment's `display` range (offsets into the message markdown) highlights exactly the text it covers.
// OpenTUI's MarkdownRenderable parses with `marked` and exposes no source positions, so it cannot style an
// arbitrary source range; this module renders from mdast instead (decision of spike M0-1).

import type {
  BlockContent,
  DefinitionContent,
  List,
  ListItem,
  Nodes,
  PhrasingContent,
  RootContent,
  Table,
} from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { RGBA, TextAttributes, type TextChunk } from "@opentui/core";
import { theme } from "./theme.ts";

export interface SourceRange {
  start: number;
  end: number;
}

export interface RunStyle {
  fg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  dim?: boolean;
}

/** A styled piece of visible text. `offsets[i]` is the source offset of `text[i]`; synthetic text has none. */
export interface Run {
  text: string;
  style: RunStyle;
  offsets?: readonly number[];
}

interface LeafBase {
  /** Source range of the markdown node this leaf renders. */
  range: SourceRange;
  /** Gutter drawn left of the content (quote bars, list markers); hanging indent for wrapped lines. */
  prefix: Run[];
  marginTop: number;
}

export interface TextLeaf extends LeafBase {
  kind: "text";
  role: "heading" | "paragraph" | "table" | "rule" | "html";
  runs: Run[];
  wrap: boolean;
}

export interface CodeLeaf extends LeafBase {
  kind: "code";
  lang: string | undefined;
  value: string;
}

export type Leaf = TextLeaf | CodeLeaf;

const RULE_WIDTH = 200;

export function layoutMarkdown(markdown: string): Leaf[] {
  const tree = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const builder = new LayoutBuilder(markdown);
  builder.blocks(tree.children, rootPrefix(), 0, 1);
  return builder.leaves;
}

interface PrefixState {
  first: Run[];
  rest: Run[];
  used: boolean;
}

function rootPrefix(): PrefixState {
  return { first: [], rest: [], used: false };
}

function takePrefix(state: PrefixState): Run[] {
  if (state.used) return state.rest;
  state.used = true;
  return state.first;
}

function rangeOf(node: Nodes): SourceRange {
  return { start: node.position?.start.offset ?? 0, end: node.position?.end.offset ?? 0 };
}

function synthetic(text: string, style: RunStyle = {}): Run {
  return { text, style };
}

class LayoutBuilder {
  readonly leaves: Leaf[] = [];
  private readonly source: string;
  constructor(source: string) {
    this.source = source;
  }

  blocks(
    nodes: readonly (RootContent | BlockContent | DefinitionContent)[],
    prefix: PrefixState,
    firstMargin: number,
    gap: number,
  ): void {
    let index = 0;
    for (const node of nodes) {
      if (this.block(node, prefix, index === 0 ? firstMargin : gap)) index++;
    }
  }

  /** Returns false when the node produced nothing (definitions, front matter). */
  private block(node: RootContent, prefix: PrefixState, marginTop: number): boolean {
    switch (node.type) {
      case "heading": {
        const runs = this.inline(node.children, { fg: theme.heading, bold: true, underline: node.depth === 1 });
        this.text("heading", runs, node, takePrefix(prefix), marginTop);
        return true;
      }
      case "paragraph":
        this.text("paragraph", this.inline(node.children, {}), node, takePrefix(prefix), marginTop);
        return true;
      case "html":
        this.text("html", [this.sourced(node.value, node, { fg: theme.dim })], node, takePrefix(prefix), marginTop);
        return true;
      case "thematicBreak":
        this.text("rule", [this.spread("─".repeat(RULE_WIDTH), node, { fg: theme.border })], node, takePrefix(prefix), marginTop, false);
        return true;
      case "code":
        this.leaves.push({ kind: "code", lang: node.lang ?? undefined, value: node.value, range: rangeOf(node), prefix: takePrefix(prefix), marginTop });
        return true;
      case "table":
        this.text("table", this.table(node), node, takePrefix(prefix), marginTop, false);
        return true;
      case "blockquote": {
        const bar = synthetic("▎ ", { fg: theme.quote });
        const head = takePrefix(prefix);
        const inner: PrefixState = { first: [...head, bar], rest: [...prefix.rest, bar], used: false };
        this.blocks(node.children, inner, marginTop, 1);
        return true;
      }
      case "list":
        this.list(node, prefix, marginTop);
        return true;
      case "footnoteDefinition": {
        const label = `[^${node.label ?? node.identifier}] `;
        const head = takePrefix(prefix);
        const inner: PrefixState = {
          first: [...head, synthetic(label, { fg: theme.dim })],
          rest: [...prefix.rest, synthetic(" ".repeat(label.length))],
          used: false,
        };
        this.blocks(node.children, inner, marginTop, 1);
        return true;
      }
      default:
        return false;
    }
  }

  private list(node: List, prefix: PrefixState, marginTop: number): void {
    const start = node.start ?? 1;
    const width = node.ordered ? `${start + node.children.length - 1}. `.length : 2;
    const gap = node.spread ? 1 : 0;
    node.children.forEach((item: ListItem, i) => {
      let marker = node.ordered ? `${start + i}.`.padStart(width - 1) + " " : "• ";
      if (typeof item.checked === "boolean") marker += item.checked ? "☑ " : "☐ ";
      const head = takePrefix(prefix);
      const inner: PrefixState = {
        first: [...head, synthetic(marker, { fg: theme.accent })],
        rest: [...prefix.rest, synthetic(" ".repeat(marker.length))],
        used: false,
      };
      const itemMargin = i === 0 ? marginTop : gap;
      if (item.children.length === 0) {
        this.text("paragraph", [], item, takePrefix(inner), itemMargin);
        return;
      }
      this.blocks(item.children, inner, itemMargin, item.spread ? 1 : 0);
    });
  }

  private text(role: TextLeaf["role"], runs: Run[], node: Nodes, prefix: Run[], marginTop: number, wrap = true): void {
    this.leaves.push({ kind: "text", role, runs, range: rangeOf(node), prefix, marginTop, wrap });
  }

  /** Text whose characters map to the node's source by greedy alignment (skips escapes, markers, backticks). */
  private sourced(text: string, node: Nodes, style: RunStyle): Run {
    const { start, end } = rangeOf(node);
    return { text, style, offsets: alignOffsets(text, this.source, start, end) };
  }

  /** Decorative text standing for a whole node: every character maps proportionally into the node range. */
  private spread(text: string, node: Nodes, style: RunStyle): Run {
    const { start, end } = rangeOf(node);
    const span = Math.max(1, end - start);
    const offsets = Array.from(text, (_, i) => start + Math.min(span - 1, Math.floor((i * span) / text.length)));
    return { text, style, offsets };
  }

  inline(nodes: readonly PhrasingContent[], style: RunStyle): Run[] {
    const runs: Run[] = [];
    this.inlineInto(nodes, style, runs);
    return runs;
  }

  private inlineInto(nodes: readonly PhrasingContent[], style: RunStyle, out: Run[]): void {
    for (const node of nodes) {
      switch (node.type) {
        case "text":
          out.push(this.sourced(node.value.replace(/\r?\n/g, (m) => " ".repeat(m.length)), node, style));
          break;
        case "strong":
          this.inlineInto(node.children, { ...style, bold: true }, out);
          break;
        case "emphasis":
          this.inlineInto(node.children, { ...style, italic: true }, out);
          break;
        case "delete":
          this.inlineInto(node.children, { ...style, strikethrough: true }, out);
          break;
        case "inlineCode":
          out.push(this.sourced(node.value, node, { ...style, fg: theme.code }));
          break;
        case "link":
        case "linkReference":
          this.inlineInto(node.children, { ...style, fg: theme.link, underline: true }, out);
          break;
        case "image":
        case "imageReference":
          out.push(this.spread(`[${node.alt || "image"}]`, node, { ...style, fg: theme.dim }));
          break;
        case "break":
          out.push({ text: "\n", style, offsets: [rangeOf(node).start] });
          break;
        case "html":
          out.push(this.sourced(node.value, node, { ...style, fg: theme.dim }));
          break;
        case "footnoteReference":
          out.push(this.spread(`[^${node.label ?? node.identifier}]`, node, { ...style, fg: theme.dim }));
          break;
      }
    }
  }

  private table(node: Table): Run[] {
    const rows = node.children.map((row) => row.children.map((cell) => this.inline(cell.children, {})));
    const columns = Math.max(0, ...rows.map((r) => r.length));
    const widths = Array.from({ length: columns }, (_, c) =>
      Math.max(1, ...rows.map((r) => textWidth(r[c] ?? []))),
    );
    const align = node.align ?? [];
    const sep = synthetic(" │ ", { fg: theme.border });
    const out: Run[] = [];
    rows.forEach((cells, r) => {
      if (r > 0) out.push(synthetic("\n"));
      for (let c = 0; c < columns; c++) {
        if (c > 0) out.push(sep);
        const cell = (cells[c] ?? []).map((run) => (r === 0 ? { ...run, style: { ...run.style, bold: true } } : run));
        const pad = (widths[c] ?? 0) - textWidth(cell);
        const left = align[c] === "right" ? pad : align[c] === "center" ? Math.floor(pad / 2) : 0;
        if (left > 0) out.push(synthetic(" ".repeat(left)));
        out.push(...cell);
        if (pad - left > 0) out.push(synthetic(" ".repeat(pad - left)));
      }
      if (r === 0 && rows.length > 1) {
        out.push(synthetic("\n" + widths.map((w) => "─".repeat(w)).join("─┼─"), { fg: theme.border }));
      }
    });
    return out;
  }
}

function textWidth(runs: readonly Run[]): number {
  let width = 0;
  for (const run of runs) width += Bun.stringWidth(run.text);
  return width;
}

/**
 * Maps each character of `text` (a node's visible value) to an offset in `source[start, end)`.
 * Identical slices map 1:1; otherwise characters are matched in order, skipping source characters that are
 * not visible (escapes, markers). Unmatched characters (entities) take the current position.
 */
export function alignOffsets(text: string, source: string, start: number, end: number): number[] {
  const offsets = new Array<number>(text.length);
  if (end - start === text.length) {
    for (let i = 0; i < text.length; i++) offsets[i] = start + i;
    return offsets;
  }
  let j = start;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    let k = j;
    while (k < end && source[k] !== ch && !(ch === " " && (source[k] === "\n" || source[k] === "\r"))) k++;
    if (k < end) {
      offsets[i] = k;
      j = k + 1;
    } else {
      offsets[i] = Math.min(j, Math.max(start, end - 1));
    }
  }
  return offsets;
}

export function intersects(a: SourceRange, b: SourceRange | undefined): boolean {
  if (!b) return false;
  if (b.end <= b.start) return a.start <= b.start && b.start < Math.max(a.end, a.start + 1);
  return a.start < b.end && b.start < a.end;
}

export interface RenderedText {
  chunks: TextChunk[];
  plainText: string;
  /** Index into `plainText` of the first highlighted character, or -1. */
  firstHighlight: number;
}

const colorCache = new Map<string, RGBA>();
function rgba(hex: string): RGBA {
  let color = colorCache.get(hex);
  if (!color) {
    color = RGBA.fromHex(hex);
    colorCache.set(hex, color);
  }
  return color;
}

function attributesOf(style: RunStyle): number {
  let attributes = TextAttributes.NONE;
  if (style.bold) attributes |= TextAttributes.BOLD;
  if (style.italic) attributes |= TextAttributes.ITALIC;
  if (style.underline) attributes |= TextAttributes.UNDERLINE;
  if (style.strikethrough) attributes |= TextAttributes.STRIKETHROUGH;
  if (style.dim) attributes |= TextAttributes.DIM;
  return attributes;
}

export function chunk(text: string, style: RunStyle, highlighted = false): TextChunk {
  return {
    __isChunk: true,
    text,
    fg: rgba(highlighted ? theme.highlightFg : (style.fg ?? theme.fg)),
    bg: highlighted ? rgba(theme.highlightBg) : undefined,
    attributes: attributesOf(style),
  };
}

/**
 * Styles `runs`, highlighting characters whose source offset falls in `highlight`. Synthetic characters
 * (table padding, separators) are highlighted when the sourced characters on both sides are.
 */
export function renderRuns(runs: readonly Run[], highlight: SourceRange | undefined): RenderedText {
  const flags: (boolean | undefined)[] = [];
  for (const run of runs) {
    for (let i = 0; i < run.text.length; i++) {
      const offset = run.offsets?.[i];
      if (!highlight) flags.push(false);
      else if (offset === undefined) flags.push(undefined);
      else flags.push(offset >= highlight.start && offset < highlight.end);
    }
  }
  // Resolve synthetic characters from their sourced neighbours.
  let lastSourced: boolean | undefined;
  const before = flags.map((flag) => (flag === undefined ? lastSourced : (lastSourced = flag)));
  let nextSourced: boolean | undefined;
  for (let i = flags.length - 1; i >= 0; i--) {
    const flag = flags[i];
    if (flag === undefined) flags[i] = Boolean(before[i] && nextSourced);
    else nextSourced = flag;
  }

  const chunks: TextChunk[] = [];
  let plainText = "";
  let firstHighlight = -1;
  let cursor = 0;
  for (const run of runs) {
    let segmentStart = 0;
    for (let i = 1; i <= run.text.length; i++) {
      const current = flags[cursor + i - 1];
      if (i < run.text.length && flags[cursor + i] === current) continue;
      const text = run.text.slice(segmentStart, i);
      if (current && firstHighlight < 0) firstHighlight = plainText.length;
      chunks.push(chunk(text, run.style, current));
      plainText += text;
      segmentStart = i;
    }
    cursor += run.text.length;
  }
  return { chunks, plainText, firstHighlight };
}
