// Prefix-key state machine for wrap mode: keys go to the harness until the prefix; the next key runs one
// SpeakHarness command through the keymap (multi-key sequences stay in the prefix), prefix twice sends a literal
// prefix to the harness, esc cancels.

export type PrefixPhase = "idle" | "armed" | "sequence";

/**
 * - `harness`: send the key to the harness.
 * - `arm`: the prefix was pressed; consume it.
 * - `literal`: the prefix was pressed twice; send it to the harness.
 * - `cancel`: esc after the prefix; consume it (and drop any pending keymap sequence).
 * - `keymap`: let the keymap resolve the key, then report the outcome with `resolved`.
 */
export type PrefixAction = "harness" | "arm" | "literal" | "cancel" | "keymap";

export class PrefixState {
  phase: PrefixPhase = "idle";

  /** True while keys belong to SpeakHarness (after the prefix, until a command resolves or esc). */
  get active(): boolean {
    return this.phase !== "idle";
  }

  press(key: { prefix: boolean; escape: boolean }): PrefixAction {
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
        if (key.escape) {
          this.phase = "idle";
          return "cancel";
        }
        return "keymap";
      case "sequence":
        if (key.escape) {
          this.phase = "idle";
          return "cancel";
        }
        return "keymap";
    }
  }

  /** Outcome of a `keymap` key: the keymap still waits for more keys of a sequence, or it is done. */
  resolved(sequencePending: boolean): void {
    this.phase = sequencePending ? "sequence" : "idle";
  }

  /** The keymap dropped its pending sequence (it completed or timed out). */
  sequenceCleared(): void {
    if (this.phase === "sequence") this.phase = "idle";
  }

  reset(): void {
    this.phase = "idle";
  }
}
