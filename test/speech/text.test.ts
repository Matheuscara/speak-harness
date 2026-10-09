import { describe, expect, test } from "bun:test";
import { BUILTIN_LEXICON, compileDetectionLexicon, compileLexicon, mergeLexicon } from "../../src/core/speech/lexicon.ts";
import { codeLanguageName } from "../../src/core/speech/localize.ts";
import { cleanSpokenText, verbalizeInlineCode } from "../../src/core/speech/text.ts";

describe("verbalizeInlineCode", () => {
  test.each([
    ["speakLastMessage", "speak last message"],
    ["snake_case_name", "snake case name"],
    ["kebab-case-name", "kebab case name"],
    ["user.profile.name", "user profile name"],
    ["HTTPServer", "HTTP server"],
    ["parseJSON", "parse JSON"],
    ["refreshSessions()", "refresh sessions"],
    ["src/core/speech.ts", "speech.ts"],
    ["./scripts/run", "run"],
    ["README.md", "README.md"],
    ["@opentui/core", "opentui core"],
    ["bun test test/speech", "bun test test speech"],
    ["https://www.example.com/a/b", "example.com"],
    ["--watch", "watch"],
    ["v2Config", "v 2 config"],
  ])("%s → %s", (code, spoken) => {
    expect(verbalizeInlineCode(code, "en")).toBe(spoken);
  });

  test("long or symbol-heavy code is announced, localized", () => {
    expect(verbalizeInlineCode("a => b + c", "en")).toBe("code");
    expect(verbalizeInlineCode("foo[0]", "pt-BR")).toBe("código");
    expect(verbalizeInlineCode("averyveryverylongidentifierthatkeepsgoingon", "en")).toBe("code");
    expect(verbalizeInlineCode("   ", "en")).toBe("");
  });
});

describe("cleanSpokenText", () => {
  test("drops emoji, decorative symbols and markdown syntax; collapses whitespace", () => {
    expect(cleanSpokenText("  🚀 Done → **ok** | `x` ✅  ## end .")).toBe("Done ok x end.");
    expect(cleanSpokenText("C'est ⚠️ important --- vraiment")).toBe("C'est important vraiment");
  });

  test("keeps digits, punctuation and accents", () => {
    expect(cleanSpokenText("Versão 1.2.3: 50% pronta, não?")).toBe("Versão 1.2.3: 50% pronta, não?");
  });
});

describe("lexicon", () => {
  test("whole-word and case-sensitive", () => {
    const apply = compileLexicon({ TTL: "T T L", "e.g.": "for example" });
    expect(apply("TTL, TTLs, ttl, xTTL, e.g. here")).toBe("T T L, TTLs, ttl, xTTL, for example here");
  });

  test("user entries override built-ins without dropping the rest", () => {
    const merged = mergeLexicon({ en: { JSON: "jay son" } });
    expect(merged.en.JSON).toBe("jay son");
    expect(merged.en.TTL).toBe(BUILTIN_LEXICON.en.TTL);
    expect(merged["pt-BR"]).toEqual(BUILTIN_LEXICON["pt-BR"]);
  });

  test("detection normalization expands language-specific entries and removes shared ones", () => {
    const normalize = compileDetectionLexicon(mergeLexicon(undefined));
    expect(normalize("use TTL, e.g. this; ex. aquilo")).toBe("use  , for example this; por exemplo aquilo");
  });
});

describe("codeLanguageName", () => {
  test.each([
    ["ts", "TypeScript"],
    ["JS", "JavaScript"],
    ["sh", "shell"],
    ["bash", "shell"],
    ["py", "Python"],
    ["rs", "Rust"],
    ["json", "JSON"],
    ["text", undefined],
    ["", undefined],
    [null, undefined],
    ["elm", "elm"],
  ])("%p → %p", (fence, name) => {
    expect(codeLanguageName(fence)).toBe(name);
  });
});
