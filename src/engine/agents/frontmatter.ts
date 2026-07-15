export type ToolsField = { kind: "wildcard" } | { kind: "list"; tools: string[] };

export interface ModelOverride {
  model: string;
  effort?: string;
}

export interface ParsedHookEntry {
  matcher: string;
  type?: "command" | "prompt";
  command?: string;
  prompt?: string;
  timeoutMs?: number;
}

export type ParsedHooks = Record<string, ParsedHookEntry[]>;

export interface Parsed {
  fields: Record<string, string>;
  tools: ToolsField | null;
  disallowedTools: string[] | null;
  model: Record<string, ModelOverride>;
  mcpServers: string[] | null;
  skills: string[] | null;
  hooks: ParsedHooks | null;
  body: string;
}

export class FrontmatterError extends Error {}

export function hasFrontmatterFence(src: string): boolean {
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  return firstLine.trim() === "---";
}

export function parseFrontmatter(src: string): Parsed {
  const fields: Record<string, string> = {};
  let tools: ToolsField | null = null;
  let disallowedTools: string[] | null = null;
  let mcpServers: string[] | null = null;
  let skills: string[] | null = null;
  let hooks: ParsedHooks | null = null;
  const modelMap: Record<string, ModelOverride> = {};

  const normalized = src.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length === 0 || lines[0]?.trim() !== "---") {
    throw new FrontmatterError("missing opening `---` fence");
  }

  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) throw new FrontmatterError("missing closing `---` fence");

  const fmLines = lines.slice(1, closeIdx);
  const body = lines
    .slice(closeIdx + 1)
    .join("\n")
    .replace(/^\n+/, "");

  let i = 0;
  while (i < fmLines.length) {
    const raw = fmLines[i] ?? "";
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      i += 1;
      continue;
    }
    const colon = trimmed.indexOf(":");
    if (colon < 0) throw new FrontmatterError(`malformed line: ${trimmed}`);
    const key = trimmed.slice(0, colon).trim();
    const rest = trimmed.slice(colon + 1).trim();

    if (key === "model" && rest.length === 0) {
      i += 1;
      while (i < fmLines.length) {
        const outer = fmLines[i] ?? "";
        if (!outer.startsWith(" ") && !outer.startsWith("\t")) break;
        const outerTrim = outer.trim();
        if (outerTrim.length === 0) {
          i += 1;
          continue;
        }
        const cOuter = outerTrim.indexOf(":");
        if (cOuter < 0) break;
        const provKey = outerTrim.slice(0, cOuter).trim();
        const inlineVal = unquote(outerTrim.slice(cOuter + 1).trim());
        const outerIndent = outer.length - outer.trimStart().length;
        i += 1;
        if (inlineVal.length > 0) {
          const parts = inlineVal.split(/\s+/);
          const model = parts[0];
          const effort = parts[1];
          if (model) modelMap[provKey] = effort ? { model, effort } : { model };
          continue;
        }
        let model: string | undefined;
        let effort: string | undefined;
        while (i < fmLines.length) {
          const nested = fmLines[i] ?? "";
          const nestedIndent = nested.length - nested.trimStart().length;
          if (nestedIndent <= outerIndent) break;
          const nestedTrim = nested.trim();
          if (nestedTrim.length === 0) {
            i += 1;
            continue;
          }
          const cn = nestedTrim.indexOf(":");
          if (cn < 0) break;
          const subKey = nestedTrim.slice(0, cn).trim();
          const subVal = unquote(nestedTrim.slice(cn + 1).trim());
          if (subKey === "model") model = subVal;
          else if (subKey === "effort") effort = subVal;
          i += 1;
        }
        if (model) modelMap[provKey] = effort ? { model, effort } : { model };
      }
      continue;
    }

    if (key === "disallowedTools") {
      const list = parseToolList(rest, fmLines, i);
      disallowedTools = list.values;
      i = list.nextIdx;
      continue;
    }

    if (key === "mcpServers") {
      const list = parseToolList(rest, fmLines, i);
      mcpServers = list.values;
      i = list.nextIdx;
      continue;
    }

    if (key === "skills") {
      const list = parseToolList(rest, fmLines, i);
      skills = list.values;
      i = list.nextIdx;
      continue;
    }

    if (key === "hooks" && rest.length === 0) {
      const parsed = parseHooksBlock(fmLines, i);
      hooks = parsed.hooks;
      i = parsed.nextIdx;
      continue;
    }

    if (key === "tools" || key === "allowedTools") {
      if (rest.length === 0) {
        const list: string[] = [];
        i += 1;
        while (i < fmLines.length) {
          const inner = fmLines[i]?.trim() ?? "";
          if (inner.length === 0) break;
          if (inner.startsWith("-")) {
            list.push(unquote(inner.slice(1).trim()));
            i += 1;
          } else break;
        }
        tools = { kind: "list", tools: list };
        continue;
      }
      const val = unquote(rest);
      if (val === "*") tools = { kind: "wildcard" };
      else if (val.startsWith("[") && val.endsWith("]")) {
        const inner = val.slice(1, -1);
        tools = {
          kind: "list",
          tools: inner
            .split(",")
            .map((s) => unquote(s.trim()))
            .filter((s) => s.length > 0),
        };
      } else if (val.includes(",")) {
        tools = {
          kind: "list",
          tools: val
            .split(",")
            .map((s) => unquote(s.trim()))
            .filter((s) => s.length > 0),
        };
      } else {
        throw new FrontmatterError(`unrecognized tools value: ${val}`);
      }
      i += 1;
      continue;
    }

    if (rest.length === 0) {
      const captured: string[] = [];
      i += 1;
      while (i < fmLines.length) {
        const inner = fmLines[i] ?? "";
        const innerTrim = inner.trim();
        if (innerTrim.length === 0) {
          i += 1;
          continue;
        }
        const indented = inner.startsWith(" ") || inner.startsWith("\t");
        if (!indented && !innerTrim.startsWith("-")) break;
        captured.push(innerTrim);
        i += 1;
      }
      fields[key] = captured.join("\n");
      continue;
    }

    fields[key] = unquote(rest);
    i += 1;
  }

  return { fields, tools, disallowedTools, model: modelMap, mcpServers, skills, hooks, body };
}

function parseHooksBlock(
  fmLines: string[],
  startIdx: number,
): { hooks: ParsedHooks; nextIdx: number } {
  const hooks: ParsedHooks = {};
  let i = startIdx + 1;
  while (i < fmLines.length) {
    const eventLine = fmLines[i] ?? "";
    if (!eventLine.startsWith(" ") && !eventLine.startsWith("\t")) break;
    const eventTrim = eventLine.trim();
    if (eventTrim.length === 0) {
      i += 1;
      continue;
    }
    const eventColon = eventTrim.indexOf(":");
    if (eventColon < 0 || eventTrim.startsWith("-")) break;
    const eventName = eventTrim.slice(0, eventColon).trim();
    const eventIndent = eventLine.length - eventLine.trimStart().length;
    i += 1;
    const entries: ParsedHookEntry[] = [];
    let current: ParsedHookEntry | null = null;
    while (i < fmLines.length) {
      const line = fmLines[i] ?? "";
      const trim = line.trim();
      if (trim.length === 0) {
        i += 1;
        continue;
      }
      const indent = line.length - line.trimStart().length;
      if (indent <= eventIndent) break;
      if (trim.startsWith("-")) {
        if (current) entries.push(current);
        current = { matcher: "*" };
        const inline = trim.slice(1).trim();
        if (inline.length > 0) applyHookField(current, inline);
      } else if (current) {
        applyHookField(current, trim);
      }
      i += 1;
    }
    if (current) entries.push(current);
    if (entries.length > 0) hooks[eventName] = entries;
  }
  return { hooks, nextIdx: i };
}

function applyHookField(entry: ParsedHookEntry, line: string): void {
  const colon = line.indexOf(":");
  if (colon < 0) return;
  const key = line.slice(0, colon).trim();
  const value = unquote(line.slice(colon + 1).trim());
  if (key === "matcher") entry.matcher = value;
  else if (key === "command") {
    entry.command = value;
    if (entry.type === undefined) entry.type = "command";
  } else if (key === "prompt") {
    entry.prompt = value;
    entry.type = "prompt";
  } else if (key === "type" && (value === "command" || value === "prompt")) entry.type = value;
  else if (key === "timeout") {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) entry.timeoutMs = n * 1000;
  } else if (key === "timeoutMs") {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) entry.timeoutMs = n;
  }
}

function parseToolList(
  rest: string,
  fmLines: string[],
  startIdx: number,
): { values: string[]; nextIdx: number } {
  if (rest.length === 0) {
    const list: string[] = [];
    let i = startIdx + 1;
    while (i < fmLines.length) {
      const inner = fmLines[i]?.trim() ?? "";
      if (inner.length === 0) break;
      if (inner.startsWith("-")) {
        list.push(unquote(inner.slice(1).trim()));
        i += 1;
      } else break;
    }
    return { values: list, nextIdx: i };
  }
  const val = unquote(rest);
  if (val.startsWith("[") && val.endsWith("]")) {
    const inner = val.slice(1, -1);
    return {
      values: inner
        .split(",")
        .map((s) => unquote(s.trim()))
        .filter((s) => s.length > 0),
      nextIdx: startIdx + 1,
    };
  }
  if (val.includes(",")) {
    return {
      values: val
        .split(",")
        .map((s) => unquote(s.trim()))
        .filter((s) => s.length > 0),
      nextIdx: startIdx + 1,
    };
  }
  return { values: [val], nextIdx: startIdx + 1 };
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1);
    }
  }
  return t;
}
