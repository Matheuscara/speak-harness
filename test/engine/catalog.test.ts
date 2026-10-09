import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { findVoice, KOKORO_FILES, piperFiles, VOICE_CATALOG } from "../../src/engine/catalog.ts";

describe("voice catalog", () => {
  test("default voices resolve", () => {
    expect(findVoice("kokoro:af_heart")).toMatchObject({ engine: "kokoro", name: "af_heart", lang: "en", gender: "female" });
    expect(findVoice("kokoro:pf_dora")).toMatchObject({ engine: "kokoro", lang: "pt-BR", gender: "female" });
    expect(findVoice("piper:pt_BR-faber-medium")).toMatchObject({ engine: "piper", lang: "pt-BR", license: "CC0-1.0 (dataset)" });
    expect(findVoice("piper:pt_BR-edresson-low")).toMatchObject({ license: "CC-BY-4.0 (dataset)" });
  });

  test("unknown or malformed ids are not found", () => {
    for (const id of ["kokoro:nope", "piper:pt_BR-faber-low", "af_heart", "espeak:pt-br", "", "toString", "__proto__"]) {
      expect(findVoice(id)).toBeUndefined();
    }
  });

  test("ids are unique and spelled engine:name", () => {
    const ids = VOICE_CATALOG.map((voice) => voice.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const voice of VOICE_CATALOG) expect(voice.id).toBe(`${voice.engine}:${voice.name}`);
  });

  test("every Kokoro voice bundled with kokoro-js for en/pt-BR is listed, with language and gender from its prefix", () => {
    const voicesDir = join(dirname(Bun.resolveSync("kokoro-js/package.json", import.meta.dir)), "voices");
    const bundled = readdirSync(voicesDir)
      .map((file) => file.replace(/\.bin$/, ""))
      .filter((name) => /^[abp][fm]_/.test(name))
      .sort();
    const listed = VOICE_CATALOG.filter((voice) => voice.engine === "kokoro").map((voice) => voice.name);
    expect([...listed].sort()).toEqual(bundled);
    for (const voice of VOICE_CATALOG.filter((v) => v.engine === "kokoro")) {
      expect(voice.lang).toBe(voice.name.startsWith("p") ? "pt-BR" : "en");
      expect(voice.gender).toBe(voice.name.charAt(1) === "f" ? "female" : "male");
      expect(voice.license).toBe("Apache-2.0");
    }
  });

  test("Kokoro voices share one model size; Piper sizes cover both files", () => {
    const kokoroSize = KOKORO_FILES.reduce((sum, file) => sum + file.sizeBytes, 0);
    for (const voice of VOICE_CATALOG) {
      if (voice.engine === "kokoro") expect(voice.sizeBytes).toBe(kokoroSize);
      else expect(voice.sizeBytes).toBe(piperFiles(voice.name)!.reduce((sum, file) => sum + file.sizeBytes, 0));
    }
  });

  test("Piper files come from rhasspy/piper-voices by speaker and quality", () => {
    expect(piperFiles("pt_BR-edresson-low")?.map((file) => [file.path, file.url])).toEqual([
      [
        "pt_BR-edresson-low.onnx",
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR/edresson/low/pt_BR-edresson-low.onnx",
      ],
      [
        "pt_BR-edresson-low.onnx.json",
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR/edresson/low/pt_BR-edresson-low.onnx.json",
      ],
    ]);
    expect(piperFiles("pt_BR-nobody-medium")).toBeUndefined();
  });

  test("Kokoro files mirror the transformers cache layout for the q4 model", () => {
    expect(KOKORO_FILES.map((file) => file.path)).toContain("onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model_q4.onnx");
    for (const file of KOKORO_FILES) {
      expect(file.url).toBe(`https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/${file.path.split("/").slice(2).join("/")}`);
    }
  });
});
