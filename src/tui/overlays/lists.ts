// List overlays: Messages (answers of the followed session), Sessions picker, saved Phrases.

import { BoxRenderable, InputRenderable, InputRenderableEvents, type SelectOption } from "@opentui/core";
import { basename } from "node:path";
import { messageTitle } from "../../core/message-title.ts";
import type { Phrase, SessionRef } from "../../core/types.ts";
import { buildSpeechScript, speechOptionsFromConfig } from "../../core/speech/index.ts";
import { clock, createLine, createList, createPanel, relativeTime, type Overlay, type OverlayHost } from "./panel.ts";
import { countBar, filterSessions, HARNESSES, isTechnicalSession, sessionCounts, sessionId, type SessionHarness } from "./session-filter.ts";
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
  // A dedicated full-screen surface keeps old answer text from bleeding through the picker.
  const root = new BoxRenderable(renderer, {
    id: "overlay-sessions",
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    zIndex: 99,
    backgroundColor: theme.bg,
  });
  const panel = createPanel(renderer, "sessions-panel", "SPEAKHARNESS  /  CONVERSATIONS", "enter follow · / search · esc close");
  panel.top = "3%";
  panel.left = "3%";
  panel.width = "94%";
  panel.height = "94%";
  root.add(panel);
  const tabs = createLine(renderer, "sessions-tabs", theme.accent);
  const chart = createLine(renderer, "sessions-chart");
  const search = new InputRenderable(renderer, {
    id: "sessions-search",
    placeholder: " /  Search title, harness, folder…",
    flexShrink: 0,
    backgroundColor: theme.overlayBg,
    focusedBackgroundColor: theme.selectedBg,
    textColor: theme.fg,
    focusedTextColor: theme.selectedFg,
  });
  const list = createList(renderer, "sessions-list");
  const status = createLine(renderer, "sessions-status");
  chart.marginTop = 1;
  list.marginTop = 1;
  panel.add(tabs);
  panel.add(chart);
  panel.add(search);
  panel.add(list);
  panel.add(status);

  const current = app.sessions.session;
  const currentId = current ? sessionId(current) : undefined;
  let sessions: SessionRef[] = [];
  let scope: "here" | "all" = "here";
  let harness: SessionHarness | "all" = "all";
  let showTechnical = false;
  let loaded = false;
  let disposed = false;
  list.options = [{ name: "Scanning conversations…", description: "  Reading local session files" }];

  const update = (): void => {
    if (disposed) return;
    const selected = (list.getSelectedOption()?.value as SessionRef | undefined);
    const query = search.value;
    const options = { cwd, scope, harness, query, showTechnical, currentId };
    const visible = filterSessions(sessions, options);
    const distribution = filterSessions(sessions, { ...options, harness: "all" });
    const counts = sessionCounts(distribution);
    const total = distribution.length;
    const narrow = renderer.width < 90;
    const label = (name: string, key: number, active: boolean): string => active ? `[${key} ${name}]` : `${key} ${name}`;
    tabs.content = [
      label("ALL", 1, harness === "all"),
      ...HARNESSES.map((id, i) => label(narrow && id === "claude-code" ? "CLD" : id.toUpperCase(), i + 2, harness === id)),
    ].join("  ");
    const largest = Math.max(...Object.values(counts));
    chart.content = HARNESSES.map((id) => {
      const name = id === "claude-code" ? "CLAUDE" : id.toUpperCase();
      return `${name} ${countBar(counts[id], largest, narrow ? 3 : 6)} ${counts[id]}`;
    }).join(narrow ? "  " : "   ");

    const rows: SelectOption[] = visible.map((session) => {
      const technical = isTechnicalSession(session, currentId);
      const here = session.cwd === cwd;
      const folder = here ? "HERE" : session.cwd ? basename(session.cwd) || session.cwd : "unknown folder";
      const name = session.title ?? `Untitled · ${session.id.slice(0, 8)}`;
      return {
        name: `${sessionId(session) === currentId ? "●" : " "} ${session.harness.toUpperCase().padEnd(6)}  ${name}`,
        description: `   ${folder} · ${relativeTime(session.updatedAt)}${technical ? " · technical/empty" : ""}`,
        value: session,
      };
    });
    list.options = rows.length ? rows : [{
      name: loaded ? "No conversations match these filters" : "Scanning conversations…",
      description: loaded ? "  Try 1 for all harnesses, tab for all folders, a for technical, or clear search." : "",
    }];
    const keep = selected && visible.findIndex((session) => sessionId(session) === sessionId(selected));
    const currentIndex = currentId ? visible.findIndex((session) => sessionId(session) === currentId) : -1;
    list.setSelectedIndex(Math.max(0, keep !== undefined && keep >= 0 ? keep : currentIndex ?? 0));
    const hidden = showTechnical ? 0 : filterSessions(sessions, { ...options, harness: "all", showTechnical: true }).length - distribution.length;
    status.content = `${scope === "here" ? "HERE" : "ALL FOLDERS"} [tab] · ${showTechnical ? "ALL FILES" : "CURATED"} [a] · ${visible.length}/${total}${hidden && !showTechnical ? ` · ${hidden} hidden` : ""}`;
  };

  search.on(InputRenderableEvents.INPUT, update);
  const shortcuts = host.keys.scoped(list, [
    { key: "/", run: () => search.focus() },
    { key: "tab", run: () => { scope = scope === "here" ? "all" : "here"; update(); } },
    { key: "a", run: () => { showTechnical = !showTechnical; update(); } },
    ...(["all", ...HARNESSES] as const).map((id, i) => ({
      key: String(i + 1),
      run: () => { harness = id; update(); },
    })),
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
  ]);
  search.on(InputRenderableEvents.ENTER, () => list.focus());
  update();

  void app.sessions.list({}).then(
    (all) => {
      if (disposed) return;
      sessions = current && !all.some((s) => sessionId(s) === currentId) ? [current, ...all] : all;
      const here = sessions.filter((s) => s.cwd === cwd);
      scope = here.length ? "here" : "all";
      loaded = true;
      update();
    },
    (error: unknown) => {
      if (disposed) return;
      loaded = true;
      status.fg = theme.error;
      status.content = `Could not list sessions: ${error instanceof Error ? error.message : String(error)}`;
      list.options = [{ name: "Session scan failed", description: "  Check speakh logs for details." }];
    },
  );

  return {
    root,
    focusTarget: list,
    bindings: [],
    escape: () => {
      if (renderer.currentFocusedRenderable !== search) return false;
      list.focus();
      return true;
    },
    dispose: () => {
      disposed = true;
      shortcuts();
      search.off(InputRenderableEvents.INPUT, update);
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
