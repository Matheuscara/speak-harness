// Keymap wiring: config `keys` → one global @opentui/keymap layer dispatching command ids, focus-scoped layers
// for overlays, conflict analysis, and single-key capture for the keymap editor.

import type { CliRenderer, KeyEvent, Renderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import {
  registerDefaultKeys,
  registerEnabledFields,
  registerEscapeClearsPendingSequence,
  registerLeader,
  registerMetadataFields,
  registerNeovimDisambiguation,
} from "@opentui/keymap/addons";
import { createOpenTuiKeymap } from "@opentui/keymap/opentui";
import type { CommandId, Config } from "../core/types.ts";

export const COMMAND_IDS: readonly CommandId[] = [
  "play-pause",
  "stop",
  "next-sentence",
  "prev-sentence",
  "next-block",
  "prev-block",
  "repeat-sentence",
  "repeat-slower",
  "replay-message",
  "read-latest",
  "next-message",
  "prev-message",
  "read-table",
  "auto-read",
  "study-mode",
  "study-continue",
  "save-phrase",
  "voice-auto",
  "voice-primary",
  "voice-alternate",
  "speed-up",
  "speed-down",
  "switch-session",
  "messages",
  "phrases",
  "command-palette",
  "settings",
  "help",
  "quit",
];

export interface KeyConflict {
  /** Display form of the shared sequence. */
  key: string;
  commands: CommandId[];
}

export interface KeyProblem {
  command: CommandId;
  key: string;
  message: string;
}

export interface KeyAnalysis {
  conflicts: KeyConflict[];
  invalid: KeyProblem[];
  /** Other keymap compile errors reported while binding. */
  errors: string[];
}

export interface ScopedBinding {
  key: string;
  run: () => void;
}

/** Disambiguation wait when one binding is a prefix of another (`g` vs `gg`). */
const SEQUENCE_TIMEOUT_MS = 600;

export interface KeyControllerOptions {
  /** Called (outside keymap dispatch) when a global binding fires. */
  onCommand: (id: CommandId) => void;
  /** Global bindings are inactive while this returns true (open overlays). */
  blocked: () => boolean;
  title: (id: CommandId) => string;
}

export class KeyController {
  readonly keymap: Keymap<Renderable, KeyEvent>;
  private offLayer: (() => void) | undefined;
  private offLeader: (() => void) | undefined;
  private leader: string | undefined;
  private readonly offAddons: (() => void)[];
  private readonly compileErrors: string[] = [];
  private readonly options: KeyControllerOptions;

  constructor(renderer: CliRenderer, options: KeyControllerOptions) {
    this.options = options;
    this.keymap = createOpenTuiKeymap(renderer);
    this.offAddons = [
      registerDefaultKeys(this.keymap),
      registerEnabledFields(this.keymap),
      registerMetadataFields(this.keymap),
      registerNeovimDisambiguation(this.keymap, { timeoutMs: SEQUENCE_TIMEOUT_MS }),
      registerEscapeClearsPendingSequence(this.keymap),
      this.keymap.on("error", (event) => this.compileErrors.push(event.message)),
    ];
  }

  /** Replaces the global layer with bindings from `keys`. Returns problems found while compiling. */
  bind(keys: Config["keys"]): KeyAnalysis {
    this.offLayer?.();
    this.offLayer = undefined;
    if (keys.leader !== this.leader) {
      this.offLeader?.();
      this.offLeader = keys.leader ? registerLeader(this.keymap, { trigger: keys.leader }) : undefined;
      this.leader = keys.leader;
    }
    const analysis = this.analyze(keys);
    const invalid = new Set(analysis.invalid.map((p) => `${p.command}\u0000${p.key}`));
    const bindings = COMMAND_IDS.flatMap((id) =>
      (keys[id] ?? []).filter((key) => !invalid.has(`${id}\u0000${key}`)).map((key) => ({ key, cmd: id })),
    );
    this.compileErrors.length = 0;
    this.offLayer = this.keymap.registerLayer({
      enabled: () => !this.options.blocked(),
      commands: COMMAND_IDS.map((id) => ({
        name: id,
        title: this.options.title(id),
        run: () => {
          queueMicrotask(() => this.options.onCommand(id));
        },
      })),
      bindings,
    });
    return { ...analysis, errors: [...this.compileErrors] };
  }

  /** Canonical form of a key sequence; throws on invalid syntax. */
  canonical(key: string): string {
    const parts = this.keymap.parseKeySequence(key);
    if (parts.length === 0) throw new Error(`Invalid key "${key}": empty`);
    return parts.map((part) => part.match).join(" ");
  }

  format(key: string): string {
    try {
      return this.keymap.formatKey(key, { separator: " " });
    } catch {
      return key;
    }
  }

  analyze(keys: Config["keys"]): Omit<KeyAnalysis, "errors"> {
    const owners = new Map<string, { key: string; commands: CommandId[] }>();
    const invalid: KeyProblem[] = [];
    for (const id of COMMAND_IDS) {
      for (const key of keys[id] ?? []) {
        let canonical: string;
        try {
          canonical = this.canonical(key);
        } catch (error) {
          invalid.push({ command: id, key, message: error instanceof Error ? error.message : String(error) });
          continue;
        }
        const entry = owners.get(canonical) ?? { key: this.format(key), commands: [] };
        if (!entry.commands.includes(id)) entry.commands.push(id);
        owners.set(canonical, entry);
      }
    }
    const conflicts = [...owners.values()].filter((entry) => entry.commands.length > 1);
    return { conflicts, invalid };
  }

  /** Commands other than `command` already bound to `key`. */
  conflictsFor(keys: Config["keys"], command: CommandId, key: string): CommandId[] {
    const canonical = this.canonical(key);
    return COMMAND_IDS.filter(
      (id) =>
        id !== command &&
        (keys[id] ?? []).some((other) => {
          try {
            return this.canonical(other) === canonical;
          } catch {
            return false;
          }
        }),
    );
  }

  /** Focus-scoped bindings active while `target` or a descendant has focus. Handlers run outside dispatch. */
  scoped(target: Renderable, bindings: readonly ScopedBinding[]): () => void {
    return this.keymap.registerLayer({
      target,
      targetMode: "focus-within",
      priority: 10,
      bindings: bindings.map(({ key, run }) => ({
        key,
        cmd: () => {
          queueMicrotask(run);
        },
      })),
    });
  }

  /** Consumes the next key press (escape cancels) and reports it in binding syntax. */
  capture(onKey: (key: string | undefined) => void): () => void {
    const off = this.keymap.intercept(
      "key",
      (ctx) => {
        ctx.consume({ preventDefault: true, stopPropagation: true });
        const key = ctx.event.name === "escape" && !ctx.event.ctrl && !ctx.event.meta ? undefined : keyFromEvent(ctx.event);
        queueMicrotask(() => {
          off();
          onKey(key);
        });
      },
      { priority: 1000 },
    );
    return off;
  }

  onPending(listener: (display: string) => void): () => void {
    return this.keymap.on("pendingSequence", (parts) => listener(parts.map((part) => part.display).join("")));
  }

  dispose(): void {
    this.offLayer?.();
    this.offLeader?.();
    for (const off of this.offAddons.reverse()) off();
  }
}

/** Binding-syntax string for a key event (`ctrl+r`, `shift+l`, `space`, `?`). */
export function keyFromEvent(event: Pick<KeyEvent, "name" | "ctrl" | "meta" | "shift" | "super">): string {
  const parts: string[] = [];
  if (event.ctrl) parts.push("ctrl");
  if (event.meta) parts.push("meta");
  if (event.super) parts.push("super");
  if (event.shift) parts.push("shift");
  parts.push(event.name === " " ? "space" : event.name);
  return parts.join("+");
}
