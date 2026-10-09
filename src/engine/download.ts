// Atomic model downloads with byte progress. Worker-only (Node).
import { createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ModelFile } from "./catalog.ts";

export function filesInstalled(dir: string, files: readonly ModelFile[]): boolean {
  return files.every((file) => existsSync(join(dir, file.path)));
}

/**
 * Downloads every missing file of `files` into `dir`. Each file is written to a temp file and renamed
 * into place, so a partial download never looks installed. Progress counts already-present files as done.
 */
export async function downloadFiles(
  dir: string,
  files: readonly ModelFile[],
  onProgress: (done: number, total: number) => void,
): Promise<void> {
  const total = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  let done = 0;
  for (const file of files) {
    const dest = join(dir, file.path);
    if (existsSync(dest)) {
      done += statSync(dest).size;
      onProgress(done, total);
      continue;
    }
    await mkdir(dirname(dest), { recursive: true });
    const response = await fetch(file.url, { redirect: "follow" });
    if (!response.ok || !response.body) {
      throw new Error(`download failed (${response.status} ${response.statusText}): ${file.url}`);
    }
    const temp = `${dest}.part-${process.pid}`;
    try {
      await pipeline(
        Readable.fromWeb(response.body),
        async function* (source: AsyncIterable<Uint8Array>) {
          for await (const chunk of source) {
            done += chunk.byteLength;
            onProgress(done, total);
            yield chunk;
          }
        },
        createWriteStream(temp),
      );
      await rename(temp, dest);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }
}
