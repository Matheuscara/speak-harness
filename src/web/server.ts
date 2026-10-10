import { randomBytes } from "node:crypto";
import type { AppCore, Config } from "../core/types.ts";
import { messageTitle } from "../core/message-title.ts";
import { findVoice } from "../engine/catalog.ts";
import {
  filterSessions,
  sessionCounts,
  sessionId,
  type SessionHarness,
} from "../tui/overlays/session-filter.ts";
import {
  buildSpeechScript,
  speechOptionsFromConfig,
} from "../core/speech/index.ts";
import { renderMarkdown } from "./markdown.ts";

const HOST = "127.0.0.1";
const IDLE_MS = 120_000;
const MAX_BODY = 8192;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reply(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "Request is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
  if (!isObject(parsed)) throw new HttpError(400, "Expected a JSON object");
  return parsed;
}

const BOOLEANS = new Set([
  "voices.autoLanguage",
  "reading.autoRead",
  "reading.quoteCue",
  "study.pauseAfterSentence",
  "study.shadowing",
]);
const NUMBERS: Record<string, [number, number]> = {
  "voices.speed": [0.5, 2],
  "study.slowerSpeed": [0.3, 1],
  "study.shadowingFactor": [0.5, 3],
};
const CHOICES: Record<string, readonly string[]> = {
  "reading.autoReadQueue": ["latest", "all"],
  "reading.tables": ["summary", "rows"],
};

/** Deliberately narrow: browser JSON can change preferences, not arbitrary config or filesystem fields. */
export function applySetting(
  config: Config,
  path: string,
  value: unknown,
): void {
  if (BOOLEANS.has(path)) {
    if (typeof value !== "boolean")
      throw new HttpError(400, `${path} must be a boolean`);
  } else if (path in NUMBERS) {
    const [min, max] = NUMBERS[path]!;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < min ||
      value > max
    )
      throw new HttpError(400, `${path} must be ${min}–${max}`);
  } else if (path in CHOICES) {
    if (typeof value !== "string" || !CHOICES[path]!.includes(value))
      throw new HttpError(400, `Invalid ${path}`);
  } else if (
    [
      "voices.primary",
      "voices.alternate",
      "voices.languages.en",
      "voices.languages.pt-BR",
    ].includes(path)
  ) {
    if (typeof value !== "string")
      throw new HttpError(400, `${path} must be a voice id`);
    const voice = findVoice(value);
    if (!voice) throw new HttpError(400, `Unknown voice ${value}`);
    if (path === "voices.languages.en" && voice.lang !== "en")
      throw new HttpError(400, "Choose an English voice");
    if (path === "voices.languages.pt-BR" && voice.lang !== "pt-BR")
      throw new HttpError(400, "Choose a pt-BR voice");
  } else {
    throw new HttpError(400, `Setting ${path} is not editable here`);
  }

  switch (path) {
    case "voices.speed":
      config.voices.speed = value as number;
      break;
    case "voices.primary":
      config.voices.primary = value as string;
      break;
    case "voices.alternate":
      config.voices.alternate = value as string;
      break;
    case "voices.autoLanguage":
      config.voices.autoLanguage = value as boolean;
      break;
    case "voices.languages.en":
      config.voices.languages.en = value as string;
      break;
    case "voices.languages.pt-BR":
      config.voices.languages["pt-BR"] = value as string;
      break;
    case "reading.autoRead":
      config.reading.autoRead = value as boolean;
      break;
    case "reading.autoReadQueue":
      config.reading.autoReadQueue =
        value as Config["reading"]["autoReadQueue"];
      break;
    case "reading.tables":
      config.reading.tables = value as Config["reading"]["tables"];
      break;
    case "reading.quoteCue":
      config.reading.quoteCue = value as boolean;
      break;
    case "study.pauseAfterSentence":
      config.study.pauseAfterSentence = value as boolean;
      break;
    case "study.shadowing":
      config.study.shadowing = value as boolean;
      break;
    case "study.shadowingFactor":
      config.study.shadowingFactor = value as number;
      break;
    case "study.slowerSpeed":
      config.study.slowerSpeed = value as number;
      break;
  }
}

export interface WebServer {
  url: string;
  closed: Promise<void>;
  close(): void;
}

/** A loopback-only UI backed by the same AppCore as the terminal interface. */
export function startWebServer(
  app: AppCore,
  options: { port?: number; idleMs?: number; cwd?: string } = {},
): WebServer {
  const token = randomBytes(24).toString("hex");
  const listeners = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  const completed = Promise.withResolvers<void>();
  const idleMs = options.idleMs ?? IDLE_MS;
  let lastSeen = Date.now();
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let pulse: ReturnType<typeof setInterval> | undefined;
  let scheduled = false;
  let closed = false;
  let server: ReturnType<typeof Bun.serve>;
  const touch = () => {
    lastSeen = Date.now();
  };
  const emit = (name: string, value: unknown = {}) => {
    const data = encoder.encode(
      `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`,
    );
    for (const client of listeners) {
      try {
        client.enqueue(data);
      } catch {
        listeners.delete(client);
      }
    }
  };
  const notify = () => {
    if (scheduled || closed) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      emit("change");
    });
  };
  const subscriptions = [
    app.subscribe((event) => {
      if (event.type === "notice")
        emit("notice", { level: event.level, text: event.text });
      notify();
    }),
    app.sessions.subscribe(notify),
    app.playback.subscribe(notify),
  ];
  const installations = new Map<
    string,
    { done: number; total: number; error?: string }
  >();
  // The SSE channel may trigger repeated snapshots without a new segment. Parse the markdown only when needed.
  let rendered:
    | {
        key: string;
        markdown: string;
        start?: number;
        end?: number;
        html: string;
      }
    | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(watchdog);
    clearInterval(pulse);
    for (const off of subscriptions) off();
    for (const client of listeners) {
      try {
        client.close();
      } catch {
        /* Disconnected. */
      }
    }
    listeners.clear();
    server.stop(true);
    completed.resolve();
  };
  // Bun's stream cancellation is not guaranteed on every client/terminal. Browser heartbeats bound server lifetime.
  watchdog = setInterval(
    () => {
      if (Date.now() - lastSeen > idleMs) close();
    },
    Math.min(15_000, Math.max(20, idleMs / 2)),
  );
  watchdog.unref?.();

  const securityHeaders = {
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };
  const asset = (file: string, type: string): Response =>
    new Response(Bun.file(new URL(`./public/${file}`, import.meta.url)), {
      headers: { ...securityHeaders, "Content-Type": type },
    });

  server = Bun.serve({
    hostname: HOST,
    port: options.port ?? 0,
    idleTimeout: 30,
    async fetch(request) {
      const url = new URL(request.url);
      const expected = `${HOST}:${server.port}`;
      if (
        request.headers.get("host") !== expected ||
        (request.headers.get("origin") &&
          request.headers.get("origin") !== `http://${expected}`)
      ) {
        return new Response("Forbidden", { status: 403 });
      }
      if (url.pathname === "/" && request.method === "GET") {
        touch();
        const html = await Bun.file(
          new URL("./public/index.html", import.meta.url),
        ).text();
        return new Response(html.replace("__SPEAKH_TOKEN__", token), {
          headers: {
            ...securityHeaders,
            "Content-Type": "text/html; charset=utf-8",
          },
        });
      }
      if (url.pathname === "/app.css" && request.method === "GET")
        return asset("app.css", "text/css; charset=utf-8");
      if (url.pathname === "/app.js" && request.method === "GET")
        return asset("app.js", "text/javascript; charset=utf-8");
      if (url.pathname === "/favicon.svg" && request.method === "GET")
        return new Response(Bun.file(new URL("../../assets/icon.svg", import.meta.url)), {
          headers: { ...securityHeaders, "Content-Type": "image/svg+xml" },
        });
      if (url.pathname !== "/events" && !url.pathname.startsWith("/api/"))
        return new Response("Not found", { status: 404 });
      if (
        (url.pathname === "/events"
          ? url.searchParams.get("key")
          : request.headers.get("x-speakh-key")) !== token
      ) {
        return reply({ error: "Unauthorized" }, 401);
      }
      touch();
      try {
        if (url.pathname === "/api/ping" && request.method === "GET")
          return reply({ ok: true });
        if (url.pathname === "/events" && request.method === "GET") {
          let client: ReadableStreamDefaultController<Uint8Array>;
          let disconnected = false;
          const disconnect = () => {
            if (disconnected) return;
            disconnected = true;
            request.signal.removeEventListener("abort", disconnect);
            listeners.delete(client);
            if (!listeners.size) {
              clearInterval(pulse);
              pulse = undefined;
            }
          };
          request.signal.addEventListener("abort", disconnect, { once: true });
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              client = controller;
              listeners.add(controller);
              controller.enqueue(encoder.encode(": connected\n\n"));
              if (!pulse) pulse = setInterval(() => emit("ping"), 20_000);
            },
            cancel: disconnect,
          });
          return new Response(stream, {
            headers: {
              ...securityHeaders,
              "Content-Type": "text/event-stream; charset=utf-8",
              Connection: "keep-alive",
            },
          });
        }
        if (url.pathname === "/api/state" && request.method === "GET") {
          const message = app.sessions.messages.find(
            (item) => item.key === app.selectedMessageKey,
          );
          const script = message ? app.scriptFor(message) : undefined;
          const playback = app.playback.state;
          const active =
            app.playback.script?.messageKey === message?.key
              ? app.playback.script?.segments[playback.segmentIndex]
              : undefined;
          const range =
            playback.status === "idle" ? undefined : active?.display;
          if (
            message &&
            (rendered?.key !== message.key ||
              rendered.markdown !== message.markdown ||
              rendered.start !== range?.start ||
              rendered.end !== range?.end)
          ) {
            rendered = {
              key: message.key,
              markdown: message.markdown,
              start: range?.start,
              end: range?.end,
              html: renderMarkdown(message.markdown, range),
            };
          }
          return reply({
            session: app.sessions.session,
            messages: app.sessions.messages.map(
              ({ key, markdown, createdAt, commentary }) => ({
                key,
                title: messageTitle(markdown, 110),
                createdAt,
                commentary,
              }),
            ),
            selectedKey: message?.key,
            markdown: message?.markdown ?? "",
            html: message ? (rendered?.html ?? "") : "",
            script: script
              ? {
                  segments: script.segments.map(({ text, lang, kind }) => ({
                    text,
                    lang,
                    kind,
                  })),
                  dominantLang: script.dominantLang,
                }
              : undefined,
            activeText: playback.status !== "idle" ? active?.text : undefined,
            playback,
            config: {
              voices: app.config.voices,
              reading: app.config.reading,
              study: app.config.study,
            },
          });
        }
        if (url.pathname === "/api/sessions" && request.method === "GET") {
          const listed = await app.sessions.list({});
          const current = app.sessions.session;
          const sessions =
            current &&
            !listed.some(
              (s) => s.harness === current.harness && s.id === current.id,
            )
              ? [current, ...listed]
              : listed;
          const scope: "all" | "here" =
            url.searchParams.get("scope") === "all" ? "all" : "here";
          const wanted = url.searchParams.get("harness");
          const harness: SessionHarness | "all" =
            wanted === "omp" ||
            wanted === "pi" ||
            wanted === "codex" ||
            wanted === "claude-code"
              ? wanted
              : "all";
          const query = (url.searchParams.get("q") ?? "").slice(0, 200);
          const showTechnical = url.searchParams.get("technical") === "1";
          const filter = {
            cwd: options.cwd ?? process.cwd(),
            scope,
            harness,
            query,
            showTechnical,
            currentId: current && sessionId(current),
          };
          const distribution = filterSessions(sessions, {
            ...filter,
            harness: "all",
          });
          const shown = filterSessions(sessions, filter);
          const hidden = showTechnical
            ? 0
            : filterSessions(sessions, {
                ...filter,
                harness: "all",
                showTechnical: true,
              }).length - distribution.length;
          const hereCount = filterSessions(sessions, {
            ...filter,
            scope: "here",
            harness: "all",
            query: "",
            showTechnical: false,
          }).length;
          return reply({
            sessions: shown,
            counts: sessionCounts(distribution),
            total: distribution.length,
            hidden,
            hereCount,
            current: current && sessionId(current),
          });
        }
        if (url.pathname === "/api/voices" && request.method === "GET")
          return reply({
            voices: await app.engine.voices(),
            installations: Object.fromEntries(installations),
          });
        if (url.pathname === "/api/phrases" && request.method === "GET")
          return reply({ phrases: await app.phrases.list() });
        if (
          request.method !== "POST" ||
          request.headers.get("content-type")?.split(";")[0] !==
            "application/json"
        )
          throw new HttpError(405, "Expected an application/json POST");
        const data = await body(request);
        if (url.pathname === "/api/command") {
          const id = data.id;
          if (typeof id !== "string" || !app.commands.get(id))
            throw new HttpError(400, "Unknown command");
          await app.commands.run(id);
          return reply({ ok: true });
        }
        if (url.pathname === "/api/follow") {
          const key = data.key;
          if (typeof key !== "string")
            throw new HttpError(400, "Expected a session key");
          const session = (await app.sessions.list({})).find(
            (item) => `${item.harness}:${item.id}` === key,
          );
          if (!session) throw new HttpError(404, "Session not found");
          app.playback.stop();
          await app.sessions.follow(session);
          notify();
          return reply({ ok: true });
        }
        if (url.pathname === "/api/message") {
          const key = data.key;
          if (
            typeof key !== "string" ||
            !app.sessions.messages.some((item) => item.key === key)
          )
            throw new HttpError(404, "Answer not found");
          if (data.read === true) app.readMessage(key);
          else {
            if (
              app.playback.state.status !== "idle" &&
              app.playback.state.messageKey !== key
            )
              app.playback.stop();
            app.selectMessage(key);
          }
          notify();
          return reply({ ok: true });
        }
        if (url.pathname === "/api/setting") {
          if (typeof data.path !== "string")
            throw new HttpError(400, "Expected a setting path");
          await app.updateConfig((draft) =>
            applySetting(draft, data.path as string, data.value),
          );
          return reply({ ok: true });
        }
        if (url.pathname === "/api/phrase") {
          if (
            typeof data.text !== "string" ||
            (data.lang !== "en" && data.lang !== "pt-BR")
          )
            throw new HttpError(400, "Invalid phrase");
          const saved = (await app.phrases.list()).find(
            (phrase) => phrase.text === data.text && phrase.lang === data.lang,
          );
          if (!saved) throw new HttpError(404, "Saved phrase not found");
          const options = {
            ...speechOptionsFromConfig(app.config, saved.lang),
            autoLanguage: false,
            defaultLang: saved.lang,
          };
          app.playback.play(
            buildSpeechScript(
              `phrase:${saved.savedAt.getTime()}`,
              saved.text,
              options,
            ),
          );
          return reply({ ok: true });
        }
        if (url.pathname === "/api/install") {
          const id = data.voice;
          if (typeof id !== "string" || !findVoice(id))
            throw new HttpError(400, "Unknown voice");
          if (installations.has(id))
            return reply({ ok: true, installing: true });
          installations.set(id, { done: 0, total: findVoice(id)!.sizeBytes });
          void app.engine
            .install(id, (done, total) => {
              installations.set(id, { done, total });
              notify();
            })
            .then(
              () => {
                installations.delete(id);
                notify();
              },
              (error: unknown) => {
                installations.set(id, {
                  done: 0,
                  total: 0,
                  error: error instanceof Error ? error.message : String(error),
                });
                notify();
              },
            );
          notify();
          return reply({ ok: true, installing: true }, 202);
        }
        if (url.pathname === "/api/quit") {
          queueMicrotask(close);
          return reply({ ok: true });
        }
        throw new HttpError(404, "Not found");
      } catch (error) {
        return reply(
          { error: error instanceof Error ? error.message : String(error) },
          error instanceof HttpError ? error.status : 500,
        );
      }
    },
  });
  return {
    url: `http://${HOST}:${server.port}/`,
    closed: completed.promise,
    close,
  };
}
