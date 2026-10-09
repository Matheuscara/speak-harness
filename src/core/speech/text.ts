import type { Lang } from "../types.ts";
import { codeWord } from "./localize.ts";

const FILE_EXTENSIONS =
  "tsx?|jsx?|mjs|cjs|mts|cts|json[c5l]?|md|mdx|toml|ya?ml|py|rs|go|sh|bash|zsh|fish|nix|lock|txt|html?|css|scss|sql|c|h|cpp|hpp|cc|java|kt|rb|php|swift|lua|zig|vue|svelte|env|log|csv|tsv|xml|ini|cfg|conf|wav|onnx|png|jpe?g|gif|svg|pdf|zip|gz|tar";

const URL_SOURCE = String.raw`\bhttps?:\/\/[^\s<>()\[\]{}"'\x60]*[^\s<>()\[\]{}"'\x60.,;:!?]`;
const PATH_SEGMENT = String.raw`[\p{L}\p{N}_@+-][\p{L}\p{N}_@.+-]*`;
/** A path with at least one slash whose last segment has an extension, or a rooted path (`/`, `./`, `../`, `~/`). */
const PATH_SOURCE =
  String.raw`(?<![\p{L}\p{N}_/.:@-])(?:` +
  String.raw`(?:~\/|\.{1,2}\/|\/)?(?:${PATH_SEGMENT}\/)+${PATH_SEGMENT}\.[\p{L}\p{N}]{1,8}` +
  String.raw`|(?:~\/|\.{1,2}\/|\/)(?:${PATH_SEGMENT}\/)*${PATH_SEGMENT}` +
  String.raw`)(?![\p{L}\p{N}_\/])`;
/** A bare file name with a known extension, kept whole so its dot is not taken as a sentence end. */
const FILE_SOURCE = String.raw`(?<![\p{L}\p{N}_/.@-])${PATH_SEGMENT}\.(?:${FILE_EXTENSIONS})(?![\p{L}\p{N}_-]|\.[\p{L}\p{N}])`;

/** Matches URLs, file paths and file names inside plain text (global). */
export const TEXT_ENTITY = new RegExp(`(${URL_SOURCE})|(${PATH_SOURCE})|(${FILE_SOURCE})`, "gu");

/** Host of `url` without `www.`; `undefined` if it does not parse. */
export function urlHost(url: string): string | undefined {
  try {
    const host = new URL(url).hostname;
    return host ? host.replace(/^www\./, "") : undefined;
  } catch {
    return undefined;
  }
}

export function lastPathSegment(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part.length > 0);
  return parts.at(-1) ?? path;
}

/** Spoken form of a URL / path / file-name match from `TEXT_ENTITY`. */
export function speakTextEntity(match: RegExpExecArray): string {
  const [whole, url, path] = match;
  if (url) return urlHost(url) ?? "";
  if (path) return lastPathSegment(path);
  return whole;
}

const FILE_NAME = new RegExp(`^${PATH_SEGMENT}\\.(?:${FILE_EXTENSIONS})$`, "u");
/** Characters that make inline code unreadable as words. */
const CODE_SYMBOL = /[^\p{L}\p{N}\s_\-./:@]/gu;
const MAX_INLINE_CODE = 40;

function splitIdentifier(token: string): string[] {
  return token
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/(\p{L})(\p{N})|(\p{N})(\p{L})/gu, (_m, l1, n1, n2, l2) => (l1 ? `${l1} ${n1}` : `${n2} ${l2}`))
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => (/^\p{Lu}\p{Ll}+$/u.test(word) ? word.toLowerCase() : word));
}

function verbalizeCodeToken(token: string): string[] {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) {
    const host = urlHost(token);
    return host ? [host] : [];
  }
  let word = token;
  const slashes = (word.match(/\//g) ?? []).length;
  const rooted = /^(?:~|\.{1,2})?\//.test(word);
  const scoped = /^@[^/]+\/[^/]+$/.test(word);
  if (!scoped && (rooted || slashes >= 2 || (slashes === 1 && FILE_NAME.test(lastPathSegment(word))))) {
    word = lastPathSegment(word);
  }
  if (FILE_NAME.test(word)) return [word];
  return word
    .split(/[^\p{L}\p{N}]+/u)
    .filter((part) => part.length > 0)
    .flatMap(splitIdentifier);
}

/**
 * Inline code as words: identifiers are split (`speakLastMessage` → "speak last message"),
 * paths read their last segment, URLs their host. Long or symbol-heavy code becomes "code".
 */
export function verbalizeInlineCode(code: string, lang: Lang): string {
  const trimmed = code.trim().replace(/\(\s*\)/g, "").replace(/;$/, "");
  if (!trimmed) return "";
  const symbols = (trimmed.match(CODE_SYMBOL) ?? []).length;
  if (trimmed.length > MAX_INLINE_CODE || symbols >= 3 || symbols / trimmed.length > 0.2) return codeWord(lang);
  const words = trimmed.split(/\s+/).flatMap(verbalizeCodeToken);
  return words.length > 0 ? words.join(" ") : codeWord(lang);
}

const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}]/gu;
/** Arrows, box drawing, geometric shapes, misc symbols, dingbats, bullets. */
const DECORATIVE = /[\u2022\u2023\u2043\u2219\u2190-\u21FF\u2300-\u23FF\u2500-\u27BF\u2B00-\u2BFF]/gu;
/** Markdown syntax and other characters that must never be spoken. */
const SYNTAX = /[*#`|[\]~^\\{}<>_]|-{2,}|={2,}/g;

/** Removes emoji, decorative symbols and markdown syntax; collapses whitespace. */
export function cleanSpokenText(text: string): string {
  return text
    .replace(EMOJI, " ")
    .replace(DECORATIVE, " ")
    .replace(SYNTAX, " ")
    .replace(/\(\s*\)/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?)])/g, "$1")
    .replace(/([(])\s+/g, "$1")
    .replace(/^[\s,.;:!?)-]+/, "")
    .trim();
}

export function isSpeakable(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}
