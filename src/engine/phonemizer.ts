// Shared eSpeak-NG phonemizer (ephone WASM), instantiated lazily per language pack. Worker-only.
import createEphone, { en_us, roa } from "ephone";
import type { ephoneModule } from "ephone";

type Pack = "roa" | "en_us";

const instances: Partial<Record<Pack, Promise<ephoneModule>>> = {};

/** IPA for `text` in eSpeak voice `espeakVoice` (`pt-br`, `en-us`, …); punctuation (`,` `.` `?` `!`) is kept. */
export async function textToIpa(text: string, espeakVoice: string): Promise<string> {
  const lang = espeakVoice.toLowerCase();
  let pack: Pack;
  if (lang.startsWith("en")) pack = "en_us";
  else if (/^(pt|es|fr|it)\b/.test(lang)) pack = "roa";
  else throw new Error(`no eSpeak language pack bundled for "${espeakVoice}"`);
  const ephone = await (instances[pack] ??= createEphone(pack === "roa" ? roa : en_us));
  // The instance is shared by engines, so select the voice on every call (cheap).
  ephone.setVoice(espeakVoice);
  return ephone.textToIpa(text);
}
