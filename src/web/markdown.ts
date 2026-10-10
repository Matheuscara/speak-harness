import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Nodes, Root } from "mdast";

export interface SourceRange {
  start: number;
  end: number;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}

function overlaps(node: Nodes, active: SourceRange | undefined): boolean {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return (
    active !== undefined &&
    start !== undefined &&
    end !== undefined &&
    start < active.end &&
    active.start < end
  );
}

function renderText(
  node: Extract<Nodes, { type: "text" }>,
  active: SourceRange | undefined,
): string {
  const text = node.value;
  const offset = node.position?.start.offset;
  if (!active || offset === undefined || !overlaps(node, active))
    return escapeHtml(text);
  const start = Math.max(0, Math.min(text.length, active.start - offset));
  const end = Math.max(start, Math.min(text.length, active.end - offset));
  if (start === end) return `<mark>${escapeHtml(text)}</mark>`;
  return `${escapeHtml(text.slice(0, start))}<mark>${escapeHtml(text.slice(start, end))}</mark>${escapeHtml(text.slice(end))}`;
}

function children(node: Nodes, active: SourceRange | undefined): string {
  return "children" in node && Array.isArray(node.children)
    ? node.children.map((child) => renderNode(child as Nodes, active)).join("")
    : "";
}

/** No raw HTML or external images are emitted; assistant-supplied markup cannot execute code in the dashboard. */
function renderNode(node: Nodes, active: SourceRange | undefined): string {
  switch (node.type) {
    case "root":
      return children(node, active);
    case "paragraph":
      return `<p>${children(node, active)}</p>`;
    case "heading":
      return `<h${node.depth}>${children(node, active)}</h${node.depth}>`;
    case "text":
      return renderText(node, active);
    case "strong":
      return `<strong>${children(node, active)}</strong>`;
    case "emphasis":
      return `<em>${children(node, active)}</em>`;
    case "delete":
      return `<del>${children(node, active)}</del>`;
    case "inlineCode":
      return `<code${overlaps(node, active) ? ' class="current-code"' : ""}>${escapeHtml(node.value)}</code>`;
    case "code": {
      const lang =
        node.lang && /^[\w+-]{1,30}$/.test(node.lang)
          ? ` data-lang="${escapeHtml(node.lang)}"`
          : "";
      return `<pre${lang}${overlaps(node, active) ? ' class="current-code"' : ""}><code>${escapeHtml(node.value)}</code></pre>`;
    }
    case "link": {
      const label = children(node, active);
      let safe: URL | undefined;
      try {
        const url = new URL(node.url);
        if (["http:", "https:", "mailto:"].includes(url.protocol)) safe = url;
      } catch {
        /* Relative or malformed links remain plain text. */
      }
      return safe
        ? `<a href="${escapeHtml(safe.href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
        : label;
    }
    case "image":
      return `<span class="image-alt">[image: ${escapeHtml(node.alt ?? "image")}]</span>`;
    case "list": {
      const tag = node.ordered ? "ol" : "ul";
      const start =
        node.ordered && node.start && node.start !== 1
          ? ` start="${node.start}"`
          : "";
      return `<${tag}${start}>${children(node, active)}</${tag}>`;
    }
    case "listItem":
      return `<li>${node.checked === null || node.checked === undefined ? "" : node.checked ? "☑ " : "☐ "}${children(node, active)}</li>`;
    case "blockquote":
      return `<blockquote>${children(node, active)}</blockquote>`;
    case "table":
      return `<div class="table-scroll"><table>${children(node, active)}</table></div>`;
    case "tableRow":
      return `<tr>${children(node, active)}</tr>`;
    case "tableCell":
      return `<td>${children(node, active)}</td>`;
    case "thematicBreak":
      return "<hr>";
    case "break":
      return "<br>";
    case "html":
      return escapeHtml(node.value);
    case "linkReference":
      return children(node, active);
    case "imageReference":
      return `<span class="image-alt">[image: ${escapeHtml(node.alt ?? "image")}]</span>`;
    case "footnoteReference":
      return `<sup>${escapeHtml(node.identifier)}</sup>`;
    case "footnoteDefinition":
      return "";
    default:
      return children(node, active);
  }
}

export function renderMarkdown(markdown: string, active?: SourceRange): string {
  const tree: Root = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  return renderNode(tree, active);
}
