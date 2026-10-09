// List overlays: Messages (answers of the followed session), Sessions picker, saved Phrases.

import type { Phrase, SessionRef } from "../../core/types.ts";
import { buildSpeechScript, speechOptionsFromConfig } from "../../core/speech/index.ts";
import { clock, createLine, createList, createPanel, messageTitle, relativeTime, type Overlay, type OverlayHost } from "./panel.ts";
import { theme } from "../theme.ts";

export function messagesOverlay(host: OverlayHost, shownKey: string | undefined): Overlay {
  const { renderer, app } = host;
  const root = createPanel(renderer, "overlay-messages", "Messages", "enter read · esc close");
  const list = createList(renderer, "messages-list");
  root.add(list);
  const messages = [...app.sessions.messages].reverse();
  if (messages.length === 0) {
    list.options = [{ name: "No answers in this session yet", description: "" }];
  } else {
    // Select rows cannot be styled one by one, so narration is indented and labelled instead of dimmed.
    list.options = messages.map((message, i) => ({
      name: `${message.key === shownKey ? "●" : " "} ${message.commentary ? "  ┄ " : ""}${messageTitle(message.markdown)}`,
      description: `  ${clock(message.createdAt)} · #${messages.length - i} · ${message.commentary ? "narration" : "answer"} · ${message.markdown.split("\n").length} lines`,
      value: message.key,
    }));
    list.setSelectedIndex(Math.max(0, messages.findIndex((m) => m.key === shownKey)));
  }
  return {
    root,
    focusTarget: list,
    bindings: [
      {
        key: "return",
        run: () => {
          const key = list.getSelectedOption()?.value as string | undefined;
          host.close();
          if (!key) return;
          app.selectMessage(key);
          app.readMessage(key);
        },
      },
    ],
  };
}

export function sessionsOverlay(host: OverlayHost): Overlay {
  const { renderer, app, cwd } = host;
  const root = createPanel(renderer, "overlay-sessions", "Sessions", "enter follow · esc close");
  const list = createList(renderer, "sessions-list");
  const status = createLine(renderer, "sessions-status");
  root.add(list);
  root.add(status);
  list.options = [{ name: "Looking for sessions…", description: "" }];
  let sessions: SessionRef[] = [];
  let disposed = false;
  const id = (s: SessionRef) => `${s.harness}:${s.id}`;

  void (async () => {
    try {
      const [here, all] = await Promise.all([app.sessions.list({ cwd }), app.sessions.list({})]);
      if (disposed) return;
      const hereIds = new Set(here.map(id));
      sessions = [...here, ...all.filter((s) => !hereIds.has(id(s)))];
      const current = app.sessions.session;
      if (sessions.length === 0) {
        list.options = [{ name: "No harness sessions found", description: "  Start omp, pi, codex or claude in a project first." }];
        return;
      }
      list.options = sessions.map((s) => ({
        name: `${current && id(current) === id(s) ? "●" : " "} ${s.harness} · ${s.title ?? s.id}`,
        description: `  ${hereIds.has(id(s)) ? "this directory" : (s.cwd ?? "unknown directory")} · ${relativeTime(s.updatedAt)}`,
        value: s,
      }));
      const currentIndex = current ? sessions.findIndex((s) => id(s) === id(current)) : -1;
      list.setSelectedIndex(Math.max(0, currentIndex));
      status.content = `${here.length} in this directory · ${sessions.length} total`;
    } catch (error) {
      if (disposed) return;
      status.fg = theme.error;
      status.content = `Could not list sessions: ${error instanceof Error ? error.message : String(error)}`;
    }
  })();

  return {
    root,
    focusTarget: list,
    bindings: [
      {
        key: "return",
        run: () => {
          const session = list.getSelectedOption()?.value as SessionRef | undefined;
          if (!session) return;
          host.close();
          app.sessions.follow(session).then(
            () => host.notice("info", `Following ${session.harness} · ${session.title ?? session.id}`),
            (error: unknown) => host.notice("error", `Could not follow session: ${error instanceof Error ? error.message : String(error)}`),
          );
        },
      },
    ],
    dispose: () => {
      disposed = true;
    },
  };
}

export function phrasesOverlay(host: OverlayHost): Overlay {
  const { renderer, app } = host;
  const root = createPanel(renderer, "overlay-phrases", "Phrases", "enter play · esc close");
  const list = createList(renderer, "phrases-list");
  root.add(list);
  list.options = [{ name: "Loading phrases…", description: "" }];
  let disposed = false;

  void app.phrases.list().then(
    (phrases) => {
      if (disposed) return;
      const newest = [...phrases].reverse();
      list.options =
        newest.length === 0
          ? [{ name: "No saved phrases yet", description: "  Press the save-phrase key while a sentence is read." }]
          : newest.map((phrase) => ({
              name: phrase.text,
              description: `  ${phrase.lang} · ${phrase.savedAt.toISOString().slice(0, 10)} ${clock(phrase.savedAt)}`,
              value: phrase,
            }));
    },
    (error: unknown) => {
      if (!disposed) list.options = [{ name: `Could not load phrases: ${error instanceof Error ? error.message : String(error)}`, description: "" }];
    },
  );

  return {
    root,
    focusTarget: list,
    bindings: [
      {
        key: "return",
        run: () => {
          const phrase = list.getSelectedOption()?.value as Phrase | undefined;
          if (phrase) playPhrase(host, phrase);
        },
      },
    ],
    dispose: () => {
      disposed = true;
    },
  };
}

function playPhrase(host: OverlayHost, phrase: Phrase): void {
  try {
    const options = { ...speechOptionsFromConfig(host.app.config, phrase.lang), autoLanguage: false, defaultLang: phrase.lang };
    host.app.playback.play(buildSpeechScript(`phrase:${phrase.savedAt.getTime()}`, phrase.text, options));
  } catch (error) {
    host.notice("error", `Could not play phrase: ${error instanceof Error ? error.message : String(error)}`);
  }
}
