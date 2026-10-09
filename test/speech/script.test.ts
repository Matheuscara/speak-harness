import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSpeechScript, buildTableScript, speechOptionsFromConfig } from "../../src/core/speech/index.ts";
import type { Config, SpeechOptions, SpeechScript } from "../../src/core/types.ts";

const FIXTURES = join(import.meta.dir, "../fixtures/speech");
const fixture = (name: string): string => readFileSync(join(FIXTURES, `${name}.md`), "utf8");

const OPTIONS: SpeechOptions = {
  tables: "summary",
  quoteCue: true,
  autoLanguage: true,
  defaultLang: "en",
  lexicon: { en: {}, "pt-BR": {} },
  maxSegmentChars: 240,
};

function build(markdown: string, options: Partial<SpeechOptions> = {}): SpeechScript {
  return buildSpeechScript("test:session:1", markdown, { ...OPTIONS, ...options });
}

/** [kind, lang, text, source covered by display] per segment. */
function golden(markdown: string, script: SpeechScript): Array<[string, string, string, string]> {
  return script.segments.map((s) => [s.kind, s.lang, s.text, markdown.slice(s.display.start, s.display.end)]);
}

describe("OMP-style Portuguese answer", () => {
  const md = fixture("omp-pt");
  const script = build(md);

  test("golden segments", () => {
    expect(script.dominantLang).toBe("pt-BR");
    expect(golden(md, script)).toEqual([
      ["heading", "pt-BR", "Resumo da mudança", "## Resumo da mudança"],
      [
        "sentence",
        "pt-BR",
        "Implementei o cache de sessões no session service, com T T L configurável.",
        "Implementei o **cache de sessões** no `SessionService`, com TTL configurável.",
      ],
      [
        "sentence",
        "pt-BR",
        "A lógica principal fica em sessions.ts e os testes em sessions.test.ts.",
        "A lógica principal fica em `src/core/sessions.ts` e os testes em `test/core/sessions.test.ts`.",
      ],
      ["heading", "pt-BR", "O que mudou", "### O que mudou"],
      [
        "list-item",
        "pt-BR",
        "Adicionei o método refresh sessions com debounce de 200 ms",
        "- Adicionei o método `refreshSessions()` com *debounce* de 200 ms",
      ],
      [
        "list-item",
        "pt-BR",
        "O parser agora ignora linhas vazias, por exemplo no final do arquivo",
        "- O parser agora ignora linhas vazias, por ex. no final do arquivo",
      ],
      ["list-item", "pt-BR", "Removi a dependência antiga do lodash", "- Removi a dependência antiga do `lodash`"],
      ["list-item", "pt-BR", "1. Rode bun install", "1. Rode `bun install`"],
      ["list-item", "pt-BR", "2. Rode bun test para validar", "2. Rode `bun test` para validar"],
      ["cue", "pt-BR", "Bloco de código TypeScript, 4 linhas", md.slice(md.indexOf("```ts"), md.indexOf("```\n\n|") + 3)],
      ["table", "pt-BR", "Tabela com 3 colunas: Opção, Tipo, Padrão.", md.slice(md.indexOf("| Opção"), md.indexOf("| 100 |") + 7)],
      ["cue", "pt-BR", "Citação.", "> **Atenção:** a limpeza do cache acontece só quando o processo reinicia."],
      [
        "quote",
        "pt-BR",
        "Atenção: a limpeza do cache acontece só quando o processo reinicia.",
        "**Atenção:** a limpeza do cache acontece só quando o processo reinicia.",
      ],
      ["sentence", "pt-BR", "Se precisar, posso abrir um P R com essas mudanças.", "Se precisar, posso abrir um PR com essas mudanças. ✅"],
    ]);
  });

  test("blocks, indexes and pauses", () => {
    expect(script.blocks).toBe(12);
    expect(script.segments.map((s) => s.index)).toEqual(script.segments.map((_, i) => i));
    expect(script.segments.map((s) => s.blockIndex)).toEqual([0, 1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 11]);
    const pause = (text: string) => script.segments.find((s) => s.text.startsWith(text))?.pauseAfterMs;
    expect(pause("Resumo")).toBe(600);
    expect(pause("Adicionei")).toBe(250);
    expect(pause("Implementei")).toBeLessThan(pause("A lógica") ?? 0);
  });
});

describe("English answer", () => {
  const md = fixture("english");
  const script = build(md, { defaultLang: "pt-BR" });

  test("golden segments", () => {
    expect(script.dominantLang).toBe("en");
    expect(golden(md, script)).toEqual([
      ["heading", "en", "Fix for the playback race", "# Fix for the playback race"],
      [
        "sentence",
        "en",
        "The bug was in playback controller next: it read the index before the previous chunk finished.",
        "The bug was in `PlaybackController.next()`: it read the index before the previous chunk finished.",
      ],
      [
        "sentence",
        "en",
        "I moved the update into the on ended handler, so the state is consistent.",
        "I moved the update into the `onEnded` handler, so the state is consistent.",
      ],
      [
        "sentence",
        "en",
        "Why it happened: the audio player emits ended asynchronously, for example after the buffer drains.",
        "**Why it happened:** the audio player emits `ended` asynchronously, e.g. after the buffer drains.",
      ],
      [
        "sentence",
        "en",
        "See the Node.js docs and github.com for details.",
        "See [the Node.js docs](https://nodejs.org/api/events.html) and https://www.github.com/oven-sh/bun/issues/1234 for details.",
      ],
      ["sentence", "en", "Changes:", "Changes:"],
      ["list-item", "en", "Updated controller.ts", "- Updated `src/core/playback/controller.ts`"],
      ["list-item", "en", "Added a regression test in playback.test.ts", "- Added a regression test in `test/core/playback.test.ts`"],
      ["cue", "en", "Code block, 1 line", "```\nbun test test/core\n```"],
      ["sentence", "en", "Version 1.2.3 includes the fix.", "Version 1.2.3 includes the fix."],
      ["sentence", "en", "Let me know if you want a C L I flag for it!", "Let me know if you want a CLI flag for it!"],
    ]);
  });

  test("thematic break lengthens the pause before it", () => {
    const cue = script.segments.find((s) => s.kind === "cue");
    expect(cue?.pauseAfterMs).toBe(600);
  });
});

describe("mixed Portuguese and English", () => {
  const md = fixture("mixed");

  test("Portuguese with English terms stays pt-BR; an English paragraph switches", () => {
    const script = build(md);
    expect(script.dominantLang).toBe("pt-BR");
    expect(script.segments.map((s) => [s.lang, s.text.split(" ").slice(0, 3).join(" ")])).toEqual([
      ["pt-BR", "Fiz o merge"],
      ["en", "The error message"],
      ["pt-BR", "Então o próximo"],
    ]);
  });

  test("autoLanguage off reads everything in defaultLang", () => {
    const script = build(md, { autoLanguage: false, defaultLang: "en" });
    expect(script.dominantLang).toBe("en");
    expect(new Set(script.segments.map((s) => s.lang))).toEqual(new Set(["en"]));
  });

  test("short first block inherits the dominant language; short later blocks inherit the previous one", () => {
    const text = [
      "Pronto.",
      "Agora o servidor reinicia sozinho quando o arquivo de configuração muda.",
      "Ok, then.",
      "The watcher now debounces events so the reload only happens once per save.",
      "Done.",
    ].join("\n\n");
    expect(build(text, { defaultLang: "en" }).segments.map((s) => s.lang)).toEqual(["pt-BR", "pt-BR", "pt-BR", "en", "en"]);
  });

  test("whole message undetermined falls back to defaultLang", () => {
    expect(build("Ok.", { defaultLang: "pt-BR" }).segments[0]?.lang).toBe("pt-BR");
    expect(build("Ok.", { defaultLang: "en" }).dominantLang).toBe("en");
  });

  test("code cues use the surrounding language", () => {
    const text = "Este é o trecho que corrige a leitura do arquivo de configuração.\n\n```json\n{}\n```\n";
    expect(build(text).segments.at(-1)).toMatchObject({ kind: "cue", lang: "pt-BR", text: "Bloco de código jêison, 1 linha" });
  });
});

describe("markdown syntax is never spoken", () => {
  const SYNTAX = /[*#`|[]|\]\(/;
  for (const name of ["omp-pt", "english", "mixed"]) {
    test(name, () => {
      for (const tables of ["summary", "rows"] as const) {
        for (const segment of build(fixture(name), { tables }).segments) expect(segment.text).not.toMatch(SYNTAX);
      }
    });
  }

  test("stray syntax, emoji and decorative symbols", () => {
    const md = "🚀 Pronto → agora **funciona** ~~quebrado~~ \\*literal\\* e `|` também ✨ — fim. ##\n\n***\n\n<div>bloco html</div>\n";
    const texts = build(md).segments.map((s) => s.text);
    expect(texts).toEqual(["Pronto agora funciona quebrado literal e código também — fim."]);
  });
});

describe("display ranges", () => {
  test("sentences inside a paragraph cover their own source, including inline markup", () => {
    const md = "First sentence is plain. Second has **bold text** and `codeName`. Third ends with a [link](https://x.dev).";
    const script = build(md);
    expect(golden(md, script).map(([, , , source]) => source)).toEqual([
      "First sentence is plain.",
      "Second has **bold text** and `codeName`.",
      "Third ends with a [link](https://x.dev).",
    ]);
  });

  test("a sentence starting and ending inside emphasis takes the markup", () => {
    const md = "Intro text here. *Whole sentence emphasized.* Outro text.";
    expect(golden(md, build(md))[1]?.[3]).toBe("*Whole sentence emphasized.*");
  });

  test("ranges are ordered and inside the markdown", () => {
    for (const name of ["omp-pt", "english", "mixed"]) {
      const md = fixture(name);
      let previousStart = -1;
      for (const { display } of build(md).segments) {
        expect(display.start).toBeGreaterThanOrEqual(previousStart);
        expect(display.end).toBeGreaterThan(display.start);
        expect(display.end).toBeLessThanOrEqual(md.length);
        previousStart = display.start;
      }
    }
  });

  test("soft line breaks and CRLF do not split sentences", () => {
    const md = "> primeira linha da citação\r\n> continua aqui no mesmo parágrafo.\r\n";
    expect(build(md).segments.map((s) => s.text)).toEqual(["Citação.", "primeira linha da citação continua aqui no mesmo parágrafo."]);
  });
});

describe("sentence splitting", () => {
  test("abbreviations, versions and file names do not end sentences", () => {
    const md = "Use a flag, e.g. the verbose one. Version 1.2.3 fixed it in config.ts today. Done!";
    expect(build(md).segments.map((s) => s.text)).toEqual([
      "Use a flag, for example the verbose one.",
      "Version 1.2.3 fixed it in config.ts today.",
      "Done!",
    ]);
  });

  test("Portuguese abbreviations", () => {
    const md = "Use um arquivo, ex. o de configuração. Depois rode os testes, etc. e pronto.";
    expect(build(md, { defaultLang: "pt-BR" }).segments.map((s) => s.text)).toEqual([
      "Use um arquivo, por exemplo o de configuração.",
      "Depois rode os testes, etcétera e pronto.",
    ]);
  });

  test("long sentences split at clause boundaries, then words", () => {
    const clause = "o servidor recarrega a configuração sem reiniciar o processo";
    const md = `${[clause, clause, clause, clause].join(", ")} e termina.`;
    const script = build(md, { maxSegmentChars: 80 });
    expect(script.segments.length).toBeGreaterThan(1);
    for (const segment of script.segments) expect(segment.text.length).toBeLessThanOrEqual(80);
    expect(script.segments.slice(0, -1).every((s) => s.text.endsWith(","))).toBe(true);
    expect(script.segments.map((s) => s.text).join(" ")).toBe(md);
    const words = "palavra ".repeat(40).trim();
    const byWords = build(`${words}.`, { maxSegmentChars: 50 });
    for (const segment of byWords.segments) expect(segment.text.length).toBeLessThanOrEqual(50);
    expect(byWords.segments.map((s) => s.text).join(" ")).toBe(`${words}.`);
    const starts = byWords.segments.map((s) => s.display.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});

describe("inline rules", () => {
  const say = (md: string) => build(md).segments.map((s) => s.text).join(" | ");

  test("links read their label; autolinks and bare URLs read the host", () => {
    expect(say("Read [the guide](https://docs.example.com/guide) now.")).toBe("Read the guide now.");
    expect(say("Open <https://www.example.com/path> or www.foo.org or https://bar.dev/x?y=1 now.")).toBe(
      "Open example.com or foo.org or bar.dev now.",
    );
  });

  test("images read alt text; html and footnote references are dropped", () => {
    expect(say("See ![the flow diagram](a.png) and <kbd>Ctrl</kbd> here.[^1]\n\n[^1]: note")).toBe("See the flow diagram and Ctrl here.");
  });

  test("file paths in text read the last segment", () => {
    expect(say("Edit src/core/speech/index.ts and ./scripts/run then ~/notes now.")).toBe("Edit index.ts and run then notes now.");
  });

  test("inline code is verbalized; long or symbol-heavy code becomes 'code'", () => {
    expect(say("Call `speakLastMessage` with `max_segment_chars` and `const x: Record<string, number> = {}`.")).toBe(
      "Call speak last message with max segment chars and code.",
    );
    expect(build("Chame `a => b + c` agora mesmo, por favor, no terminal.", { defaultLang: "pt-BR" }).segments[0]?.text).toBe(
      "Chame código agora mesmo, por favor, no terminal.",
    );
  });

  test("ordered lists speak the number, honoring the start", () => {
    expect(build("3. third step\n4. fourth step\n").segments.map((s) => s.text)).toEqual(["3. third step", "4. fourth step"]);
  });

  test("nested lists and code inside items", () => {
    const md = "- outer item\n  - inner item\n  ```sh\n  ls\n  ```\n";
    expect(golden(md, build(md, { autoLanguage: false }))).toEqual([
      ["list-item", "en", "outer item", "- outer item"],
      ["list-item", "en", "inner item", "- inner item"],
      ["cue", "en", "Shell code block, 1 line", "```sh\n  ls\n  ```"],
    ]);
  });
});

describe("code blocks", () => {
  const cue = (md: string, lang: "en" | "pt-BR" = "en") =>
    build(md, { autoLanguage: false, defaultLang: lang }).segments.map((s) => s.text);

  test("language names, line counts and localization", () => {
    expect(cue("```typescript\na\nb\n```")).toEqual(["TypeScript code block, 2 lines"]);
    expect(cue("```py\na\n```", "pt-BR")).toEqual(["Bloco de código Python, 1 linha"]);
    expect(cue("```\na\nb\nc\n```", "pt-BR")).toEqual(["Bloco de código, 3 linhas"]);
    expect(cue("```bash\n```")).toEqual(["Shell code block"]);
    expect(cue("```text\nx\n```")).toEqual(["Code block, 1 line"]);
    expect(cue("```elm\nx\n```")).toEqual(["Elm code block, 1 line"]);
  });
});

describe("tables", () => {
  const md = "Resultado da comparação entre as opções de configuração:\n\n| Nome | Tipo | Padrão |\n| --- | --- | --- |\n| `ttl_ms` | número | 5000 |\n| modo | texto | |\n";

  test("summary by default", () => {
    const table = build(md).segments.find((s) => s.kind === "table");
    expect(table).toMatchObject({ text: "Tabela com 3 colunas: Nome, Tipo, Padrão.", lang: "pt-BR", blockIndex: 1 });
    expect(md.slice(table?.display.start, table?.display.end)).toStartWith("| Nome");
  });

  test("rows mode reads header then rows, each pointing at its row", () => {
    const script = build(md, { tables: "rows" });
    expect(golden(md, script).slice(1)).toEqual([
      ["table", "pt-BR", "Tabela com 3 colunas: Nome, Tipo, Padrão.", "| Nome | Tipo | Padrão |"],
      ["table", "pt-BR", "Linha 1: ttl ms, número, 5000.", "| `ttl_ms` | número | 5000 |"],
      ["table", "pt-BR", "Linha 2: modo, texto, vazio.", "| modo | texto | |"],
    ]);
  });

  test("buildTableScript reads the table at a block index", () => {
    const script = buildTableScript("k", md, 1, OPTIONS);
    expect(script?.segments.map((s) => [s.index, s.blockIndex, s.text])).toEqual([
      [0, 1, "Tabela com 3 colunas: Nome, Tipo, Padrão."],
      [1, 1, "Linha 1: ttl ms, número, 5000."],
      [2, 1, "Linha 2: modo, texto, vazio."],
    ]);
    expect(script?.blocks).toBe(2);
    expect(buildTableScript("k", md, 0, OPTIONS)).toBeUndefined();
    expect(buildTableScript("k", md, 7, OPTIONS)).toBeUndefined();
  });

  test("English summary", () => {
    const text = "| name | type | default |\n| - | - | - |\n| a | b | c |\n";
    expect(build(text).segments[0]?.text).toBe("Table with 3 columns: name, type, default.");
    expect(build("| only |\n| - |\n| a |\n").segments[0]?.text).toBe("Table with 1 column: only.");
  });
});

describe("quotes", () => {
  test("quote cue is configurable", () => {
    const md = "> This is a quoted paragraph from the documentation page.\n";
    expect(build(md).segments.map((s) => [s.kind, s.text])).toEqual([
      ["cue", "Quote."],
      ["quote", "This is a quoted paragraph from the documentation page."],
    ]);
    expect(build(md, { quoteCue: false }).segments.map((s) => [s.kind, s.text])).toEqual([
      ["quote", "This is a quoted paragraph from the documentation page."],
    ]);
  });
});

describe("lexicon", () => {
  test("user entries win over built-ins and are whole-word, case-sensitive", () => {
    const md = "The TTL and SQL settings use ttl and TTLs values.";
    expect(build(md).segments[0]?.text).toBe("The T T L and S Q L settings use ttl and TTLs values.");
    const custom = build(md, { lexicon: { en: { TTL: "time to live", ttl: "tee tee ell" }, "pt-BR": {} } });
    expect(custom.segments[0]?.text).toBe("The time to live and S Q L settings use tee tee ell and TTLs values.");
  });

  test("lexicon of the block language applies", () => {
    const pt = build("Configurei o JSON do projeto com os valores corretos.", { lexicon: { en: {}, "pt-BR": { JSON: "jota som" } } });
    expect(pt.segments[0]?.text).toBe("Configurei o jota som do projeto com os valores corretos.");
  });
});

describe("speechOptionsFromConfig", () => {
  test("maps config fields", () => {
    const config = {
      voices: { primary: "kokoro:af_heart", alternate: "kokoro:pf_dora", autoLanguage: false, speed: 1, languages: { en: "a", "pt-BR": "b" } },
      reading: { autoRead: false, autoReadQueue: "latest", tables: "rows", quoteCue: false, maxSegmentChars: 120 },
      lexicon: { en: { TTL: "T T L" }, "pt-BR": {} },
    } as unknown as Config;
    expect(speechOptionsFromConfig(config, "pt-BR")).toEqual({
      tables: "rows",
      quoteCue: false,
      autoLanguage: false,
      defaultLang: "pt-BR",
      lexicon: { en: { TTL: "T T L" }, "pt-BR": {} },
      maxSegmentChars: 120,
    });
  });
});
