// Kokoro engine (kokoro-js). Worker-only (Node).
import { join } from "node:path";
import { env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import { findVoice, KOKORO_DTYPE, KOKORO_FILES, KOKORO_MODEL_ID } from "./catalog.ts";
import { downloadFiles, filesInstalled } from "./download.ts";
import { ESPEAK_VOICE } from "./engine.ts";
import type { SpeechEngine } from "./engine.ts";
import { textToIpa } from "./phonemizer.ts";
import { VoiceNotInstalledError } from "./protocol.ts";

type KokoroVoice = NonNullable<Parameters<KokoroTTS["generate"]>[1]>["voice"];

export function createKokoroEngine(cacheDir: string): SpeechEngine {
  const dir = join(cacheDir, "kokoro");
  let model: Promise<KokoroTTS> | undefined;

  const load = (): Promise<KokoroTTS> => {
    if (!model) {
      // Read only our cache; downloads happen exclusively through install().
      env.cacheDir = dir;
      env.localModelPath = dir;
      env.allowLocalModels = true;
      env.allowRemoteModels = false;
      model = KokoroTTS.from_pretrained(KOKORO_MODEL_ID, { dtype: KOKORO_DTYPE, device: "cpu" });
      model.catch(() => {
        model = undefined;
      });
    }
    return model;
  };

  return {
    id: "kokoro",
    installed: () => filesInstalled(dir, KOKORO_FILES),
    install: (_name, onProgress) => downloadFiles(dir, KOKORO_FILES, onProgress),
    async synthesize({ text, name, lang, speed }) {
      const voice = findVoice(`kokoro:${name}`);
      if (!voice) throw new Error(`unknown Kokoro voice "${name}"`);
      if (!filesInstalled(dir, KOKORO_FILES)) throw new VoiceNotInstalledError(voice.id);
      const tts = await load();
      // Kokoro's id is typed as its English voice list; pt-BR voice files ship with kokoro-js too.
      const options = { voice: name as KokoroVoice, speed };
      let audio;
      if (voice.lang === "en" && lang === "en") {
        audio = await tts.generate(text, options);
      } else {
        // kokoro-js only phonemizes English; other text goes through eSpeak IPA → Kokoro tokens.
        const ipa = (await textToIpa(text, ESPEAK_VOICE[lang])).trim().replace(/\.$/, "");
        const { input_ids } = tts.tokenizer(ipa, { truncation: true });
        audio = await tts.generate_from_ids(input_ids, options);
      }
      return { sampleRate: audio.sampling_rate, pcm: audio.audio };
    },
  };
}
