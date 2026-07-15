import { basename, extname } from "node:path";

export interface Span {
  text: string;
  scope?: string;
}

interface HljsNode {
  scope?: string;
  kind?: string;
  children: (HljsNode | string)[];
}

interface HljsHighlightResult {
  emitter?: { rootNode?: HljsNode } & Record<string, unknown>;
  _emitter?: { rootNode?: HljsNode } & Record<string, unknown>;
}

interface HljsApi {
  highlight(
    code: string,
    options: { language: string; ignoreIllegals?: boolean },
  ): HljsHighlightResult;
  getLanguage(name: string): unknown;
}

let cached: HljsApi | null = null;

function load(): HljsApi {
  if (cached) return cached;
  const mod = require("highlight.js") as HljsApi & { default?: HljsApi };
  cached = mod.default ?? mod;
  return cached as HljsApi;
}

const FILENAME_LANGS: Record<string, string> = {
  Dockerfile: "dockerfile",
  Makefile: "makefile",
  Rakefile: "ruby",
  Gemfile: "ruby",
  CMakeLists: "cmake",
};

export function detectLanguage(filePath: string): string | null {
  if (!filePath) return null;
  const hl = load();
  const base = basename(filePath);
  const stem = base.split("..")[0] ?? "";
  const ext = extname(filePath).slice(1);
  const direct = FILENAME_LANGS[base] ?? FILENAME_LANGS[stem];
  if (direct && hl.getLanguage(direct)) return direct;
  if (ext && hl.getLanguage(ext)) return ext;
  return null;
}

function flatten(node: HljsNode | string, inheritedScope: string | undefined, out: Span[]): void {
  if (typeof node === "string") {
    if (node.length > 0) {
      const span: Span = { text: node };
      if (inheritedScope !== undefined) span.scope = inheritedScope;
      out.push(span);
    }
    return;
  }
  const scope = node.scope ?? node.kind ?? inheritedScope;
  for (const child of node.children) flatten(child, scope, out);
}

const TOKENIZE_CACHE_CAP = 500;
// Keyed by hash so the cache never holds a second full copy of the source as key.
const tokenizeCache = new Map<string, Span[]>();

function cacheKeyFor(code: string, language: string): string {
  return `${language}:${Bun.hash(code).toString(36)}`;
}

export function tokenize(code: string, language: string | null): Span[] {
  if (!language) return [{ text: code }];
  const hl = load();
  if (!hl.getLanguage(language)) return [{ text: code }];
  const cacheKey = cacheKeyFor(code, language);
  const hit = tokenizeCache.get(cacheKey);
  if (hit) {
    tokenizeCache.delete(cacheKey);
    tokenizeCache.set(cacheKey, hit);
    return hit;
  }
  let result: HljsHighlightResult;
  try {
    result = hl.highlight(code, { language, ignoreIllegals: true });
  } catch {
    return [{ text: code }];
  }
  const root = result.emitter?.rootNode ?? result._emitter?.rootNode;
  if (!root) return [{ text: code }];
  const out: Span[] = [];
  flatten(root, undefined, out);
  tokenizeCache.set(cacheKey, out);
  if (tokenizeCache.size > TOKENIZE_CACHE_CAP) {
    const oldest = tokenizeCache.keys().next().value;
    if (oldest !== undefined) tokenizeCache.delete(oldest);
  }
  return out;
}
