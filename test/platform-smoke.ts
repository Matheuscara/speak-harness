// Run on a native CI runner for each supported OS; this exercises the real Node worker and model binaries.
import { createApp } from "../src/core/app.ts";
import { encodeWav } from "../src/audio/wav.ts";
import { DEFAULT_CONFIG } from "../src/core/config/index.ts";
import { startWebServer } from "../src/web/server.ts";
import type { Lang } from "../src/core/types.ts";

const app = await createApp({ cwd: process.cwd(), config: DEFAULT_CONFIG, followSessions: false, autoRead: false });
const web = startWebServer(app, { cwd: process.cwd() });
try {
  const response = await fetch(web.url);
  const html = await response.text();
  if (!response.ok || !html.includes("READ WITH")) throw new Error("Local dashboard did not load");
  const token = /<meta name="speakh-key" content="([a-f0-9]+)"/.exec(html)?.[1];
  if (!token) throw new Error("Dashboard did not provide its local API key");
  const state = await fetch(new URL("api/state", web.url), { headers: { "X-Speakh-Key": token } });
  if (!state.ok) throw new Error(`Local dashboard API failed: ${state.status}`);

  for (const [voice, lang, text] of [
    ["kokoro:af_heart", "en", "This answer is spoken locally."],
    ["piper:pt_BR-faber-medium", "pt-BR", "Esta resposta é falada localmente."],
  ] as const satisfies readonly (readonly [string, Lang, string])[]) {
    const voices = await app.engine.voices();
    if (!voices.some((item) => item.id === voice && item.installed)) await app.engine.install(voice);
    const audio = await app.engine.synthesize({ text, voice, lang, speed: 1 });
    if (audio.pcm.length < 1000) throw new Error(`${voice} produced no speech`);
    const wav = encodeWav(audio);
    if (new TextDecoder().decode(wav.subarray(0, 4)) !== "RIFF") throw new Error(`${voice} produced invalid WAV`);
    console.log(`${process.platform}/${process.arch}: ${voice} generated ${audio.pcm.length} samples`);
  }
  console.log(`PASS: local web dashboard and English/pt-BR synthesis on ${process.platform}/${process.arch}`);
} finally {
  web.close();
  await app.dispose();
}
