// Recognizes harness commands (`omp`, `codex`, `bunx @openai/codex`, `env X=1 claude`…) so wrap mode follows the
// harness's own transcripts and uses screen capture only for commands no adapter knows.

import { basename } from "node:path";
import type { HarnessId } from "../core/types.ts";

/** Executable names of harnesses with adapters. */
const BINARIES: Readonly<Record<string, HarnessId>> = { omp: "omp", pi: "pi", codex: "codex", claude: "claude-code" };

/** npm package names (without version) that install those executables. */
const PACKAGES: ReadonlyArray<readonly [RegExp, HarnessId]> = [
  [/^@oh-my-pi\//, "omp"],
  [/^@mariozechner\/pi-coding-agent$/, "pi"],
  [/^@openai\/codex$/, "codex"],
  [/^@anthropic-ai\/claude-code$/, "claude-code"],
];

/** Harness run by `command` (argv), looking through `env` and package runners (`bunx`, `npx`, `pnpm dlx`…). */
export function recognizeHarness(command: readonly string[]): HarnessId | undefined {
  const [program, ...args] = command;
  if (program === undefined) return undefined;
  const name = basename(program).replace(/\.(?:exe|cmd|bat)$/i, "");
  const direct = BINARIES[name];
  if (direct) return direct;
  if (name === "env") return recognizeHarness(skipEnv(args));
  const runnerArgs = runnerArguments(name, args);
  if (!runnerArgs) return undefined;
  for (const spec of packageCandidates(runnerArgs)) {
    const id = harnessOfPackage(spec);
    if (id) return id;
  }
  return undefined;
}

/** Arguments after the runner itself, or undefined when `name` is not a package runner. */
function runnerArguments(name: string, args: readonly string[]): readonly string[] | undefined {
  const [first, ...rest] = args;
  switch (name) {
    case "bunx":
    case "npx":
    case "pnpx":
      return args;
    case "bun":
      return first === "x" ? rest : undefined;
    case "pnpm":
    case "yarn":
      return first === "dlx" ? rest : undefined;
    case "npm":
      return first === "exec" || first === "x" ? rest : undefined;
    default:
      return undefined;
  }
}

/** Packages named by `-p/--package` plus the first positional argument (the package or binary to run). */
function packageCandidates(args: readonly string[]): string[] {
  const candidates: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--") {
      const next = args[i + 1];
      if (next !== undefined) candidates.push(next);
      break;
    }
    if (arg === "-p" || arg === "--package") {
      const value = args[++i];
      if (value !== undefined) candidates.push(value);
      continue;
    }
    if (arg.startsWith("--package=")) {
      candidates.push(arg.slice("--package=".length));
      continue;
    }
    if (arg.startsWith("-")) continue;
    candidates.push(arg);
    break;
  }
  return candidates;
}

function harnessOfPackage(spec: string): HarnessId | undefined {
  // `@scope/name@1.2.3` and `name@latest` → package name.
  const at = spec.lastIndexOf("@");
  const name = at > 0 ? spec.slice(0, at) : spec;
  if (name.startsWith("@")) return PACKAGES.find(([pattern]) => pattern.test(name))?.[1];
  return BINARIES[basename(name)];
}

/** The command `env [options] [NAME=value…] command…` runs. */
function skipEnv(args: readonly string[]): readonly string[] {
  let i = 0;
  while (i < args.length) {
    const arg = args[i] as string;
    if (arg === "--") return args.slice(i + 1);
    if (arg === "-u" || arg === "--unset" || arg === "-C" || arg === "--chdir") i += 2;
    else if (arg.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) i += 1;
    else break;
  }
  return args.slice(i);
}
