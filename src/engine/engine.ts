// Engine interface implemented inside the TTS worker (DESIGN.md "Speech engines").
import type { AudioChunk, EngineId, Lang } from "../core/types.ts";

export interface EngineSynthesisRequest {
  text: string;
  /** Voice name without the engine prefix (`af_heart`, `pt_BR-faber-medium`). */
  name: string;
  /** Language of `text`. */
  lang: Lang;
  speed: number;
}

export interface SpeechEngine {
  readonly id: EngineId;
  installed(name: string): boolean;
  install(name: string, onProgress: (done: number, total: number) => void): Promise<void>;
  /** Throws `VoiceNotInstalledError` when model files are missing; never downloads. */
  synthesize(request: EngineSynthesisRequest, signal: AbortSignal): Promise<AudioChunk>;
}

/** eSpeak voice used to phonemize text of each language. */
export const ESPEAK_VOICE: Record<Lang, string> = { en: "en-us", "pt-BR": "pt-br" };
