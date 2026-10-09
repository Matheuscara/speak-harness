import type { Config, Lang, VoiceOverride } from "../types.ts";

/** Voice precedence: explicit override (primary/alternate) → language map when auto-language is on → primary. */
export function resolveVoice(config: Config, override: VoiceOverride, lang: Lang): string {
  if (override === "primary") return config.voices.primary;
  if (override === "alternate") return config.voices.alternate;
  if (!config.voices.autoLanguage) return config.voices.primary;
  return config.voices.languages[lang] || config.voices.primary;
}
