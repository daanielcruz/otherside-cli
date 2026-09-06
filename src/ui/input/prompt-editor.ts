import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { withReleasedTerminal } from "@/terminal-runtime/host/terminal-handoff.ts";

const FALLBACK_EDITOR = "vi";
const TEMP_DIRECTORY_PREFIX = "otherside-prompt-";
const TEMP_FILE_NAME = "prompt.md";

export interface EditorLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

/** The temp file the editor is handed, and what comes back out of it. */
export interface ExternalEditorIo {
  /** Writes `contents` somewhere private and returns the path to hand over. */
  readonly createFile: (contents: string) => string;
  /** Runs the editor to completion; false when it never ran or refused to save. */
  readonly run: (launch: EditorLaunch, path: string) => boolean;
  readonly readFile: (path: string) => string;
  readonly discard: (path: string) => void;
}

/**
 * `$EDITOR` split on whitespace so a flagged editor keeps its flags; `vi` when the
 * environment names none. The file path is appended as the last argument.
 */
export function editorLaunchFor(env: NodeJS.ProcessEnv = process.env): EditorLaunch {
  const parts = (env.EDITOR ?? "").trim().split(/\s+/).filter(Boolean);
  const [command = FALLBACK_EDITOR, ...args] = parts;
  return { command, args };
}

/** Editors save with a closing newline the buffer never asked for. */
export function normalizeEditedText(raw: string): string {
  return raw.replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

export const defaultEditorIo: ExternalEditorIo = {
  createFile(contents) {
    const path = join(mkdtempSync(join(tmpdir(), TEMP_DIRECTORY_PREFIX)), TEMP_FILE_NAME);
    writeFileSync(path, contents, { mode: 0o600 });
    return path;
  },
  run(launch, path) {
    const result = spawnSync(launch.command, [...launch.args, path], { stdio: "inherit" });
    return result.error === undefined && result.status === 0;
  },
  readFile: (path) => readFileSync(path, "utf8"),
  discard(path) {
    try {
      rmSync(dirname(path), { recursive: true, force: true });
    } catch {}
  },
};

/**
 * Round-trips `text` through an editor. The buffer is replaced only by a clean exit:
 * an editor that could not start, or that left with a failing status, keeps the draft
 * as it was (null). The temp file never outlives the call.
 */
export function editTextExternally(
  text: string,
  io: ExternalEditorIo = defaultEditorIo,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  let path: string;
  try {
    path = io.createFile(text);
  } catch {
    return null;
  }
  try {
    if (!io.run(editorLaunchFor(env), path)) return null;
    return normalizeEditedText(io.readFile(path));
  } catch {
    return null;
  } finally {
    io.discard(path);
  }
}

/**
 * Opens a file that already exists, in place. Nothing is copied and nothing comes
 * back: the edit IS the file, which is what a config the reader owns needs — a
 * temp-file round trip would lose whatever the editor did that we did not read.
 *
 * Answers whether the editor ran and left cleanly, so the caller knows whether to
 * re-read.
 */
export function editFileExternally(
  path: string,
  io: ExternalEditorIo = defaultEditorIo,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return withReleasedTerminal(() => {
    try {
      return io.run(editorLaunchFor(env), path);
    } catch {
      return false;
    }
  });
}

/** The same round trip with the terminal handed to the editor and taken back after. */
export function editPromptExternally(
  text: string,
  io: ExternalEditorIo = defaultEditorIo,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return withReleasedTerminal(() => editTextExternally(text, io, env));
}
