const MENTION_TRIGGER_RE =
  /(^|[\s\u3002\u3001\uFF1F\uFF01])@([\p{L}\p{N}\p{M}_\-./\\()[\]~:]*|"[^"]*"?)$/u;
const PATH_HEAD_RE = /^[\p{L}\p{N}\p{M}_\-./\\()[\]~:]+/u;
const MAX_SUGGESTIONS = 15;

export interface MentionSpan {
  start: number;
  end: number;
  query: string;
  quoted: boolean;
}

export interface MentionCandidate {
  id: string;
  kind: "file" | "agent";
  value: string;
  description?: string;
}

export interface MentionInsertion {
  text: string;
  caret: number;
}

export function mentionSpanAtCaret(
  text: string,
  caret: number,
  bashMode = false,
): MentionSpan | null {
  if (bashMode) return null;
  const before = text.slice(0, caret);
  const match = before.match(MENTION_TRIGGER_RE);
  if (!match || match.index === undefined) return null;
  const boundary = match[1] ?? "";
  const token = match[0].slice(boundary.length);
  const after = text.slice(caret);
  const quoted = token.startsWith('@"');
  const suffix = quoted
    ? (after.match(/^[^"]*"?/)?.[0] ?? "")
    : (after.match(PATH_HEAD_RE)?.[0] ?? "");
  const query = quoted ? token.slice(2).replace(/"$/, "") : token.slice(1);
  return {
    start: match.index + boundary.length,
    end: caret + suffix.length,
    query,
    quoted,
  };
}

export function fileMentionCandidates(paths: readonly string[]): MentionCandidate[] {
  const values = new Set<string>();
  for (const rawPath of paths) {
    const path = rawPath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
    if (path.length === 0) continue;
    values.add(path);
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      values.add(`${segments.slice(0, index).join("/")}/`);
    }
  }
  return [...values]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((value) => ({ id: `file-${value}`, kind: "file", value }));
}

export function agentMentionCandidate(input: {
  id: string;
  description: string;
}): MentionCandidate {
  return {
    id: `agent-${input.id}`,
    kind: "agent",
    value: `${input.id} (agent)`,
    description: input.description,
  };
}

export function mentionSuggestions(
  query: string,
  files: readonly MentionCandidate[],
  agents: readonly MentionCandidate[],
): MentionCandidate[] {
  if (query.length === 0) {
    return [...files.filter((candidate) => isTopLevel(candidate.value)), ...agents].slice(
      0,
      MAX_SUGGESTIONS,
    );
  }

  return [...files, ...agents]
    .map((candidate, order) => ({
      candidate,
      order,
      score: matchScore(candidate.value, query, candidate.kind === "file"),
    }))
    .filter((entry): entry is typeof entry & { score: number } => entry.score !== null)
    .sort((left, right) => left.score - right.score || left.order - right.order)
    .slice(0, MAX_SUGGESTIONS)
    .map((entry) => entry.candidate);
}

export function longestMentionPrefix(candidates: readonly MentionCandidate[]): string {
  const first = candidates[0]?.value ?? "";
  let prefix = first;
  for (const candidate of candidates.slice(1)) {
    let index = 0;
    while (
      index < prefix.length &&
      index < candidate.value.length &&
      prefix[index] === candidate.value[index]
    ) {
      index += 1;
    }
    prefix = prefix.slice(0, index);
    if (prefix.length === 0) break;
  }
  return prefix;
}

export function insertMentionPrefix(
  text: string,
  span: MentionSpan,
  prefix: string,
): MentionInsertion {
  const replacement = span.quoted ? `@"${prefix}"` : `@${prefix}`;
  return {
    text: text.slice(0, span.start) + replacement + text.slice(span.end),
    caret: span.start + replacement.length,
  };
}

export function insertMention(
  text: string,
  span: MentionSpan,
  candidate: MentionCandidate,
): MentionInsertion {
  const replacement = mentionReplacement(candidate);
  return {
    text: text.slice(0, span.start) + replacement + text.slice(span.end),
    caret: span.start + replacement.length,
  };
}

function isTopLevel(value: string): boolean {
  return !value.replace(/\/$/, "").includes("/");
}

function mentionReplacement(candidate: MentionCandidate): string {
  if (candidate.kind === "agent" || candidate.value.includes(" ")) {
    return `@"${candidate.value}" `;
  }
  return `@${candidate.value} `;
}

function matchScore(value: string, query: string, allowSubsequence: boolean): number | null {
  const haystack = value.toLowerCase();
  const needle = query.toLowerCase();
  const contiguous = haystack.indexOf(needle);
  if (contiguous >= 0) return contiguous * 4 + (haystack.length - needle.length) / 1_000;
  if (!allowSubsequence) return null;

  let previous = -1;
  let gaps = 0;
  for (const character of needle) {
    const found = haystack.indexOf(character, previous + 1);
    if (found < 0) return null;
    if (previous >= 0) gaps += found - previous - 1;
    previous = found;
  }
  return 100 + gaps * 4 + previous / 100 + haystack.length / 10_000;
}
