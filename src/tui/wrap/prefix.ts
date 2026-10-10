// Prefix-key state machine for wrap mode. Keys go to the harness until the prefix; the next key runs one
// SpeakHarness command through the keymap (multi-key sequences stay in the prefix), prefix twice sends a literal
// prefix to the harness, esc cancels. Prefix then → moves the keyboard to the reader until esc, ← or the prefix.

export type PrefixPhase = "idle" | "armed" | "sequence" | "reader";

export interface PrefixKey {
  prefix: boolean;
  escape: boolean;
  /** Arrow keys without modifiers. */
  left?: boolean;
  right?: boolean;
}

/**
 * - `harness`: send the key to the harness.
 * - `arm`: the prefix was pressed; consume it.
 * - `literal`: the prefix was pressed twice; send it to the harness.
 * - `cancel`: esc after the prefix; consume it (and drop any pending keymap sequence).
 * - `keymap`: let the keymap resolve the key, then report the outcome with `resolved`.
 * - `focus-reader` / `focus-harness`: the keyboard moves to that pane; consume the key.
 */
export type PrefixAction = "harness" | "arm" | "literal" | "cancel" | "keymap" | "focus-reader" | "focus-harness";

export class PrefixState {
  phase: PrefixPhase = "idle";
  /** Where keys go once a command resolves: back to the harness, or staying in the reader. */
  private home: "harness" | "reader" = "harness";

  /** True while keys belong to SpeakHarness. */
  get active(): boolean {
    return this.phase !== "idle";
  }

  /** True while the reader keeps the keyboard between commands. */
  get readerFocused(): boolean {
    return this.home === "reader";
  }

  press(key: PrefixKey): PrefixAction {
    switch (this.phase) {
      case "idle":
        if (!key.prefix) return "harness";
        this.phase = "armed";
        return "arm";
      case "armed":
        if (key.prefix) {
          this.phase = "idle";
          return "literal";
        }
        if (key.right) return this.focus("reader");
        if (key.escape || key.left) {
          this.phase = "idle";
          return key.left ? "focus-harness" : "cancel";
        }
        return "keymap";
      case "reader":
        if (key.prefix || key.escape || key.left) return this.focus("harness");
        return "keymap";
      case "sequence":
        if (key.escape) {
          this.phase = this.restingPhase();
          return "cancel";
        }
        return "keymap";
    }
  }

  /** Outcome of a `keymap` key: the keymap still waits for more keys of a sequence, or it is done. */
  resolved(sequencePending: boolean): void {
    this.phase = sequencePending ? "sequence" : this.restingPhase();
  }

  /** The keymap dropped its pending sequence (it completed or timed out). */
  sequenceCleared(): void {
    if (this.phase === "sequence") this.phase = this.restingPhase();
  }

  reset(): void {
    this.home = "harness";
    this.phase = "idle";
  }

  private focus(pane: "harness" | "reader"): PrefixAction {
    this.home = pane;
    this.phase = this.restingPhase();
    return pane === "reader" ? "focus-reader" : "focus-harness";
  }

  private restingPhase(): PrefixPhase {
    return this.home === "reader" ? "reader" : "idle";
  }
}
