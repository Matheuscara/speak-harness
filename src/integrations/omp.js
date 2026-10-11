// speak-harness OMP extension — installed by `speakh integrate omp`; reinstalling replaces this file.
//
// Reads each final main-session Oh My Pi reply aloud through the running SpeakHarness (`speakh web`, `speakh`,
// `speakh follow` or `speakh daemon`). Self-contained on purpose: it is copied into the OMP extensions directory and
// must not import anything from the SpeakHarness install.
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { posix, win32 } from "node:path";

export const SPEAK_COMMAND = "speak-text";
/** The core rejects larger payloads; longer replies are cut rather than dropped. */
export const MAX_MARKDOWN_CHARS = 100_000;
const TIMEOUT_MS = 2_500;

/**
 * The control endpoint of the running SpeakHarness: the per-user named pipe on Windows, the `current` socket elsewhere.
 * Mirrors `resolvePaths(...).control` in src/core/paths.ts.
 */
export function controlSocketPath(
  env = process.env,
  platform = process.platform,
  home = homedir(),
) {
  if (platform === "win32") {
    const profile = win32.normalize(home).replace(/\\+$/, "").toLowerCase();
    const user = createHash("sha256")
      .update(profile)
      .digest("hex")
      .slice(0, 16);
    return `\\\\.\\pipe\\speak-harness-${user}`;
  }
  const base =
    env.XDG_RUNTIME_DIR ||
    posix.join(tmpdir(), `speak-harness-${process.getuid?.() ?? "user"}`);
  return posix.join(base, "speak-harness", "current");
}

/** The reply text of a finished assistant message: text blocks only (no thinking, no tool calls). */
export function replyMarkdown(message) {
  if (
    !message ||
    message.role !== "assistant" ||
    !Array.isArray(message.content)
  )
    return undefined;
  if (message.stopReason === "error" || message.stopReason === "aborted")
    return undefined;
  const text = message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
  return text === "" ? undefined : text.slice(0, MAX_MARKDOWN_CHARS);
}

/**
 * Identity of one reply. OMP's `turn_id` restarts at 0 on every prompt, so the assistant message timestamp (or,
 * without one, a hash of the reply) keeps ids of different replies apart while a re-fired stop keeps the same id.
 */
export function eventId(event, markdown) {
  const timestamp = event.last_assistant_message?.timestamp;
  const discriminator =
    typeof timestamp === "number" && Number.isFinite(timestamp)
      ? String(timestamp)
      : createHash("sha256").update(markdown).digest("hex").slice(0, 16);
  return `omp:${event.session_id}:${event.turn_id}:${discriminator}`;
}

/**
 * Sends one control request and resolves with whether SpeakHarness accepted it. Never rejects: an absent daemon,
 * a refusal, a timeout or an abort all resolve `{ ok: false, reason }`, where `reason` never contains the request.
 */
export function sendControlRequest(
  command,
  args,
  { path = controlSocketPath(), timeoutMs = TIMEOUT_MS, signal } = {},
) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ ok: false, reason: "aborted" });
    let settled = false;
    let buffer = "";
    const socket = createConnection(path);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve(result);
    };
    const onAbort = () => finish({ ok: false, reason: "aborted" });
    const timer = setTimeout(
      () => finish({ ok: false, reason: "timeout" }),
      timeoutMs,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.setEncoding("utf8");
    socket.on("connect", () =>
      socket.write(`${JSON.stringify({ command, args })}\n`),
    );
    socket.on("data", (data) => {
      buffer += data;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      let reply;
      try {
        reply = JSON.parse(buffer.slice(0, newline));
      } catch {
        return finish({ ok: false, reason: "invalid reply" });
      }
      if (reply?.ok === true) return finish({ ok: true });
      finish({ ok: false, reason: "refused" });
    });
    socket.on("error", (error) =>
      finish({ ok: false, reason: error?.code ?? "socket error" }),
    );
    socket.on("close", () =>
      finish({ ok: false, reason: "closed without reply" }),
    );
  });
}

/** `session_stop` handler: main-session only (OMP never fires it for subagents); hands the reply to SpeakHarness. */
export function createStopHandler({
  send = sendControlRequest,
  path,
  log,
} = {}) {
  return async (event) => {
    // A stop after a hook-requested continuation answers the hook, not the user.
    if (!event || event.stop_hook_active || event.signal?.aborted) return;
    if (typeof event.session_id !== "string" || event.session_id === "") return;
    const markdown = replyMarkdown(event.last_assistant_message);
    if (markdown === undefined) return;
    const result = await send(
      SPEAK_COMMAND,
      [eventId(event, markdown), markdown, event.session_id],
      {
        path,
        signal: event.signal,
      },
    );
    if (!result.ok)
      log?.(
        `speak-harness: reply not handed to SpeakHarness (${result.reason})`,
      );
    // Returning nothing: never request a continuation.
  };
}

export default function speakHarness(pi) {
  const log = (message) => {
    try {
      pi.logger?.debug?.(message);
    } catch {
      /* Logging must never disturb the session. */
    }
  };
  const handler = createStopHandler({ log });
  pi.on("session_stop", async (event) => {
    try {
      await handler(event);
    } catch (error) {
      log(`speak-harness: ${error instanceof Error ? error.name : "error"}`);
    }
  });
}
