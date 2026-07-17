import { spawn } from "node:child_process";
import { whichSync } from "@/kernel/std/proc/which.ts";

// GUI editors open detached and return immediately; terminal editors would
// need to own the tty (suspend the renderer), so the caller falls back to
// showing the file path instead of launching them from inside a panel.
const GUI_EDITORS = new Set([
  "code",
  "cursor",
  "windsurf",
  "codium",
  "subl",
  "atom",
  "gedit",
  "notepad++",
  "notepad",
]);
// Windows shell-open launchers behave like GUI opens (detached, no tty).
const SHELL_LAUNCHERS = new Set(["start", "cmd", "cmd.exe"]);
const TERMINAL_EDITOR = /\b(vi|vim|nvim|nano|emacs|pico|micro|helix|hx)\b/;
const PROBE_ORDER = ["code", "vi", "nano"] as const;

export type EditorLaunch =
  | { ok: true; editor: string }
  | { ok: false; reason: "none-found" | "terminal-editor" | "spawn-failed"; editor?: string };

export function resolveExternalEditor(): string | undefined {
  const visual = process.env.VISUAL?.trim();
  if (visual) return visual;
  const editor = process.env.EDITOR?.trim();
  if (editor) return editor;
  return PROBE_ORDER.find((candidate) => whichSync(candidate) !== null);
}

function editorBaseName(command: string): string {
  return command.split("/").pop()?.toLowerCase() ?? command.toLowerCase();
}

export function openPathInEditor(path: string): EditorLaunch {
  const editor = resolveExternalEditor();
  if (!editor) return { ok: false, reason: "none-found" };
  const argv = editor.split(" ").filter((part) => part.length > 0);
  const head = argv[0] ?? editor;
  const base = editorBaseName(head);
  const detachable = GUI_EDITORS.has(base) || SHELL_LAUNCHERS.has(base);
  if (!detachable || TERMINAL_EDITOR.test(base)) {
    // Unknown commands are treated as terminal editors: launching one from a
    // live panel would fight the renderer for the tty.
    return { ok: false, reason: "terminal-editor", editor: base };
  }
  try {
    const child = spawn(head, [...argv.slice(1), path], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return { ok: true, editor: base };
  } catch {
    return { ok: false, reason: "spawn-failed", editor: base };
  }
}
