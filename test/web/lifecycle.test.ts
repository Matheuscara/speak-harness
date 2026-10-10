import { expect, test } from "bun:test";
import { FakeApp } from "../tui/fake-app.ts";
import { startWebServer } from "../../src/web/server.ts";

test("local server releases itself after the last browser event stream closes", async () => {
  // This is an integration test of Bun.serve's real stream cancellation and idle timer, not a guessed sleep.
  const app = new FakeApp();
  const server = startWebServer(app, { idleMs: 100 });
  try {
    const html = await (await fetch(server.url)).text();
    const key = /<meta name="speakh-key" content="([a-f0-9]+)"\s*\/?>/.exec(
      html,
    )?.[1];
    if (!key) throw new Error("Missing key");
    const stream = await fetch(`${server.url}events?key=${key}`);
    expect(stream.status).toBe(200);
    const reader = stream.body?.getReader();
    expect(reader).toBeDefined();
    await reader!.read();
    await reader!.cancel();
    await server.closed;
  } finally {
    server.close();
    await app.dispose();
  }
});
