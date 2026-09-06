import { marked, type Token } from "marked";

const MARKDOWN_MARKERS = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /;
const PROBE_CODE_UNITS = 500;
const FULL_CACHE_KEY_LIMIT = 4096;
const KEY_EDGE_CODE_UNITS = 64;
const LEXER_CACHE_CAPACITY = 500;

const recentTokenTrees = new Map<string, Token[]>();

export function lexMarkdown(content: string): Token[] {
  if (isPlainText(content)) return plainParagraph(content);

  const cacheKey = identifyContent(content);
  const savedTokens = recentTokenTrees.get(cacheKey);
  if (savedTokens !== undefined) {
    recentTokenTrees.delete(cacheKey);
    recentTokenTrees.set(cacheKey, savedTokens);
    return savedTokens;
  }

  const parsedTokens = marked.lexer(content);
  makeRoomFor(cacheKey);
  recentTokenTrees.set(cacheKey, parsedTokens);
  return parsedTokens;
}

function isPlainText(content: string): boolean {
  const prefix = content.length > PROBE_CODE_UNITS ? content.slice(0, PROBE_CODE_UNITS) : content;
  return !MARKDOWN_MARKERS.test(prefix);
}

function plainParagraph(content: string): Token[] {
  const textToken = { type: "text", raw: content, text: content };
  return [
    {
      type: "paragraph",
      raw: content,
      text: content,
      tokens: [textToken],
    } as Token,
  ];
}

function identifyContent(content: string): string {
  if (content.length < FULL_CACHE_KEY_LIMIT) return content;
  const head = content.slice(0, KEY_EDGE_CODE_UNITS);
  const tail = content.slice(-KEY_EDGE_CODE_UNITS);
  return `${content.length}:${head}:${tail}`;
}

function makeRoomFor(incomingKey: string): void {
  if (recentTokenTrees.has(incomingKey) || recentTokenTrees.size < LEXER_CACHE_CAPACITY) return;
  const oldestKey = recentTokenTrees.keys().next().value;
  if (oldestKey !== undefined) recentTokenTrees.delete(oldestKey);
}
