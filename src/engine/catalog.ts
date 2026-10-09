// Voice catalog shared by the engine client (Bun) and the TTS worker (Node). Keep it dependency-free.
import type { Lang, VoiceInfo } from "../core/types.ts";

export type CatalogVoice = Omit<VoiceInfo, "installed">;

export interface ModelFile {
  /** Path relative to the engine's cache directory. */
  path: string;
  url: string;
  sizeBytes: number;
}

const HF = "https://huggingface.co";

// ---------- Kokoro ----------

export const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const KOKORO_DTYPE = "q4";
export const KOKORO_LICENSE = "Apache-2.0";

/** Files `KokoroTTS.from_pretrained(KOKORO_MODEL_ID, { dtype: "q4" })` reads, laid out like the transformers file cache. */
export const KOKORO_FILES: readonly ModelFile[] = [
  ["config.json", 44],
  ["tokenizer.json", 3497],
  ["tokenizer_config.json", 113],
  ["onnx/model_q4.onnx", 305_215_966],
].map(([file, size]) => ({
  path: `${KOKORO_MODEL_ID}/${file}`,
  url: `${HF}/${KOKORO_MODEL_ID}/resolve/main/${file}`,
  sizeBytes: size as number,
}));

const KOKORO_SIZE = KOKORO_FILES.reduce((sum, file) => sum + file.sizeBytes, 0);

// Voice style vectors ship inside kokoro-js (`kokoro-js/voices/*.bin`); only the model is downloaded.
const KOKORO_VOICES: readonly [name: string, label: string][] = [
  ["af_heart", "Heart"],
  ["af_alloy", "Alloy"],
  ["af_aoede", "Aoede"],
  ["af_bella", "Bella"],
  ["af_jessica", "Jessica"],
  ["af_kore", "Kore"],
  ["af_nicole", "Nicole"],
  ["af_nova", "Nova"],
  ["af_river", "River"],
  ["af_sarah", "Sarah"],
  ["af_sky", "Sky"],
  ["am_adam", "Adam"],
  ["am_echo", "Echo"],
  ["am_eric", "Eric"],
  ["am_fenrir", "Fenrir"],
  ["am_liam", "Liam"],
  ["am_michael", "Michael"],
  ["am_onyx", "Onyx"],
  ["am_puck", "Puck"],
  ["am_santa", "Santa"],
  ["bf_alice", "Alice"],
  ["bf_emma", "Emma"],
  ["bf_isabella", "Isabella"],
  ["bf_lily", "Lily"],
  ["bm_daniel", "Daniel"],
  ["bm_fable", "Fable"],
  ["bm_george", "George"],
  ["bm_lewis", "Lewis"],
  ["pf_dora", "Dora"],
  ["pm_alex", "Alex"],
  ["pm_santa", "Santa"],
];

const KOKORO_ACCENTS: Record<string, { lang: Lang; accent: string }> = {
  a: { lang: "en", accent: "American English" },
  b: { lang: "en", accent: "British English" },
  p: { lang: "pt-BR", accent: "Brazilian Portuguese" },
};

function kokoroVoice(name: string, label: string): CatalogVoice {
  const accent = KOKORO_ACCENTS[name.charAt(0)];
  if (!accent) throw new Error(`no accent for Kokoro voice ${name}`);
  return {
    id: `kokoro:${name}`,
    engine: "kokoro",
    name,
    lang: accent.lang,
    label: `${label} (Kokoro, ${accent.accent})`,
    gender: name.charAt(1) === "f" ? "female" : "male",
    sizeBytes: KOKORO_SIZE,
    license: KOKORO_LICENSE,
  };
}

// ---------- Piper ----------

interface PiperVoiceSpec {
  speaker: string;
  quality: "low" | "medium";
  label: string;
  gender: "female" | "male";
  onnxBytes: number;
  configBytes: number;
  license: string;
}

const PIPER_VOICES: readonly PiperVoiceSpec[] = [
  { speaker: "faber", quality: "medium", label: "Faber", gender: "male", onnxBytes: 63_201_294, configBytes: 4855, license: "CC0-1.0 (dataset)" },
  { speaker: "cadu", quality: "medium", label: "Cadu", gender: "male", onnxBytes: 62_950_044, configBytes: 5040, license: "CC0-1.0 (dataset)" },
  { speaker: "jeff", quality: "medium", label: "Jeff", gender: "male", onnxBytes: 62_950_044, configBytes: 5041, license: "CC0-1.0 (dataset)" },
  { speaker: "edresson", quality: "low", label: "Edresson", gender: "male", onnxBytes: 63_104_526, configBytes: 4168, license: "CC-BY-4.0 (dataset)" },
];

/** `<name>.onnx` and `<name>.onnx.json`, relative to the Piper cache directory. */
export function piperFiles(name: string): readonly ModelFile[] | undefined {
  const spec = PIPER_VOICES.find((voice) => `pt_BR-${voice.speaker}-${voice.quality}` === name);
  if (!spec) return undefined;
  const base = `${HF}/rhasspy/piper-voices/resolve/main/pt/pt_BR/${spec.speaker}/${spec.quality}/${name}`;
  return [
    { path: `${name}.onnx`, url: `${base}.onnx`, sizeBytes: spec.onnxBytes },
    { path: `${name}.onnx.json`, url: `${base}.onnx.json`, sizeBytes: spec.configBytes },
  ];
}

function piperVoice(spec: PiperVoiceSpec): CatalogVoice {
  const name = `pt_BR-${spec.speaker}-${spec.quality}`;
  return {
    id: `piper:${name}`,
    engine: "piper",
    name,
    lang: "pt-BR",
    label: `${spec.label} (Piper ${spec.quality}, Brazilian Portuguese)`,
    gender: spec.gender,
    sizeBytes: spec.onnxBytes + spec.configBytes,
    license: spec.license,
  };
}

// ---------- Catalog ----------

export const VOICE_CATALOG: readonly CatalogVoice[] = [
  ...KOKORO_VOICES.map(([name, label]) => kokoroVoice(name, label)),
  ...PIPER_VOICES.map(piperVoice),
];

const BY_ID: Record<string, CatalogVoice> = Object.fromEntries(VOICE_CATALOG.map((voice) => [voice.id, voice]));

export function findVoice(id: string): CatalogVoice | undefined {
  return Object.hasOwn(BY_ID, id) ? BY_ID[id] : undefined;
}
