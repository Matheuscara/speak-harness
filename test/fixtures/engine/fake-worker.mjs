// Fake TTS worker speaking the real JSON-lines protocol, for engine client tests.
// synthesize text commands: "crash" exits, "slow…" answers after 300 ms, "pid" returns [pid],
// "cancelled" returns the cancelled request ids, "big" returns 200k samples; anything else returns
// [text.length, 0.5, -0.5]. Voice piper:pt_BR-edresson-low is "not installed".
import { createInterface } from "node:readline";

const cancelled = [];
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const audio = (id, samples) =>
  send({ id, ok: true, sampleRate: 22050, pcm: Buffer.from(Float32Array.from(samples).buffer).toString("base64") });

process.stdout.write("this line is not JSON and must be ignored\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  switch (request.op) {
    case "voices":
      send({
        id: request.id,
        ok: true,
        voices: [
          { id: "piper:pt_BR-faber-medium", installed: true },
          { id: "kokoro:af_heart", installed: false },
          { id: "not-in-catalog:x", installed: true },
        ],
      });
      return;
    case "install":
      if (request.voice === "piper:broken") return send({ id: request.id, ok: false, error: "download failed (404)" });
      send({ id: request.id, progress: [50, 100] });
      send({ id: request.id, progress: [100, 100] });
      send({ id: request.id, ok: true });
      return;
    case "cancel":
      cancelled.push(request.target);
      return;
    case "synthesize": {
      const { id, text, voice } = request;
      if (voice === "piper:pt_BR-edresson-low") {
        return send({ id, ok: false, error: "not installed", code: "voice-not-installed", voice });
      }
      if (text === "crash") {
        process.stderr.write("boom: fake worker crashed\n");
        process.exit(3);
      }
      if (text.startsWith("slow")) {
        // Answers even when cancelled, so tests see the client drop late results.
        setTimeout(() => audio(id, [1]), 300);
        return;
      }
      if (text === "pid") return audio(id, [process.pid]);
      if (text === "cancelled") return audio(id, cancelled);
      if (text === "big") return audio(id, Array.from({ length: 200_000 }, (_, i) => (i % 100) / 100));
      return audio(id, [text.length, 0.5, -0.5]);
    }
    default:
      send({ id: request.id, ok: false, error: `unknown op ${request.op}` });
  }
});
