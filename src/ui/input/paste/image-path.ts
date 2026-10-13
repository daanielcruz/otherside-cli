import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ImageMediaType } from "@/kernel/std/types/image.ts";
import { detectMediaType } from "@/ui/input/paste/clipboard.ts";

// Dragging an image file from a file manager into the terminal pastes its
// path, not its pixels. Read the file the path names; otherwise the only image
// the clipboard offers is the file manager's generic document icon, and that
// is what the model would be shown.

const IMAGE_FILE_PATTERN = /\.(png|jpe?g|gif|webp)$/i;

export interface PastedImageFile {
  path: string;
  base64: string;
  mediaType: ImageMediaType;
}

function withoutOuterQuotes(text: string): string {
  const quoted =
    (text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"));
  return quoted ? text.slice(1, -1) : text;
}

// A dragged path arrives shell-escaped (`My\ File.png`). Escaped backslashes
// are kept literal so a Windows-style segment survives the pass.
function withoutShellEscapes(path: string): string {
  return path.replace(/\\(.)/g, (_, escaped: string) => escaped);
}

/** The image file path a pasted line names, or null when it names none. */
export function imageFilePathFrom(line: string): string | null {
  const path = withoutShellEscapes(withoutOuterQuotes(line.trim()));
  return isAbsolute(path) && IMAGE_FILE_PATTERN.test(path) ? path : null;
}

/**
 * Split a paste into the image files it names and the text that remains.
 * Several dragged files arrive separated by spaces or newlines; a space only
 * splits where an absolute path begins, since spaces inside paths are escaped.
 */
export function splitPastedImagePaths(pasted: string): { imagePaths: string[]; text: string } {
  const lines = pasted
    .split(/ (?=\/|[A-Za-z]:\\)/)
    .flatMap((part) => part.split("\n"))
    .filter((line) => line.trim().length > 0);
  const imagePaths: string[] = [];
  const textLines: string[] = [];
  for (const line of lines) {
    const path = imageFilePathFrom(line);
    if (path) imagePaths.push(path);
    else textLines.push(line);
  }
  return { imagePaths, text: textLines.join("\n") };
}

export function readPastedImageFile(path: string): PastedImageFile | null {
  let buffer: Buffer;
  try {
    buffer = readFileSync(path);
  } catch {
    return null;
  }
  if (buffer.length === 0) return null;
  return { path, base64: buffer.toString("base64"), mediaType: detectMediaType(buffer) };
}
