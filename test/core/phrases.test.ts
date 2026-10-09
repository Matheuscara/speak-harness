import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPhraseStore } from "../../src/core/phrases.ts";
import type { Phrase } from "../../src/core/types.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "speakh-phrases-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("missing file lists nothing", async () => {
  expect(await createPhraseStore(join(dir, "phrases.md")).list()).toEqual([]);
});

test("saved phrases round-trip through readable markdown", async () => {
  const file = join(dir, "data", "phrases.md");
  const store = createPhraseStore(file);
  const phrases: Phrase[] = [
    { text: "The credential has a TTL.", lang: "en", messageKey: "omp:s1:3", savedAt: new Date("2026-10-08T14:03:12.000Z") },
    { text: "A credencial é temporária.", lang: "pt-BR", messageKey: "codex:abc:9", savedAt: new Date("2026-10-08T15:00:00.000Z") },
  ];
  for (const phrase of phrases) await store.save(phrase);

  expect(await store.list()).toEqual(phrases);
  const markdown = await readFile(file, "utf8");
  expect(markdown.startsWith("# SpeakHarness phrases\n")).toBe(true);
  expect(markdown).toContain("> The credential has a TTL.");
  expect(markdown).toContain("- lang: pt-BR");
  expect(markdown.match(/^# /gm)).toHaveLength(1);
});
