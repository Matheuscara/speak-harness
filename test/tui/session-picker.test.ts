import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { SessionRef } from "../../src/core/types.ts";
import { runTui } from "../../src/tui/index.ts";
import { FakeApp, FakeSessions } from "./fake-app.ts";

const date = new Date("2026-10-09T12:00:00Z");
const sessions: SessionRef[] = [
  { id: "o", harness: "omp", title: "Main task", cwd: "/work", updatedAt: date },
  { id: "test", harness: "claude-code", title: "Reply with exactly: ok", cwd: "/work", updatedAt: new Date("2026-09-01") },
  { id: "c", harness: "claude-code", title: "Produtos no 3dcontrol", cwd: "/other", updatedAt: date },
];

test("picker filters by harness and folder, searches, then follows the selected conversation", async () => {
  const setup = await createTestRenderer({ width: 100, height: 28 });
  const app = new FakeApp({ sessions: new FakeSessions(sessions) });
  const done = runTui(app, { renderer: setup.renderer, cwd: "/work", pickSession: true });
  const frame = async () => { await setup.flush(); await setup.renderOnce(); return setup.captureCharFrame(); };
  try {
    expect(await frame()).toContain("SPEAKHARNESS  /  CONVERSATIONS");
    expect(await frame()).toContain("Main task");
    setup.mockInput.pressKey("5");
    expect(await frame()).toContain("No conversations match these filters");
    setup.mockInput.pressKey("\t");
    expect(await frame()).toContain("Produtos no 3dcontrol");
    expect(await frame()).not.toContain("Reply with exactly");
    setup.mockInput.pressKey("/");
    await frame();
    setup.mockInput.typeText("3dcontrol");
    expect(await frame()).toContain("1/1");
    setup.mockInput.pressEnter(); // leave search; do not follow yet
    await frame();
    expect(app.sessions.followed).toEqual([]);
    setup.mockInput.pressEnter();
    await frame();
    expect(app.sessions.followed).toEqual(["c"]);
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    await done.catch(() => {});
  }
});
