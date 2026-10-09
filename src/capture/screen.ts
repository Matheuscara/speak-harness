// Screen-text capture for wrap mode when no adapter knows the wrapped command: after the user presses Enter, the
// text that appears below the input line is collected until the screen stays unchanged for `idleMs`, then cleaned
// of prompt, status and frame lines. Pure: callers pass screens and timestamps.

export interface ScreenSnapshot {
  /** Visible rows, right-trimmed; trailing empty rows may be missing. */
  lines: readonly string[];
  rows: number;
  cursor: { x: number; y: number; visible: boolean };
}

export const DEFAULT_IDLE_MS = 1500;

/** Box-drawing frame at a line edge (`│ text │`). */
const FRAME = /^\s*[│┃║]\s?|\s?[│┃║]\s*$/g;
/** Lines made only of rules, box corners and blocks. */
const DECORATION = /^[\s\u2500-\u259f\-=_~+|]+$/;
/** Marker some harnesses draw before an answer (`● text`); replaced by spaces so its hanging indent dedents. */
const ANSWER_MARKER = /^(\s*)[●⏺] /u;
/** A shell/REPL prompt with nothing typed after it (`$`, `user@host:~/x$`, `(venv) ❯`, `sqlite>`, `>>>`). */
const PROMPT = /^\s*(?:\([^)]*\)\s*)?[\w.@:~/+-]*\s?(?:>>>|[$#%>❯›»➜λ])\s*$/u;
/** Prompt prefix in front of typed text, removed to compare an input line with its echo. */
const PROMPT_PREFIX = /^\s*(?:\([^)]*\)\s*)?[\w.@:~/+-]*\s?(?:>>>|[$#%>❯›»➜λ])\s?/u;
/** Harness chrome shown under or around the input: key hints, token and context counters, spinners. */
const STATUS: readonly RegExp[] = [
  /\besc to (?:interrupt|cancel|exit)\b/i,
  /\?\s+for shortcuts\b/i,
  /\b(?:ctrl|shift|alt)[+-]\w+ to \w/i,
  /⏎\s*send\b/,
  /\b\d[\d.,]*\s*k?\s+tokens?\b/i,
  /\bcontext (?:left|window|used)\b/i,
  /^\s*[\u2800-\u28ff✻✽✶✳✢◐◓◑◒]\s+\S.*(?:…|\.\.\.)/u,
];

/**
 * Rows the content moved up between two snapshots of the same terminal: the shift whose overlapping rows agree
 * best. 0 when the screen did not scroll, or was redrawn so that no shift explains it.
 */
export function scrollOffset(previous: readonly string[], next: readonly string[], rows: number): number {
  const score = (shift: number): number => {
    let total = 0;
    for (let row = 0; row + shift < rows; row++) {
      const before = previous[row + shift] ?? "";
      const after = next[row] ?? "";
      if (before === "" && after === "") continue;
      total += before === after ? 1 : -1;
    }
    return total;
  };
  let best = 0;
  let bestScore = score(0);
  for (let shift = 1; shift < rows; shift++) {
    const candidate = score(shift);
    if (candidate > 0 && candidate > bestScore) {
      best = shift;
      bestScore = candidate;
    }
  }
  return best;
}

/**
 * Row of the submitted input line in `lines`: the original row when it still shows the same text (or that text
 * plus an echo that arrived after Enter), otherwise the row nearest to it whose typed text equals (then contains)
 * the submitted one; -1 when it cannot be found.
 */
export function locateInput(lines: readonly string[], inputRow: number, inputLine: string): number {
  const original = lines[inputRow] ?? "";
  if (original === inputLine || (inputLine.trim() !== "" && original.startsWith(inputLine))) return inputRow;
  // Typed text of each line: frame and prompt removed.
  const [core = "", ...cores] = [inputLine, ...lines].map((line) => line.replace(FRAME, "").replace(PROMPT_PREFIX, "").trim());
  if (core.length < 2) return -1;
  for (const exact of [true, false]) {
    let best = -1;
    cores.forEach((candidate, row) => {
      const matches = exact ? candidate === core : candidate.includes(core);
      if (matches && (best < 0 || Math.abs(row - inputRow) < Math.abs(best - inputRow))) best = row;
    });
    if (best >= 0) return best;
  }
  return -1;
}

/**
 * Plain text of captured answer rows: frames, rule lines and answer markers (`● `) removed, trailing
 * prompt/status/blank lines dropped, common indentation removed (so indented terminal text is not read as a markdown
 * code block), blank runs collapsed.
 */
export function cleanCapture(lines: readonly string[]): string {
  const kept = lines
    .map((line) => line.replace(FRAME, "").replace(ANSWER_MARKER, "$1  "))
    .filter((line) => line.trim() === "" || !DECORATION.test(line));
  // Trailing prompt, status and blank lines are the next input area, not the answer.
  while (kept.length > 0) {
    const last = kept.at(-1) as string;
    if (last.trim() !== "" && !PROMPT.test(last) && !STATUS.some((pattern) => pattern.test(last))) break;
    kept.pop();
  }
  while (kept.length > 0 && (kept[0] as string).trim() === "") kept.shift();
  const indent = Math.min(...kept.filter((line) => line.trim() !== "").map((line) => line.length - line.trimStart().length));
  const out: string[] = [];
  for (const line of kept) {
    const text = line.trim() === "" ? "" : line.slice(indent).trimEnd();
    if (text === "" && out.at(-1) === "") continue;
    out.push(text);
  }
  return out.join("\n");
}

export interface CapturedScreen {
  /** Rows scrolled off since the input was submitted, followed by the current screen. */
  lines: readonly string[];
  /** Row of the input line when it was submitted. */
  inputRow: number;
  inputLine: string;
  /** Row of the visible cursor (the next input area), if any. */
  cursorRow: number | undefined;
}

/** Answer text below the submitted input line and above the next input area. */
export function answerText({ lines, inputRow, inputLine, cursorRow }: CapturedScreen): string {
  const start = locateInput(lines, inputRow, inputLine);
  if (start < 0) return "";
  const end = cursorRow !== undefined && cursorRow > start ? cursorRow : lines.length;
  return cleanCapture(lines.slice(start + 1, end));
}

interface Pending {
  inputRow: number;
  inputLine: string;
  /** Rows that scrolled off the top since the input was submitted. */
  history: string[];
  screen: ScreenSnapshot;
  changedAt: number;
  changed: boolean;
}

/** Collects one answer per submitted input; feed it every redraw of the terminal. */
export class ScreenCapture {
  readonly idleMs: number;
  private pending: Pending | undefined;

  constructor(options: { idleMs?: number } = {}) {
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  }

  /** An input was submitted and its answer is being collected. */
  get waiting(): boolean {
    return this.pending !== undefined;
  }

  /** When `poll` can return the answer, if the screen stays unchanged until then. */
  get deadline(): number | undefined {
    return this.pending?.changed ? this.pending.changedAt + this.idleMs : undefined;
  }

  /**
   * The user pressed Enter; `screen` is the screen at that moment, cursor on the input line. Returns the text
   * collected for the previous input when it was still waiting for the screen to settle.
   */
  submit(screen: ScreenSnapshot, now: number): string | undefined {
    const previous = this.pending?.changed ? this.finish() : undefined;
    this.pending = {
      inputRow: screen.cursor.y,
      inputLine: screen.lines[screen.cursor.y] ?? "",
      history: [],
      screen,
      changedAt: now,
      changed: false,
    };
    return previous || undefined;
  }

  /** The terminal redrew. Returns true when its text changed (the idle deadline moved). */
  observe(screen: ScreenSnapshot, now: number): boolean {
    const pending = this.pending;
    if (!pending) return false;
    const before = pending.screen;
    pending.screen = screen;
    if (before.lines.length === screen.lines.length && before.lines.every((line, row) => line === screen.lines[row])) return false;
    const shift = scrollOffset(before.lines, screen.lines, Math.max(before.rows, screen.rows));
    for (let row = 0; row < shift; row++) pending.history.push(before.lines[row] ?? "");
    pending.changedAt = now;
    pending.changed = true;
    return true;
  }

  /** The answer once the screen stayed unchanged for `idleMs`; undefined while waiting or when nothing was printed. */
  poll(now: number): string | undefined {
    const deadline = this.deadline;
    if (deadline === undefined || now < deadline) return undefined;
    return this.finish() || undefined;
  }

  private finish(): string {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return "";
    const { history, screen } = pending;
    return answerText({
      lines: [...history, ...screen.lines],
      inputRow: pending.inputRow,
      inputLine: pending.inputLine,
      cursorRow: screen.cursor.visible ? history.length + screen.cursor.y : undefined,
    });
  }
}
