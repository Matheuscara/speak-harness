// Wrap mode (`speakh run -- <cmd>`): the harness runs on a PTY shown in an embedded terminal left of the reader.
// Every key goes to the harness except after the prefix key, whose next key runs one SpeakHarness command through
// the keymap. Commands without an adapter get their answers from screen capture.

import {
  BoxRenderable,
  CliRenderEvents,
  EmbeddedTerminalRenderable,
  StyledText,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
  type TextChunk,
} from "@opentui/core";
import type { KeyAfterInputContext, KeyInputContext } from "@opentui/keymap";
import { basename } from "node:path";
import { recognizeHarness } from "../../capture/harness.ts";
import { PtyProcess, type PtyExit } from "../../capture/pty.ts";
import { ScreenCapture } from "../../capture/screen.ts";
import type { AppCore } from "../../core/types.ts";
import { keyFromEvent, type KeyController } from "../keys.ts";
import { chunk } from "../markdown-view.ts";
import type { NoticeLevel } from "../overlays/panel.ts";
import { statusLine, type StatusInput } from "../reader.ts";
import { theme } from "../theme.ts";
import { PrefixState } from "./prefix.ts";

export const DEFAULT_PREFIX = "ctrl+g";
const MIN_READER = 36;
const MIN_HARNESS = 20;
/** Above the keymap addons' intercepts (priority 0), below key capture in the keymap editor (1000). */
const INTERCEPT_PRIORITY = 500;

/** Pane widths for a terminal `total` columns wide: reader ≈40% (min 36), including its separator column. */
export function splitWidths(total: number): { harness: number; reader: number } {
  const reader = Math.min(Math.max(MIN_READER, Math.round(total * 0.4)), Math.max(0, total - MIN_HARNESS));
  return { harness: total - reader, reader };
}

export interface WrapHost {
  readonly renderer: CliRenderer;
  readonly app: AppCore;
  readonly keys: KeyController;
  readonly cwd: string;
  overlayOpen(): boolean;
  closeOverlay(): void;
  notice(level: NoticeLevel, text: string): void;
  renderStatus(): void;
  quit(): void;
}

export class WrapMode {
  private readonly host: WrapHost;
  private readonly command: readonly string[];
  /** Executable name, used in titles and as the capture session title. */
  private readonly name: string;
  private readonly terminal: EmbeddedTerminalRenderable;
  private readonly readerPane: BoxRenderable;
  private readonly harnessTitle: TextRenderable;
  private readonly readerTitle: TextRenderable;
  private readonly prefix = new PrefixState();
  /** Set when no enabled adapter follows the wrapped command. */
  private readonly capture: ScreenCapture | undefined;
  private readonly offs: (() => void)[] = [];
  private pty: PtyProcess | undefined;
  /** How the harness exited (`code 0`, `signal SIGHUP`), once it has. */
  private exit: string | undefined;
  private captureTimer: NodeJS.Timeout | undefined;
  /** A key after the prefix is being resolved by the keymap; `key:after` settles it. */
  private dispatching = false;
  private matcher: { key: string; match: (event: KeyEvent) => boolean } | undefined;
  private disposed = false;

  /** Mounts the harness pane and `reader` (with title bars) into the horizontal `layout`. */
  constructor(host: WrapHost, command: readonly string[], layout: BoxRenderable, reader: Renderable) {
    this.host = host;
    this.command = command;
    this.name = basename(command[0] ?? "harness");
    const { renderer, keys } = host;
    const known = recognizeHarness(command);
    this.capture = known && host.app.config.harnesses.enabled.includes(known) ? undefined : new ScreenCapture();

    const widths = splitWidths(renderer.width);
    const harnessPane = new BoxRenderable(renderer, { id: "wrap-harness", flexDirection: "column", flexGrow: 1, flexShrink: 1, height: "100%" });
    this.harnessTitle = new TextRenderable(renderer, { id: "wrap-harness-title", height: 1, flexShrink: 0, wrapMode: "none", truncate: true });
    this.terminal = new EmbeddedTerminalRenderable(renderer, {
      id: "wrap-terminal",
      cols: widths.harness,
      rows: Math.max(1, renderer.height - 1),
      width: "100%",
      height: "auto",
      flexGrow: 1,
      flexShrink: 1,
      onData: (data) => this.pty?.write(data),
      onTerminalResize: (cols, rows) => this.pty?.resize(cols, rows),
      onScreenChange: this.capture ? () => this.observeScreen() : undefined,
    });
    harnessPane.add(this.harnessTitle);
    harnessPane.add(this.terminal);

    this.readerPane = new BoxRenderable(renderer, {
      id: "wrap-reader",
      flexDirection: "column",
      width: widths.reader,
      flexShrink: 0,
      height: "100%",
      border: ["left"],
      borderColor: theme.border,
    });
    this.readerTitle = new TextRenderable(renderer, { id: "wrap-reader-title", height: 1, flexShrink: 0, wrapMode: "none", truncate: true });
    // The reader fills the column below its title bar.
    reader.height = "auto";
    reader.flexGrow = 1;
    reader.flexShrink = 1;
    this.readerPane.add(this.readerTitle);
    this.readerPane.add(reader);
    layout.add(harnessPane);
    layout.add(this.readerPane);

    const onResize = (width: number) => {
      this.readerPane.width = splitWidths(width).reader;
    };
    const onFocus = () => this.focusChanged();
    renderer.on(CliRenderEvents.RESIZE, onResize);
    renderer.on(CliRenderEvents.FOCUSED_RENDERABLE, onFocus);
    this.offs.push(
      () => renderer.off(CliRenderEvents.RESIZE, onResize),
      () => renderer.off(CliRenderEvents.FOCUSED_RENDERABLE, onFocus),
      keys.keymap.intercept("key", (ctx) => this.onKey(ctx), { priority: INTERCEPT_PRIORITY }),
      keys.keymap.intercept("key:after", (ctx) => this.afterKey(ctx), { priority: INTERCEPT_PRIORITY }),
      keys.keymap.on("pendingSequence", (parts) => {
        if (parts.length > 0 || this.prefix.phase !== "sequence") return;
        this.prefix.sequenceCleared();
        this.refresh();
      }),
    );
    this.renderTitles();
  }

  /** Keys belong to the harness: SpeakHarness's global bindings stay off. */
  get ownsKeys(): boolean {
    return !this.prefix.active;
  }

  /** Starts the harness on a PTY sized like its pane; throws when it cannot be started. */
  start(): void {
    const { renderer } = this.host;
    this.pty = new PtyProcess(this.command, {
      cwd: this.host.cwd,
      cols: splitWidths(renderer.width).harness,
      rows: Math.max(1, renderer.height - 1),
      onData: (data) => this.terminal.write(data),
    });
    void this.pty.exited.then((exit) => this.exited(exit));
    if (this.capture) {
      // No adapter follows this command: show its captured answers instead of another harness's session.
      this.host.app.sessions
        .follow({ harness: "capture", id: "capture", title: this.name, cwd: this.host.cwd, updatedAt: new Date() })
        .catch((error: unknown) => this.host.notice("warning", `capture: ${error instanceof Error ? error.message : String(error)}`));
    }
    this.terminal.focus();
    this.refresh();
  }

  /**
   * Status line: `PREFIX` badge while a command key is awaited; the exit notice once the harness has exited. The
   * help-key hint moves to the reader title bar, where it fits next to the prefix.
   */
  status(input: StatusInput): TextChunk[] {
    if (this.exit) return [chunk(`■ harness exited (${this.exit})`, { fg: theme.warning, bold: true })];
    const chunks = statusLine({ ...input, helpKey: undefined });
    return this.prefix.active ? [chunk(" PREFIX ", { bold: true }, true), chunk(" ", {}), ...chunks] : chunks;
  }

  /** An overlay closed: keys return to the harness. */
  overlayClosed(): void {
    if (this.disposed || this.terminal.isDestroyed || this.host.renderer.isDestroyed) return;
    if (!this.exit) this.terminal.focus();
    this.refresh();
  }

  /** Stops listening and stops the harness (hang-up, terminate, kill). Never rejects. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.captureTimer);
    for (const off of this.offs.splice(0)) off();
    await this.pty?.stop().catch(() => undefined);
  }

  // ---------- keys ----------

  private onKey(ctx: KeyInputContext<KeyEvent>): void {
    if (this.disposed || this.host.overlayOpen()) return;
    const { event } = ctx;
    if (this.exit) {
      ctx.consume();
      queueMicrotask(() => this.host.quit());
      return;
    }
    const action = this.prefix.press({ prefix: this.isPrefix(event), escape: event.name === "escape" && !event.ctrl && !event.meta });
    if (action === "keymap") {
      this.dispatching = true;
      return;
    }
    ctx.consume();
    if (action === "harness" || action === "literal") this.toHarness(event);
    if (action === "cancel") this.host.keys.keymap.clearPendingSequence();
    if (action !== "harness") this.refresh();
  }

  private afterKey(ctx: KeyAfterInputContext<Renderable, KeyEvent>): void {
    if (!this.dispatching) return;
    this.dispatching = false;
    // Whatever the keymap made of it, a key typed after the prefix never reaches the harness.
    ctx.consume();
    this.prefix.resolved(ctx.reason === "sequence-pending");
    if (!ctx.handled) {
      this.host.notice("warning", `${this.prefixLabel()} ${this.host.keys.format(keyFromEvent(ctx.event))} is not bound to a command`);
    }
    this.refresh();
  }

  private toHarness(event: KeyEvent): void {
    if (this.capture && (event.name === "return" || event.name === "enter") && !event.shift && !event.ctrl && !event.meta) {
      const previous = this.capture.submit(this.terminal.screen(), Date.now());
      if (previous) this.host.app.sessions.addManual(previous, "capture");
    }
    this.terminal.handleKeyPress(event);
  }

  private isPrefix(event: KeyEvent): boolean {
    const key = this.host.app.config.wrap.prefix || DEFAULT_PREFIX;
    if (this.matcher?.key !== key) {
      const { keymap } = this.host.keys;
      let match: (event: KeyEvent) => boolean;
      try {
        match = keymap.createKeyMatcher(key);
      } catch (error) {
        this.host.notice("warning", `Invalid wrap prefix "${key}" (${error instanceof Error ? error.message : String(error)}); using ${DEFAULT_PREFIX}`);
        match = keymap.createKeyMatcher(DEFAULT_PREFIX);
      }
      this.matcher = { key, match };
    }
    return this.matcher.match(event);
  }

  private prefixLabel(): string {
    return this.host.keys.format(this.matcher?.key ?? (this.host.app.config.wrap.prefix || DEFAULT_PREFIX));
  }

  // ---------- harness lifecycle ----------

  private exited(exit: PtyExit): void {
    if (this.disposed) return;
    this.exit = exit.code !== null ? `code ${exit.code}` : `signal ${exit.signal ?? "unknown"}`;
    this.prefix.reset();
    this.dispatching = false;
    this.host.keys.keymap.clearPendingSequence();
    if (!this.terminal.isDestroyed) this.terminal.blur();
    this.refresh();
  }

  private focusChanged(): void {
    if (this.disposed) return;
    // Clicking into the harness pane while an overlay is open returns to the harness.
    if (this.terminal.focused && this.host.overlayOpen()) this.host.closeOverlay();
    this.renderTitles();
  }

  // ---------- capture ----------

  private observeScreen(): void {
    const capture = this.capture;
    if (!capture?.waiting || !capture.observe(this.terminal.screen(), Date.now())) return;
    clearTimeout(this.captureTimer);
    const deadline = capture.deadline;
    if (deadline === undefined) return;
    this.captureTimer = setTimeout(() => {
      const text = capture.poll(Date.now());
      if (text && !this.disposed) this.host.app.sessions.addManual(text, "capture");
    }, Math.max(0, deadline - Date.now()));
    this.captureTimer.unref?.();
  }

  // ---------- rendering ----------

  private refresh(): void {
    this.renderTitles();
    this.host.renderStatus();
  }

  /** The pane that has the keyboard gets a highlighted title bar. */
  private renderTitles(): void {
    if (this.harnessTitle.isDestroyed) return;
    const harnessKeys = !this.exit && !this.prefix.active && !this.host.overlayOpen();
    const label = this.command.join(" ");
    const on = { fg: theme.selectedFg, bold: true };
    this.harnessTitle.bg = harnessKeys ? theme.selectedBg : theme.bg;
    this.harnessTitle.content = new StyledText(
      this.exit
        ? [chunk(" ■ ", { fg: theme.warning }), chunk(this.name, { fg: theme.muted }), chunk(` · exited (${this.exit}) · press any key to quit`, { fg: theme.warning })]
        : harnessKeys
          ? [chunk(" ● ", on), chunk(label, on)]
          : [chunk(" ○ ", { fg: theme.dim }), chunk(label, { fg: theme.muted })],
    );
    const readerKeys = !this.exit && !harnessKeys;
    const help = this.host.app.config.keys.help?.[0];
    this.readerTitle.bg = readerKeys ? theme.selectedBg : theme.bg;
    this.readerTitle.content = new StyledText(
      readerKeys
        ? [chunk(" ● SpeakHarness", on), chunk(this.prefix.active ? " · next key: command" : ` · esc back to ${this.name}`, { fg: theme.selectedFg })]
        : [
            chunk(" ○ SpeakHarness", { fg: theme.muted }),
            chunk(help ? ` · ${this.prefixLabel()} ${this.host.keys.format(help)} keys` : ` · ${this.prefixLabel()} prefix`, { fg: theme.dim }),
          ],
    );
  }
}
