import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { paths } from "./paths.ts";
import { LANGS } from "./types.ts";
import type { Lang, Phrase, PhraseStore } from "./types.ts";

const HEADER = "# SpeakHarness phrases\n";

/**
 * Markdown entry per phrase:
 *
 * ## 2026-10-08T14:03:12.000Z
 *
 * - lang: en
 * - source: omp:session:message
 *
 * > The sentence text.
 */
function formatPhrase(phrase: Phrase): string {
  const text = phrase.text.replace(/\s+/g, " ").trim();
  return `\n## ${phrase.savedAt.toISOString()}\n\n- lang: ${phrase.lang}\n- source: ${phrase.messageKey}\n\n> ${text}\n`;
}

export function parsePhrases(markdown: string): Phrase[] {
  const phrases: Phrase[] = [];
  for (const entry of markdown.split(/^## /m).slice(1)) {
    const lines = entry.split("\n");
    const savedAt = new Date((lines[0] ?? "").trim());
    let lang: Lang | undefined;
    let messageKey = "";
    const quoted: string[] = [];
    for (const line of lines.slice(1)) {
      const field = /^- (lang|source): (.*)$/.exec(line);
      if (field?.[1] === "lang") {
        const value = (field[2] ?? "").trim();
        lang = LANGS.find((candidate) => candidate === value);
      } else if (field?.[1] === "source") {
        messageKey = (field[2] ?? "").trim();
      } else if (line.startsWith(">")) {
        quoted.push(line.replace(/^>\s?/, ""));
      }
    }
    const text = quoted.join(" ").trim();
    if (Number.isNaN(savedAt.getTime()) || !lang || text === "") continue;
    phrases.push({ text, lang, messageKey, savedAt });
  }
  return phrases;
}

export function createPhraseStore(file: string = paths.phrasesFile()): PhraseStore {
  return {
    async save(phrase) {
      await mkdir(dirname(file), { recursive: true });
      const exists = await stat(file).then(
        () => true,
        () => false,
      );
      await appendFile(file, `${exists ? "" : HEADER}${formatPhrase(phrase)}`, "utf8");
    },
    async list() {
      try {
        return parsePhrases(await readFile(file, "utf8"));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
      }
    },
  };
}
