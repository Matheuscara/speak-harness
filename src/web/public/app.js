const key = document.querySelector('meta[name="speakh-key"]').content;
const el = (id) => document.getElementById(id);
const by = (selector) => document.querySelector(selector);
const create = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

let snapshot;
let sessionData = {
  sessions: [],
  counts: {},
  total: 0,
  hidden: 0,
  hereCount: 0,
};
let voiceData = { voices: [], installations: {} };
let scope = "here";
let harness = "all";
let query = "";
let technical = false;
let settingsTab = "audio";
let lastMarkdown = "";
let lastRange = "";
let previousSession = "";
let lastSettings = "";
let lastMessages = "";
let toastTimer;
let searchTimer;
let refreshing = false;
let refreshAgain = false;

async function api(path, payload) {
  const response = await fetch(path, {
    method: payload === undefined ? "GET" : "POST",
    headers: {
      "X-Speakh-Key": key,
      ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function toast(text, error = false) {
  const node = el("toast");
  node.textContent = text;
  node.classList.toggle("error", error);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 5000);
}

async function action(path, body) {
  try {
    await api(path, body);
    await refreshState();
  } catch (error) {
    toast(error.message, true);
  }
}
async function command(id) {
  await action("/api/command", { id });
}

function shortVoice(id) {
  const item = voiceData.voices.find((v) => v.id === id);
  if (item) return item.label.replace(/\s*\([^)]*\)$/, "");
  return (
    id
      ?.split(":")
      .at(-1)
      ?.replace(/^pt_BR-([^-]+)-.*/, "$1")
      .replace(/^[a-z]{2}_/, "") || "—"
  );
}
function shortDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
function sessionKey(session) {
  return `${session.harness}:${session.id}`;
}
function renderState(data) {
  const oldSession = previousSession;
  snapshot = data;
  const s = data.session;
  const p = data.playback;
  const message = data.messages.find((m) => m.key === data.selectedKey);
  const sessionTitle =
    s?.title || (s ? `Session ${s.id.slice(0, 8)}` : "Choose a conversation");
  previousSession = s ? sessionKey(s) : "";
  el("hero-session-title").textContent = sessionTitle;
  el("hero-session-meta").textContent = s
    ? `${s.harness.toUpperCase()}  ·  ${s.cwd || "local session"}`
    : "OMP · Pi · Codex · Claude Code";
  el("reader-harness").textContent = s?.harness.toUpperCase() || "NO SESSION";
  el("reader-message-title").textContent = message?.title || "Select an answer";
  const sameAnswer = p.messageKey && p.messageKey === data.selectedKey;
  const displayedStatus = sameAnswer ? p.status : "idle";
  const statusName = {
    idle: "READY",
    preparing: "PREPARING",
    speaking: "PLAYING",
    paused: "PAUSED",
    "study-wait": "STUDY PAUSE",
  };
  el("reader-state").textContent =
    statusName[displayedStatus] || displayedStatus;
  el("reader-state").classList.toggle(
    "playing",
    displayedStatus === "speaking",
  );
  by(".reader-card").dataset.playing =
    displayedStatus === "speaking" ? "true" : "false";
  const count = data.script?.segments.length || 0;
  const index =
    sameAnswer && p.segmentCount
      ? Math.min(p.segmentIndex + 1, p.segmentCount)
      : 0;
  el("spotlight-position").textContent = count
    ? `${index || 1} / ${count}`
    : "— / —";
  const phrase =
    data.activeText || data.script?.segments[index ? index - 1 : 0]?.text;
  el("spotlight-text").textContent =
    phrase ||
    "Choose a conversation in Sessions, then press Play to hear an answer.";
  const percent = count && index ? Math.round((index / count) * 100) : 0;
  el("progress-label").textContent = `${percent}%`;
  el("progress-fill").style.width = `${percent}%`;
  const language = sameAnswer ? p.lang : data.script?.dominantLang;
  el("reader-language").textContent =
    `LANGUAGE ${language?.toUpperCase() || "—"}`;
  const voice =
    (sameAnswer && p.voice) || data.config.voices.languages[language || "en"];
  el("reader-voice").textContent = `VOICE ${shortVoice(voice)}`;
  const playing =
    displayedStatus === "speaking" || displayedStatus === "preparing";
  el("play-button").innerHTML = playing
    ? "Ⅱ <span>PAUSE</span>"
    : displayedStatus === "paused"
      ? "▶ <span>RESUME</span>"
      : "▶ <span>PLAY</span>";
  el("play-button").setAttribute(
    "aria-label",
    playing ? "Pause playback" : "Play answer",
  );
  el("study-button").classList.toggle("active", p.studyMode);
  el("study-button").querySelector("span").textContent = p.studyMode
    ? "ON"
    : "OFF";
  el("play-button").disabled = !message;
  el("save-phrase").disabled = !sameAnswer || !p.segmentCount;
  if (p.error && sameAnswer) toast(p.error, true);
  const rangeKey = `${p.messageKey}:${p.segmentIndex}:${p.status}`;
  if (lastMarkdown !== data.markdown || lastRange !== rangeKey) {
    const article = el("answer-html");
    const scroll = article.scrollTop;
    article.innerHTML =
      data.html ||
      '<p class="empty-copy">The full answer appears here when you select a conversation.</p>';
    if (lastMarkdown === data.markdown && article.querySelector("mark"))
      article
        .querySelector("mark")
        .scrollIntoView({ block: "nearest", behavior: "smooth" });
    else article.scrollTop = data.markdown === lastMarkdown ? scroll : 0;
    lastMarkdown = data.markdown;
    lastRange = rangeKey;
  }
  renderMessages(data.messages, data.selectedKey);
  const settingsHash =
    JSON.stringify(data.config) +
    JSON.stringify(voiceData.voices.map((v) => [v.id, v.installed]));
  if (!el("settings-page").hidden && settingsHash !== lastSettings)
    renderSettings();
  if (oldSession !== previousSession) refreshSessions();
}

function renderMessages(messages, selected) {
  const fingerprint = `${selected || ""}\\0${messages.map((message) => `${message.key}:${message.title}:${message.createdAt}:${message.commentary}`).join("\\0")}`;
  if (fingerprint === lastMessages) return;
  lastMessages = fingerprint;
  el("message-count").textContent = String(
    messages.filter((m) => !m.commentary).length,
  ).padStart(2, "0");
  const list = el("message-list");
  list.replaceChildren();
  if (!messages.length) {
    list.append(create("p", "empty-copy", "No answers in this session yet."));
    return;
  }
  for (const [index, message] of [...messages].reverse().entries()) {
    const button = create(
      "button",
      `message-item${message.key === selected ? " selected" : ""}${message.commentary ? " commentary" : ""}`,
    );
    button.type = "button";
    const title = create("span", "message-title");
    title.append(
      create(
        "span",
        "message-no",
        `#${String(messages.length - index).padStart(2, "0")}`,
      ),
      document.createTextNode(message.title),
    );
    button.append(
      title,
      create(
        "small",
        "",
        `${shortDate(message.createdAt)}  /  ${message.commentary ? "NARRATION" : "ANSWER"}`,
      ),
    );
    button.addEventListener("click", () =>
      action("/api/message", { key: message.key }),
    );
    list.append(button);
  }
}

async function refreshState() {
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  try {
    renderState(await api("/api/state"));
  } catch (error) {
    toast(error.message, true);
  } finally {
    refreshing = false;
    if (refreshAgain) {
      refreshAgain = false;
      void refreshState();
    }
  }
}

async function refreshSessions() {
  const params = new URLSearchParams({
    scope,
    harness,
    q: query,
    technical: technical ? "1" : "0",
  });
  try {
    const data = await api(`/api/sessions?${params}`);
    // A slow older search must never overwrite the result of a newer keystroke.
    if (
      params.toString() !==
      new URLSearchParams({
        scope,
        harness,
        q: query,
        technical: technical ? "1" : "0",
      }).toString()
    )
      return;
    sessionData = data;
    renderSessions();
  } catch (error) {
    toast(error.message, true);
  }
}

function renderSessions() {
  el("sessions-count").textContent =
    `${sessionData.sessions.length} / ${sessionData.total}${sessionData.hidden ? ` · ${sessionData.hidden} HIDDEN` : ""}`;
  for (const button of document.querySelectorAll("[data-scope]"))
    button.classList.toggle("selected", button.dataset.scope === scope);
  const filters = el("harness-filters");
  filters.replaceChildren();
  for (const [id, label] of [
    ["all", "ALL"],
    ["omp", "OMP"],
    ["pi", "PI"],
    ["codex", "CODEX"],
    ["claude-code", "CLAUDE"],
  ]) {
    const button = create("button", harness === id ? "selected" : "", label);
    button.type = "button";
    button.dataset.filterHarness = id;
    button.setAttribute("aria-pressed", String(harness === id));
    button.addEventListener("click", () => {
      harness = id;
      void refreshSessions();
    });
    filters.append(button);
  }
  const list = el("session-list");
  list.replaceChildren();
  if (!sessionData.sessions.length) {
    list.append(
      create(
        "p",
        "empty-copy",
        sessionData.hereCount === 0 && scope === "here"
          ? "No conversations in this folder. Choose ALL above."
          : "No conversations match these filters. Change the harness or search.",
      ),
    );
  } else {
    for (const session of sessionData.sessions) {
      const selected =
        snapshot?.session &&
        sessionKey(session) === sessionKey(snapshot.session);
      const item = create(
        "button",
        `session-item${selected ? " selected" : ""}${session.hasReadableAnswer === false ? " technical" : ""}`,
      );
      item.type = "button";
      item.dataset.session = sessionKey(session);
      item.append(
        create(
          "span",
          "session-harness",
          `${session.harness.toUpperCase()}  /  ${selected ? "IN FOCUS" : "SESSION"}`,
        ),
        create(
          "strong",
          "",
          session.title || `Untitled · ${session.id.slice(0, 8)}`,
        ),
        create(
          "small",
          "",
          `${session.cwd?.split("/").filter(Boolean).at(-1) || "local"}  ·  ${shortDate(session.updatedAt)}`,
        ),
      );
      item.addEventListener("click", async () => {
        await action("/api/follow", { key: sessionKey(session) });
        navigate("listen");
      });
      list.append(item);
    }
  }
  const chart = el("harness-chart");
  chart.replaceChildren();
  const max = Math.max(1, ...Object.values(sessionData.counts));
  for (const [id, label] of [
    ["omp", "OMP"],
    ["pi", "PI"],
    ["codex", "CODEX"],
    ["claude-code", "CLAUDE"],
  ]) {
    const count = sessionData.counts[id] || 0;
    const row = create("div", "chart-row");
    const track = create("div", "chart-track");
    const fill = create("div", "chart-fill");
    fill.style.width = `${Math.round((count / max) * 100)}%`;
    track.append(fill);
    row.append(
      create("span", "", label),
      track,
      create("strong", "", String(count)),
    );
    chart.append(row);
  }
}

async function refreshVoices() {
  try {
    voiceData = await api("/api/voices");
    if (snapshot && !el("settings-page").hidden) renderSettings();
  } catch (error) {
    toast(error.message, true);
  }
}

function group(parent, title, description = "") {
  const node = create("div", "setting-group");
  node.append(create("div", "setting-heading", title));
  if (description) node.append(create("p", "setting-desc", description));
  parent.append(node);
  return node;
}
function slider(
  parent,
  path,
  title,
  description,
  min,
  max,
  step,
  value,
  unit = "×",
) {
  const node = group(parent, title, description);
  const valueLabel = create(
    "span",
    "",
    `${Number(value).toFixed(2).replace(/0$/, "").replace(/\.$/, "")}${unit}`,
  );
  node.firstChild.append(valueLabel);
  const input = create("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.setAttribute("aria-label", title);
  input.addEventListener("input", () => {
    valueLabel.textContent = `${Number(input.value).toFixed(2).replace(/0$/, "").replace(/\.$/, "")}${unit}`;
  });
  input.addEventListener("change", () =>
    action("/api/setting", { path, value: Number(input.value) }),
  );
  node.append(input);
}
function toggle(parent, path, title, description, value) {
  const node = create("label", "switch-row");
  const words = create("span");
  words.append(create("strong", "", title), create("small", "", description));
  const input = create("input");
  input.type = "checkbox";
  input.checked = !!value;
  input.addEventListener("change", () =>
    action("/api/setting", { path, value: input.checked }),
  );
  node.append(words, input);
  parent.append(node);
}
function choice(parent, path, title, description, options, value) {
  const node = group(parent, title, description);
  const select = create("select");
  select.setAttribute("aria-label", title);
  for (const [id, label] of options) {
    const option = create("option", "", label);
    option.value = id;
    select.append(option);
  }
  select.value = value;
  select.addEventListener("change", () =>
    action("/api/setting", { path, value: select.value }),
  );
  node.append(select);
}
function voiceChoice(parent, path, title, language, value) {
  choice(
    parent,
    path,
    title,
    "Local voice for this role. Install models in the Voices tab.",
    voiceData.voices
      .filter((v) => !language || v.lang === language)
      .map((v) => [v.id, `${v.label}${v.installed ? "" : " · not installed"}`]),
    value,
  );
}
function renderSettings() {
  if (!snapshot) return;
  const c = snapshot.config;
  lastSettings =
    JSON.stringify(c) +
    JSON.stringify(voiceData.voices.map((v) => [v.id, v.installed]));
  const panel = el("settings-content");
  panel.replaceChildren();
  for (const button of document.querySelectorAll("[data-settings-tab]"))
    button.classList.toggle(
      "selected",
      button.dataset.settingsTab === settingsTab,
    );
  if (settingsTab === "audio") {
    slider(
      panel,
      "voices.speed",
      "Reading speed",
      "Saved for future sessions; adjust in 0.1× steps.",
      0.5,
      2,
      0.1,
      c.voices.speed,
    );
    toggle(
      panel,
      "voices.autoLanguage",
      "Switch voice by language",
      "Detects English and Portuguese per paragraph.",
      c.voices.autoLanguage,
    );
    voiceChoice(
      panel,
      "voices.languages.en",
      "English",
      "en",
      c.voices.languages.en,
    );
    voiceChoice(
      panel,
      "voices.languages.pt-BR",
      "Brazilian Portuguese",
      "pt-BR",
      c.voices.languages["pt-BR"],
    );
    voiceChoice(
      panel,
      "voices.primary",
      "Primary voice",
      null,
      c.voices.primary,
    );
    voiceChoice(
      panel,
      "voices.alternate",
      "Alternate voice",
      null,
      c.voices.alternate,
    );
  } else if (settingsTab === "reading") {
    toggle(
      panel,
      "reading.autoRead",
      "Read new answers automatically",
      "Listen while you keep working in your harness.",
      c.reading.autoRead,
    );
    choice(
      panel,
      "reading.autoReadQueue",
      "Answer queue",
      "When another answer arrives during playback.",
      [
        ["latest", "Newest only"],
        ["all", "All, in order"],
      ],
      c.reading.autoReadQueue,
    );
    choice(
      panel,
      "reading.tables",
      "Tables",
      "How tables should be spoken.",
      [
        ["summary", "Summarize columns"],
        ["rows", "Read every row"],
      ],
      c.reading.tables,
    );
    toggle(
      panel,
      "reading.quoteCue",
      "Announce quotes",
      "Introduce quoted passages.",
      c.reading.quoteCue,
    );
  } else if (settingsTab === "study") {
    toggle(
      panel,
      "study.pauseAfterSentence",
      "Pause after each sentence",
      "Continue at your own pace to practice pronunciation.",
      c.study.pauseAfterSentence,
    );
    toggle(
      panel,
      "study.shadowing",
      "Shadowing silence",
      "Leave time to repeat each sentence aloud.",
      c.study.shadowing,
    );
    slider(
      panel,
      "study.shadowingFactor",
      "Silence duration",
      "Proportional to the spoken sentence length.",
      0.5,
      3,
      0.25,
      c.study.shadowingFactor,
    );
    slider(
      panel,
      "study.slowerSpeed",
      "Slower repeat speed",
      "Used by the Repeat slower control.",
      0.3,
      1,
      0.05,
      c.study.slowerSpeed,
    );
  } else {
    const head = create(
      "p",
      "setting-desc",
      "Models are downloaded and synthesized on your machine. No answer is sent to a hosted service.",
    );
    panel.append(head);
    for (const voice of voiceData.voices) {
      const row = create("div", "voice-row");
      row.append(
        create("strong", "", voice.label),
        create(
          "small",
          "",
          `${voice.engine.toUpperCase()} / ${voice.lang.toUpperCase()} / ${Math.round(voice.sizeBytes / 1e6)} MB / ${voice.license}`,
        ),
      );
      const progress = voiceData.installations[voice.id];
      if (progress?.error)
        row.append(create("small", "", `Failed: ${progress.error}`));
      if (progress && !progress.error) {
        row.append(
          create(
            "small",
            "",
            `Installing… ${progress.total ? Math.floor((progress.done / progress.total) * 100) : 0}%`,
          ),
        );
        const track = create("span", "install-progress");
        const fill = create("i");
        fill.style.width = `${progress.total ? Math.floor((progress.done / progress.total) * 100) : 0}%`;
        track.append(fill);
        row.append(track);
      } else if (voice.installed)
        row.append(create("small", "", "● INSTALLED"));
      else {
        const button = create("button", "", "INSTALL LOCALLY ↓");
        button.type = "button";
        button.addEventListener("click", async () => {
          await action("/api/install", { voice: voice.id });
          await refreshVoices();
        });
        row.append(button);
      }
      panel.append(row);
    }
  }
}
const views = {
  listen: "LISTENING DESK",
  sessions: "SESSIONS",
  phrases: "SAVED PHRASES",
  settings: "SETTINGS",
};
let currentView = "listen";
function showView(view) {
  if (!views[view]) view = "listen";
  currentView = view;
  for (const name of Object.keys(views)) {
    el(`${name}-page`).hidden = name !== view;
  }
  for (const button of document.querySelectorAll("[data-view]")) {
    const selected = button.dataset.view === view;
    button.classList.toggle("selected", selected);
    if (selected) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  el("current-view-label").textContent = views[view];
  document.title = `SpeakHarness — ${views[view]}`;
  window.scrollTo(0, 0);
  if (view === "sessions") {
    void refreshSessions();
    el("session-search").focus();
  } else if (view === "phrases") {
    void refreshPhrases();
  } else if (view === "settings") {
    renderSettings();
    void refreshVoices();
  }
}
function navigate(view) {
  if (location.hash === `#${view}`) showView(view);
  else location.hash = view;
}
async function refreshPhrases() {
  try {
    const { phrases } = await api("/api/phrases");
    const target = el("phrases-content");
    el("phrases-count").textContent = String(phrases.length).padStart(2, "0");
    target.replaceChildren();
    if (!phrases.length) {
      const empty = create("div", "empty-library");
      empty.append(
        create("span", "section-index", "YOUR ARCHIVE STARTS HERE"),
        create("h2", "", "Keep a sentence worth hearing twice."),
        create(
          "p",
          "",
          "While listening to an answer, use Save sentence to collect phrases for later practice.",
        ),
      );
      const button = create(
        "button",
        "outline-button",
        "OPEN LISTENING DESK ↗",
      );
      button.type = "button";
      button.addEventListener("click", () => navigate("listen"));
      empty.append(button);
      target.append(empty);
      return;
    }
    for (const phrase of [...phrases].reverse()) {
      const row = create("div", "phrase-row");
      row.append(
        create("strong", "", phrase.text),
        create("small", "", `${phrase.lang}  /  ${shortDate(phrase.savedAt)}`),
      );
      const button = create("button", "", "▶ PLAY PHRASE");
      button.addEventListener("click", () =>
        action("/api/phrase", { text: phrase.text, lang: phrase.lang }),
      );
      row.append(button);
      target.append(row);
    }
  } catch (error) {
    toast(error.message, true);
  }
}

for (const button of document.querySelectorAll("[data-command]"))
  button.addEventListener("click", () => command(button.dataset.command));
for (const button of document.querySelectorAll("[data-view]"))
  button.addEventListener("click", () => navigate(button.dataset.view));
el("top-settings").addEventListener("click", () => navigate("settings"));
el("sessions-toggle").addEventListener("click", () => navigate("sessions"));
window.addEventListener("hashchange", () => showView(location.hash.slice(1)));
showView(location.hash.slice(1));
for (const button of document.querySelectorAll("[data-settings-tab]"))
  button.addEventListener("click", () => {
    settingsTab = button.dataset.settingsTab;
    renderSettings();
  });
for (const button of document.querySelectorAll("[data-scope]"))
  button.addEventListener("click", () => {
    scope = button.dataset.scope;
    void refreshSessions();
  });
el("show-technical").addEventListener("change", (event) => {
  technical = event.target.checked;
  void refreshSessions();
});
el("session-search").addEventListener("input", (event) => {
  query = event.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void refreshSessions(), 120);
});
window.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === "Escape" && currentView !== "listen") {
    navigate("listen");
    return;
  }
  if (
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLSelectElement
  )
    return;
  if (event.key === ",") {
    event.preventDefault();
    navigate("settings");
    return;
  }
  if (event.key === "/") {
    event.preventDefault();
    navigate("sessions");
    return;
  }
  if (currentView !== "listen") return;
  const commands = {
    " ": "play-pause",
    ArrowLeft: "prev-sentence",
    ArrowRight: "next-sentence",
    r: "repeat-sentence",
    a: "auto-read",
    s: "stop",
  };
  if (commands[event.key]) {
    event.preventDefault();
    void command(commands[event.key]);
  }
});
window.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    void refreshState();
    void refreshSessions();
  }
});

const stream = new EventSource(`/events?key=${encodeURIComponent(key)}`);
stream.addEventListener("change", () => {
  void refreshState();
  if (Object.keys(voiceData.installations).length) void refreshVoices();
});
stream.addEventListener("notice", (event) => {
  const note = JSON.parse(event.data);
  toast(note.text, note.level === "error");
});
stream.onopen = () => {
  el("connection-state").classList.add("online");
  el("connection-state").innerHTML = "<i></i> CONNECTED";
};
stream.onerror = () => {
  el("connection-state").classList.remove("online");
  el("connection-state").innerHTML = "<i></i> RECONNECTING";
};
void Promise.all([refreshState(), refreshSessions(), refreshVoices()]);
setInterval(() => {
  if (!document.hidden) void refreshSessions();
}, 30_000);
// A heartbeat is independent of the SSE transport: some Bun/browser pairs do not surface stream cancellation.
// Keeping it active in background tabs preserves automatic reading while the user codes elsewhere.
setInterval(() => {
  void api("/api/ping").catch(() => {});
}, 30_000);
