import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatform } from "@/kernel/std/proc/platform.ts";
import { shellCommand } from "@/kernel/std/proc/shell.ts";
import type { ImageMediaType } from "@/kernel/std/types/image.ts";

export interface ClipboardImage {
  base64: string;
  mediaType: ImageMediaType;
  byteLength: number;
}

const SCREENSHOT_PATH = join(tmpdir(), `otherside_clipboard_${process.pid}.png`);

function spawnSync(cmd: string[]): { code: number; stdout: string } {
  try {
    const proc = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "ignore" });
    return {
      code: proc.exitCode ?? 0,
      stdout: (proc.stdout?.toString?.("utf8") ?? "").trim(),
    };
  } catch {
    return { code: 1, stdout: "" };
  }
}

function shellSync(command: string): { code: number; stdout: string } {
  return spawnSync(shellCommand(command));
}

async function spawnAsync(cmd: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "ignore" });
    const [stdoutText, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return { code: exitCode ?? 0, stdout: stdoutText.trim() };
  } catch {
    return { code: 1, stdout: "" };
  }
}

async function shellAsync(command: string): Promise<{ code: number; stdout: string }> {
  return spawnAsync(shellCommand(command));
}

export function hasImageInClipboard(): boolean {
  switch (getPlatform()) {
    case "macos":
      return spawnSync(["osascript", "-e", "the clipboard as «class PNGf»"]).code === 0;
    case "linux":
    case "wsl": {
      const cmd =
        'xclip -selection clipboard -t TARGETS -o 2>/dev/null | grep -E "image/(png|jpeg|jpg|gif|webp|bmp)" || ' +
        'wl-paste -l 2>/dev/null | grep -E "image/(png|jpeg|jpg|gif|webp|bmp)"';
      return shellSync(cmd).code === 0;
    }
    case "windows": {
      const ps = 'powershell -NoProfile -Command "(Get-Clipboard -Format Image) -ne $null"';
      const r = shellSync(ps);
      return r.code === 0 && r.stdout.toLowerCase() === "true";
    }
    default:
      return false;
  }
}

export async function hasImageInClipboardAsync(): Promise<boolean> {
  switch (getPlatform()) {
    case "macos": {
      const r = await spawnAsync(["osascript", "-e", "the clipboard as «class PNGf»"]);
      return r.code === 0;
    }
    case "linux":
    case "wsl": {
      const cmd =
        'xclip -selection clipboard -t TARGETS -o 2>/dev/null | grep -E "image/(png|jpeg|jpg|gif|webp|bmp)" || ' +
        'wl-paste -l 2>/dev/null | grep -E "image/(png|jpeg|jpg|gif|webp|bmp)"';
      const r = await shellAsync(cmd);
      return r.code === 0;
    }
    case "windows": {
      const ps = 'powershell -NoProfile -Command "(Get-Clipboard -Format Image) -ne $null"';
      const r = await shellAsync(ps);
      return r.code === 0 && r.stdout.toLowerCase() === "true";
    }
    default:
      return false;
  }
}

export async function writeTextToClipboard(text: string): Promise<boolean> {
  switch (getPlatform()) {
    case "macos":
      return writeViaStdin(["pbcopy"], text);
    case "linux":
    case "wsl": {
      if (await writeViaStdin(["wl-copy"], text)) return true;
      return writeViaStdin(["xclip", "-selection", "clipboard"], text);
    }
    case "windows":
      return writeViaStdin(["clip.exe"], text);
    default:
      return false;
  }
}

async function writeViaStdin(cmd: string[], text: string): Promise<boolean> {
  try {
    const proc = Bun.spawn({ cmd, stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    proc.stdin.write(text);
    await proc.stdin.end();
    const code = await proc.exited;
    return (code ?? 0) === 0;
  } catch {
    return false;
  }
}

export function readImageFromClipboard(): ClipboardImage | null {
  if (!writeClipboardImageToFile()) return null;
  if (!existsSync(SCREENSHOT_PATH)) return null;
  let buffer: Buffer;
  try {
    buffer = readFileSync(SCREENSHOT_PATH);
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(SCREENSHOT_PATH);
    } catch {}
  }
  if (buffer.length === 0) return null;
  return {
    base64: buffer.toString("base64"),
    mediaType: detectMediaType(buffer),
    byteLength: buffer.length,
  };
}

function writeClipboardImageToFile(): boolean {
  const path = SCREENSHOT_PATH;
  switch (getPlatform()) {
    case "macos": {
      const r = spawnSync([
        "osascript",
        "-e",
        "set png_data to (the clipboard as «class PNGf»)",
        "-e",
        `set fp to open for access POSIX file "${path}" with write permission`,
        "-e",
        "write png_data to fp",
        "-e",
        "close access fp",
      ]);
      return r.code === 0;
    }
    case "linux":
    case "wsl": {
      const cmd =
        `xclip -selection clipboard -t image/png -o > "${path}" 2>/dev/null || ` +
        `wl-paste --type image/png > "${path}" 2>/dev/null || ` +
        `xclip -selection clipboard -t image/bmp -o > "${path}" 2>/dev/null || ` +
        `wl-paste --type image/bmp > "${path}"`;
      return shellSync(cmd).code === 0;
    }
    case "windows": {
      const escaped = path.replace(/\\/g, "\\\\").replace(/'/g, "''");
      const ps = `powershell -NoProfile -Command "$img = Get-Clipboard -Format Image; if ($img) { $img.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png) }"`;
      return shellSync(ps).code === 0;
    }
    default:
      return false;
  }
}

function detectMediaType(buf: Buffer): ImageMediaType {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return "image/gif";
  }
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "image/webp";
  }
  return "image/png";
}
