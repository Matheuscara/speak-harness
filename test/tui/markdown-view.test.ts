import { describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { alignOffsets, layoutMarkdown, renderRuns, type Leaf, type TextLeaf } from "../../src/tui/markdown-view.ts";
import { theme } from "../../src/tui/theme.ts";
import { MESSAGE_EN } from "./fake-app.ts";

const HIGHLIGHT = RGBA.fromHex(theme.highlightBg);

function highlighted(leaf: Leaf, start: number, end: number): string {
  if (leaf.kind !== "text") throw new Error("text leaf expected");
  return renderRuns(leaf.runs, { start, end })
    .chunks.filter((c) => c.bg?.equals(HIGHLIGHT))
    .map((c) => c.text)
    .join("");
}

function plain(leaf: Leaf): string {
  return leaf.kind === "text" ? leaf.runs.map((r) => r.text).join("") : leaf.value;
}

function textLeaves(markdown: string): TextLeaf[] {
  return layoutMarkdown(markdown).filter((l): l is TextLeaf => l.kind === "text");
}

describe("layoutMarkdown", () => {
  test("renders blocks without markdown symbols and keeps structure", () => {
    const leaves = layoutMarkdown(MESSAGE_EN);
    expect(leaves.map((l) => (l.kind === "text" ? l.role : "code"))).toEqual(["heading", "paragraph", "paragraph", "paragraph", "code", "table"]);
    expect(plain(leaves[0]!)).toBe("What is this task about?");
    expect(plain(leaves[1]!)).toBe("Developers use the app's database user to access production. Each credential is temporary.");
    expect(leaves[2]!.prefix.map((r) => r.text).join("")).toBe("• ");
    expect(plain(leaves[3]!)).toBe("Scoped to one schema only.");
    expect(leaves[4]).toMatchObject({ kind: "code", lang: "ts", value: 'const user = await vault.issue("db");\nconsole.log(user.ttl);' });
  });

  test("a source range highlights exactly the sentence it covers, across inline markup", () => {
    const paragraph = layoutMarkdown(MESSAGE_EN)[1]!;
    const first = "Developers use the **app's database user** to access production.";
    const start = MESSAGE_EN.indexOf(first);
    expect(highlighted(paragraph, start, start + first.length)).toBe("Developers use the app's database user to access production.");
    const second = MESSAGE_EN.indexOf("Each credential");
    expect(highlighted(paragraph, second, second + "Each credential is temporary.".length)).toBe("Each credential is temporary.");
  });

  test("inline code and escapes map back to their source characters", () => {
    const md = "Run `bun test` now \\*really\\*.";
    const [leaf] = textLeaves(md);
    expect(plain(leaf!)).toBe("Run bun test now *really*.");
    expect(highlighted(leaf!, md.indexOf("`bun"), md.indexOf("now") - 1)).toBe("bun test");
    expect(highlighted(leaf!, md.indexOf("\\*really"), md.length)).toBe("*really*.");
  });

  test("table rows highlight including synthetic padding between cells", () => {
    const md = "| a | long header |\n| --- | --- |\n| x | y |\n";
    const [table] = textLeaves(md);
    expect(plain(table!)).toBe("a │ long header\n──┼────────────\nx │ y          ");
    const row = md.indexOf("| x");
    expect(highlighted(table!, row, md.length)).toBe("x │ y");
  });

  test("nested lists and quotes produce hanging-indent prefixes", () => {
    const leaves = textLeaves("> quoted\n\n1. one\n2. two\n   - inner\n");
    expect(leaves.map((l) => [l.prefix.map((r) => r.text).join(""), plain(l)])).toEqual([
      ["▎ ", "quoted"],
      ["1. ", "one"],
      ["2. ", "two"],
      ["   • ", "inner"],
    ]);
  });

  test("no highlight leaves every chunk unhighlighted and reports -1", () => {
    const [leaf] = textLeaves("Plain text.");
    const rendered = renderRuns(leaf!.runs, undefined);
    expect(rendered.firstHighlight).toBe(-1);
    expect(rendered.chunks.every((c) => c.bg === undefined)).toBe(true);
  });
});

describe("alignOffsets", () => {
  test("skips invisible source characters and falls back for entities", () => {
    expect(alignOffsets("a*b", "a\\*b", 0, 4)).toEqual([0, 2, 3]);
    expect(alignOffsets("x&y", "x&amp;y", 0, 7)).toEqual([0, 1, 6]);
  });
});
