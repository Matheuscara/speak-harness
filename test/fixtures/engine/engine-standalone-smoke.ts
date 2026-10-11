import { fileURLToPath } from "node:url";
import { createEngineClient } from "../../../src/engine/client.ts";

const workerPath = fileURLToPath(new URL("./fake-worker.mjs", import.meta.url));
const engine = createEngineClient({ workerPath, cacheDir: "/nonexistent-cache" });
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  const progress: number[] = [];
  await Promise.race([
    (async () => {
      await engine.install("piper:pt_BR-faber-medium", (done) => progress.push(done));
      if (progress.join(",") !== "50,100") throw new Error(`invalid progress: ${progress}`);
      const error = await engine.install("piper:broken").catch((cause: unknown) => cause);
      if (!(error instanceof Error) || error.message !== "download failed (404)") throw new Error(`invalid error: ${error}`);
    })(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("second short worker response timed out")), 4_000);
    }),
  ]);
  console.log(`PASS: sequential progress and short error on ${process.platform}/${process.arch}`);
} finally {
  clearTimeout(timer);
  await engine.close();
}
