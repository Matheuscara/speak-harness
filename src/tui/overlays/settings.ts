// Settings: voices (with install + progress), speed, reading and study options, and the keymap editor
// (pick command → press key → conflict warning → enter saves through app.updateConfig).

import type { CommandId, Config, Lang, VoiceInfo } from "../../core/types.ts";
import { COMMAND_IDS } from "../keys.ts";
import { formatSpeed } from "../reader.ts";
import { theme } from "../theme.ts";
import { createLine, createList, createPanel, type Overlay, type OverlayHost } from "./panel.ts";

type VoiceSlot = "primary" | "alternate" | Lang;
type View = { kind: "main" } | { kind: "voices"; slot: VoiceSlot | undefined } | { kind: "keys" };

interface Item {
  label: string;
  value(config: Config): string;
  /** Enter. */
  activate(): void;
  /** Left / right. */
  adjust?(direction: 1 | -1): void;
}

interface PendingBinding {
  command: CommandId;
  key: string;
}

const LANG_LABELS: Record<Lang, string> = { en: "English", "pt-BR": "Português (BR)" };

function clampStep(value: number, step: number, direction: 1 | -1, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, value + step * direction)) * 100) / 100;
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

export function settingsOverlay(host: OverlayHost): Overlay {
  const { renderer, app, keys } = host;
  const root = createPanel(renderer, "overlay-settings", "Settings", "esc back");
  const list = createList(renderer, "settings-list");
  const hint = createLine(renderer, "settings-hint");
  const warning = createLine(renderer, "settings-warning", theme.warning);
  root.add(list);
  root.add(hint);
  root.add(warning);

  let view: View = { kind: "main" };
  let voices: VoiceInfo[] | undefined;
  let voicesError: string | undefined;
  let pending: PendingBinding | undefined;
  let stopCapture: (() => void) | undefined;
  let installing: string | undefined;
  let disposed = false;
  let mainIndex = 0;

  const update = (mutate: (draft: Config) => void) => {
    app.updateConfig(mutate).catch((error: unknown) => host.notice("error", `Could not save settings: ${error instanceof Error ? error.message : String(error)}`));
  };
  const toggle = (label: string, get: (c: Config) => boolean, set: (c: Config, v: boolean) => void): Item => ({
    label,
    value: (c) => (get(c) ? "on" : "off"),
    activate: () => update((c) => set(c, !get(c))),
    adjust: () => update((c) => set(c, !get(c))),
  });
  const voiceLabel = (id: string) => {
    const info = voices?.find((v) => v.id === id);
    return info && !info.installed ? `${id}  (not installed)` : id;
  };
  const voiceItem = (label: string, slot: VoiceSlot, get: (c: Config) => string): Item => ({
    label,
    value: (c) => voiceLabel(get(c)),
    activate: () => show({ kind: "voices", slot }),
  });
  const speedItem = (label: string, get: (c: Config) => number, set: (c: Config, v: number) => void, step: number, min: number, max: number): Item => ({
    label,
    value: (c) => formatSpeed(get(c)),
    activate: () => update((c) => set(c, clampStep(get(c), step, 1, min, max))),
    adjust: (direction) => update((c) => set(c, clampStep(get(c), step, direction, min, max))),
  });

  const items: Item[] = [
    voiceItem("Primary voice", "primary", (c) => c.voices.primary),
    voiceItem("Alternate voice", "alternate", (c) => c.voices.alternate),
    voiceItem(`Voice · ${LANG_LABELS.en}`, "en", (c) => c.voices.languages.en),
    voiceItem(`Voice · ${LANG_LABELS["pt-BR"]}`, "pt-BR", (c) => c.voices.languages["pt-BR"]),
    speedItem("Speed", (c) => c.voices.speed, (c, v) => void (c.voices.speed = v), 0.05, 0.5, 2),
    toggle("Detect language per paragraph", (c) => c.voices.autoLanguage, (c, v) => void (c.voices.autoLanguage = v)),
    toggle("Auto-read new answers", (c) => c.reading.autoRead, (c, v) => void (c.reading.autoRead = v)),
    {
      label: "Auto-read queue",
      value: (c) => c.reading.autoReadQueue,
      activate: () => update((c) => void (c.reading.autoReadQueue = c.reading.autoReadQueue === "latest" ? "all" : "latest")),
      adjust: () => update((c) => void (c.reading.autoReadQueue = c.reading.autoReadQueue === "latest" ? "all" : "latest")),
    },
    {
      label: "Tables",
      value: (c) => c.reading.tables,
      activate: () => update((c) => void (c.reading.tables = c.reading.tables === "summary" ? "rows" : "summary")),
      adjust: () => update((c) => void (c.reading.tables = c.reading.tables === "summary" ? "rows" : "summary")),
    },
    toggle("Announce quotes", (c) => c.reading.quoteCue, (c, v) => void (c.reading.quoteCue = v)),
    toggle("Study · pause after each sentence", (c) => c.study.pauseAfterSentence, (c, v) => void (c.study.pauseAfterSentence = v)),
    toggle("Study · shadowing silence", (c) => c.study.shadowing, (c, v) => void (c.study.shadowing = v)),
    speedItem("Study · shadowing factor", (c) => c.study.shadowingFactor, (c, v) => void (c.study.shadowingFactor = v), 0.25, 0.5, 3),
    speedItem("Study · slower speed", (c) => c.study.slowerSpeed, (c, v) => void (c.study.slowerSpeed = v), 0.05, 0.3, 1),
    { label: "Voices…", value: () => "install and preview the catalog", activate: () => show({ kind: "voices", slot: undefined }) },
    { label: "Key bindings…", value: () => "remap any command", activate: () => show({ kind: "keys" }) },
  ];

  const setHint = (text: string, color: string = theme.muted) => {
    hint.fg = color;
    hint.content = text;
  };

  const conflictText = (config: Config): Map<CommandId, string> => {
    const out = new Map<CommandId, string>();
    for (const conflict of keys.analyze(config.keys).conflicts) {
      for (const id of conflict.commands) {
        const others = conflict.commands.filter((other) => other !== id);
        out.set(id, `${out.get(id) ? `${out.get(id)}; ` : ""}${conflict.key} also: ${others.join(", ")}`);
      }
    }
    return out;
  };

  const voiceSlotValue = (config: Config, slot: VoiceSlot): string =>
    slot === "primary" ? config.voices.primary : slot === "alternate" ? config.voices.alternate : config.voices.languages[slot];

  const render = () => {
    const config = app.config;
    const index = list.getSelectedIndex();
    if (view.kind === "main") {
      root.title = " Settings ";
      list.options = items.map((item) => ({ name: item.label, description: `  ${item.value(config)}` }));
      list.setSelectedIndex(mainIndex);
      if (!pending) setHint("enter change · ←/→ adjust · esc close");
      warning.content = "";
    } else if (view.kind === "voices") {
      const slot = view.slot;
      root.title = slot ? ` Voice · ${slot === "primary" || slot === "alternate" ? slot : LANG_LABELS[slot]} ` : " Voices ";
      if (voicesError) {
        list.options = [{ name: `Could not list voices: ${voicesError}`, description: "" }];
      } else if (!voices) {
        list.options = [{ name: "Loading voices…", description: "" }];
      } else {
        const current = slot ? voiceSlotValue(config, slot) : undefined;
        const shown = slot === "en" || slot === "pt-BR" ? voices.filter((v) => v.lang === slot) : voices;
        list.options = shown.map((v) => ({
          name: `${v.id === current ? "✓" : " "} ${v.installed ? "●" : "○"} ${v.label}`,
          description: `    ${v.id} · ${v.lang} · ${v.installed ? "installed" : `not installed · ${megabytes(v.sizeBytes)} · ${v.license}`}`,
          value: v,
        }));
        list.setSelectedIndex(Math.min(index, Math.max(0, shown.length - 1)));
      }
      if (!installing) setHint(slot ? "enter use · i install · esc back" : "i install · esc back");
    } else {
      root.title = " Key bindings ";
      const conflicts = conflictText(config);
      list.options = COMMAND_IDS.map((id) => {
        const bound = (config.keys[id] ?? []).map((key) => keys.format(key)).join(", ") || "unbound";
        const conflict = conflicts.get(id);
        return {
          name: `${conflict ? "⚠" : " "} ${app.commands.get(id)?.title ?? id}`,
          description: `    ${id} · ${bound}${conflict ? ` · ${conflict}` : ""}`,
          value: id,
        };
      });
      list.setSelectedIndex(index);
      if (!pending && !stopCapture) setHint("enter rebind · esc back");
    }
    renderer.requestRender();
  };

  const loadVoices = () => {
    app.engine.voices().then(
      (list) => {
        voices = list;
        voicesError = undefined;
        if (!disposed) render();
      },
      (error: unknown) => {
        voicesError = error instanceof Error ? error.message : String(error);
        if (!disposed) render();
      },
    );
  };

  const show = (next: View) => {
    if (view.kind === "main") mainIndex = list.getSelectedIndex();
    view = next;
    list.setSelectedIndex(0);
    pending = undefined;
    warning.content = "";
    render();
  };

  const install = (voice: VoiceInfo) => {
    if (voice.installed) {
      setHint(`${voice.id} is already installed`);
      return;
    }
    if (installing) return;
    installing = voice.id;
    setHint(`Installing ${voice.id}… 0% of ${megabytes(voice.sizeBytes)} (${voice.license})`, theme.info);
    app.engine
      .install(voice.id, (done, total) => {
        if (!disposed) setHint(`Installing ${voice.id}… ${total > 0 ? Math.floor((done / total) * 100) : 0}% of ${megabytes(total)}`, theme.info);
      })
      .then(
        () => {
          installing = undefined;
          host.notice("info", `Installed ${voice.id}`);
          if (!disposed) {
            setHint(`Installed ${voice.id}`, theme.live);
            loadVoices();
          }
        },
        (error: unknown) => {
          installing = undefined;
          const message = `Install failed for ${voice.id}: ${error instanceof Error ? error.message : String(error)}`;
          host.notice("error", message);
          if (!disposed) setHint(message, theme.error);
        },
      );
  };

  const chooseVoice = (voice: VoiceInfo, slot: VoiceSlot) => {
    update((c) => {
      if (slot === "primary") c.voices.primary = voice.id;
      else if (slot === "alternate") c.voices.alternate = voice.id;
      else c.voices.languages[slot] = voice.id;
    });
    if (!voice.installed) setHint(`${voice.id} is not installed yet: press i to install (${megabytes(voice.sizeBytes)}, ${voice.license})`, theme.warning);
  };

  const startCapture = (command: CommandId) => {
    pending = undefined;
    warning.content = "";
    setHint(`Press the new key for "${app.commands.get(command)?.title ?? command}" · esc cancels`, theme.info);
    stopCapture = keys.capture((key) => {
      stopCapture = undefined;
      if (disposed) return;
      if (key === undefined) {
        setHint("Rebind cancelled");
        return;
      }
      let conflicts: CommandId[];
      try {
        conflicts = keys.conflictsFor(app.config.keys, command, key);
      } catch (error) {
        setHint(error instanceof Error ? error.message : String(error), theme.error);
        return;
      }
      pending = { command, key };
      setHint(`Bind ${keys.format(key)} to "${app.commands.get(command)?.title ?? command}"? enter save · esc cancel`, theme.info);
      warning.content = conflicts.length > 0 ? `⚠ ${keys.format(key)} is already bound to: ${conflicts.join(", ")}` : "";
    });
  };

  const savePending = () => {
    if (!pending) return false;
    const { command, key } = pending;
    pending = undefined;
    update((c) => {
      c.keys[command] = [key];
    });
    setHint(`Saved: ${command} → ${keys.format(key)}`, theme.live);
    return true;
  };

  const enter = () => {
    if (view.kind === "main") {
      mainIndex = list.getSelectedIndex();
      items[mainIndex]?.activate();
    } else if (view.kind === "voices") {
      const voice = list.getSelectedOption()?.value as VoiceInfo | undefined;
      if (voice && view.slot) chooseVoice(voice, view.slot);
      else if (voice) install(voice);
    } else if (!savePending()) {
      const command = list.getSelectedOption()?.value as CommandId | undefined;
      if (command) startCapture(command);
    }
  };

  const adjust = (direction: 1 | -1) => {
    if (view.kind !== "main") return;
    mainIndex = list.getSelectedIndex();
    items[mainIndex]?.adjust?.(direction);
  };

  loadVoices();
  render();

  return {
    root,
    focusTarget: list,
    bindings: [
      { key: "return", run: enter },
      { key: "left", run: () => adjust(-1) },
      { key: "right", run: () => adjust(1) },
      {
        key: "i",
        run: () => {
          const voice = view.kind === "voices" ? (list.getSelectedOption()?.value as VoiceInfo | undefined) : undefined;
          if (voice) install(voice);
        },
      },
    ],
    escape: () => {
      if (pending) {
        pending = undefined;
        warning.content = "";
        setHint("Rebind cancelled");
        return true;
      }
      if (view.kind !== "main") {
        view = { kind: "main" };
        render();
        return true;
      }
      return false;
    },
    refresh: () => {
      if (view.kind === "main") mainIndex = list.getSelectedIndex();
      render();
    },
    dispose: () => {
      disposed = true;
      stopCapture?.();
    },
  };
}
