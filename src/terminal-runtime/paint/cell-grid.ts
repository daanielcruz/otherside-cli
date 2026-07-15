import { type AnsiCode, ansiCodesToString, diffAnsiCodes } from "@alcalzone/ansi-tokenize";
import * as warn from "@/terminal-runtime/diagnostics/warnings.js";
import {
  type Point,
  type Rectangle,
  type Size,
  unionRect,
} from "@/terminal-runtime/geometry/coordinates.js";
import { BEL, ESC, SEP } from "@/terminal-runtime/terminal/ansi-control.js";
import { emitDiagnosticOutput } from "@/utils/debug.js";
import { isMetricsActive, recordAtlasKey } from "@/utils/xtermAtlasMetrics.js";

export class CharPool {
  private strings: string[] = [" ", ""];
  private stringMap = new Map<string, number>([
    [" ", 0],
    ["", 1],
  ]);
  private ascii: Int32Array = initCharAscii();

  intern(char: string): number {
    if (char.length === 1) {
      const code = char.charCodeAt(0);
      if (code < 128) {
        const cached = this.ascii[code]!;
        if (cached !== -1) return cached;
        const index = this.strings.length;
        this.strings.push(char);
        this.ascii[code] = index;
        return index;
      }
    }
    const existing = this.stringMap.get(char);
    if (existing !== undefined) return existing;
    const index = this.strings.length;
    this.strings.push(char);
    this.stringMap.set(char, index);
    return index;
  }

  get(index: number): string {
    return this.strings[index] ?? " ";
  }

  get size(): number {
    return this.strings.length;
  }
}

export class HyperlinkPool {
  private strings: string[] = [""];
  private stringMap = new Map<string, number>();

  intern(hyperlink: string | undefined): number {
    if (!hyperlink) return 0;
    let id = this.stringMap.get(hyperlink);
    if (id === undefined) {
      id = this.strings.length;
      this.strings.push(hyperlink);
      this.stringMap.set(hyperlink, id);
    }
    return id;
  }

  get(id: number): string | undefined {
    return id === 0 ? undefined : this.strings[id];
  }

  get size(): number {
    return this.strings.length;
  }
}

function fixBoldDimTransition(fromCodes: AnsiCode[], toCodes: AnsiCode[]): string {
  let fromFlags = 0;
  let toFlags = 0;
  for (const code of fromCodes) {
    if (code.code === "\x1b[1m") fromFlags |= 1;
    else if (code.code === "\x1b[2m") fromFlags |= 2;
  }
  for (const code of toCodes) {
    if (code.code === "\x1b[1m") toFlags |= 1;
    else if (code.code === "\x1b[2m") toFlags |= 2;
  }
  if (fromFlags & ~toFlags && toFlags) {
    const keepFlags = fromFlags & toFlags;
    return "\x1b[22m" + (keepFlags & 1 ? "\x1b[1m" : "") + (keepFlags & 2 ? "\x1b[2m" : "");
  }
  return "";
}

export class StylePool {
  private ids = new Map<string, number>();
  private styles: AnsiCode[][] = [];
  private transitionCache = new Map<number, string>();
  private overflowWarned = false;
  private generationCount = 0;
  readonly none: number;

  constructor() {
    this.none = this.intern([]);
  }

  get size(): number {
    return this.styles.length;
  }

  get overflowed(): boolean {
    return this.overflowWarned;
  }

  get transitionCacheSize(): number {
    return this.transitionCache.size;
  }

  get generation(): number {
    return this.generationCount;
  }

  needsCompaction(targetSize: number): boolean {
    return this.overflowWarned || this.styles.length > Math.max(512, 2 * targetSize);
  }

  intern(styles: AnsiCode[]): number {
    const key = styles.length === 0 ? "" : styles.map((s) => s.code).join("\0");
    let id = this.ids.get(key);
    if (id === undefined) {
      const rawId = this.styles.length;
      if (rawId > 16383) {
        if (!this.overflowWarned) {
          this.overflowWarned = true;
          emitDiagnosticOutput(
            `StylePool exhausted 16383 unique styles — further style combinations render unstyled to avoid packed-cell aliasing`,
            { level: "warn" },
          );
        }
        return this.none;
      }
      this.styles.push(styles.length === 0 ? [] : styles);
      id = (rawId << 1) | (styles.length > 0 && hasVisibleSpaceEffect(styles) ? 1 : 0);
      this.ids.set(key, id);
    }
    return id;
  }

  get(id: number): AnsiCode[] {
    return this.styles[id >>> 1] ?? [];
  }

  transition(fromId: number, toId: number): string {
    if (fromId === toId) return "";
    const key = fromId * 0x100000 + toId;
    let str = this.transitionCache.get(key);
    if (str === undefined) {
      if (this.transitionCache.size >= 8192) {
        this.transitionCache.clear();
      }
      const fromCodes = this.get(fromId);
      const toCodes = this.get(toId);
      str =
        fixBoldDimTransition(fromCodes, toCodes) +
        ansiCodesToString(diffAnsiCodes(fromCodes, toCodes));
      this.transitionCache.set(key, str);
    }
    return str;
  }

  compact(): (styleId: number) => number {
    const oldStyles = this.styles;
    this.ids = new Map();
    this.styles = [];
    this.transitionCache.clear();
    this.overflowWarned = false;
    this.generationCount++;
    this.intern([]);

    const mapping = new Int32Array(oldStyles.length).fill(-1);
    return (oldStyleId: number) => {
      const oldRawId = oldStyleId >>> 1;
      const cached = mapping[oldRawId];
      if (cached !== undefined && cached !== -1) return cached;

      const codes = oldStyles[oldRawId] ?? [];
      const newStyleId = this.intern(codes);
      if (oldRawId < mapping.length) {
        mapping[oldRawId] = newStyleId;
      }
      return newStyleId;
    };
  }
}

const VISIBLE_ON_SPACE = new Set(["\x1b[49m", "\x1b[27m", "\x1b[24m", "\x1b[29m", "\x1b[55m"]);

function hasVisibleSpaceEffect(styles: AnsiCode[]): boolean {
  for (const style of styles) {
    if (VISIBLE_ON_SPACE.has(style.endCode)) return true;
  }
  return false;
}

export enum CellWidth {
  Narrow = 0,

  Wide = 1,

  SpacerTail = 2,

  SpacerHead = 3,
}

export enum SoftWrapType {
  HardBreak = 0,
  Continuation = 1,
  ContinuationElidedSep = 2,
}

export enum SoftWrap {
  SW_START_MASK = 0x7fff,
  SW_ELIDED_SEP = 0x8000,
}

export function packSoftWrap(prevEndCol: number, startCol: number, elidedSep = false): number {
  if (startCol > 32767) {
    emitDiagnosticOutput(
      `packSoftWrap: start column ${startCol} exceeds the 15-bit field; bit 15 is reserved for SW_ELIDED_SEP and will be corrupted`,
      { level: "error" },
    );
  }
  return (prevEndCol << 16) | (startCol & 0x7fff) | (elidedSep ? 0x8000 : 0);
}

export function unpackSoftWrapStart(packed: number): number {
  return packed & 0x7fff;
}

export function getRowWrapBounds(screen: Screen, row: number): { start: number; end: number } {
  const q = screen.softWrap[row] ?? 0;
  const K = row + 1 < screen.height ? (screen.softWrap[row + 1] ?? 0) : 0;
  return {
    start: q !== 0 ? q & 0x7fff : 0,
    end: K !== 0 ? K >>> 16 : screen.width,
  };
}

export type Hyperlink = string | undefined;

export type Cell = {
  char: string;
  styleId: number;
  width: CellWidth;
  hyperlink: Hyperlink;
};

const EMPTY_CHAR_INDEX = 0;
const SPACER_CHAR_INDEX = 1;

function initCharAscii(): Int32Array {
  const table = new Int32Array(128);
  table.fill(-1);
  table[32] = EMPTY_CHAR_INDEX;
  return table;
}

const STYLE_SHIFT = 17;
const HYPERLINK_SHIFT = 2;
const HYPERLINK_MASK = 0x7fff;
const WIDTH_MASK = 3;

function packWord1(styleId: number, hyperlinkId: number, width: number): number {
  return (styleId << STYLE_SHIFT) | (hyperlinkId << HYPERLINK_SHIFT) | width;
}

const EMPTY_CELL_VALUE = 0n;

export type Screen = Size & {
  cells: Int32Array;
  cells64: BigInt64Array;

  charPool: CharPool;
  hyperlinkPool: HyperlinkPool;

  emptyStyleId: number;

  damage: Rectangle | undefined;

  softWrap: Int32Array;
};

function isEmptyCellByIndex(screen: Screen, index: number): boolean {
  const ci = index << 1;
  return screen.cells[ci] === 0 && screen.cells[ci | 1] === 0;
}

export function isEmptyCellAt(screen: Screen, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) return true;
  return isEmptyCellByIndex(screen, y * screen.width + x);
}

export function isCellEmpty(screen: Screen, cell: Cell): boolean {
  return (
    cell.char === " " &&
    cell.styleId === screen.emptyStyleId &&
    cell.width === CellWidth.Narrow &&
    !cell.hyperlink
  );
}

export function fillScreenWithSpacers(screen: Screen): void {
  const cells = screen.cells;
  for (let ci = 0; ci < cells.length; ci += 2) {
    cells[ci] = SPACER_CHAR_INDEX;
  }
}

export function areScreensEqual(prev: Screen, next: Screen): boolean {
  if (prev.width !== next.width || prev.height !== next.height) return false;
  const len = prev.width * prev.height * 2;
  const prevCells = prev.cells;
  const nextCells = next.cells;
  for (let ci = 0; ci < len; ci++) {
    if (prevCells[ci] !== nextCells[ci]) return false;
  }
  return true;
}

function internHyperlink(screen: Screen, hyperlink: Hyperlink): number {
  return screen.hyperlinkPool.intern(hyperlink);
}

export function createScreen(
  width: number,
  height: number,
  styles: StylePool,
  charPool: CharPool,
  hyperlinkPool: HyperlinkPool,
): Screen {
  warn.warnIfNotInteger(width, "createScreen width");
  warn.warnIfNotInteger(height, "createScreen height");

  if (!Number.isInteger(width) || width < 0) {
    width = Math.max(0, Math.floor(width) || 0);
  }
  if (!Number.isInteger(height) || height < 0) {
    height = Math.max(0, Math.floor(height) || 0);
  }

  const size = width * height;

  const buf = new ArrayBuffer(size << 3);
  const cells = new Int32Array(buf);
  const cells64 = new BigInt64Array(buf);

  return {
    width,
    height,
    cells,
    cells64,
    charPool,
    hyperlinkPool,
    emptyStyleId: styles.none,
    damage: undefined,
    softWrap: new Int32Array(height),
  };
}

export function resetScreen(screen: Screen, width: number, height: number): void {
  warn.warnIfNotInteger(width, "resetScreen width");
  warn.warnIfNotInteger(height, "resetScreen height");

  if (!Number.isInteger(width) || width < 0) {
    width = Math.max(0, Math.floor(width) || 0);
  }
  if (!Number.isInteger(height) || height < 0) {
    height = Math.max(0, Math.floor(height) || 0);
  }

  const size = width * height;

  if (screen.cells64.length < size) {
    const buf = new ArrayBuffer(size << 3);
    screen.cells = new Int32Array(buf);
    screen.cells64 = new BigInt64Array(buf);
  }
  if (screen.softWrap.length < height) {
    screen.softWrap = new Int32Array(height);
  }

  screen.cells64.fill(EMPTY_CELL_VALUE, 0, size);
  screen.softWrap.fill(0, 0, height);

  screen.width = width;
  screen.height = height;

  screen.damage = undefined;
}

export function migrateScreenPools(
  screen: Screen,
  charPool: CharPool,
  hyperlinkPool: HyperlinkPool,
  migrateStyleId?: (styleId: number) => number,
): void {
  const oldCharPool = screen.charPool;
  const oldHyperlinkPool = screen.hyperlinkPool;
  const hasCharMigrate = oldCharPool !== charPool;
  const hasLinkMigrate = oldHyperlinkPool !== hyperlinkPool;
  if (!hasCharMigrate && !hasLinkMigrate && !migrateStyleId) return;

  const size = screen.width * screen.height;
  const cells = screen.cells;

  for (let ci = 0; ci < size << 1; ci += 2) {
    if (hasCharMigrate) {
      const oldCharId = cells[ci]!;
      cells[ci] = charPool.intern(oldCharPool.get(oldCharId));
    }
    const word1 = cells[ci + 1]!;
    const oldHyperlinkId = (word1 >>> HYPERLINK_SHIFT) & HYPERLINK_MASK;
    const oldStyleId = word1 >>> STYLE_SHIFT;

    const newHyperlinkId =
      hasLinkMigrate && oldHyperlinkId !== 0
        ? hyperlinkPool.intern(oldHyperlinkPool.get(oldHyperlinkId))
        : oldHyperlinkId;

    const newStyleId = migrateStyleId && oldStyleId !== 0 ? migrateStyleId(oldStyleId) : oldStyleId;

    if (newHyperlinkId !== oldHyperlinkId || newStyleId !== oldStyleId) {
      const width = word1 & WIDTH_MASK;
      cells[ci + 1] = packWord1(newStyleId, newHyperlinkId, width);
    }
  }

  screen.charPool = charPool;
  screen.hyperlinkPool = hyperlinkPool;
}

export function cellAt(screen: Screen, x: number, y: number): Cell | undefined {
  if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) return undefined;
  return cellAtIndex(screen, y * screen.width + x);
}

export function cellAtIndex(screen: Screen, index: number): Cell {
  const ci = index << 1;
  const word1 = screen.cells[ci + 1]!;
  const hid = (word1 >>> HYPERLINK_SHIFT) & HYPERLINK_MASK;
  return {
    char: screen.charPool.get(screen.cells[ci]!),
    styleId: word1 >>> STYLE_SHIFT,
    width: word1 & WIDTH_MASK,
    hyperlink: hid === 0 ? undefined : screen.hyperlinkPool.get(hid),
  };
}

export function visibleCellAtIndex(
  cells: Int32Array,
  charPool: CharPool,
  hyperlinkPool: HyperlinkPool,
  index: number,
  lastRenderedStyleId: number,
): Cell | undefined {
  const ci = index << 1;
  const charId = cells[ci]!;
  if (charId === 1) return undefined;
  const word1 = cells[ci + 1]!;

  if (charId === 0 && (word1 & 0x3fffc) === 0) {
    const fgStyle = word1 >>> STYLE_SHIFT;
    if (fgStyle === 0 || fgStyle === lastRenderedStyleId) return undefined;
  }
  const hid = (word1 >>> HYPERLINK_SHIFT) & HYPERLINK_MASK;
  return {
    char: charPool.get(charId),
    styleId: word1 >>> STYLE_SHIFT,
    width: word1 & WIDTH_MASK,
    hyperlink: hid === 0 ? undefined : hyperlinkPool.get(hid),
  };
}

function cellAtCI(screen: Screen, ci: number, out: Cell): void {
  const w1 = ci | 1;
  const word1 = screen.cells[w1]!;
  out.char = screen.charPool.get(screen.cells[ci]!);
  out.styleId = word1 >>> STYLE_SHIFT;
  out.width = word1 & WIDTH_MASK;
  const hid = (word1 >>> HYPERLINK_SHIFT) & HYPERLINK_MASK;
  out.hyperlink = hid === 0 ? undefined : screen.hyperlinkPool.get(hid);
}

export function charInCellAt(screen: Screen, x: number, y: number): string | undefined {
  if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) return undefined;
  const ci = (y * screen.width + x) << 1;
  return screen.charPool.get(screen.cells[ci]!);
}

export function setCellAt(screen: Screen, x: number, y: number, cell: Cell): void {
  if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) return;
  const ci = (y * screen.width + x) << 1;
  const cells = screen.cells;

  const prevWidth = cells[ci + 1]! & WIDTH_MASK;
  if (prevWidth === CellWidth.Wide && cell.width !== CellWidth.Wide) {
    const spacerX = x + 1;
    if (spacerX < screen.width) {
      const spacerCI = ci + 2;
      if ((cells[spacerCI + 1]! & WIDTH_MASK) === CellWidth.SpacerTail) {
        cells[spacerCI] = EMPTY_CHAR_INDEX;
        cells[spacerCI + 1] = packWord1(screen.emptyStyleId, 0, CellWidth.Narrow);
      }
    }
  }

  let clearedWideX = -1;
  if (prevWidth === CellWidth.SpacerTail && cell.width !== CellWidth.SpacerTail) {
    if (x > 0) {
      const wideCI = ci - 2;
      if ((cells[wideCI + 1]! & WIDTH_MASK) === CellWidth.Wide) {
        cells[wideCI] = EMPTY_CHAR_INDEX;
        cells[wideCI + 1] = packWord1(screen.emptyStyleId, 0, CellWidth.Narrow);
        clearedWideX = x - 1;
      }
    }
  }

  cells[ci] = internCharString(screen, cell.char);
  cells[ci + 1] = packWord1(cell.styleId, internHyperlink(screen, cell.hyperlink), cell.width);

  if (isMetricsActive()) {
    recordAtlasKey(cells[ci]!, cell.styleId);
  }

  const minX = clearedWideX >= 0 ? Math.min(x, clearedWideX) : x;
  const damage = screen.damage;
  if (damage) {
    const right = damage.x + damage.width;
    const bottom = damage.y + damage.height;
    if (minX < damage.x) {
      damage.width += damage.x - minX;
      damage.x = minX;
    } else if (x >= right) {
      damage.width = x - damage.x + 1;
    }
    if (y < damage.y) {
      damage.height += damage.y - y;
      damage.y = y;
    } else if (y >= bottom) {
      damage.height = y - damage.y + 1;
    }
  } else {
    screen.damage = { x: minX, y, width: x - minX + 1, height: 1 };
  }

  if (cell.width === CellWidth.Wide) {
    const spacerX = x + 1;
    if (spacerX < screen.width) {
      const spacerCI = ci + 2;

      if ((cells[spacerCI + 1]! & WIDTH_MASK) === CellWidth.Wide) {
        const orphanCI = spacerCI + 2;
        if (
          spacerX + 1 < screen.width &&
          (cells[orphanCI + 1]! & WIDTH_MASK) === CellWidth.SpacerTail
        ) {
          cells[orphanCI] = EMPTY_CHAR_INDEX;
          cells[orphanCI + 1] = packWord1(screen.emptyStyleId, 0, CellWidth.Narrow);
        }
      }
      cells[spacerCI] = SPACER_CHAR_INDEX;
      cells[spacerCI + 1] = packWord1(screen.emptyStyleId, 0, CellWidth.SpacerTail);

      const d = screen.damage;
      if (d && spacerX >= d.x + d.width) {
        d.width = spacerX - d.x + 1;
      }
    }
  }
}

function internCharString(screen: Screen, char: string): number {
  return screen.charPool.intern(char);
}

export function blitRegion(
  dst: Screen,
  src: Screen,
  regionX: number,
  regionY: number,
  maxX: number,
  maxY: number,
): void {
  regionX = Math.max(0, regionX);
  regionY = Math.max(0, regionY);
  if (regionX >= maxX || regionY >= maxY) return;

  const rowLen = maxX - regionX;
  const srcStride = src.width << 1;
  const dstStride = dst.width << 1;
  const rowBytes = rowLen << 1;
  const srcCells = src.cells;
  const dstCells = dst.cells;

  dst.softWrap.set(src.softWrap.subarray(regionY, maxY), regionY);

  if (regionX === 0 && maxX === src.width && src.width === dst.width) {
    const srcStart = regionY * srcStride;
    const totalBytes = (maxY - regionY) * srcStride;
    dstCells.set(srcCells.subarray(srcStart, srcStart + totalBytes), srcStart);
  } else {
    let srcRowCI = regionY * srcStride + (regionX << 1);
    let dstRowCI = regionY * dstStride + (regionX << 1);
    for (let y = regionY; y < maxY; y++) {
      dstCells.set(srcCells.subarray(srcRowCI, srcRowCI + rowBytes), dstRowCI);
      srcRowCI += srcStride;
      dstRowCI += dstStride;
    }
  }

  const checkLeft = regionX > 0;
  const checkRight = maxX < dst.width;
  let damageLeftExt = false;
  let damageRightExt = 0;

  if (checkLeft || checkRight) {
    let leftEdgeDstCI = (regionY * dst.width + regionX - 1) << 1;
    let rightEdgeDstCI = (regionY * dst.width + maxX - 1) << 1;
    for (let y = regionY; y < maxY; y++) {
      if (checkLeft) {
        const word1AtRegionX = dstCells[leftEdgeDstCI + 3]!;
        const widthAtRegionX = word1AtRegionX & WIDTH_MASK;
        if ((dstCells[leftEdgeDstCI + 1]! & WIDTH_MASK) === CellWidth.Wide) {
          if (widthAtRegionX !== CellWidth.SpacerTail) {
            dstCells[leftEdgeDstCI] = EMPTY_CHAR_INDEX;
            dstCells[leftEdgeDstCI + 1] = packWord1(dst.emptyStyleId, 0, CellWidth.Narrow);
            damageLeftExt = true;
          }
        } else if (widthAtRegionX === CellWidth.SpacerTail) {
          dstCells[leftEdgeDstCI + 2] = EMPTY_CHAR_INDEX;
          dstCells[leftEdgeDstCI + 3] = packWord1(dst.emptyStyleId, 0, CellWidth.Narrow);
        }
      }
      if (checkRight) {
        if ((dstCells[rightEdgeDstCI + 1]! & WIDTH_MASK) === CellWidth.Wide) {
          if (
            maxX + 1 < dst.width &&
            (dstCells[rightEdgeDstCI + 3]! & WIDTH_MASK) === CellWidth.Wide &&
            (dstCells[rightEdgeDstCI + 5]! & WIDTH_MASK) === CellWidth.SpacerTail
          ) {
            dstCells[rightEdgeDstCI + 4] = EMPTY_CHAR_INDEX;
            dstCells[rightEdgeDstCI + 5] = packWord1(dst.emptyStyleId, 0, CellWidth.Narrow);
            damageRightExt = 2;
          } else if (damageRightExt < 1) {
            damageRightExt = 1;
          }
          dstCells[rightEdgeDstCI + 2] = SPACER_CHAR_INDEX;
          dstCells[rightEdgeDstCI + 3] = packWord1(dst.emptyStyleId, 0, CellWidth.SpacerTail);
        } else if ((dstCells[rightEdgeDstCI + 3]! & WIDTH_MASK) === CellWidth.SpacerTail) {
          dstCells[rightEdgeDstCI + 2] = EMPTY_CHAR_INDEX;
          dstCells[rightEdgeDstCI + 3] = packWord1(dst.emptyStyleId, 0, CellWidth.Narrow);
          if (damageRightExt < 1) {
            damageRightExt = 1;
          }
        }
      }
      leftEdgeDstCI += dstStride;
      rightEdgeDstCI += dstStride;
    }
  }

  const damageMinX = damageLeftExt ? regionX - 1 : regionX;
  const damageMaxX = maxX + damageRightExt;
  const regionRect = {
    x: damageMinX,
    y: regionY,
    width: damageMaxX - damageMinX,
    height: maxY - regionY,
  };
  if (dst.damage) {
    dst.damage = unionRect(dst.damage, regionRect);
  } else {
    dst.damage = regionRect;
  }
}

export function clearRegion(
  screen: Screen,
  regionX: number,
  regionY: number,
  regionWidth: number,
  regionHeight: number,
): void {
  const startX = Math.max(0, regionX);
  const startY = Math.max(0, regionY);
  const maxX = Math.min(regionX + regionWidth, screen.width);
  const maxY = Math.min(regionY + regionHeight, screen.height);
  if (startX >= maxX || startY >= maxY) return;

  const cells = screen.cells;
  const cells64 = screen.cells64;
  const screenWidth = screen.width;
  const rowBase = startY * screenWidth;
  let damageMinX = startX;
  let damageMaxX = maxX;

  if (startX === 0 && maxX === screenWidth) {
    cells64.fill(EMPTY_CELL_VALUE, rowBase, rowBase + (maxY - startY) * screenWidth);
  } else {
    const stride = screenWidth << 1;
    const rowLen = maxX - startX;
    const checkLeft = startX > 0;
    const checkRight = maxX < screenWidth;
    let leftEdge = (rowBase + startX) << 1;
    let rightEdge = (rowBase + maxX - 1) << 1;
    let fillStart = rowBase + startX;

    for (let y = startY; y < maxY; y++) {
      if (checkLeft) {
        if ((cells[leftEdge + 1]! & WIDTH_MASK) === CellWidth.SpacerTail) {
          const prevW1 = leftEdge - 1;
          if ((cells[prevW1]! & WIDTH_MASK) === CellWidth.Wide) {
            cells[prevW1 - 1] = EMPTY_CHAR_INDEX;
            cells[prevW1] = packWord1(screen.emptyStyleId, 0, CellWidth.Narrow);
            damageMinX = startX - 1;
          }
        }
      }

      if (checkRight) {
        if ((cells[rightEdge + 1]! & WIDTH_MASK) === CellWidth.Wide) {
          const nextW1 = rightEdge + 3;
          if ((cells[nextW1]! & WIDTH_MASK) === CellWidth.SpacerTail) {
            cells[nextW1 - 1] = EMPTY_CHAR_INDEX;
            cells[nextW1] = packWord1(screen.emptyStyleId, 0, CellWidth.Narrow);
            damageMaxX = maxX + 1;
          }
        }
      }

      cells64.fill(EMPTY_CELL_VALUE, fillStart, fillStart + rowLen);
      leftEdge += stride;
      rightEdge += stride;
      fillStart += screenWidth;
    }
  }

  const regionRect = {
    x: damageMinX,
    y: startY,
    width: damageMaxX - damageMinX,
    height: maxY - startY,
  };
  if (screen.damage) {
    screen.damage = unionRect(screen.damage, regionRect);
  } else {
    screen.damage = regionRect;
  }
}

const OSC8_REGEX = new RegExp(`^${ESC}\\]8${SEP}${SEP}([^${BEL}]*)${BEL}$`);

export const OSC8_PREFIX = `${ESC}]8${SEP}`;

export function extractHyperlinkFromStyles(styles: AnsiCode[]): Hyperlink | null {
  for (const style of styles) {
    const code = style.code;
    if (code.length < 5 || !code.startsWith(OSC8_PREFIX)) continue;
    const match = code.match(OSC8_REGEX);
    if (match) {
      return match[1] || null;
    }
  }
  return null;
}

export function filterOutHyperlinkStyles(styles: AnsiCode[]): AnsiCode[] {
  return styles.filter(
    (style) => !style.code.startsWith(OSC8_PREFIX) || !OSC8_REGEX.test(style.code),
  );
}

export function diff(
  prev: Screen,
  next: Screen,
): [point: Point, removed: Cell | undefined, added: Cell | undefined][] {
  const output: [Point, Cell | undefined, Cell | undefined][] = [];
  diffEach(prev, next, (x, y, removed, added) => {
    output.push([{ x, y }, removed ? { ...removed } : undefined, added ? { ...added } : undefined]);
  });
  return output;
}

type DiffCallback = (
  x: number,
  y: number,
  removed: Cell | undefined,
  added: Cell | undefined,
) => boolean | void;

export function diffEach(prev: Screen, next: Screen, cb: DiffCallback): boolean {
  const prevWidth = prev.width;
  const nextWidth = next.width;
  const prevHeight = prev.height;
  const nextHeight = next.height;

  let region: Rectangle;
  if (prevWidth === 0 && prevHeight === 0) {
    region = { x: 0, y: 0, width: nextWidth, height: nextHeight };
  } else if (next.damage) {
    region = next.damage;
    if (prev.damage) {
      region = unionRect(region, prev.damage);
    }
  } else if (prev.damage) {
    region = prev.damage;
  } else {
    region = { x: 0, y: 0, width: 0, height: 0 };
  }

  if (prevHeight > nextHeight) {
    region = unionRect(region, {
      x: 0,
      y: nextHeight,
      width: prevWidth,
      height: prevHeight - nextHeight,
    });
  }
  if (prevWidth > nextWidth) {
    region = unionRect(region, {
      x: nextWidth,
      y: 0,
      width: prevWidth - nextWidth,
      height: prevHeight,
    });
  }

  const maxHeight = Math.max(prevHeight, nextHeight);
  const maxWidth = Math.max(prevWidth, nextWidth);
  const endY = Math.min(region.y + region.height, maxHeight);
  const endX = Math.min(region.x + region.width, maxWidth);

  if (prevWidth === nextWidth) {
    return diffSameWidth(prev, next, region.x, endX, region.y, endY, cb);
  }
  return diffDifferentWidth(prev, next, region.x, endX, region.y, endY, cb);
}

function findNextDiff(a: Int32Array, b: Int32Array, w0: number, count: number): number {
  for (let i = 0; i < count; i++, w0 += 2) {
    const w1 = w0 | 1;
    if (a[w0] !== b[w0] || a[w1] !== b[w1]) return i;
  }
  return count;
}

function diffRowBoth(
  prevCells: Int32Array,
  nextCells: Int32Array,
  prev: Screen,
  next: Screen,
  ci: number,
  y: number,
  startX: number,
  endX: number,
  prevCell: Cell,
  nextCell: Cell,
  cb: DiffCallback,
): boolean {
  let x = startX;
  while (x < endX) {
    const skip = findNextDiff(prevCells, nextCells, ci, endX - x);
    x += skip;
    ci += skip << 1;
    if (x >= endX) break;
    cellAtCI(prev, ci, prevCell);
    cellAtCI(next, ci, nextCell);
    if (cb(x, y, prevCell, nextCell)) return true;
    x++;
    ci += 2;
  }
  return false;
}

function diffRowRemoved(
  prev: Screen,
  ci: number,
  y: number,
  startX: number,
  endX: number,
  prevCell: Cell,
  cb: DiffCallback,
): boolean {
  for (let x = startX; x < endX; x++, ci += 2) {
    cellAtCI(prev, ci, prevCell);
    if (cb(x, y, prevCell, undefined)) return true;
  }
  return false;
}

function diffRowAdded(
  nextCells: Int32Array,
  next: Screen,
  ci: number,
  y: number,
  startX: number,
  endX: number,
  nextCell: Cell,
  cb: DiffCallback,
): boolean {
  for (let x = startX; x < endX; x++, ci += 2) {
    if (nextCells[ci] === 0 && nextCells[ci | 1] === 0) continue;
    cellAtCI(next, ci, nextCell);
    if (cb(x, y, undefined, nextCell)) return true;
  }
  return false;
}

function diffSameWidth(
  prev: Screen,
  next: Screen,
  startX: number,
  endX: number,
  startY: number,
  endY: number,
  cb: DiffCallback,
): boolean {
  const prevCells = prev.cells;
  const nextCells = next.cells;
  const width = prev.width;
  const prevHeight = prev.height;
  const nextHeight = next.height;
  const stride = width << 1;

  const prevCell: Cell = {
    char: " ",
    styleId: 0,
    width: CellWidth.Narrow,
    hyperlink: undefined,
  };
  const nextCell: Cell = {
    char: " ",
    styleId: 0,
    width: CellWidth.Narrow,
    hyperlink: undefined,
  };

  const rowEndX = Math.min(endX, width);
  let rowCI = (startY * width + startX) << 1;

  for (let y = startY; y < endY; y++) {
    const prevIn = y < prevHeight;
    const nextIn = y < nextHeight;

    if (prevIn && nextIn) {
      if (
        diffRowBoth(
          prevCells,
          nextCells,
          prev,
          next,
          rowCI,
          y,
          startX,
          rowEndX,
          prevCell,
          nextCell,
          cb,
        )
      )
        return true;
    } else if (prevIn) {
      if (diffRowRemoved(prev, rowCI, y, startX, rowEndX, prevCell, cb)) return true;
    } else if (nextIn) {
      if (diffRowAdded(nextCells, next, rowCI, y, startX, rowEndX, nextCell, cb)) return true;
    }

    rowCI += stride;
  }

  return false;
}

function diffDifferentWidth(
  prev: Screen,
  next: Screen,
  startX: number,
  endX: number,
  startY: number,
  endY: number,
  cb: DiffCallback,
): boolean {
  const prevWidth = prev.width;
  const nextWidth = next.width;
  const prevCells = prev.cells;
  const nextCells = next.cells;

  const prevCell: Cell = {
    char: " ",
    styleId: 0,
    width: CellWidth.Narrow,
    hyperlink: undefined,
  };
  const nextCell: Cell = {
    char: " ",
    styleId: 0,
    width: CellWidth.Narrow,
    hyperlink: undefined,
  };

  const prevStride = prevWidth << 1;
  const nextStride = nextWidth << 1;
  let prevRowCI = (startY * prevWidth + startX) << 1;
  let nextRowCI = (startY * nextWidth + startX) << 1;

  for (let y = startY; y < endY; y++) {
    const prevIn = y < prev.height;
    const nextIn = y < next.height;
    const prevEndX = prevIn ? Math.min(endX, prevWidth) : startX;
    const nextEndX = nextIn ? Math.min(endX, nextWidth) : startX;
    const bothEndX = Math.min(prevEndX, nextEndX);

    let prevCI = prevRowCI;
    let nextCI = nextRowCI;

    for (let x = startX; x < bothEndX; x++) {
      if (
        prevCells[prevCI] === nextCells[nextCI] &&
        prevCells[prevCI + 1] === nextCells[nextCI + 1]
      ) {
        prevCI += 2;
        nextCI += 2;
        continue;
      }
      cellAtCI(prev, prevCI, prevCell);
      cellAtCI(next, nextCI, nextCell);
      prevCI += 2;
      nextCI += 2;
      if (cb(x, y, prevCell, nextCell)) return true;
    }

    if (prevEndX > bothEndX) {
      prevCI = prevRowCI + ((bothEndX - startX) << 1);
      for (let x = bothEndX; x < prevEndX; x++) {
        cellAtCI(prev, prevCI, prevCell);
        prevCI += 2;
        if (cb(x, y, prevCell, undefined)) return true;
      }
    }

    if (nextEndX > bothEndX) {
      nextCI = nextRowCI + ((bothEndX - startX) << 1);
      for (let x = bothEndX; x < nextEndX; x++) {
        if (nextCells[nextCI] === 0 && nextCells[nextCI | 1] === 0) {
          nextCI += 2;
          continue;
        }
        cellAtCI(next, nextCI, nextCell);
        nextCI += 2;
        if (cb(x, y, undefined, nextCell)) return true;
      }
    }

    prevRowCI += prevStride;
    nextRowCI += nextStride;
  }

  return false;
}

export { default as DrawingOps } from "@/terminal-runtime/paint/line-composer.js";

const SGR_RESET = "\x1b[0m";

const OSC8_CLOSE = `${ESC}]8${SEP}${SEP}${BEL}`;

function openHyperlink(uri: string): string {
  return `${ESC}]8${SEP}${SEP}${uri}${BEL}`;
}

export function rowToString(screen: Screen, stylePool: StylePool, row: number): string {
  const width = screen.width;
  const rowBase = row * width;
  let lastVisible = -1;

  for (let col = width - 1; col >= 0; col--) {
    const cell = cellAtIndex(screen, rowBase + col);
    if (cell.width === CellWidth.SpacerTail) continue;
    if (cell.char === " " && (cell.styleId & 1) === 0 && cell.hyperlink === undefined) {
      continue;
    }
    lastVisible = col;
    break;
  }

  if (lastVisible < 0) return "";

  let out = "";
  let prevStyleId = stylePool.none;
  let prevHyperlink: Hyperlink;

  for (let col = 0; col <= lastVisible; col++) {
    const cell = cellAtIndex(screen, rowBase + col);
    if (cell.width === CellWidth.SpacerTail || cell.width === CellWidth.SpacerHead) {
      continue;
    }
    if (cell.hyperlink !== prevHyperlink) {
      if (prevHyperlink !== undefined) out += OSC8_CLOSE;
      if (cell.hyperlink !== undefined) out += openHyperlink(cell.hyperlink);
      prevHyperlink = cell.hyperlink;
    }
    out += stylePool.transition(prevStyleId, cell.styleId);
    prevStyleId = cell.styleId;
    out += cell.char;
  }

  if (prevHyperlink !== undefined) out += OSC8_CLOSE;
  if (prevStyleId !== stylePool.none) out += SGR_RESET;
  return out;
}
