import { get as getAgent } from "@/engine/agents/registry.ts";
import { findModel } from "@/engine/model/catalog.ts";
import { filePathSegment } from "@/engine/tools/contract.ts";
import { parseSedEditCommand } from "@/engine/tools/index.ts";
import { detectHyperlinkCapability } from "@/ink";
import { osc8FileLink } from "@/ui/transcript/markdown/osc8.ts";
import { clipFlat } from "@/ui/transcript/tool-render/format.ts";

export const DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  WebFetch: "Fetch",
  WebSearch: "Web Search",
  NotebookEdit: "Edit Notebook",
  TaskStop: "Stop Task",
  TaskOutput: "Task Output",
  ListMcpResourcesTool: "listMcpResources",
  ReadMcpResourceTool: "readMcpResource",
  TaskCreate: "",
  TaskUpdate: "",
  TaskList: "",
  TaskGet: "",
  AskUserQuestion: "",
  EnterPlanMode: "",
  ExitPlanMode: "",
  ToolSearch: "",
};

export function displayNameFor(name: string, args: unknown): string {
  if (name === "Agent") {
    const sub = readString(args, "subagent_type");
    if (sub && sub !== "general-purpose" && sub !== "worker") {
      return getAgent(sub)?.name ?? sub;
    }
  }
  const override = DISPLAY_NAME_OVERRIDES[name];
  if (override !== undefined) return override;
  if (name.startsWith("mcp__")) {
    const rest = name.slice("mcp__".length);
    const sep = rest.indexOf("__");
    if (sep > 0) {
      const server = rest.slice(0, sep);
      const tool = rest.slice(sep + 2);
      return `${server} - ${tool} (MCP)`;
    }
    return `${rest} (MCP)`;
  }
  return name;
}

export function displayModelName(modelId: string): string {
  return findModel(modelId)?.displayName ?? modelId;
}

export function agentModelSuffix(
  name: string,
  args: unknown,
  providerShortKey: string,
  currentModel?: string,
): string | undefined {
  if (name !== "Agent") return undefined;
  const sub = readString(args, "subagent_type");
  if (!sub) return undefined;
  const def = getAgent(sub);
  if (!def) return undefined;
  const callOverride = readString(args, "model");
  const defOverride = def.model[providerShortKey];
  const modelId = callOverride ?? defOverride?.model ?? currentModel;
  if (!modelId || modelId === currentModel) return undefined;
  const m = findModel(modelId);
  return m?.displayName ?? modelId;
}

export function readString(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const v = (args as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

export function readNumber(args: unknown, key: string): number | undefined {
  if (!args || typeof args !== "object") return undefined;
  const v = (args as Record<string, unknown>)[key];
  return typeof v === "number" ? v : undefined;
}

export type ArgSegment = import("@/engine/tools/contract.ts").ToolArgSegment;

export function resolveArgSegments(
  hooks: import("@/engine/tools/contract.ts").ToolRenderHooks | undefined,
  name: string,
  args: unknown,
): ArgSegment[] {
  if (hooks?.summarizeArgSegments) return hooks.summarizeArgSegments(args);
  if (hooks?.summarizeArgs) return toSegments(hooks.summarizeArgs(args));
  return summarizeArgSegments(name, args);
}

export function segmentsText(segs: ArgSegment[]): string {
  return segs.map((s) => s.text).join("");
}

export function supportsHyperlinks(): boolean {
  if (process.env.NO_HYPERLINK || process.env.FORCE_HYPERLINK === "0") return false;
  if (process.env.FORCE_HYPERLINK === "1") return true;
  return detectHyperlinkCapability();
}

export function segmentsToAnsi(segs: ArgSegment[]): string {
  if (!supportsHyperlinks()) return segmentsText(segs);
  return segs
    .map((s) => (s.kind === "path" ? osc8FileLink({ path: s.path, label: s.text }) : s.text))
    .join("");
}

export function toSegments(s: string): ArgSegment[] {
  if (s.length === 0) return [];
  return [{ kind: "text", text: s }];
}

export function summarizeArgSegments(name: string, args: unknown): ArgSegment[] {
  if (!args || typeof args !== "object") return [];
  const obj = args as Record<string, unknown>;
  if (Object.keys(obj).length === 0) return [];
  if (name === "ToolSearch" || name.startsWith("Task")) return [];
  if (name.startsWith("mcp__")) return [];

  const fpField =
    readString(obj, "file_path") ?? readString(obj, "path") ?? readString(obj, "notebook_path");
  if (
    (name === "Read" || name === "Edit" || name === "Write" || name === "NotebookEdit") &&
    fpField
  ) {
    const out: ArgSegment[] = [];
    out.push(filePathSegment(fpField));
    if (name === "Read") {
      const pages = readString(obj, "pages");
      if (pages) {
        out.push({ kind: "text", text: ` · pages ${clipFlat(pages, 20)}` });
      } else {
        const offset = readNumber(obj, "offset");
        const limit = readNumber(obj, "limit");
        if (offset !== undefined && limit !== undefined) {
          out.push({
            kind: "text",
            text: ` · lines ${offset}-${offset + Math.max(0, limit - 1)}`,
          });
        } else if (offset !== undefined) {
          out.push({ kind: "text", text: ` · from line ${offset}` });
        } else if (limit !== undefined) {
          out.push({ kind: "text", text: ` · lines 1-${limit}` });
        }
      }
    } else if (name === "NotebookEdit") {
      const cell = readString(obj, "cell_id");
      if (cell) out.push({ kind: "text", text: `@${clipFlat(cell, 40)}` });
    }
    return out;
  }
  const flat = summarizeArgs(name, args);
  return flat.length === 0 ? [] : [{ kind: "text", text: flat }];
}

export function summarizeArgs(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const obj = args as Record<string, unknown>;
  if (Object.keys(obj).length === 0) return "";

  if (name === "ToolSearch" || name.startsWith("Task")) return "";
  if (name.startsWith("mcp__")) return "";

  if (name === "Bash") {
    const cmd = readString(obj, "command");
    if (cmd) {
      const sedInfo = parseSedEditCommand(cmd);
      if (sedInfo) return sedInfo.filePath;
      return clipFlat(cmd, 90);
    }
  }
  if (name === "Skill") {
    const s = readString(obj, "skill");
    if (s) return clipFlat(s, 60);
  }
  if (name === "Agent") {
    const s = readString(obj, "description");
    if (s) return clipFlat(s, 80);
  }
  if (name === "Read") {
    const fp = readString(obj, "file_path");
    if (fp) {
      let header = fp;
      const pages = readString(obj, "pages");
      if (pages) {
        header += ` · pages ${clipFlat(pages, 20)}`;
      } else {
        const offset = readNumber(obj, "offset");
        const limit = readNumber(obj, "limit");
        if (offset !== undefined && limit !== undefined) {
          header += ` · lines ${offset}-${offset + Math.max(0, limit - 1)}`;
        } else if (offset !== undefined) {
          header += ` · from line ${offset}`;
        } else if (limit !== undefined) {
          header += ` · lines 1-${limit}`;
        }
      }
      return header;
    }
  }
  if (name === "Edit" || name === "Write") {
    const fp = readString(obj, "file_path");
    if (fp) return fp;
  }
  if (name === "WebFetch") {
    const u = readString(obj, "url");
    if (u) return clipFlat(u, 100);
  }
  if (name === "WebSearch") {
    const q = readString(obj, "query");
    if (q) return `"${clipFlat(q, 100)}"`;
  }
  if (name === "NotebookEdit") {
    const path = readString(obj, "notebook_path") ?? "";
    const cell = readString(obj, "cell_id") ?? "";
    if (path && cell) return `${clipFlat(path, 70)}@${clipFlat(cell, 40)}`;
    if (path) return clipFlat(path, 80);
    if (cell) return `@${clipFlat(cell, 40)}`;
  }

  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj).slice(0, 2)) {
    let rendered: string;
    if (typeof v === "string") rendered = clipFlat(v, 60);
    else if (typeof v === "number" || typeof v === "boolean") rendered = String(v);
    else rendered = clipFlat(JSON.stringify(v), 40);
    parts.push(`${k}=${rendered}`);
  }
  return parts.join(", ");
}

export function bashHeaderCommand(args: unknown): string | null {
  const cmd = readString(args, "command");
  if (cmd === undefined || cmd.length === 0) return null;
  const sedInfo = parseSedEditCommand(cmd);
  if (sedInfo !== null) return sedInfo.filePath;
  return cmd;
}

export function resolveArgBody(options: {
  name: string;
  bashCommand: string | null;
  argSegments: ArgSegment[];
}): string {
  if (options.bashCommand !== null) {
    return options.bashCommand;
  }
  if (options.name === "Workflow") {
    // Verbose baseline renders the script verbatim inside the parens — no
    // post-processing. The script's own trailing newline (or lack of it)
    // decides whether the closing paren lands on its own line.
    return segmentsText(options.argSegments);
  }
  return segmentsToAnsi(options.argSegments);
}

export function formatNumberCompact(n: number): string {
  if (n < 1000) return String(n);
  const units: [number, string][] = [
    [1_000_000_000_000, "t"],
    [1_000_000_000, "b"],
    [1_000_000, "m"],
    [1_000, "k"],
  ];
  for (let i = 0; i < units.length; i++) {
    const tuple = units[i];
    if (!tuple) continue;
    const [div, suffix] = tuple;
    if (n >= div) {
      const scaled = n / div;
      const rounded = Math.round(scaled * 10) / 10;
      if (rounded >= 1000 && i > 0) {
        const previous = units[i - 1];
        if (!previous) continue;
        const pscaled = n / previous[0];
        const prounded = Math.round(pscaled * 10) / 10;
        return prounded % 1 === 0
          ? `${prounded}${previous[1]}`
          : `${prounded.toFixed(1)}${previous[1]}`;
      }
      return rounded % 1 === 0 ? `${rounded}${suffix}` : `${rounded.toFixed(1)}${suffix}`;
    }
  }
  return String(n);
}
