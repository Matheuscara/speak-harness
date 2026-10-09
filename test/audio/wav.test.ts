import { describe, expect, test } from "bun:test";
import { encodeWav } from "../../src/audio/wav.ts";

const text = (bytes: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...bytes.subarray(start, start + length));

describe("encodeWav", () => {
  test("writes a 16-bit mono PCM RIFF header at the chunk's sample rate", () => {
    const bytes = encodeWav({ sampleRate: 22050, pcm: new Float32Array(3) });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(bytes.byteLength).toBe(44 + 6);
    expect(text(bytes, 0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(bytes.byteLength - 8);
    expect(text(bytes, 8, 8)).toBe("WAVEfmt ");
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(22050);
    expect(view.getUint32(28, true)).toBe(44100); // byte rate
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16);
    expect(text(bytes, 36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(6);
  });

  test("keeps each chunk's own sample rate", () => {
    const view = (rate: number) => new DataView(encodeWav({ sampleRate: rate, pcm: new Float32Array(1) }).buffer);
    expect(view(24000).getUint32(24, true)).toBe(24000);
    expect(view(16000).getUint32(28, true)).toBe(32000);
  });

  test("converts samples to int16 little-endian and clamps out-of-range values", () => {
    const bytes = encodeWav({ sampleRate: 8000, pcm: Float32Array.from([0, 1, -1, 0.5, 2, -3]) });
    const samples = Array.from({ length: 6 }, (_, i) => new DataView(bytes.buffer).getInt16(44 + i * 2, true));
    expect(samples).toEqual([0, 32767, -32768, 16383, 32767, -32768]);
  });

  test("an empty chunk is a valid header-only file", () => {
    const bytes = encodeWav({ sampleRate: 24000, pcm: new Float32Array(0) });
    expect(bytes.byteLength).toBe(44);
    expect(new DataView(bytes.buffer).getUint32(40, true)).toBe(0);
  });
});
