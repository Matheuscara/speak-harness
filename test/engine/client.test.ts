import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEngineClient, VoiceNotInstalledError } from "../../src/engine/client.ts";
import { decodePcm, encodePcm } from "../../src/engine/protocol.ts";
import type { EngineClient, SynthesisRequest } from "../../src/core/types.ts";

const workerPath = fileURLToPath(new URL("../fixtures/engine/fake-worker.mjs", import.meta.url));
const clients: EngineClient[] = [];

function client(options: { nodePath?: string } = {}): EngineClient {
  const created = createEngineClient({ workerPath, cacheDir: "/nonexistent-cache", ...options });
  clients.push(created);
  return created;
}

const say = (text: string, voice = "piper:pt_BR-faber-medium"): SynthesisRequest => ({ text, voice, lang: "pt-BR", speed: 1 });

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

describe("pcm encoding", () => {
  test("round-trips float32 samples, including unaligned decode buffers", () => {
    const samples = Float32Array.from([0, 1, -1, 0.25, Math.fround(1e-7)]);
    expect([...decodePcm(encodePcm(samples))]).toEqual([...samples]);
    expect([...decodePcm(encodePcm(samples.subarray(1, 3)))]).toEqual([1, -1]);
  });
});

describe("engine client", () => {
  test("synthesizes audio chunks with the worker's sample rate", async () => {
    const engine = client();
    const chunk = await engine.synthesize(say("olá"));
    expect(chunk.sampleRate).toBe(22050);
    expect([...chunk.pcm]).toEqual([3, 0.5, -0.5]);
  });

  test("handles large audio lines", async () => {
    const chunk = await client().synthesize(say("big"));
    expect(chunk.pcm.length).toBe(200_000);
    expect(chunk.pcm[199_999]).toBeCloseTo(0.99, 5);
  });

  test("voices() lists the whole catalog with installed state from the worker", async () => {
    const voices = await client().voices();
    expect(voices.find((v) => v.id === "piper:pt_BR-faber-medium")?.installed).toBe(true);
    expect(voices.find((v) => v.id === "kokoro:af_heart")?.installed).toBe(false);
    expect(voices.find((v) => v.id === "kokoro:pf_dora")).toMatchObject({ installed: false, lang: "pt-BR" });
    expect(voices.some((v) => v.id === "not-in-catalog:x")).toBe(false);
  });

  test("install reports progress and surfaces worker errors", async () => {
    const engine = client();
    const progress: [number, number][] = [];
    await engine.install("piper:pt_BR-faber-medium", (done, total) => progress.push([done, total]));
    expect(progress).toEqual([
      [50, 100],
      [100, 100],
    ]);
    await expect(engine.install("piper:broken")).rejects.toThrow("download failed (404)");
  });

  test("missing model files reject with VoiceNotInstalledError", async () => {
    const error = await client()
      .synthesize(say("oi", "piper:pt_BR-edresson-low"))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VoiceNotInstalledError);
    expect((error as VoiceNotInstalledError).voice).toBe("piper:pt_BR-edresson-low");
  });

  test("abort rejects with AbortError, sends cancel, and drops the late result", async () => {
    const engine = client();
    const controller = new AbortController();
    const started = performance.now();
    const pending = engine.synthesize(say("slow"), controller.signal);
    controller.abort();
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
    // Rejected before the worker's 300 ms answer.
    expect(performance.now() - started).toBeLessThan(250);

    // The worker received exactly one cancel, for the first request id.
    expect([...(await engine.synthesize(say("cancelled"))).pcm]).toEqual([1]);
    // The worker answers the aborted request first (its timer started earlier); that late
    // answer must be dropped, not delivered to this newer request.
    expect([...(await engine.synthesize(say("slow again"))).pcm]).toEqual([1]);
    expect([...(await engine.synthesize(say("ok"))).pcm]).toEqual([2, 0.5, -0.5]);
  });

  test("an already-aborted signal rejects without contacting the worker", async () => {
    const engine = client();
    const error = await engine.synthesize(say("x"), AbortSignal.abort()).catch((e: unknown) => e);
    expect((error as DOMException).name).toBe("AbortError");
    expect([...(await engine.synthesize(say("cancelled"))).pcm]).toEqual([]);
  });

  test("a worker crash rejects every pending request with its stderr, and the next request restarts it", async () => {
    const engine = client();
    const firstPid = (await engine.synthesize(say("pid"))).pcm[0];
    const slow = engine.synthesize(say("slow")).catch((e: Error) => e);
    const crash = engine.synthesize(say("crash")).catch((e: Error) => e);
    for (const error of [await slow, await crash]) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("exited unexpectedly (exit code 3)");
      expect((error as Error).message).toContain("boom: fake worker crashed");
    }
    const secondPid = (await engine.synthesize(say("pid"))).pcm[0];
    expect(secondPid).toBeGreaterThan(0);
    expect(secondPid).not.toBe(firstPid);
  });

  test("a missing node binary fails with a readable error", async () => {
    const engine = client({ nodePath: "/nonexistent/node" });
    await expect(engine.synthesize(say("x"))).rejects.toThrow(/Cannot start the TTS worker: .*Node\.js >= 22\.18/);
  });

  describe("SPEAKH_NODE_BINARY", () => {
    const saved = process.env.SPEAKH_NODE_BINARY;
    let dir: string | undefined;
    afterEach(() => {
      if (saved === undefined) delete process.env.SPEAKH_NODE_BINARY;
      else process.env.SPEAKH_NODE_BINARY = saved;
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });

    test.skipIf(process.platform === "win32")("runs the worker on the configured Node binary instead of PATH's", async () => {
      const node = Bun.which("node");
      if (!node) throw new Error("these tests need Node.js on PATH");
      dir = mkdtempSync(join(tmpdir(), "speakh-node-"));
      const wrapper = join(dir, "bundled-node");
      writeFileSync(wrapper, `#!/bin/sh\ntouch "${dir}/used"\nexec "${node}" "$@"\n`);
      chmodSync(wrapper, 0o755);
      process.env.SPEAKH_NODE_BINARY = wrapper;

      expect((await client().synthesize(say("olá"))).sampleRate).toBe(22050);
      expect(existsSync(join(dir, "used"))).toBe(true);
    });

    test("an explicit nodePath wins; a missing configured binary is named in the error", async () => {
      process.env.SPEAKH_NODE_BINARY = "/nonexistent/bundled-node";
      await expect(client().synthesize(say("x"))).rejects.toThrow(
        /Cannot start the TTS worker: "\/nonexistent\/bundled-node" \(from SPEAKH_NODE_BINARY\) was not found/,
      );
      const node = Bun.which("node");
      if (!node) throw new Error("these tests need Node.js on PATH");
      expect((await client({ nodePath: node }).synthesize(say("olá"))).sampleRate).toBe(22050);
    });
  });

  test("close() rejects pending work and later calls", async () => {
    const engine = client();
    const pending = engine.synthesize(say("slow")).catch((e: Error) => e.message);
    await engine.close();
    expect(await pending).toBe("engine client is closed");
    await expect(engine.voices()).rejects.toThrow("engine client is closed");
  });
});
