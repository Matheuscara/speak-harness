export const SPEAK_COMMAND: "speak-text";
export const MAX_MARKDOWN_CHARS: number;

export interface OmpAssistantMessage {
  role: string;
  content?: unknown;
  stopReason?: string;
  timestamp?: number;
}

export interface OmpSessionStopEvent {
  session_id: string;
  turn_id: number;
  last_assistant_message?: OmpAssistantMessage;
  stop_hook_active?: boolean;
  signal?: AbortSignal;
}

export type ControlResult = { ok: true } | { ok: false; reason: string };
export interface ControlRequestOptions {
  path?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function controlSocketPath(
  env?: Record<string, string | undefined>,
  platform?: NodeJS.Platform,
  home?: string,
): string;
export function replyMarkdown(
  message: OmpAssistantMessage | undefined,
): string | undefined;
export function eventId(event: OmpSessionStopEvent, markdown: string): string;
export function sendControlRequest(
  command: string,
  args: string[],
  options?: ControlRequestOptions,
): Promise<ControlResult>;
export function createStopHandler(options?: {
  send?: (
    command: string,
    args: string[],
    options: ControlRequestOptions,
  ) => Promise<ControlResult>;
  path?: string;
  log?: (message: string) => void;
}): (event: OmpSessionStopEvent) => Promise<void>;

export default function speakHarness(pi: {
  on(
    event: "session_stop",
    handler: (event: OmpSessionStopEvent) => Promise<void>,
  ): void;
  logger?: { debug?(message: string): void };
}): void;
