// Engine client ↔ TTS worker protocol: JSON lines over stdio (DESIGN.md "Worker protocol").
import type { Lang, VoiceInfo } from "../core/types.ts";

export type WorkerRequest =
  | { id: number; op: "voices" }
  | { id: number; op: "install"; voice: string }
  | { id: number; op: "synthesize"; text: string; voice: string; lang: Lang; speed: number }
  | { id: number; op: "cancel"; target: number };

export type WorkerResponse =
  | { id: number; progress: [done: number, total: number] }
  | { id: number; ok: true; voices: VoiceInfo[] }
  | { id: number; ok: true; sampleRate: number; pcm: string }
  | { id: number; ok: true }
  | { id: number; ok: false; error: string; code?: "voice-not-installed"; voice?: string };

export class VoiceNotInstalledError extends Error {
  readonly voice: string;
  constructor(voice: string) {
    super(`Voice ${voice} is not installed. Install it with: speakh voices install ${voice}`);
    this.name = "VoiceNotInstalledError";
    this.voice = voice;
  }
}

/** Float32 samples → base64 of their little-endian bytes. */
export function encodePcm(pcm: Float32Array): string {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");
}

export function decodePcm(base64: string): Float32Array {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength % 4 !== 0) throw new Error("PCM payload is not a whole number of float32 samples");
  // Large base64 payloads decode into their own buffer at offset 0; small pooled ones may be unaligned.
  if (bytes.byteOffset % 4 === 0) return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
