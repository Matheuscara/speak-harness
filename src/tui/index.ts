// OpenTUI terminal UI: reader screen, overlays, keymap, and lifecycle (terminal restore on quit, signals, errors).

import { BoxRenderable, createCliRenderer, type CliRenderer } from "@opentui/core";
import type { AppCore, Command, CommandId, HarnessMessage, PlaybackState } from "../core/types.ts";
import { KeyController, type KeyAnalysis } from "./keys.ts";
import { chunk } from "./markdown-view.ts";
import { messagesOverlay, phrasesOverlay, sessionsOverlay } from "./overlays/lists.ts";
import { helpOverlay, paletteOverlay } from "./overlays/palette.ts";
import type { NoticeLevel, Overlay, OverlayHost } from "./overlays/panel.ts";
import { settingsOverlay } from "./overlays/settings.ts";
import { headerLine, ReaderView, statusLine } from "./reader.ts";
import { theme } from "./theme.ts";
import { WrapMode } from "./wrap/index.ts";

export interface TuiOptions {
  /** Wrap mode (`speakh run -- <cmd>`): runs the command in an embedded terminal left of the reader. */
  wrapCommand?: string[];
  /** Directory whose harness sessions are listed first. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Renderer to draw into (tests pass OpenTUI's test renderer). Defaults to a full-screen terminal renderer. */
  renderer?: CliRenderer;
}

/** Resolves after `quit` (or a terminating signal) once the terminal is restored. Does not dispose `app`. */
export async function runTui(app: AppCore, options: TuiOptions = {}): Promise<void> {
  // In wrap mode ctrl+c belongs to the harness.
  const renderer =
    options.renderer ?? (await createCliRenderer({ exitOnCtrlC: !options.wrapCommand, useMouse: true, autoFocus: false, backgroundColor: theme.bg }));
  return new Tui(app, renderer, options.cwd ?? process.cwd(), options.wrapCommand).run();
}

type OverlayKind = "messages" | "sessions" | "phrases" | "palette" | "settings" | "help";

const UI_COMMANDS: ReadonlyArray<{ id: CommandId; title: string; overlay?: OverlayKind }> = [
  { id: "switch-session", title: "Switch session", overlay: "sessions" },
  { id: "messages", title: "Messages", overlay: "messages" },
  { id: "phrases", title: "Saved phrases", overlay: "phrases" },
  { id: "command-palette", title: "Command palette", overlay: "palette" },
  { id: "settings", title: "Settings", overlay: "settings" },
  { id: "help", title: "Help: keys", overlay: "help" },
  { id: "quit", title: "Quit" },
];

/** How long a notice stays on the notice line. */
const NOTICE_MS = 8_000;
/** A session counts as live when its newest answer is this recent. */
const LIVE_MS = 10 * 60_000;

class Tui implements OverlayHost {
  readonly keys: KeyController;
  private readonly reader: ReaderView;
  private readonly cleanups: (() => void)[] = [];
  private overlay: { kind: OverlayKind; view: Overlay; offBindings: () => void } | undefined;
  private currentNotice: { level: NoticeLevel; text: string } | undefined;
  private noticeTimer: NodeJS.Timeout | undefined;
  private liveTimer: NodeJS.Timeout | undefined;
  private pending = "";
  private torndown = false;
  private finish: { resolve: () => void; reject: (error: unknown) => void } | undefined;
  private failure: unknown;
  readonly app: AppCore;
  readonly renderer: CliRenderer;
  readonly cwd: string;
  private readonly wrap: WrapMode | undefined;

  constructor(app: AppCore, renderer: CliRenderer, cwd: string, wrapCommand?: readonly string[]) {
    this.app = app;
    this.renderer = renderer;
    this.cwd = cwd;
    // Layout: a horizontal root so wrap mode can add the harness pane left of the reader.
    const layout = new BoxRenderable(renderer, { id: "layout", flexDirection: "row", width: "100%", height: "100%", backgroundColor: theme.bg });
    this.reader = new ReaderView(renderer);
    renderer.root.add(layout);

    this.keys = new KeyController(renderer, {
      onCommand: (id) => this.runCommand(id),
      blocked: () => this.overlay !== undefined || this.wrap?.ownsKeys === true,
      title: (id) => app.commands.get(id)?.title ?? UI_COMMANDS.find((c) => c.id === id)?.title ?? id,
    });
    this.cleanups.push(() => this.keys.dispose());
    this.wrap = wrapCommand
      ? new WrapMode(
          {
            renderer,
            app,
            keys: this.keys,
            cwd,
            overlayOpen: () => this.overlay !== undefined,
            closeOverlay: () => this.close(),
            notice: (level, text) => this.showNotice(level, text),
            renderStatus: () => this.renderStatus(),
            quit: () => this.quit(),
          },
          wrapCommand,
          layout,
          this.reader.root,
        )
      : undefined;
    if (!this.wrap) layout.add(this.reader.root);

    for (const { id, title, overlay } of UI_COMMANDS) {
      const command: Command = { id, title, group: "app", run: () => (overlay ? this.open(overlay) : this.quit()) };
      this.cleanups.push(app.commands.register(command));
    }

    this.cleanups.push(
      app.subscribe((event) => {
        if (event.type === "config") {
          queueMicrotask(() => this.rebind(false));
          this.renderStatus();
          this.overlay?.view.refresh?.();
        } else if (event.type === "selection") {
          this.renderMessage();
        } else {
          this.showNotice(event.level, event.text);
        }
      }),
      app.playback.subscribe((state) => {
        this.renderStatus(state);
        this.renderHighlight(state);
        if (state.error) this.renderNotice();
      }),
      app.sessions.subscribe((event) => {
        if (event.type === "warning") this.showNotice("warning", `${event.harness}: ${event.message}`);
        else this.renderMessage();
      }),
      this.keys.onPending((display) => {
        this.pending = display;
        this.renderStatus();
      }),
    );

    this.rebind(true);
    this.renderMessage();
    this.renderStatus();
    this.renderNotice();
    this.liveTimer = setInterval(() => this.renderHeader(), 30_000);
    this.liveTimer.unref?.();
  }

  run(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.finish = { resolve, reject };
      const onDestroy = () => this.teardown();
      const onFatal = (error: unknown) => {
        this.failure ??= error;
        this.close();
        if (!this.renderer.isDestroyed) this.renderer.destroy();
        else this.teardown();
      };
      this.renderer.once("destroy", onDestroy);
      process.on("uncaughtException", onFatal);
      process.on("unhandledRejection", onFatal);
      this.cleanups.push(() => {
        this.renderer.off("destroy", onDestroy);
        process.off("uncaughtException", onFatal);
        process.off("unhandledRejection", onFatal);
      });
      try {
        this.wrap?.start();
      } catch (error) {
        onFatal(error);
        return;
      }
      this.renderer.requestRender();
    });
  }

  // ---------- OverlayHost ----------

  close(): void {
    const current = this.overlay;
    if (!current) return;
    this.overlay = undefined;
    current.offBindings();
    current.view.dispose?.();
    current.view.root.destroyRecursively();
    this.wrap?.overlayClosed();
    this.renderer.requestRender();
  }

  notice(level: NoticeLevel, text: string): void {
    this.showNotice(level, text);
  }

  runCommand(id: CommandId): void {
    this.app.commands.run(id).catch((error: unknown) => {
      // Core commands already raise an error notice through the app before rethrowing.
      const core = this.app.commands.get(id) !== undefined && !UI_COMMANDS.some((command) => command.id === id);
      if (!core) this.showNotice("error", error instanceof Error ? error.message : String(error));
    });
  }

  // ---------- overlays ----------

  private open(kind: OverlayKind): void {
    if (this.torndown) return;
    this.close();
    const view = this.createOverlay(kind);
    this.renderer.root.add(view.root);
    const offBindings = this.keys.scoped(view.root, [
      {
        key: "escape",
        run: () => {
          if (this.overlay?.view === view && !view.escape?.()) this.close();
        },
      },
      ...view.bindings,
    ]);
    this.overlay = { kind, view, offBindings };
    view.focusTarget.focus();
    this.renderer.requestRender();
  }

  private createOverlay(kind: OverlayKind): Overlay {
    switch (kind) {
      case "messages":
        return messagesOverlay(this, this.reader.messageKey);
      case "sessions":
        return sessionsOverlay(this);
      case "phrases":
        return phrasesOverlay(this);
      case "palette":
        return paletteOverlay(this);
      case "settings":
        return settingsOverlay(this);
      case "help":
        return helpOverlay(this);
    }
  }

  // ---------- rendering ----------

  private shownMessage(): HarnessMessage | undefined {
    const messages = this.app.sessions.messages;
    const key = this.app.selectedMessageKey;
    const selected = key ? messages.find((m) => m.key === key) : undefined;
    // Like the app's default selection: the newest final answer, not in-between narration.
    return selected ?? messages.findLast((m) => !m.commentary) ?? messages.at(-1);
  }

  private renderMessage(): void {
    const message = this.shownMessage();
    const session = this.app.sessions.session;
    this.reader.setMessage(
      message,
      session
        ? `No answers yet in ${session.harness} · ${session.title ?? session.id}. They appear here as soon as the harness replies.`
        : "No harness session found for this directory. Start omp, pi, codex or claude here, or press the switch-session key to pick one.",
    );
    this.renderHeader();
    this.renderHighlight(this.app.playback.state);
  }

  private renderHeader(): void {
    const { session, messages } = this.app.sessions;
    const message = this.shownMessage();
    const newest = messages.at(-1);
    const lastActivity = Math.max(session?.updatedAt.getTime() ?? 0, newest?.createdAt.getTime() ?? 0);
    this.reader.setHeader(
      headerLine({
        session,
        live: session !== undefined && Date.now() - lastActivity < LIVE_MS,
        position: message ? { index: messages.indexOf(message), count: messages.length } : undefined,
      }),
    );
  }

  private renderHighlight(state: PlaybackState): void {
    const script = this.app.playback.script;
    const segment =
      state.status !== "idle" && script && script.messageKey === this.reader.messageKey ? script.segments[state.segmentIndex] : undefined;
    this.reader.setHighlight(segment?.display);
  }

  private renderStatus(state: PlaybackState = this.app.playback.state): void {
    const helpKey = this.app.config.keys.help?.[0];
    const input = { state, config: this.app.config, helpKey: helpKey ? this.keys.format(helpKey) : undefined, pending: this.pending };
    this.reader.setStatus(this.wrap ? this.wrap.status(input) : statusLine(input));
  }

  private showNotice(level: NoticeLevel, text: string): void {
    if (this.currentNotice?.text === text && this.currentNotice.level === level) return;
    this.currentNotice = { level, text };
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.currentNotice = undefined;
      this.renderNotice();
    }, NOTICE_MS);
    this.noticeTimer.unref?.();
    this.renderNotice();
  }

  private renderNotice(): void {
    const error = this.app.playback.state.error;
    const shown = error ? { level: "error" as const, text: error } : this.currentNotice;
    if (!shown) {
      this.reader.setNotice([]);
      return;
    }
    const color = shown.level === "error" ? theme.error : shown.level === "warning" ? theme.warning : theme.info;
    const icon = shown.level === "info" ? "ℹ" : "⚠";
    this.reader.setNotice([chunk(`${icon} ${shown.text}`, { fg: color })]);
  }

  private rebind(startup: boolean): void {
    if (this.torndown) return;
    const analysis = this.keys.bind(this.app.config.keys);
    const problems = describeKeyProblems(analysis);
    if (problems) this.showNotice("warning", problems);
    else if (!startup) this.renderStatus();
  }

  // ---------- lifecycle ----------

  private quit(): void {
    this.close();
    if (!this.renderer.isDestroyed) this.renderer.destroy();
    else this.teardown();
  }

  private teardown(): void {
    if (this.torndown) return;
    this.torndown = true;
    this.close();
    clearTimeout(this.noticeTimer);
    clearInterval(this.liveTimer);
    for (const cleanup of this.cleanups.splice(0).reverse()) {
      try {
        cleanup();
      } catch {
        // Cleanup must not prevent restoring the terminal or resolving runTui.
      }
    }
    const settle = () => (this.failure !== undefined ? this.finish?.reject(this.failure) : this.finish?.resolve());
    // Wrap mode resolves runTui only once the harness has stopped.
    if (this.wrap) void this.wrap.dispose().then(settle);
    else settle();
  }
}

export function describeKeyProblems(analysis: KeyAnalysis): string | undefined {
  const parts = [
    ...analysis.conflicts.map((c) => `${c.key} → ${c.commands.join(" & ")}`),
    ...analysis.invalid.map((p) => `${p.command}: ${p.message}`),
    ...analysis.errors,
  ];
  return parts.length > 0 ? `Key conflicts: ${parts.join("; ")}` : undefined;
}
