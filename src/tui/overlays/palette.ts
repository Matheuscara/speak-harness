// Command palette (fuzzy filter over the registry) and the Help cheat sheet generated from the live keymap.

import { InputRenderable, InputRenderableEvents, ScrollBoxRenderable, StyledText, TextRenderable, type TextChunk } from "@opentui/core";
import type { Command, CommandId } from "../../core/types.ts";
import { chunk } from "../markdown-view.ts";
import { theme } from "../theme.ts";
import { createList, createPanel, type Overlay, type OverlayHost } from "./panel.ts";

/**
 * Subsequence match score (higher is better), or undefined when `query` does not match. Consecutive
 * characters and word starts score more; earlier matches beat later ones.
 */
export function fuzzyScore(query: string, text: string): number | undefined {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (q === "") return 0;
  const t = text.toLowerCase();
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const ch of q) {
    const index = t.indexOf(ch, from);
    if (index < 0) return undefined;
    const wordStart = index === 0 || /[\s\-_:./]/.test(t[index - 1] ?? "");
    score += 1 + (index === previous + 1 ? 3 : 0) + (wordStart ? 2 : 0) - Math.min(index - from, 5) * 0.1;
    previous = index;
    from = index + 1;
  }
  return score;
}

export function filterCommands(commands: readonly Command[], query: string): Command[] {
  return commands
    .map((command, order) => ({ command, order, score: fuzzyScore(query, `${command.title} ${command.id}`) }))
    .filter((entry): entry is { command: Command; order: number; score: number } => entry.score !== undefined)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((entry) => entry.command);
}

function keysOf(host: OverlayHost, id: CommandId): string {
  return (host.app.config.keys[id] ?? []).map((key) => host.keys.format(key)).join(", ");
}

export function paletteOverlay(host: OverlayHost): Overlay {
  const { renderer, app } = host;
  const root = createPanel(renderer, "overlay-palette", "Command palette", "↑↓ choose · enter run · esc close");
  const input = new InputRenderable(renderer, {
    id: "palette-input",
    placeholder: "Type a command…",
    flexShrink: 0,
    backgroundColor: theme.bg,
    focusedBackgroundColor: theme.bg,
    textColor: theme.fg,
    focusedTextColor: theme.fg,
  });
  const list = createList(renderer, "palette-list");
  list.marginTop = 1;
  root.add(input);
  root.add(list);
  const commands = app.commands.list();
  const update = () => {
    const matches = filterCommands(commands, input.value);
    list.options =
      matches.length === 0
        ? [{ name: "No matching command", description: "" }]
        : matches.map((command) => {
            const keys = keysOf(host, command.id);
            return { name: command.title, description: `  ${command.id}${keys ? ` · ${keys}` : ""}`, value: command.id };
          });
    list.setSelectedIndex(0);
  };
  input.on(InputRenderableEvents.INPUT, update);
  update();

  const run = () => {
    const id = list.getSelectedOption()?.value as CommandId | undefined;
    host.close();
    if (id) host.runCommand(id);
  };
  return {
    root,
    focusTarget: input,
    bindings: [
      { key: "up", run: () => list.moveUp() },
      { key: "down", run: () => list.moveDown() },
      { key: "ctrl+p", run: () => list.moveUp() },
      { key: "ctrl+n", run: () => list.moveDown() },
      { key: "return", run },
    ],
  };
}

const GROUP_TITLES: Record<Command["group"], string> = {
  playback: "Playback",
  navigation: "Navigation",
  voice: "Voice",
  study: "Study",
  app: "App",
};

/** Cheat-sheet lines: commands grouped, each with its live bindings. */
export function cheatSheet(host: OverlayHost): TextChunk[] {
  const out: TextChunk[] = [];
  const commands = host.app.commands.list();
  const leader = host.app.config.keys.leader;
  if (leader) out.push(chunk("Leader ", { fg: theme.muted }), chunk(host.keys.format(leader), { fg: theme.code, bold: true }), chunk("\n", {}));
  for (const group of Object.keys(GROUP_TITLES) as Command["group"][]) {
    const inGroup = commands.filter((command) => command.group === group);
    if (inGroup.length === 0) continue;
    out.push(chunk(`\n${GROUP_TITLES[group]}\n`, { fg: theme.heading, bold: true }));
    for (const command of inGroup) {
      const keys = keysOf(host, command.id) || "—";
      out.push(chunk(`  ${keys.padEnd(16)} `, { fg: theme.code }), chunk(`${command.title}\n`, { fg: theme.fg }));
    }
  }
  return out;
}

export function helpOverlay(host: OverlayHost): Overlay {
  const { renderer } = host;
  const root = createPanel(renderer, "overlay-help", "Keys", "j/k scroll · esc close");
  const scroll = new ScrollBoxRenderable(renderer, { id: "help-scroll", flexGrow: 1, verticalScrollbarOptions: { visible: false } });
  const text = new TextRenderable(renderer, { id: "help-text", wrapMode: "word" });
  scroll.add(text);
  root.add(scroll);
  const refresh = () => {
    text.content = new StyledText(cheatSheet(host));
  };
  refresh();
  return {
    root,
    focusTarget: scroll,
    bindings: [
      { key: "j", run: () => scroll.scrollBy(1) },
      { key: "down", run: () => scroll.scrollBy(1) },
      { key: "k", run: () => scroll.scrollBy(-1) },
      { key: "up", run: () => scroll.scrollBy(-1) },
    ],
    refresh,
  };
}
