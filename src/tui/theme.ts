// Colors used across the TUI. One palette keeps screens consistent and lets tests assert exact styles.

export const theme = {
  bg: "#0b1421",
  fg: "#dce8f3",
  muted: "#9aafc0",
  dim: "#71889c",
  accent: "#4bd8d1",
  heading: "#a4baff",
  code: "#f3bb78",
  link: "#7ccfff",
  quote: "#a1b4c6",
  border: "#294357",
  /** Current sentence. */
  highlightBg: "#16616d",
  highlightFg: "#ffffff",
  live: "#68d6a8",
  info: "#4bd8d1",
  warning: "#f2bc66",
  error: "#ff7e91",
  overlayBg: "#132335",
  selectedBg: "#205b70",
  selectedFg: "#ffffff",
  progress: "#52d5cb",
  progressTrack: "#365164",
} as const;
