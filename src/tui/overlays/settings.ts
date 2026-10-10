// Settings: voices (with install + progress), speed, reading and study options, and the keymap editor
// (pick command → press key → conflict warning → enter saves through app.updateConfig).

import { BoxRenderable } from "@opentui/core";
import type { CommandId, Config, Lang, VoiceInfo } from "../../core/types.ts";
import { COMMAND_IDS } from "../keys.ts";
import { formatSpeed } from "../reader.ts";
import { theme } from "../theme.ts";
import {
  createLine,
  createList,
  createPanel,
  type Overlay,
  type OverlayHost,
} from "./panel.ts";

type VoiceSlot = "primary" | "alternate" | Lang;
type Category = "audio" | "reading" | "study" | "keys";
type View =
  | { kind: "main" }
  | { kind: "voices"; slot: VoiceSlot | undefined }
  | { kind: "keys" };

interface Item {
  category: Category;
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

const LANG_LABELS: Record<Lang, string> = {
  en: "English",
  "pt-BR": "Brazilian Portuguese",
};
const CATEGORIES: readonly Category[] = ["audio", "reading", "study", "keys"];

/** The marker depicts the configured value, not an audio signal. */
export function speedGauge(value: number, min: number, max: number): string {
  const steps = 11;
  const marker = Math.round(
    ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * (steps - 1),
  );
  return `${formatSpeed(min)} ${"━".repeat(marker)}●${"─".repeat(steps - marker - 1)} ${formatSpeed(max)}   ${formatSpeed(value)}`;
}

function clampStep(
  value: number,
  step: number,
  direction: 1 | -1,
  min: number,
  max: number,
): number {
  return (
    Math.round(Math.min(max, Math.max(min, value + step * direction)) * 100) /
    100
  );
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

export function settingsOverlay(host: OverlayHost): Overlay {
  const { renderer, app, keys } = host;
  const root = new BoxRenderable(renderer, {
    id: "overlay-settings",
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    zIndex: 99,
    backgroundColor: theme.bg,
  });
  const panel = createPanel(
    renderer,
    "settings-panel",
    "SETTINGS  /  AUDIO",
    "esc back",
  );
  panel.top = "4%";
  panel.left = "6%";
  panel.width = "88%";
  panel.height = "92%";
  root.add(panel);
  const tabs = createLine(renderer, "settings-tabs", theme.accent);
  const summary = createLine(renderer, "settings-summary", theme.muted);
  const list = createList(renderer, "settings-list");
  const hint = createLine(renderer, "settings-hint");
  const warning = createLine(renderer, "settings-warning", theme.warning);
  panel.add(tabs);
  panel.add(summary);
  panel.add(list);
  panel.add(hint);
  panel.add(warning);

  let view: View = { kind: "main" };
  let category: Category = "audio";
  let voices: VoiceInfo[] | undefined;
  let voicesError: string | undefined;
  let pending: PendingBinding | undefined;
  let stopCapture: (() => void) | undefined;
  let installing: string | undefined;
  let disposed = false;
  let mainIndex = 0;

  const update = (mutate: (draft: Config) => void) => {
    app
      .updateConfig(mutate)
      .catch((error: unknown) =>
        host.notice(
          "error",
          `Could not save settings: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  };
  const toggle = (
    category: Category,
    label: string,
    get: (c: Config) => boolean,
    set: (c: Config, v: boolean) => void,
  ): Item => ({
    category,
    label,
    value: (c) => (get(c) ? "●  on" : "○  off"),
    activate: () => update((c) => set(c, !get(c))),
    adjust: () => update((c) => set(c, !get(c))),
  });
  const voiceLabel = (id: string) => {
    const info = voices?.find((v) => v.id === id);
    return info
      ? `${info.label}${info.installed ? "" : "  ·  not installed"}`
      : id;
  };
  const conciseVoice = (id: string): string =>
    (
      voices?.find((voice) => voice.id === id)?.label ??
      id.split(":").at(-1) ??
      id
    )
      .replace(/\s*\([^)]*\)$/, "")
      .replace(/^pt_BR-([^-]+)-.*/, "$1")
      .replace(/^[a-z]{2}_/, "");
  const voiceItem = (
    label: string,
    slot: VoiceSlot,
    get: (c: Config) => string,
  ): Item => ({
    category: "audio",
    label,
    value: (c) => voiceLabel(get(c)),
    activate: () => show({ kind: "voices", slot }),
  });
  const speedItem = (
    category: Category,
    label: string,
    get: (c: Config) => number,
    set: (c: Config, v: number) => void,
    step: number,
    min: number,
    max: number,
  ): Item => ({
    category,
    label,
    value: (c) => speedGauge(get(c), min, max),
    activate: () => update((c) => set(c, clampStep(get(c), step, 1, min, max))),
    adjust: (direction) =>
      update((c) => set(c, clampStep(get(c), step, direction, min, max))),
  });

  const items: Item[] = [
    speedItem(
      "audio",
      "Playback speed",
      (c) => c.voices.speed,
      (c, v) => void (c.voices.speed = v),
      0.1,
      0.5,
      2,
    ),
    voiceItem("Primary voice", "primary", (c) => c.voices.primary),
    voiceItem("Alternate voice", "alternate", (c) => c.voices.alternate),
    voiceItem(`English voice`, "en", (c) => c.voices.languages.en),
    voiceItem(
      "Brazilian Portuguese voice",
      "pt-BR",
      (c) => c.voices.languages["pt-BR"],
    ),
    toggle(
      "audio",
      "Detect language per paragraph",
      (c) => c.voices.autoLanguage,
      (c, v) => void (c.voices.autoLanguage = v),
    ),
    {
      category: "audio",
      label: "Voice catalog…",
      value: () => "install another local voice",
      activate: () => show({ kind: "voices", slot: undefined }),
    },
    toggle(
      "reading",
      "Read new answers automatically",
      (c) => c.reading.autoRead,
      (c, v) => void (c.reading.autoRead = v),
    ),
    {
      category: "reading",
      label: "When answers arrive during playback",
      value: (c) =>
        c.reading.autoReadQueue === "latest"
          ? "keep only the newest"
          : "read every answer",
      activate: () =>
        update(
          (c) =>
            void (c.reading.autoReadQueue =
              c.reading.autoReadQueue === "latest" ? "all" : "latest"),
        ),
      adjust: () =>
        update(
          (c) =>
            void (c.reading.autoReadQueue =
              c.reading.autoReadQueue === "latest" ? "all" : "latest"),
        ),
    },
    {
      category: "reading",
      label: "Tables",
      value: (c) =>
        c.reading.tables === "summary" ? "announce columns" : "read every row",
      activate: () =>
        update(
          (c) =>
            void (c.reading.tables =
              c.reading.tables === "summary" ? "rows" : "summary"),
        ),
      adjust: () =>
        update(
          (c) =>
            void (c.reading.tables =
              c.reading.tables === "summary" ? "rows" : "summary"),
        ),
    },
    toggle(
      "reading",
      "Announce quotes",
      (c) => c.reading.quoteCue,
      (c, v) => void (c.reading.quoteCue = v),
    ),
    toggle(
      "study",
      "Pause after each sentence",
      (c) => c.study.pauseAfterSentence,
      (c, v) => void (c.study.pauseAfterSentence = v),
    ),
    toggle(
      "study",
      "Shadowing silence",
      (c) => c.study.shadowing,
      (c, v) => void (c.study.shadowing = v),
    ),
    speedItem(
      "study",
      "Shadowing delay factor",
      (c) => c.study.shadowingFactor,
      (c, v) => void (c.study.shadowingFactor = v),
      0.25,
      0.5,
      3,
    ),
    speedItem(
      "study",
      "Repeat slower at",
      (c) => c.study.slowerSpeed,
      (c, v) => void (c.study.slowerSpeed = v),
      0.05,
      0.3,
      1,
    ),
    {
      category: "keys",
      label: "Edit key bindings…",
      value: () => "customize every command",
      activate: () => show({ kind: "keys" }),
    },
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
        out.set(
          id,
          `${out.get(id) ? `${out.get(id)}; ` : ""}${conflict.key} also: ${others.join(", ")}`,
        );
      }
    }
    return out;
  };

  const voiceSlotValue = (config: Config, slot: VoiceSlot): string =>
    slot === "primary"
      ? config.voices.primary
      : slot === "alternate"
        ? config.voices.alternate
        : config.voices.languages[slot];

  const render = () => {
    const config = app.config;
    const index = list.getSelectedIndex();
    if (view.kind === "main") {
      panel.title = ` SETTINGS  /  ${category.toUpperCase()} `;
      tabs.content = CATEGORIES.map((name, i) =>
        category === name
          ? `[${i + 1} ${name.toUpperCase()}]`
          : `${i + 1} ${name.toUpperCase()}`,
      ).join("   ");
      summary.content =
        category === "audio"
          ? `OUTPUT  ·  ${formatSpeed(config.voices.speed)}  ·  EN ${conciseVoice(config.voices.languages.en)}  ·  PT ${conciseVoice(config.voices.languages["pt-BR"])}`
          : category === "reading"
            ? `NEW ANSWERS  ·  ${config.reading.autoRead ? "auto-read ON" : "auto-read OFF"}  ·  tables: ${config.reading.tables}`
            : category === "study"
              ? `PRACTICE  ·  ${config.study.pauseAfterSentence ? "pause each sentence" : "continuous"}  ·  slower ${formatSpeed(config.study.slowerSpeed)}`
              : `KEYBOARD  ·  ${COMMAND_IDS.filter((id) => config.keys[id]?.length).length} commands bound`;
      list.options = items
        .filter((item) => item.category === category)
        .map((item) => ({
          name: item.label,
          description: `  ${item.value(config)}`,
        }));
      list.setSelectedIndex(mainIndex);
      if (!pending)
        setHint(
          category === "audio"
            ? "←/→ adjust · +/- playback speed · enter choose · esc close"
            : "←/→ adjust · enter choose · esc close",
        );
      warning.content = "";
    } else if (view.kind === "voices") {
      const slot = view.slot;
      panel.title = slot
        ? ` Voice · ${slot === "primary" || slot === "alternate" ? slot : LANG_LABELS[slot]} `
        : " Voices ";
      tabs.content = "ESC  ←  BACK TO SETTINGS";
      summary.content = slot
        ? `SELECT VOICE  ·  ${slot === "primary" || slot === "alternate" ? slot.toUpperCase() : LANG_LABELS[slot]}`
        : "VOICE CATALOG  ·  local models";
      if (voicesError) {
        list.options = [
          { name: `Could not list voices: ${voicesError}`, description: "" },
        ];
      } else if (!voices) {
        list.options = [{ name: "Loading voices…", description: "" }];
      } else {
        const current = slot ? voiceSlotValue(config, slot) : undefined;
        const shown =
          slot === "en" || slot === "pt-BR"
            ? voices.filter((v) => v.lang === slot)
            : voices;
        list.options = shown.map((v) => ({
          name: `${v.id === current ? "✓" : " "} ${v.installed ? "●" : "○"} ${v.label}`,
          description: `    ${v.id} · ${v.lang} · ${v.installed ? "installed" : `not installed · ${megabytes(v.sizeBytes)} · ${v.license}`}`,
          value: v,
        }));
        list.setSelectedIndex(Math.min(index, Math.max(0, shown.length - 1)));
      }
      if (!installing)
        setHint(
          slot ? "enter use · i install · esc back" : "i install · esc back",
        );
    } else {
      panel.title = " Key bindings ";
      tabs.content = "ESC  ←  BACK TO SETTINGS";
      summary.content = "ENTER TO REBIND  ·  conflicts are shown before saving";
      const conflicts = conflictText(config);
      list.options = COMMAND_IDS.map((id) => {
        const bound =
          (config.keys[id] ?? []).map((key) => keys.format(key)).join(", ") ||
          "unbound";
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
    setHint(
      `Installing ${voice.id}… 0% of ${megabytes(voice.sizeBytes)} (${voice.license})`,
      theme.info,
    );
    app.engine
      .install(voice.id, (done, total) => {
        if (!disposed)
          setHint(
            `Installing ${voice.id}… ${total > 0 ? Math.floor((done / total) * 100) : 0}% of ${megabytes(total)}`,
            theme.info,
          );
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
    if (!voice.installed)
      setHint(
        `${voice.id} is not installed yet: press i to install (${megabytes(voice.sizeBytes)}, ${voice.license})`,
        theme.warning,
      );
  };

  const startCapture = (command: CommandId) => {
    pending = undefined;
    warning.content = "";
    setHint(
      `Press the new key for "${app.commands.get(command)?.title ?? command}" · esc cancels`,
      theme.info,
    );
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
        setHint(
          error instanceof Error ? error.message : String(error),
          theme.error,
        );
        return;
      }
      pending = { command, key };
      setHint(
        `Bind ${keys.format(key)} to "${app.commands.get(command)?.title ?? command}"? enter save · esc cancel`,
        theme.info,
      );
      warning.content =
        conflicts.length > 0
          ? `⚠ ${keys.format(key)} is already bound to: ${conflicts.join(", ")}`
          : "";
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
      items.filter((item) => item.category === category)[mainIndex]?.activate();
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
    items
      .filter((item) => item.category === category)
      [mainIndex]?.adjust?.(direction);
  };

  const chooseCategory = (next: Category) => {
    if (view.kind !== "main" || category === next) return;
    category = next;
    mainIndex = 0;
    list.setSelectedIndex(0);
    render();
  };

  // The same category tabs are clickable when the terminal supports mouse input.
  tabs.onMouseUp = (event) => {
    if (view.kind !== "main") return;
    let start = tabs.screenX;
    for (const [i, name] of CATEGORIES.entries()) {
      const label =
        category === name
          ? `[${i + 1} ${name.toUpperCase()}]`
          : `${i + 1} ${name.toUpperCase()}`;
      const end = start + Bun.stringWidth(label);
      if (event.x >= start && event.x < end) {
        chooseCategory(name);
        return;
      }
      start = end + 3;
    }
  };

  const adjustPlaybackSpeed = (direction: 1 | -1) => {
    if (view.kind !== "main" || category !== "audio") return;
    mainIndex = 0;
    list.setSelectedIndex(0);
    items[0]?.adjust?.(direction);
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
      ...CATEGORIES.map((name, index) => ({
        key: String(index + 1),
        run: () => chooseCategory(name),
      })),
      { key: "+", run: () => adjustPlaybackSpeed(1) },
      { key: "=", run: () => adjustPlaybackSpeed(1) },
      { key: "-", run: () => adjustPlaybackSpeed(-1) },
      {
        key: "i",
        run: () => {
          const voice =
            view.kind === "voices"
              ? (list.getSelectedOption()?.value as VoiceInfo | undefined)
              : undefined;
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
