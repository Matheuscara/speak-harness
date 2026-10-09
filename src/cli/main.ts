#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { sendControlCommand } from "../control/client.ts";
import { startControlServer } from "../control/server.ts";
import { createApp } from "../core/app.ts";
import { COMMAND_IDS, DEFAULT_CONFIG } from "../core/config/index.ts";
import { resolveVoice } from "../core/playback/voices.ts";
import type { AppCore, EngineClient, HarnessMessage, Lang } from "../core/types.ts";
import { findVoice } from "../engine/catalog.ts";
import { createEngineClient } from "../engine/client.ts";

export type CliCommand =
  | { kind: "tui" }
  | { kind: "run"; command: string[] }
  | { kind: "say"; source: string | undefined }
  | { kind: "follow" }
  | { kind: "ctl"; command: string; args: string[] }
  | { kind: "voices-list" }
  | { kind: "voices-install"; voice: string }
  | { kind: "setup" }
  | { kind: "help" }
  | { kind: "version" };

export class UsageError extends Error {
  override name = "UsageError";
}

/** Voices the default config uses; `setup` installs them and `say` installs them on demand. */
export const DEFAULT_VOICES: readonly string[] = [
  ...new Set([DEFAULT_CONFIG.voices.primary, DEFAULT_CONFIG.voices.alternate, ...Object.values(DEFAULT_CONFIG.voices.languages)]),
];

export const HELP = `speakh — read AI coding-harness answers aloud

Usage:
  speakh                      reader TUI following the harness session of this directory
  speakh run -- <cmd...>      run a harness inside SpeakHarness (wrap mode)
  speakh say [file|-]         read a markdown file (or stdin) once and exit
  speakh follow               read new answers in this directory aloud, without UI
  speakh ctl <command> [args] send a command to the running speakh
  speakh voices [list]        list voices and whether they are installed
  speakh voices install <id>  download a voice (e.g. piper:pt_BR-faber-medium)
  speakh setup                install the default voices (${DEFAULT_VOICES.join(", ")})
  speakh --help | --version

Commands for ctl and key bindings:
  ${COMMAND_IDS.join(", ")}

Config: $XDG_CONFIG_HOME/speak-harness/config.toml (created when settings are saved).
`;

export function parseCliArgs(argv: readonly string[]): CliCommand {
  const [first, ...rest] = argv;
  switch (first) {
    case undefined:
      return { kind: "tui" };
    case "-h":
    case "--help":
    case "help":
      return { kind: "help" };
    case "-v":
    case "--version":
      return { kind: "version" };
    case "run": {
      const command = rest[0] === "--" ? rest.slice(1) : rest;
      if (command.length === 0) throw new UsageError("speakh run needs a command, e.g. `speakh run -- omp`");
      return { kind: "run", command };
    }
    case "say":
      if (rest.length > 1) throw new UsageError("speakh say takes one file (or `-` for stdin)");
      return { kind: "say", source: rest[0] };
    case "follow":
      if (rest.length > 0) throw new UsageError("speakh follow takes no arguments");
      return { kind: "follow" };
    case "ctl": {
      const [command, ...args] = rest;
      if (!command) throw new UsageError("speakh ctl needs a command id, e.g. `speakh ctl replay-message`");
      return { kind: "ctl", command, args };
    }
    case "voices": {
      const [action, voice, ...extra] = rest;
      if (action === undefined || (action === "list" && voice === undefined)) return { kind: "voices-list" };
      if (action === "install" && voice !== undefined && extra.length === 0) return { kind: "voices-install", voice };
      throw new UsageError("usage: speakh voices [list | install <voice-id>]");
    }
    case "setup":
      return { kind: "setup" };
    default:
      throw new UsageError(`unknown command "${first}" (see speakh --help)`);
  }
}

// ---------- helpers ----------

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** Installs one voice, drawing a single progress line on stderr. */
async function installVoice(engine: EngineClient, id: string): Promise<void> {
  const info = findVoice(id);
  const details = info ? ` · ${info.label} · ${formatMegabytes(info.sizeBytes)} · license ${info.license}` : "";
  const label = `Installing ${id}${details}`;
  const tty = process.stderr.isTTY;
  process.stderr.write(tty ? label : `${label}\n`);
  let lastPercent = -1;
  await engine.install(id, (done, total) => {
    if (!tty || total <= 0) return;
    const percent = Math.floor((done / total) * 100);
    if (percent === lastPercent) return;
    lastPercent = percent;
    process.stderr.write(`\r\x1b[2K${label} — ${percent}% (${formatMegabytes(done)} / ${formatMegabytes(total)})`);
  });
  process.stderr.write(tty ? `\r\x1b[2K${label} — done\n` : `Installed ${id}\n`);
}

function waitForSignal(): Promise<NodeJS.Signals> {
  const { promise, resolve } = Promise.withResolvers<NodeJS.Signals>();
  process.once("SIGINT", () => resolve("SIGINT"));
  process.once("SIGTERM", () => resolve("SIGTERM"));
  return promise;
}

async function readMarkdown(source: string | undefined): Promise<string> {
  if (source !== undefined && source !== "-") return readFile(source, "utf8");
  if (source === undefined && process.stdin.isTTY) {
    throw new UsageError("speakh say needs a file, or markdown on stdin (`speakh say -`)");
  }
  return new Response(Bun.stdin.stream()).text();
}

function firstLine(message: HarnessMessage): string {
  const line = message.markdown.split("\n").map((text) => text.replace(/^[#>*\-\s]+/, "").trim()).find((text) => text !== "") ?? "";
  return line.length > 72 ? `${line.slice(0, 71)}…` : line;
}

function printNotices(app: AppCore): () => void {
  return app.subscribe((event) => {
    if (event.type === "notice" && event.level !== "info") console.error(`speakh: ${event.text}`);
  });
}

// ---------- modes ----------

async function runInteractive(wrapCommand: string[] | undefined): Promise<void> {
  const app = await createApp({ cwd: process.cwd() });
  const control = await startControlServer(app.commands).catch((error: unknown) => {
    console.error(`speakh: control socket unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  });
  try {
    // Loaded on demand: headless commands (say, follow, ctl, voices) must not load OpenTUI's native renderer.
    const { runTui } = await import("../tui/index.ts");
    await runTui(app, wrapCommand ? { wrapCommand } : {});
  } finally {
    await control?.close();
    await app.dispose();
  }
}

async function say(source: string | undefined): Promise<number> {
  const markdown = await readMarkdown(source);
  const app = await createApp({ cwd: process.cwd(), followSessions: false, autoRead: false });
  const stopNotices = printNotices(app);
  try {
    const message = app.sessions.addManual(markdown);
    const script = app.scriptFor(message);
    if (script.segments.length === 0) {
      console.error("speakh: nothing to read");
      return 0;
    }
    const voices = new Map<Lang, string>();
    for (const segment of script.segments) voices.set(segment.lang, resolveVoice(app.config, "auto", segment.lang));
    console.error(`Voices: ${[...voices].map(([lang, voice]) => `${lang} → ${voice}`).join(" · ")}`);

    const installed = new Set((await app.engine.voices()).filter((voice) => voice.installed).map((voice) => voice.id));
    for (const voice of new Set(voices.values())) {
      if (installed.has(voice)) continue;
      if (!DEFAULT_VOICES.includes(voice)) {
        console.error(`speakh: voice ${voice} is not installed. Install it with: speakh voices install ${voice}`);
        return 1;
      }
      await installVoice(app.engine, voice);
    }

    const finished = Promise.withResolvers<void>();
    const unsubscribe = app.playback.subscribe((state) => {
      if (state.status === "idle") finished.resolve();
    });
    const onSignal = (): void => app.playback.stop();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    app.playback.play(script);
    await finished.promise;
    unsubscribe();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    // Playback errors were already printed as notices.
    return app.playback.state.error ? 1 : 0;
  } finally {
    stopNotices();
    await app.dispose();
  }
}

async function follow(): Promise<void> {
  const cwd = process.cwd();
  const app = await createApp({ cwd, autoRead: true });
  const stopNotices = printNotices(app);
  const control = await startControlServer(app.commands).catch((error: unknown) => {
    console.error(`speakh: control socket unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  });
  const stopSessions = app.sessions.subscribe((event) => {
    if (event.type === "session") {
      const session = event.session;
      console.log(session ? `Following ${session.harness} session ${session.title ?? session.id}` : `No harness session found for ${cwd} yet`);
    } else if (event.type === "message" && event.message.final && !event.message.historical) {
      const time = event.message.createdAt.toTimeString().slice(0, 5);
      console.log(`${time} ${event.message.session.harness} · ${firstLine(event.message)}`);
    }
  });
  console.log(`Reading new answers in ${cwd} aloud (ctrl+c to stop)`);
  try {
    await waitForSignal();
  } finally {
    stopSessions();
    stopNotices();
    await control?.close();
    await app.dispose();
  }
}

async function listVoices(): Promise<void> {
  const engine = createEngineClient();
  try {
    const voices = await engine.voices();
    const width = Math.max(...voices.map((voice) => voice.id.length));
    for (const voice of voices) {
      const mark = voice.installed ? "✓" : " ";
      console.log(`${mark} ${voice.id.padEnd(width)}  ${voice.lang.padEnd(5)}  ${formatMegabytes(voice.sizeBytes).padStart(9)}  ${voice.label} (${voice.license})`);
    }
  } finally {
    await engine.close();
  }
}

async function installVoices(ids: readonly string[]): Promise<void> {
  const engine = createEngineClient();
  try {
    const installed = new Set((await engine.voices()).filter((voice) => voice.installed).map((voice) => voice.id));
    for (const id of ids) {
      if (installed.has(id)) {
        console.error(`✓ ${id} already installed`);
        continue;
      }
      await installVoice(engine, id);
    }
  } finally {
    await engine.close();
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const command = parseCliArgs(argv);
  switch (command.kind) {
    case "help":
      process.stdout.write(HELP);
      return 0;
    case "version": {
      const pkg: unknown = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
      const version = typeof pkg === "object" && pkg !== null && "version" in pkg ? String(pkg.version) : "unknown";
      console.log(`speakh ${version}`);
      return 0;
    }
    case "tui":
      await runInteractive(undefined);
      return 0;
    case "run":
      await runInteractive(command.command);
      return 0;
    case "say":
      return say(command.source);
    case "follow":
      await follow();
      return 0;
    case "ctl":
      await sendControlCommand(command.command, command.args);
      return 0;
    case "voices-list":
      await listVoices();
      return 0;
    case "voices-install":
      if (!findVoice(command.voice)) throw new UsageError(`unknown voice "${command.voice}" (see speakh voices list)`);
      await installVoices([command.voice]);
      return 0;
    case "setup":
      await installVoices(DEFAULT_VOICES);
      console.error("Default voices installed.");
      return 0;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`speakh: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(error instanceof UsageError ? 2 : 1);
    },
  );
}
