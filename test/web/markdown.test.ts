import { expect, test } from "bun:test";
import { renderMarkdown } from "../../src/web/markdown.ts";

test("renders assistant markdown as structure without allowing script, HTML or unsafe links", () => {
  const html = renderMarkdown('## Result\n\n**Good** [click](javascript:alert(1)) <img src=x onerror=alert(1)>\n\n```ts\nconst n = 1;\n```');
  expect(html).toContain("<h2>Result</h2>");
  expect(html).toContain("<strong>Good</strong>");
  expect(html).toContain("click");
  expect(html).not.toContain('href="javascript:');
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  expect(html).toContain('<pre data-lang="ts"><code>const n = 1;</code></pre>');
});

test("only the spoken sentence is marked while adjacent markdown remains legible", () => {
  const markdown = "**First.** Second sentence.";
  const start = markdown.indexOf("Second");
  const html = renderMarkdown(markdown, { start, end: markdown.length });
  expect(html).toContain("<strong>First.</strong>");
  expect(html).toContain("<mark>Second sentence.</mark>");
  expect(html).not.toContain("<mark>First.");
});
