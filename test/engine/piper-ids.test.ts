import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { peakNormalize, phonemesToIds, splitPhonemeSentences } from "../../src/engine/piper-ids.ts";
import type { PhonemeIdMap } from "../../src/engine/piper-ids.ts";

const config = JSON.parse(readFileSync(new URL("../fixtures/engine/pt_BR-faber-medium.onnx.json", import.meta.url), "utf8")) as {
  phoneme_id_map: PhonemeIdMap;
};
const idMap = config.phoneme_id_map;

describe("phonemesToIds (pt_BR-faber-medium id map)", () => {
  test("wraps phonemes as ^ _ (id _)* $", () => {
    // eSpeak IPA for "Olá, mundo!": o l ˈ a , ␠ m ˈ ũ ŋ d ʊ !
    const { ids, missing } = phonemesToIds("olˈa, mˈũŋdʊ!", idMap);
    expect(missing).toEqual([]);
    expect(ids).toEqual([
      1, 0, // ^ _
      27, 0, 24, 0, 120, 0, 14, 0, 8, 0, 3, 0, // o l ˈ a , ␠
      25, 0, 120, 0, 33, 0, 141, 0, 44, 0, 17, 0, 100, 0, // m ˈ u ◌̃ ŋ d ʊ
      4, 0, // !
      2, // $
    ]);
  });

  test("decomposes precomposed phonemes to NFD codepoints", () => {
    expect(phonemesToIds("ũ", idMap).ids).toEqual(phonemesToIds("u\u0303", idMap).ids);
    expect(phonemesToIds("ũ", idMap).ids).toEqual([1, 0, 33, 0, 141, 0, 2]);
  });

  test("drops unknown phonemes and reports each once", () => {
    const { ids, missing } = phonemesToIds("aQ😀Qa", idMap);
    expect(ids).toEqual([1, 0, 14, 0, 14, 0, 2]);
    expect(missing).toEqual(["Q", "😀"]);
  });

  test("empty input still yields a valid utterance frame", () => {
    expect(phonemesToIds("", idMap).ids).toEqual([1, 0, 2]);
  });

  test("an id map without the frame symbols is rejected", () => {
    expect(() => phonemesToIds("a", { a: [14] })).toThrow(/phoneme_id_map has no/);
  });
});

describe("splitPhonemeSentences", () => {
  test("splits after terminators and keeps them", () => {
    expect(splitPhonemeSentences("olˈa, mˈũŋdʊ! kˌomʊ vaɪ? tˈudʊ bˈeɪŋ.")).toEqual([
      "olˈa, mˈũŋdʊ!",
      "kˌomʊ vaɪ?",
      "tˈudʊ bˈeɪŋ.",
    ]);
  });

  test("collapses whitespace and ignores blank input", () => {
    expect(splitPhonemeSentences("  a\n b.\n\n c  ")).toEqual(["a b.", "c"]);
    expect(splitPhonemeSentences(" \n ")).toEqual([]);
  });
});

describe("peakNormalize", () => {
  test("scales the loudest sample to 1", () => {
    expect([...peakNormalize(Float32Array.from([0.25, -0.5, 0.1]))]).toEqual([0.5, -1, Math.fround(0.2)]);
  });

  test("leaves near-silence quiet instead of amplifying noise", () => {
    expect([...peakNormalize(Float32Array.from([0.001, -0.002]))]).toEqual([Math.fround(0.1), Math.fround(-0.2)]);
  });
});
