import { expect, test } from "bun:test";
import type { SessionRef } from "../../src/core/types.ts";
import { countBar, filterSessions, isTechnicalSession, sessionCounts } from "../../src/tui/overlays/session-filter.ts";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * 86_400_000);
const session = (id: string, title: string | undefined, harness: SessionRef["harness"], cwd = "/work", days = 2): SessionRef => ({
  id, title, harness, cwd, updatedAt: ago(days),
});
const all: SessionRef[] = [
  session("1", "Conexão com banco", "omp"),
  session("2", "Reply with exactly: ok", "claude-code"),
  session("3", "Generate the session title from this JSON array", "claude-code"),
  { ...session("4", undefined, "pi", "/work", 7), hasReadableAnswer: false },
  session("5", "Produtos no 3dcontrol", "claude-code", "/other"),
  { ...session("6", undefined, "codex", "/work", 0.1), hasReadableAnswer: false },
];
const base = { cwd: "/work", scope: "all" as const, harness: "all" as const, query: "", showTechnical: false, now: NOW };

test("curated view hides old probes and empty files but keeps recent/current sessions", () => {
  expect(filterSessions(all, base).map((s) => s.id)).toEqual(["1", "5", "6"]);
  expect(filterSessions(all, { ...base, currentId: "claude-code:2" }).map((s) => s.id)).toEqual(["1", "2", "5", "6"]);
  expect(filterSessions(all, { ...base, showTechnical: true })).toHaveLength(6);
  expect(isTechnicalSession(all[5]!, undefined, NOW)).toBe(false);
});

test("case/accent-insensitive search composes with folder and harness filters", () => {
  expect(filterSessions(all, { ...base, scope: "here", query: "conexao" }).map((s) => s.id)).toEqual(["1"]);
  expect(filterSessions(all, { ...base, harness: "claude-code", query: "3DCONTROL" }).map((s) => s.id)).toEqual(["5"]);
  expect(filterSessions(all, { ...base, scope: "here", harness: "claude-code" })).toEqual([]);
});

test("distribution bars reflect actual session counts", () => {
  expect(sessionCounts(filterSessions(all, base))).toEqual({ omp: 1, pi: 0, codex: 1, "claude-code": 1 });
  expect(countBar(0, 100)).toBe("·");
  expect(countBar(50, 100, 8)).toBe("▰▰▰▰");
});
