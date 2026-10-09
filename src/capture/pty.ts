// The wrapped harness as a child process on a pseudo-terminal (Bun.spawn with `terminal`): output callback,
// input, resize, and a graceful stop (hang-up, then terminate, then kill).

export interface PtyOptions {
  cwd: string;
  cols: number;
  rows: number;
  /** Extra environment on top of `process.env`; `TERM` is always `xterm-256color`. */
  env?: Record<string, string | undefined>;
  onData(data: Uint8Array): void;
}

export interface PtyExit {
  /** Exit status, or null when a signal ended the process. */
  code: number | null;
  signal: string | null;
}

/** Wait after SIGHUP, then after SIGTERM, before SIGKILL. */
const STOP_STEP_MS = 500;

export class PtyProcess {
  readonly pid: number;
  /** Settles when the child exits (never rejects). */
  readonly exited: Promise<PtyExit>;
  private readonly process: Bun.Subprocess;
  private readonly terminal: Bun.Terminal;
  private size: { cols: number; rows: number };
  private done = false;

  /** Starts `command`; throws when it cannot be started (for example, not found). */
  constructor(command: readonly string[], options: PtyOptions) {
    if (command.length === 0) throw new Error("no command to run");
    try {
      this.process = Bun.spawn([...command], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env, TERM: "xterm-256color" },
        terminal: { cols: options.cols, rows: options.rows, name: "xterm-256color", data: (_terminal, data) => options.onData(data) },
      });
    } catch (error) {
      throw new Error(`cannot run ${command[0]}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const terminal = this.process.terminal;
    if (!terminal) throw new Error("Bun did not attach a terminal to the child process");
    this.terminal = terminal;
    this.pid = this.process.pid;
    this.size = { cols: options.cols, rows: options.rows };
    this.exited = this.process.exited.then(
      () => {
        this.done = true;
        return { code: this.process.signalCode ? null : this.process.exitCode, signal: this.process.signalCode ?? null };
      },
      () => {
        this.done = true;
        return { code: null, signal: null };
      },
    );
  }

  /** Bytes for the child's terminal input (keys, paste, terminal query responses). Dropped after exit. */
  write(data: string | Uint8Array): void {
    if (this.done || this.terminal.closed) return;
    this.terminal.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.done || this.terminal.closed || (cols === this.size.cols && rows === this.size.rows)) return;
    this.size = { cols, rows };
    this.terminal.resize(cols, rows);
  }

  /** Hangs up (SIGHUP), then SIGTERM, then SIGKILL, waiting briefly between steps; closes the terminal. */
  async stop(): Promise<PtyExit> {
    for (const signal of ["SIGHUP", "SIGTERM", "SIGKILL"] as const) {
      if (this.done) break;
      this.signal(signal);
      if (signal === "SIGKILL") await this.exited;
      else await Promise.race([this.exited, Bun.sleep(STOP_STEP_MS)]);
    }
    if (!this.terminal.closed) this.terminal.close();
    return this.exited;
  }

  /** The child leads its own session; signal its process group so helpers it started (bunx → harness) stop too. */
  private signal(signal: NodeJS.Signals): void {
    try {
      process.kill(-this.pid, signal);
    } catch {
      try {
        this.process.kill(signal);
      } catch {
        // Already gone.
      }
    }
  }
}
