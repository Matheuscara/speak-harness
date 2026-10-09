import { homedir } from "node:os";
import type { HarnessAdapter, HarnessId } from "../core/types.ts";
import { createClaudeCodeAdapter } from "./claude-code.ts";
import { createCodexAdapter } from "./codex.ts";
import { createOmpAdapter, createPiAdapter } from "./omp.ts";

/** File-backed adapters for the enabled harnesses (`capture` and `manual` have none), reading under `home`. */
export function createAdapters(enabled: readonly HarnessId[], options: { home?: string } = {}): HarnessAdapter[] {
  const home = options.home ?? homedir();
  const adapters: HarnessAdapter[] = [];
  for (const id of new Set(enabled)) {
    if (id === "omp") adapters.push(createOmpAdapter(home));
    else if (id === "pi") adapters.push(createPiAdapter(home));
    else if (id === "codex") adapters.push(createCodexAdapter(home));
    else if (id === "claude-code") adapters.push(createClaudeCodeAdapter(home));
  }
  return adapters;
}
