import { expect, test } from "bun:test";
import { messageTitle } from "../../src/core/message-title.ts";

test("assistant title stays readable without Markdown markers", () => {
  expect(messageTitle("## Você tem **2 produtos** cadastrados\n\nMais detalhes.")).toBe("Você tem 2 produtos cadastrados");
  expect(messageTitle("[Clique aqui](https://example.com) e `rode` o comando")).toBe("Clique aqui e rode o comando");
});
