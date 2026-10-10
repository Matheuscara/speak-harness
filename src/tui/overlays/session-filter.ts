import { resolve } from "node:path";
import type { SessionRef } from "../../core/types.ts";

export const HARNESSES = ["omp", "pi", "codex", "claude-code"] as const;
export type SessionHarness = (typeof HARNESSES)[number];

export interface SessionFilters {
  cwd: string;
  scope: "here" | "all";
  harness: SessionHarness | "all";
  query: string;
  showTechnical: boolean;
  currentId?: string;
  now?: number;
}

const TECHNICAL_TITLE = /^(?:reply with exactly\b|generate the session title\b|api error\b|<local-command-|<command-name>)/i;
const RECENT_MS = 24 * 60 * 60 * 1000;

export function sessionId(session: SessionRef): string {
  return `${session.harness}:${session.id}`;
}

export function isTechnicalSession(session: SessionRef, currentId?: string, now = Date.now()): boolean {
  if (sessionId(session) === currentId || now - session.updatedAt.getTime() <= RECENT_MS) return false;
  return session.hasReadableAnswer === false || TECHNICAL_TITLE.test(session.title ?? "");
}

/** Search ignores case and accents; matching title, harness, cwd and id helps find untitled sessions. */
function fold(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

export function filterSessions(sessions: readonly SessionRef[], options: SessionFilters): SessionRef[] {
  const cwd = resolve(options.cwd);
  const query = fold(options.query.trim());
  const now = options.now ?? Date.now();
  return sessions.filter((session) => {
    if (options.scope === "here" && (!session.cwd || resolve(session.cwd) !== cwd)) return false;
    if (options.harness !== "all" && session.harness !== options.harness) return false;
    if (!options.showTechnical && isTechnicalSession(session, options.currentId, now)) return false;
    if (!query) return true;
    return fold(`${session.title ?? ""} ${session.harness} ${session.cwd ?? ""} ${session.id}`).includes(query);
  });
}

export function sessionCounts(sessions: readonly SessionRef[]): Record<SessionHarness, number> {
  const counts: Record<SessionHarness, number> = { omp: 0, pi: 0, codex: 0, "claude-code": 0 };
  for (const session of sessions) if (HARNESSES.includes(session.harness as SessionHarness)) counts[session.harness as SessionHarness]++;
  return counts;
}

/** True data-viz: the bar length is proportional to the largest category count. */
export function countBar(count: number, largest: number, width = 8): string {
  if (count === 0 || largest === 0) return "·";
  return "▰".repeat(Math.max(1, Math.round((count / largest) * width)));
}
