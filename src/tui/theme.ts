// Colors used across the TUI. One palette keeps screens consistent and lets tests assert exact styles.

export const theme = {
  bg: "#0d1117",
  fg: "#c9d1d9",
  muted: "#8b949e",
  dim: "#6e7681",
  accent: "#58a6ff",
  heading: "#79c0ff",
  code: "#ffa657",
  link: "#58a6ff",
  quote: "#8b949e",
  border: "#30363d",
  /** Current sentence. */
  highlightBg: "#1f6feb",
  highlightFg: "#ffffff",
  live: "#3fb950",
  info: "#58a6ff",
  warning: "#d29922",
  error: "#f85149",
  overlayBg: "#161b22",
  selectedBg: "#1f6feb",
  selectedFg: "#ffffff",
} as const;
