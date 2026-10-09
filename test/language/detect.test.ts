import { describe, expect, test } from "bun:test";
import { chooseBlockLanguage, detectLanguage, functionWordVotes } from "../../src/core/language/index.ts";
import { LANGS } from "../../src/core/types.ts";

describe("detectLanguage", () => {
  test("English and Portuguese prose", () => {
    expect(detectLanguage("This function reads the config file and returns the parsed value.", LANGS)).toBe("en");
    expect(detectLanguage("O teste falhou porque o mock não foi resetado entre os casos.", LANGS)).toBe("pt-BR");
  });

  test("short text is undetermined", () => {
    expect(detectLanguage("Pronto.", LANGS)).toBeUndefined();
    expect(detectLanguage("   ", LANGS)).toBeUndefined();
  });

  test("restricted to the candidates", () => {
    expect(detectLanguage("O teste falhou porque o mock não foi resetado entre os casos.", ["en"])).toBe("en");
    expect(detectLanguage("This function reads the config file and returns the parsed value.", [])).toBeUndefined();
  });
});

describe("chooseBlockLanguage", () => {
  test("Portuguese with English terms stays Portuguese", () => {
    for (const text of [
      "Fiz o merge da branch e abri o PR com o changelog atualizado.",
      "Esse é o approach mais simples pro refactor do parser.",
      "Isso resolve o bug: o worker não fazia retry quando o socket fechava.",
    ]) {
      expect(chooseBlockLanguage(text, "pt-BR", LANGS)).toBe("pt-BR");
    }
  });

  test("English prose switches away from Portuguese, and back", () => {
    expect(chooseBlockLanguage("The cache is invalidated when the file changes.", "pt-BR", LANGS)).toBe("en");
    expect(chooseBlockLanguage("Then restart the server.", "pt-BR", LANGS)).toBe("en");
    expect(chooseBlockLanguage("Volta pro português aqui, com um deploy no pipeline e um fix no handler.", "en", LANGS)).toBe(
      "pt-BR",
    );
  });

  test("a borrowed English sentence fragment does not flip a Portuguese block", () => {
    expect(chooseBlockLanguage("Agora o hook de pre-commit roda o lint e o typecheck antes do push.", "pt-BR", LANGS)).toBe("pt-BR");
    expect(chooseBlockLanguage("Use o feature flag no build de production.", "pt-BR", LANGS)).toBe("pt-BR");
  });

  test("short blocks inherit the previous language", () => {
    expect(chooseBlockLanguage("Done.", "pt-BR", LANGS)).toBe("pt-BR");
    expect(chooseBlockLanguage("Pronto.", "en", LANGS)).toBe("en");
  });
});

describe("functionWordVotes", () => {
  test("counts function words per language", () => {
    expect(functionWordVotes("O cache de sessões e the parser")).toEqual({ en: 1, "pt-BR": 3 });
  });
});
