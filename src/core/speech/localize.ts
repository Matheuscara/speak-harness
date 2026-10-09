import type { Lang } from "../types.ts";

/** Spoken names for fenced-code language ids. Ids not listed are spoken as written. */
const CODE_LANGUAGE_NAMES: Record<string, string> = {
  ts: "TypeScript",
  typescript: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  tsx: "TSX",
  js: "JavaScript",
  javascript: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  jsx: "JSX",
  sh: "shell",
  bash: "shell",
  shell: "shell",
  zsh: "shell",
  console: "shell",
  shellsession: "shell",
  fish: "fish",
  ps1: "PowerShell",
  powershell: "PowerShell",
  py: "Python",
  python: "Python",
  rs: "Rust",
  rust: "Rust",
  go: "Go",
  golang: "Go",
  rb: "Ruby",
  ruby: "Ruby",
  java: "Java",
  kt: "Kotlin",
  kotlin: "Kotlin",
  swift: "Swift",
  c: "C",
  h: "C",
  cpp: "C plus plus",
  "c++": "C plus plus",
  cc: "C plus plus",
  hpp: "C plus plus",
  cs: "C sharp",
  csharp: "C sharp",
  php: "PHP",
  lua: "Lua",
  zig: "Zig",
  nix: "Nix",
  json: "JSON",
  jsonc: "JSON",
  json5: "JSON",
  jsonl: "JSON lines",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  ini: "INI",
  xml: "XML",
  html: "HTML",
  css: "CSS",
  scss: "SCSS",
  sql: "SQL",
  graphql: "GraphQL",
  gql: "GraphQL",
  md: "Markdown",
  markdown: "Markdown",
  mdx: "MDX",
  diff: "diff",
  patch: "diff",
  dockerfile: "Dockerfile",
  docker: "Dockerfile",
  make: "Makefile",
  makefile: "Makefile",
  mermaid: "Mermaid",
  vue: "Vue",
  svelte: "Svelte",
  elixir: "Elixir",
  ex: "Elixir",
  hs: "Haskell",
  haskell: "Haskell",
};

/** Fence ids that carry no useful language. */
const PLAIN_FENCES: Record<string, true> = { text: true, txt: true, plain: true, plaintext: true, output: true };

export function codeLanguageName(fence: string | null | undefined): string | undefined {
  const id = fence?.trim().toLowerCase().replace(/^\{?\.?/, "").replace(/\}$/, "");
  if (!id || PLAIN_FENCES[id]) return undefined;
  return CODE_LANGUAGE_NAMES[id] ?? id.replace(/[^\p{L}\p{N}+#]+/gu, " ").trim();
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function codeBlockCue(lang: Lang, codeLang: string | undefined, lines: number): string {
  if (lang === "pt-BR") {
    const head = codeLang ? `Bloco de código ${codeLang}` : "Bloco de código";
    return lines > 0 ? `${head}, ${lines} ${lines === 1 ? "linha" : "linhas"}` : head;
  }
  const head = capitalize(codeLang ? `${codeLang} code block` : "code block");
  return lines > 0 ? `${head}, ${lines} ${lines === 1 ? "line" : "lines"}` : head;
}

export function tableSummary(lang: Lang, columns: readonly string[]): string {
  const n = columns.length;
  const names = columns.filter((name) => name.length > 0).join(", ");
  const head =
    lang === "pt-BR"
      ? `Tabela com ${n} ${n === 1 ? "coluna" : "colunas"}`
      : `Table with ${n} ${n === 1 ? "column" : "columns"}`;
  return names ? `${head}: ${names}.` : `${head}.`;
}

export function tableRow(lang: Lang, row: number, cells: readonly string[]): string {
  const empty = lang === "pt-BR" ? "vazio" : "empty";
  const values = cells.map((cell) => cell || empty).join(", ");
  return `${lang === "pt-BR" ? "Linha" : "Row"} ${row}: ${values}.`;
}

export function quoteCue(lang: Lang): string {
  return lang === "pt-BR" ? "Citação." : "Quote.";
}

/** Word spoken in place of inline code that cannot be read as words. */
export function codeWord(lang: Lang): string {
  return lang === "pt-BR" ? "código" : "code";
}
