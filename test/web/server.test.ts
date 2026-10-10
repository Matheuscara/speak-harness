import { expect, test } from "bun:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeApp } from "../tui/fake-app.ts";
import { applySetting, startWebServer } from "../../src/web/server.ts";

function tokenOf(html: string): string {
  const token = /<meta name="speakh-key" content="([a-f0-9]+)"\s*\/?>/.exec(
    html,
  )?.[1];
  if (!token) throw new Error("Dashboard did not supply a key");
  return token;
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
type Snapshot = {
  session: { title: string };
  html: string;
  script: { segments: unknown[] };
  playback: { status: string };
};
type Sessions = { sessions: { id: string }[] };
type Voices = { installations: Record<string, { done: number }> };

test("dashboard uses loopback auth, forbids foreign origins and drives a real AppCore contract", async () => {
  const app = new FakeApp();
  app.selectMessage(
    app.sessions.messages.findLast((message) => !message.commentary)!.key,
  );
  const server = startWebServer(app, { cwd: "/work/vitrum" });
  const url = server.url;
  let tempDir: string | undefined;
  try {
    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    const html = await page.text();
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("READ WITH");
    expect(html).toContain("YOUR<br");
    expect(html).toContain("SESSIONS.");
    const token = tokenOf(html);
    const icon = await fetch(`${url}favicon.svg`);
    expect(icon.headers.get("content-type")).toContain("image/svg+xml");
    expect(await icon.text()).toContain("H-shaped audio pulse");
    expect((await fetch(`${url}api/state`)).status).toBe(401);
    expect(
      (
        await fetch(`${url}api/state`, {
          headers: {
            "x-speakh-key": token,
            Origin: "https://malicious.example",
          },
        })
      ).status,
    ).toBe(403);
    const get = async (path: string) =>
      fetch(`${url}${path}`, { headers: { "x-speakh-key": token } });
    const post = async (path: string, payload: unknown) =>
      fetch(`${url}${path}`, {
        method: "POST",
        headers: { "x-speakh-key": token, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

    const state = await json<Snapshot>(await get("api/state"));
    expect(state.session.title).toBe("vitrum");
    expect(state.html).toContain("<h2>What is this task about?</h2>");
    expect(state.script.segments.length).toBeGreaterThan(0);
    const sessions = await json<Sessions>(
      await get("api/sessions?scope=here&harness=omp"),
    );
    expect(sessions.sessions.map((session) => session.id)).toEqual([
      "s-vitrum",
    ]);
    expect(
      (await json<Sessions>(await get("api/sessions?scope=here&harness=codex")))
        .sessions,
    ).toEqual([]);
    expect((await post("api/command", { id: "play-pause" })).status).toBe(200);
    expect((await json<Snapshot>(await get("api/state"))).playback.status).toBe(
      "speaking",
    );
    expect(
      (await post("api/setting", { path: "voices.speed", value: 1.3 })).status,
    ).toBe(200);
    expect(app.config.voices.speed).toBe(1.3);
    expect(
      (await post("api/phrase", { text: "not saved", lang: "en" })).status,
    ).toBe(404);
    expect(
      (
        await post("api/phrase", {
          text: "Each credential is temporary.",
          lang: "en",
        })
      ).status,
    ).toBe(200);
    expect(app.playback.script?.messageKey).toStartWith("phrase:");
    expect(
      (await post("api/voice-preview", { voice: "unknown:voice" })).status,
    ).toBe(400);
    expect(
      (await post("api/voice-preview", { voice: "piper:pt_BR-cadu-medium" }))
        .status,
    ).toBe(409);
    const preview = await post("api/voice-preview", {
      voice: "kokoro:af_heart",
    });
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("audio/wav");
    const wav = new Uint8Array(await preview.arrayBuffer());
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe("WAVE");
    expect(
      (await post("api/install", { voice: "piper:pt_BR-cadu-medium" })).status,
    ).toBe(202);
    const progress = await json<Voices>(await get("api/voices"));
    expect(progress.installations["piper:pt_BR-cadu-medium"]?.done).toBe(
      31_500_000,
    );
    app.engine.finishInstall();
    expect(
      (await post("api/setting", { path: "keys.quit", value: [] })).status,
    ).toBe(400);
    expect(
      (
        await post("api/setting", {
          path: "voices.languages.en",
          value: "piper:pt_BR-faber-medium",
        })
      ).status,
    ).toBe(400);
    expect((await post("api/follow", { key: "codex:s-other" })).status).toBe(
      200,
    );
    expect(app.sessions.session?.id).toBe("s-other");
    const before = await json<{ revision: number; sessionRevision: number }>(
      await get("api/revision"),
    );
    const added = app.sessions.push(
      "A fresh answer arrived in the active conversation.",
    );
    app.selectMessage(added.key);
    const after = await json<{ revision: number; sessionRevision: number }>(
      await get("api/revision"),
    );
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.sessionRevision).toBeGreaterThan(before.sessionRevision);
    expect((await json<Snapshot>(await get("api/state"))).html).toContain(
      "A fresh answer arrived",
    );
    tempDir = await mkdtemp(join(tmpdir(), "speakh-web-"));
    const transcript = join(tempDir, "session.jsonl");
    await writeFile(transcript, "{}\n");
    await utimes(transcript, new Date(1_000_000), new Date(1_000_000));
    app.sessions.session!.path = transcript;
    const idleBefore = await json<{ revision: number; activityAt: number }>(
      await get("api/revision"),
    );
    await utimes(transcript, new Date(1_010_000), new Date(1_010_000));
    const idleAfter = await json<{ revision: number; activityAt: number }>(
      await get("api/revision"),
    );
    expect(idleAfter.activityAt).toBeGreaterThan(idleBefore.activityAt);
    expect(idleAfter.revision).toBe(idleBefore.revision);
  } finally {
    server.close();
    await server.closed;
    await app.dispose();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
});

test("only recognized setting paths and in-range values can mutate config", () => {
  const app = new FakeApp();
  const config = app.config;
  applySetting(config, "reading.autoRead", true);
  expect(config.reading.autoRead).toBe(true);
  expect(() => applySetting(config, "voices.speed", 100)).toThrow("0.5–2");
  expect(() => applySetting(config, "harnesses.enabled", [])).toThrow(
    "not editable",
  );
});
