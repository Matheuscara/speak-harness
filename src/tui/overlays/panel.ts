// Shared overlay pieces: the host interface overlays use, the floating panel, and a themed select list.

import { BoxRenderable, SelectRenderable, TextRenderable, type CliRenderer, type Renderable } from "@opentui/core";
import type { AppCore, CommandId } from "../../core/types.ts";
import type { KeyController, ScopedBinding } from "../keys.ts";
import { theme } from "../theme.ts";

export type NoticeLevel = "info" | "warning" | "error";

export interface OverlayHost {
  readonly renderer: CliRenderer;
  readonly app: AppCore;
  readonly keys: KeyController;
  readonly cwd: string;
  close(): void;
  notice(level: NoticeLevel, text: string): void;
  runCommand(id: CommandId): void;
}

export interface Overlay {
  readonly root: BoxRenderable;
  /** Receives focus when the overlay opens; overlay bindings are scoped to it. */
  readonly focusTarget: Renderable;
  readonly bindings: readonly ScopedBinding[];
  /** Handles esc inside the overlay (leaving a sub-view); false closes the overlay. */
  escape?(): boolean;
  /** Config changed while open. */
  refresh?(): void;
  dispose?(): void;
}

export function createPanel(renderer: CliRenderer, id: string, title: string, hint: string): BoxRenderable {
  return new BoxRenderable(renderer, {
    id,
    position: "absolute",
    top: "10%",
    left: "8%",
    width: "84%",
    height: "80%",
    zIndex: 100,
    border: true,
    borderStyle: "rounded",
    borderColor: theme.accent,
    backgroundColor: theme.overlayBg,
    title: ` ${title} `,
    titleColor: theme.accent,
    bottomTitle: ` ${hint} `,
    bottomTitleAlignment: "right",
    flexDirection: "column",
    paddingLeft: 1,
    paddingRight: 1,
  });
}

export function createList(renderer: CliRenderer, id: string): SelectRenderable {
  return new SelectRenderable(renderer, {
    id,
    flexGrow: 1,
    flexShrink: 1,
    // Two-line items can draw past the list's last row; clip so footer lines stay clean.
    overflow: "hidden",
    backgroundColor: theme.overlayBg,
    focusedBackgroundColor: theme.overlayBg,
    textColor: theme.fg,
    focusedTextColor: theme.fg,
    selectedBackgroundColor: theme.selectedBg,
    selectedTextColor: theme.selectedFg,
    descriptionColor: theme.muted,
    selectedDescriptionColor: theme.selectedFg,
    showScrollIndicator: true,
    wrapSelection: true,
  });
}

export function createLine(renderer: CliRenderer, id: string, fg: string = theme.muted): TextRenderable {
  return new TextRenderable(renderer, { id, height: 1, flexShrink: 0, wrapMode: "none", truncate: true, fg, bg: theme.overlayBg });
}

/** One-line plain title for an answer: first non-empty line without markdown markers. */
export function messageTitle(markdown: string, max = 70): string {
  const line = markdown.split("\n").find((l) => l.trim() !== "") ?? "";
  const plain = line
    .replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, "")
    .replace(/[*_`~]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain || "(empty answer)";
}

export function clock(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function relativeTime(date: Date, now = Date.now()): string {
  const minutes = Math.round((now - date.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}
