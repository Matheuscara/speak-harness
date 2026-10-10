/** One-line plain title for an answer, without visible markdown markers. */
export function messageTitle(markdown: string, max = 70): string {
  const line = markdown.split("\n").find((part) => part.trim() !== "") ?? "";
  const plain = line
    .replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .trim();
  return plain.length > max
    ? `${plain.slice(0, max - 1)}…`
    : plain || "(empty answer)";
}
