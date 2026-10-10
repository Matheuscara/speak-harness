// Reader screen: header, scrollable rendered answer with the current segment highlighted, status and notice lines.

import {
  BoxRenderable,
  CodeRenderable,
  ScrollBoxRenderable,
  StyledText,
  SyntaxStyle,
  TextRenderable,
  type CliRenderer,
  type TextChunk,
} from "@opentui/core";
import type { Config, HarnessMessage, PlaybackState, SessionRef } from "../core/types.ts";
import { chunk, intersects, layoutMarkdown, renderRuns, type Leaf, type SourceRange } from "./markdown-view.ts";
import { relativeTime } from "./overlays/panel.ts";
import { theme } from "./theme.ts";

/** Filetypes with tree-sitter parsers bundled in @opentui/core (no download needed). */
const BUNDLED_FILETYPES: Record<string, string> = {
  ts: "typescript",
  typescript: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  javascript: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  zig: "zig",
};

let syntaxStyle: SyntaxStyle | undefined;
function codeStyle(): SyntaxStyle {
  syntaxStyle ??= SyntaxStyle.fromStyles({
    default: { fg: theme.fg },
    keyword: { fg: "#ff7b72" },
    "keyword.import": { fg: "#ff7b72" },
    string: { fg: "#a5d6ff" },
    comment: { fg: theme.dim, italic: true },
    number: { fg: "#79c0ff" },
    boolean: { fg: "#79c0ff" },
    function: { fg: "#d2a8ff" },
    "function.call": { fg: "#d2a8ff" },
    "function.method.call": { fg: "#d2a8ff" },
    type: { fg: "#ffa657" },
    constant: { fg: "#79c0ff" },
    property: { fg: "#79c0ff" },
    operator: { fg: "#ff7b72" },
    punctuation: { fg: theme.muted },
  });
  return syntaxStyle;
}

interface LeafNode {
  leaf: Leaf;
  /** Renderable whose top marks the start of the leaf's text inside the scroll content. */
  body: TextRenderable | BoxRenderable;
  firstHighlight: number;
}

export class ReaderView {
  readonly root: BoxRenderable;
  private readonly header: TextRenderable;
  private readonly scroll: ScrollBoxRenderable;
  private readonly status: TextRenderable;
  private readonly notice: TextRenderable;
  private nodes: LeafNode[] = [];
  private shownKey: string | undefined;
  private shownMarkdown: string | undefined;
  private built = false;
  private highlight: SourceRange | undefined;
  private scrollPending = false;

  private readonly renderer: CliRenderer;

  constructor(renderer: CliRenderer) {
    this.renderer = renderer;
    this.root = new BoxRenderable(renderer, { id: "reader", flexDirection: "column", flexGrow: 1, height: "100%" });
    this.header = new TextRenderable(renderer, { id: "reader-header", height: 1, flexShrink: 0, wrapMode: "none", truncate: true });
    const rule = () => new TextRenderable(renderer, { height: 1, flexShrink: 0, wrapMode: "none", content: "─".repeat(400), fg: theme.border });
    this.scroll = new ScrollBoxRenderable(renderer, {
      id: "reader-scroll",
      flexGrow: 1,
      flexShrink: 1,
      paddingLeft: 1,
      paddingRight: 1,
      contentOptions: { flexDirection: "column" },
      verticalScrollbarOptions: { visible: false },
      renderBefore: () => this.scrollToHighlight(),
    });
    this.status = new TextRenderable(renderer, { id: "reader-status", height: 1, flexShrink: 0, wrapMode: "none", truncate: true });
    this.notice = new TextRenderable(renderer, { id: "reader-notice", height: 1, flexShrink: 0, wrapMode: "none", truncate: true });
    this.root.add(this.header);
    this.root.add(rule());
    this.root.add(this.scroll);
    this.root.add(rule());
    this.root.add(this.status);
    this.root.add(this.notice);
  }

  get messageKey(): string | undefined {
    return this.shownKey;
  }

  setHeader(chunks: TextChunk[]): void {
    this.header.content = new StyledText(chunks);
  }

  setStatus(chunks: TextChunk[]): void {
    this.status.content = new StyledText(chunks);
  }

  setNotice(chunks: TextChunk[]): void {
    this.notice.content = new StyledText(chunks);
  }

  /** Re-renders only when the message or its text changed. */
  setMessage(message: HarnessMessage | undefined, emptyText: string): void {
    if (this.built && message?.key === this.shownKey && message?.markdown === this.shownMarkdown) return;
    this.built = true;
    const keyChanged = message?.key !== this.shownKey;
    this.shownKey = message?.key;
    this.shownMarkdown = message?.markdown;
    for (const child of this.scroll.getChildren()) child.destroyRecursively();
    this.nodes = [];
    if (!message) {
      this.scroll.add(new TextRenderable(this.renderer, { content: emptyText, fg: theme.muted, wrapMode: "word" }));
      return;
    }
    for (const leaf of layoutMarkdown(message.markdown)) this.nodes.push(this.buildLeaf(leaf));
    if (keyChanged) this.scroll.scrollTop = 0;
    this.scrollPending = this.highlight !== undefined;
  }

  /** Restyles only the leaves touched by the previous or the new range. */
  setHighlight(range: SourceRange | undefined): void {
    const previous = this.highlight;
    if (previous?.start === range?.start && previous?.end === range?.end) return;
    this.highlight = range;
    for (const node of this.nodes) {
      if (intersects(node.leaf.range, previous) || intersects(node.leaf.range, range)) this.styleLeaf(node);
    }
    this.scrollPending = range !== undefined;
    this.renderer.requestRender();
  }

  private buildLeaf(leaf: Leaf): LeafNode {
    const row = new BoxRenderable(this.renderer, { flexDirection: "row", flexShrink: 0, marginTop: leaf.marginTop });
    if (leaf.prefix.length > 0) {
      const width = leaf.prefix.reduce((sum, run) => sum + Bun.stringWidth(run.text), 0);
      row.add(new TextRenderable(this.renderer, {
        content: new StyledText(leaf.prefix.map((run) => chunk(run.text, run.style))),
        width,
        flexShrink: 0,
        wrapMode: "none",
      }));
    }
    let body: TextRenderable | BoxRenderable;
    if (leaf.kind === "text") {
      body = new TextRenderable(this.renderer, { flexGrow: 1, flexShrink: 1, wrapMode: leaf.wrap ? "word" : "none" });
    } else {
      body = new BoxRenderable(this.renderer, {
        flexGrow: 1,
        flexShrink: 1,
        border: true,
        borderStyle: "rounded",
        title: leaf.lang ? ` ${leaf.lang} ` : " code ",
        flexDirection: "column",
      });
      const filetype = leaf.lang ? BUNDLED_FILETYPES[leaf.lang.toLowerCase()] : undefined;
      body.add(
        filetype
          ? new CodeRenderable(this.renderer, { content: leaf.value, filetype, syntaxStyle: codeStyle(), wrapMode: "none", fg: theme.fg })
          : new TextRenderable(this.renderer, { content: leaf.value, fg: theme.fg, wrapMode: "none" }),
      );
    }
    row.add(body);
    this.scroll.add(row);
    const node: LeafNode = { leaf, body, firstHighlight: -1 };
    this.styleLeaf(node);
    return node;
  }

  private styleLeaf(node: LeafNode): void {
    const { leaf, body } = node;
    if (leaf.kind === "text" && body instanceof TextRenderable) {
      const rendered = renderRuns(leaf.runs, this.highlight);
      body.content = new StyledText(rendered.chunks);
      node.firstHighlight = rendered.firstHighlight;
    } else if (body instanceof BoxRenderable) {
      const active = intersects(leaf.range, this.highlight);
      body.borderColor = active ? theme.highlightBg : theme.border;
      body.titleColor = active ? theme.highlightFg : theme.muted;
      body.backgroundColor = active ? "#0f2742" : "transparent";
      node.firstHighlight = active ? 0 : -1;
    }
  }

  /** Runs after layout, before the scroll box draws: keeps the highlighted line inside the viewport. */
  private scrollToHighlight(): void {
    if (!this.scrollPending) return;
    this.scrollPending = false;
    const node = this.nodes.find((n) => n.firstHighlight >= 0);
    if (!node) return;
    let line = 0;
    if (node.body instanceof TextRenderable) {
      const starts = node.body.lineInfo.lineStartCols;
      for (let i = 0; i < starts.length; i++) if ((starts[i] ?? 0) <= node.firstHighlight) line = i;
    }
    const viewport = this.scroll.viewport;
    const row = node.body.y + line - viewport.y;
    const lastLine = node.body instanceof BoxRenderable ? node.body.height - 1 : 0;
    if (row >= 0 && row + lastLine < viewport.height) return;
    this.scroll.scrollTop = Math.max(0, this.scroll.scrollTop + row - Math.floor(viewport.height / 3));
    this.renderer.requestRender();
  }
}

export function formatSpeed(speed: number): string {
  const fixed = speed.toFixed(2).replace(/0$/, "");
  return `${fixed}×`;
}

export function voiceName(voice: string): string {
  return voice.slice(voice.indexOf(":") + 1);
}

const STATUS_ICON: Record<PlaybackState["status"], string> = {
  idle: "■",
  preparing: "…",
  speaking: "▶",
  paused: "⏸",
  "study-wait": "⏵",
};

export interface StatusInput {
  state: PlaybackState;
  config: Config;
  helpKey: string | undefined;
  pending: string;
}

export function statusLine({ state, config, helpKey, pending }: StatusInput): TextChunk[] {
  const lang = state.lang ?? "—";
  const voice = voiceName(state.voice ?? (state.lang ? config.voices.languages[state.lang] : config.voices.primary));
  const position = state.segmentCount > 0 ? `${Math.min(state.segmentIndex + 1, state.segmentCount)}/${state.segmentCount}` : "–";
  const sep = chunk(" · ", { fg: theme.dim });
  const out: TextChunk[] = [
    chunk(`${STATUS_ICON[state.status]} `, { fg: state.status === "idle" ? theme.muted : theme.live, bold: true }),
    chunk(lang, { fg: theme.fg }),
    sep,
    chunk(voice, { fg: theme.fg }),
    sep,
    chunk(formatSpeed(state.speed), { fg: theme.fg }),
    sep,
    chunk(position, { fg: theme.fg }),
  ];
  const flags = [
    state.studyMode ? "study" : undefined,
    config.reading.autoRead ? "auto" : undefined,
    state.voiceOverride !== "auto" ? `voice:${state.voiceOverride}` : undefined,
  ].filter((flag): flag is string => flag !== undefined);
  if (flags.length > 0) out.push(sep, chunk(flags.join(" "), { fg: theme.accent }));
  if (pending) out.push(sep, chunk(`${pending}…`, { fg: theme.warning }));
  if (helpKey) out.push(sep, chunk(`${helpKey} keys`, { fg: theme.muted }));
  return out;
}

export interface HeaderInput {
  session: SessionRef | undefined;
  /** Time of the newest activity in the session; within `LIVE_MS` it shows as live. */
  lastActivity: Date | undefined;
  live: boolean;
  position: { index: number; count: number } | undefined;
}

export function headerLine({ session, lastActivity, live, position }: HeaderInput): TextChunk[] {
  const sep = chunk(" · ", { fg: theme.dim });
  if (!session) return [chunk("no session", { fg: theme.muted }), sep, chunk("waiting for answers ○", { fg: theme.muted })];
  const out: TextChunk[] = [chunk(session.harness, { fg: theme.accent, bold: true }), sep, chunk(session.title ?? session.id, { fg: theme.fg })];
  if (position && position.count > 0) out.push(sep, chunk(`answer ${position.index + 1}/${position.count}`, { fg: theme.muted }));
  if (live) out.push(sep, chunk("live ", { fg: theme.fg }), chunk("●", { fg: theme.live }));
  else if (lastActivity) out.push(sep, chunk(relativeTime(lastActivity), { fg: theme.muted }));
  return out;
}
