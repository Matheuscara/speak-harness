import { cp, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FIXTURES = join(import.meta.dir, "..", "fixtures", "adapters");

/** Copies the fixture home into a temp dir so tests can append to transcripts; returns its path. */
export async function fixtureHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "speakh-adapters-"));
  await cp(join(FIXTURES, "home"), home, { recursive: true });
  return home;
}

export async function removeHome(home: string): Promise<void> {
  await rm(home, { recursive: true, force: true });
}

export async function setMtime(path: string, iso: string): Promise<void> {
  const date = new Date(iso);
  await utimes(path, date, date);
}

/** Drains an async iterable in the background into `items`. */
export function collect<T>(iterable: AsyncIterable<T>): { items: T[]; done: Promise<void> } {
  const items: T[] = [];
  const done = (async () => {
    for await (const item of iterable) items.push(item);
  })();
  return { items, done };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(10);
  }
}
