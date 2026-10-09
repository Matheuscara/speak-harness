// Piper engine implemented from the model format (no Piper runtime). Worker-only (Node).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { InferenceSession, Tensor } from "onnxruntime-node";
import { piperFiles } from "./catalog.ts";
import { downloadFiles, filesInstalled } from "./download.ts";
import type { SpeechEngine } from "./engine.ts";
import { textToIpa } from "./phonemizer.ts";
import { peakNormalize, phonemesToIds, splitPhonemeSentences } from "./piper-ids.ts";
import type { PhonemeIdMap } from "./piper-ids.ts";
import { VoiceNotInstalledError } from "./protocol.ts";

interface PiperConfig {
  audio: { sample_rate: number };
  espeak: { voice: string };
  inference: { noise_scale: number; length_scale: number; noise_w: number };
  phoneme_id_map: PhonemeIdMap;
  num_speakers: number;
}

interface LoadedVoice {
  config: PiperConfig;
  session: InferenceSession;
  /** Phonemes already reported as missing from the id map. */
  reported: Set<string>;
}

export function createPiperEngine(cacheDir: string): SpeechEngine {
  const dir = join(cacheDir, "piper");
  const voices = new Map<string, Promise<LoadedVoice>>();

  const filesFor = (name: string) => {
    const files = piperFiles(name);
    if (!files) throw new Error(`unknown Piper voice "${name}"`);
    return files;
  };

  const load = (name: string): Promise<LoadedVoice> => {
    let voice = voices.get(name);
    if (!voice) {
      voice = (async () => {
        const base = join(dir, `${name}.onnx`);
        const config = JSON.parse(await readFile(`${base}.json`, "utf8")) as PiperConfig;
        const session = await InferenceSession.create(base, { executionProviders: ["cpu"] });
        return { config, session, reported: new Set<string>() };
      })();
      voices.set(name, voice);
      voice.catch(() => voices.delete(name));
    }
    return voice;
  };

  return {
    id: "piper",
    installed: (name) => filesInstalled(dir, filesFor(name)),
    install: (name, onProgress) => downloadFiles(dir, filesFor(name), onProgress),
    async synthesize({ text, name, speed }, signal) {
      if (!filesInstalled(dir, filesFor(name))) throw new VoiceNotInstalledError(`piper:${name}`);
      const { config, session, reported } = await load(name);
      const { noise_scale, length_scale, noise_w } = config.inference;
      const scales = new Tensor("float32", Float32Array.from([noise_scale, length_scale / speed, noise_w]), [3]);
      const parts: Float32Array[] = [];
      for (const sentence of splitPhonemeSentences(await textToIpa(text, config.espeak.voice))) {
        signal.throwIfAborted();
        const { ids, missing } = phonemesToIds(sentence, config.phoneme_id_map);
        for (const phoneme of missing) {
          if (reported.has(phoneme)) continue;
          reported.add(phoneme);
          console.error(`piper:${name}: phoneme ${JSON.stringify(phoneme)} is not in the voice's id map; dropped`);
        }
        const feeds: Record<string, Tensor> = {
          input: new Tensor("int64", BigInt64Array.from(ids, (id) => BigInt(id)), [1, ids.length]),
          input_lengths: new Tensor("int64", BigInt64Array.of(BigInt(ids.length)), [1]),
          scales,
        };
        if (config.num_speakers > 1) feeds.sid = new Tensor("int64", BigInt64Array.of(0n), [1]);
        const results = await session.run(feeds);
        const output = results[session.outputNames[0]!];
        if (!output || !(output.data instanceof Float32Array)) throw new Error(`piper:${name}: unexpected model output`);
        parts.push(output.data);
      }
      const pcm = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
      let offset = 0;
      for (const part of parts) {
        pcm.set(part, offset);
        offset += part.length;
      }
      return { sampleRate: config.audio.sample_rate, pcm: peakNormalize(pcm) };
    },
  };
}
