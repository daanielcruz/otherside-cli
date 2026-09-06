import { errorMessage } from "@/kernel/std/errno.ts";
import type { Key } from "@/terminal-runtime";
import { printableText } from "@/ui/chrome/key-input.ts";

type ResumeKey = Partial<Key>;

export type ResumeMode = "list" | "search" | "rename" | "preview";

export type ResumeKeyAction =
  | { type: "enter-search"; seed: string }
  | { type: "clear-search" }
  | { type: "search-append"; text: string }
  | { type: "search-delete" }
  | { type: "back-to-list" }
  | { type: "move"; delta: number }
  | { type: "page"; delta: 1 | -1 }
  | { type: "preview" }
  | { type: "preview-scroll"; delta: number }
  | { type: "preview-page"; delta: 1 | -1 }
  | { type: "enter-rename" }
  | { type: "rename-append"; text: string }
  | { type: "rename-delete" }
  | { type: "rename-save" }
  | { type: "resume" }
  | { type: "close" }
  | { type: "none" };

export interface ResumeKeyContext {
  selectedIndex: number;
  queryLength: number;
}

export async function submitResumeSelection(
  id: string,
  onResume: (id: string) => void | Promise<void>,
  close: () => void,
): Promise<string | null> {
  try {
    await onResume(id);
    close();
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}

/**
 * Pure key contract for the resume picker, one action per keypress. Escape is
 * mode-scoped (clear search / leave rename / leave preview) and only closes
 * the panel from the root list, so a stray Esc never tears the overlay down
 * mid-interaction.
 */
export function resumeKeyAction(
  mode: ResumeMode,
  input: string,
  key: ResumeKey,
  context: ResumeKeyContext,
): ResumeKeyAction {
  switch (mode) {
    case "list":
      return listKeyAction(input, key, context);
    case "search":
      return searchKeyAction(input, key, context);
    case "preview":
      return previewKeyAction(key);
    case "rename":
      return renameKeyAction(input, key);
  }
}

function listKeyAction(input: string, key: ResumeKey, context: ResumeKeyContext): ResumeKeyAction {
  if (key.escape) return { type: "close" };
  if (key.return) return { type: "resume" };
  if (key.ctrl && (input === "r" || input === "R")) return { type: "enter-rename" };
  if (key.upArrow) {
    if (context.selectedIndex === 0) return { type: "enter-search", seed: "" };
    return { type: "move", delta: -1 };
  }
  if (key.downArrow) return { type: "move", delta: 1 };
  if (key.pageUp) return { type: "page", delta: -1 };
  if (key.pageDown) return { type: "page", delta: 1 };
  if (key.ctrl || key.meta) return { type: "none" };
  if (input === " ") return { type: "preview" };
  if (input === "/") return { type: "enter-search", seed: "" };
  const typed = printableText(input);
  if (typed.length > 0 && typed.trim().length > 0) return { type: "enter-search", seed: typed };
  return { type: "none" };
}

function searchKeyAction(
  input: string,
  key: ResumeKey,
  context: ResumeKeyContext,
): ResumeKeyAction {
  if (key.escape) {
    if (context.queryLength > 0) return { type: "clear-search" };
    return { type: "back-to-list" };
  }
  if (key.upArrow || key.return || key.downArrow) return { type: "back-to-list" };
  if (key.backspace || key.delete) return { type: "search-delete" };
  if (key.ctrl || key.meta) return { type: "none" };
  const typed = printableText(input);
  if (typed.length > 0) return { type: "search-append", text: typed };
  return { type: "none" };
}

function previewKeyAction(key: ResumeKey): ResumeKeyAction {
  if (key.escape) return { type: "back-to-list" };
  if (key.return) return { type: "resume" };
  if (key.upArrow) return { type: "preview-scroll", delta: -1 };
  if (key.downArrow) return { type: "preview-scroll", delta: 1 };
  if (key.pageUp) return { type: "preview-page", delta: -1 };
  if (key.pageDown) return { type: "preview-page", delta: 1 };
  return { type: "none" };
}

function renameKeyAction(input: string, key: ResumeKey): ResumeKeyAction {
  if (key.escape) return { type: "back-to-list" };
  if (key.return) return { type: "rename-save" };
  if (key.backspace || key.delete) return { type: "rename-delete" };
  if (key.ctrl || key.meta) return { type: "none" };
  const typed = printableText(input);
  if (typed.length > 0) return { type: "rename-append", text: typed };
  return { type: "none" };
}
