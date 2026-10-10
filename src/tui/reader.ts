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
  private readonly brand: TextRenderable;
  private readonly header: TextRenderable;
  private readonly scroll: ScrollBoxRenderable;
  private readonly status: TextRenderable;
  private readonly footer: BoxRenderable;
  private readonly settingsButton: TextRenderable;
  private readonly helpButton: TextRenderable;
  private readonly progress: TextRenderable;
  private readonly notice: TextRenderable;
  private nodes: LeafNode[] = [];
  private shownKey: string | undefined;
  private shownMarkdown: string | undefined;
  private built = false;
  private highlight: SourceRange | undefined;
  private scrollPending = false;
  private playback: PlaybackState | undefined;
  private motionTimer: ReturnType<typeof setInterval> | undefined;
  private motionStep = 0;
  private progressWidth = 0;
  private settingsAction: (() => void) | undefined;
  private helpAction: (() => void) | undefined;
  private settingsKey = ",";
  private helpKey = "?";
  private compact = false;

  private readonly renderer: CliRenderer;

  constructor(renderer: CliRenderer) {
    this.renderer = renderer;
    this.root = new BoxRenderable(renderer, { id: "reader", flexDirection: "column", flexGrow: 1, height: "100%", backgroundColor: theme.bg });
    this.brand = new TextRenderable(renderer, { id: "reader-brand", height: 1, flexShrink: 0, wrapMode: "none", truncate: true, bg: theme.overlayBg });
    this.header = new TextRenderable(renderer, { id: "reader-header", height: 1, flexShrink: 0, wrapMode: "none", truncate: true, bg: theme.overlayBg });
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
    this.progress = new TextRenderable(renderer, {
      id: "reader-progress", height: 1, flexShrink: 0, wrapMode: "none", truncate: true,
      bg: theme.overlayBg, renderBefore: () => this.refreshProgressWidth(),
    });
    this.footer = new BoxRenderable(renderer, { id: "reader-controls", flexDirection: "row", height: 1, flexShrink: 0, backgroundColor: theme.overlayBg });
    this.status = new TextRenderable(renderer, { id: "reader-status", height: 1, flexGrow: 1, flexShrink: 1, wrapMode: "none", truncate: true, bg: theme.overlayBg });
    this.settingsButton = new TextRenderable(renderer, {
      id: "reader-settings", height: 1, width: 17, flexShrink: 0, wrapMode: "none",
      fg: theme.accent, bg: theme.overlayBg, onMouseUp: () => this.settingsAction?.(),
    });
    this.helpButton = new TextRenderable(renderer, {
      id: "reader-help", height: 1, width: 9, flexShrink: 0, wrapMode: "none",
      fg: theme.muted, bg: theme.overlayBg, onMouseUp: () => this.helpAction?.(),
    });
    this.footer.add(this.status);
    this.footer.add(this.settingsButton);
    this.footer.add(this.helpButton);
    this.notice = new TextRenderable(renderer, { id: "reader-notice", height: 1, flexShrink: 0, wrapMode: "none", truncate: true });
    this.root.add(this.brand);
    this.root.add(this.header);
    this.root.add(rule());
    this.root.add(this.scroll);
    this.root.add(rule());
    this.root.add(this.progress);
    this.root.add(this.footer);
    this.root.add(this.notice);
    this.renderBrand();
    this.renderProgress();
    this.setControlKeys(",", "?");
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


  /** Buttons are mouse-clickable; the printed keys are still the primary terminal controls. */
  setControlActions(settings: () => void, help: () => void): void {
    this.settingsAction = settings;
    this.helpAction = help;
  }

  setCompact(compact: boolean): void {
    if (this.compact === compact) return;
    this.compact = compact;
    this.setControlKeys(this.settingsKey, this.helpKey);
    this.renderProgress();
  }

  setControlKeys(settings: string, help: string): void {
    this.settingsKey = settings;
    this.helpKey = help;
    const compact = this.compact || (this.progressWidth || this.renderer.width) < 48;
    this.settingsButton.width = compact ? 7 : 17;
    this.helpButton.width = compact ? 0 : 9;
    this.settingsButton.content = compact ? `⚙ [${settings}]` : ` ⚙ SETTINGS [${settings}]`;
    this.helpButton.content = ` ? [${help}]`;
  }
  setNotice(chunks: TextChunk[]): void {
    this.notice.content = new StyledText(chunks);
  }

  /** Small progress/activity surfaces update independently from the markdown tree. */
  setPlayback(state: PlaybackState): void {
    this.playback = state;
    const active = state.status === "speaking" || state.status === "preparing";
    if (active && motionAllowed() && !this.motionTimer) {
      this.motionTimer = setInterval(() => {
        this.motionStep = (this.motionStep + 1) % 4;
        this.renderBrand();
      }, 180);
      this.motionTimer.unref?.();
    } else if (!active || !motionAllowed()) {
      this.stopMotion();
    }
    this.renderBrand();
    this.renderProgress();
  }

  dispose(): void {
    this.stopMotion();
  }

  private stopMotion(): void {
    if (this.motionTimer) clearInterval(this.motionTimer);
    this.motionTimer = undefined;
    this.motionStep = 0;
  }

  private renderBrand(): void {
    if (this.brand.isDestroyed) return;
    const active = this.playback?.status === "speaking" || this.playback?.status === "preparing";
    const symbol = active && motionAllowed() ? ["◇", "◈", "◆", "◈"][this.motionStep] : active ? "◆" : "◇";
    this.brand.content = new StyledText([
      chunk(" ◆ SPEAKHARNESS ", { fg: theme.accent, bold: true }),
      chunk("/  READER", { fg: theme.muted }),
      chunk(`    ${symbol}`, { fg: active ? theme.live : theme.dim }),
    ]);
  }

  private refreshProgressWidth(): void {
    const width = this.root.width;
    if (typeof width === "number" && width !== this.progressWidth) {
      this.progressWidth = width;
      this.setControlKeys(this.settingsKey, this.helpKey);
      this.renderProgress();
    }
  }

  private renderProgress(): void {
    if (this.progress.isDestroyed) return;
    const width = this.compact ? 36 : this.progressWidth || this.renderer.width;
    const { complete, remaining, percent, position } = progressMeter(this.playback, width);
    if (!this.playback?.segmentCount) {
      this.progress.content = new StyledText([chunk("  ◇  READY", { fg: theme.accent, bold: true }), chunk("  ·  space to read", { fg: theme.muted })]);
      return;
    }
    this.progress.content = new StyledText([
      chunk("  PROGRESS  ", { fg: theme.muted }),
      chunk(complete, { fg: theme.progress, bold: true }),
      chunk(remaining, { fg: theme.progressTrack }),
      chunk(`  ${percent}%`, { fg: theme.accent, bold: true }),
      chunk(`  ${position}`, { fg: theme.muted }),
    ]);
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

/** NO_COLOR and dumb terminals get a stable activity mark rather than a timer. */
export function motionAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NO_COLOR === undefined && env.SPEAKH_REDUCE_MOTION !== "1" && env.TERM !== "dumb";
}

/** Progress is by spoken segment, never an invented audio-duration estimate. */
export function progressMeter(state: PlaybackState | undefined, width: number): {
  complete: string; remaining: string; percent: number; position: string;
} {
  const count = Math.max(0, state?.segmentCount ?? 0);
  const current = count ? Math.min(count, Math.max(0, (state?.segmentIndex ?? 0) + 1)) : 0;
  const percent = count ? Math.round((current / count) * 100) : 0;
  const cells = width < 48 ? 8 : width < 80 ? 16 : 26;
  const filled = count ? Math.round((current / count) * cells) : 0;
  return {
    complete: "━".repeat(filled),
    remaining: "─".repeat(cells - filled),
    percent,
    position: `${current}/${count}`,
  };
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
  preparing: "◌",
  speaking: "▶",
  paused: "⏸",
  "study-wait": "◇",
};

export interface StatusInput {
  state: PlaybackState;
  config: Config;
  helpKey: string | undefined;
  pending: string;
  compact?: boolean;
}

function shortVoice(voice: string): string {
  const raw = voiceName(voice);
  const piper = /^pt_BR-([^-]+)-/.exec(raw);
  const name = piper ? piper[1] : raw.split("_").at(-1);
  return name ? name[0]!.toUpperCase() + name.slice(1) : raw;
}

const STATUS_LABEL: Record<PlaybackState["status"], string> = {
  idle: "READY",
  preparing: "LOADING",
  speaking: "PLAYING",
  paused: "PAUSED",
  "study-wait": "STUDY WAIT",
};

export function statusLine({ state, config, pending, compact }: StatusInput): TextChunk[] {
  const active = state.status === "speaking" || state.status === "preparing";
  const lang = state.lang?.toUpperCase() ?? "—";
  const voice = shortVoice(state.voice ?? (state.lang ? config.voices.languages[state.lang] : config.voices.primary));
  const sep = chunk("  │  ", { fg: theme.border });
  const out: TextChunk[] = [
    chunk(` ${STATUS_ICON[state.status]} ${STATUS_LABEL[state.status]}`, { fg: active ? theme.live : theme.accent, bold: true }),
    sep,
  ];
  if (!compact) out.push(chunk("SPEED ", { fg: theme.muted }));
  out.push(chunk(formatSpeed(state.speed), { fg: theme.fg, bold: true }));
  if (!compact) out.push(chunk(" [-/+]", { fg: theme.dim }), sep, chunk(lang, { fg: theme.accent, bold: true }), chunk(` · ${voice}`, { fg: theme.fg }));
  if (state.studyMode) out.push(chunk(compact ? " · STUDY" : "  ·  STUDY", { fg: theme.warning }));
  if (config.reading.autoRead) out.push(chunk(compact ? " · AUTO" : "  ·  AUTO", { fg: theme.live }));
  if (pending) out.push(chunk(`  ${pending}…`, { fg: theme.warning }));
  return out;
}

export interface HeaderInput {
  session: SessionRef | undefined;
  /** Time of the newest activity in the session; within `LIVE_MS` it shows as live. */
  lastActivity: Date | undefined;
  live: boolean;
  position: { index: number; count: number } | undefined;
  compact?: boolean;
}

export function headerLine({ session, lastActivity, live, position, compact }: HeaderInput): TextChunk[] {
  const sep = chunk(" · ", { fg: theme.dim });
  if (!session) return [chunk("no session", { fg: theme.muted }), sep, chunk("waiting for answers ○", { fg: theme.muted })];
  if (compact) {
    const name = session.title ?? session.id.slice(0, 8);
    const title = name.length > 13 ? `${name.slice(0, 12)}…` : name;
    const label = session.harness === "claude-code" ? "CLAUDE" : session.harness.toUpperCase();
    return [
      chunk(`${label} · ${title}`, { fg: theme.accent, bold: true }),
      ...(position?.count ? [sep, chunk(`${position.index + 1}/${position.count}`, { fg: theme.muted })] : []),
    ];
  }
  const out: TextChunk[] = [chunk(session.harness, { fg: theme.accent, bold: true }), sep, chunk(session.title ?? session.id, { fg: theme.fg })];
  if (position && position.count > 0) out.push(sep, chunk(`answer ${position.index + 1}/${position.count}`, { fg: theme.muted }));
  if (live) out.push(sep, chunk("live ", { fg: theme.fg }), chunk("●", { fg: theme.live }));
  else if (lastActivity) out.push(sep, chunk(relativeTime(lastActivity), { fg: theme.muted }));
  return out;
}
