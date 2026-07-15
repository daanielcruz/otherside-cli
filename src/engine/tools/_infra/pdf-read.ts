import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PDF_MAX_PAGES_PER_READ = 20;
export const PDF_INLINE_PAGE_THRESHOLD = 10;
const PDF_MAX_EXTRACT_SIZE = 100 * 1024 * 1024;
const RENDER_DPI = 100;

export interface PdfPageRange {
  firstPage: number;
  lastPage: number;
}

export function parsePdfPageRange(pages: string): PdfPageRange | null {
  const trimmed = pages.trim();
  if (!trimmed) return null;

  if (trimmed.endsWith("-")) {
    const first = Number.parseInt(trimmed.slice(0, -1), 10);
    if (Number.isNaN(first) || first < 1) return null;
    return { firstPage: first, lastPage: Number.POSITIVE_INFINITY };
  }

  const dashIndex = trimmed.indexOf("-");
  if (dashIndex === -1) {
    const page = Number.parseInt(trimmed, 10);
    if (Number.isNaN(page) || page < 1) return null;
    return { firstPage: page, lastPage: page };
  }

  const first = Number.parseInt(trimmed.slice(0, dashIndex), 10);
  const last = Number.parseInt(trimmed.slice(dashIndex + 1), 10);
  if (Number.isNaN(first) || Number.isNaN(last) || first < 1 || last < 1 || last < first) {
    return null;
  }
  return { firstPage: first, lastPage: last };
}

export function isPdftoppmAvailable(): boolean {
  const result = spawnSync("pdftoppm", ["-v"], { encoding: "utf8", timeout: 5000 });
  return result.status === 0 || (result.stderr?.length ?? 0) > 0;
}

export function pdfPageCount(filePath: string): number | null {
  const result = spawnSync("pdfinfo", [filePath], { encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0 || !result.stdout) return null;
  const match = /^Pages:\s+(\d+)/m.exec(result.stdout);
  if (!match?.[1]) return null;
  const count = Number.parseInt(match[1], 10);
  return Number.isNaN(count) ? null : count;
}

export function renderPdfPages(
  filePath: string,
  range?: PdfPageRange,
): { pages: Buffer[] } | { error: string } {
  let size = 0;
  try {
    size = statSync(filePath).size;
  } catch {
    return { error: `PDF does not exist: ${filePath}` };
  }
  if (size === 0) return { error: `PDF file is empty: ${filePath}` };
  if (size > PDF_MAX_EXTRACT_SIZE) {
    return { error: `PDF file exceeds maximum allowed size of ${PDF_MAX_EXTRACT_SIZE} bytes.` };
  }

  const dir = mkdtempSync(join(tmpdir(), "otherside-pdf-"));
  const prefix = join(dir, "page");
  const args = ["-jpeg", "-r", String(RENDER_DPI)];
  if (range?.firstPage) args.push("-f", String(range.firstPage));
  if (range?.lastPage && range.lastPage !== Number.POSITIVE_INFINITY) {
    args.push("-l", String(range.lastPage));
  }
  args.push(filePath, prefix);

  try {
    const result = spawnSync("pdftoppm", args, { encoding: "buffer", timeout: 120_000 });
    if (result.status !== 0) {
      const stderr = result.stderr?.toString() ?? "";
      if (/password/i.test(stderr)) {
        return { error: "PDF is password-protected. Please provide an unprotected version." };
      }
      if (/damaged|corrupt|invalid/i.test(stderr)) {
        return { error: "PDF file is corrupted or invalid." };
      }
      return { error: `pdftoppm failed: ${stderr.trim() || "unknown error"}` };
    }

    const imageFiles = readdirSync(dir)
      .filter((name) => name.endsWith(".jpg"))
      .sort();
    if (imageFiles.length === 0) {
      return { error: "pdftoppm produced no output pages. The PDF may be invalid." };
    }
    const pages = imageFiles.map((name) => readFileSync(join(dir, name)));
    return { pages };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}
