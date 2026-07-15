import { basename, isAbsolute, join } from "node:path";
import { notify } from "@/design/bridge/envelope.ts";
import {
  AskDesignQuestionsTool,
  parseAskDesignQuestionsInput,
} from "@/design/capabilities/tools/AskDesignQuestions.ts";
import { UpdateTodosTool } from "@/design/capabilities/tools/UpdateTodos.ts";
import { designForkContextFor } from "@/design/fork-context.ts";
import { awaitQuestion } from "@/design/pending.ts";
import { DESIGN_SKILLS } from "@/design/skills.ts";
import { designStorageDir } from "@/design/storage.ts";
import { getProviderConfig } from "@/engine/contract/registry.ts";
import { canSendNatively } from "@/engine/model/capabilities-runtime.ts";
import { GenerateImage } from "@/engine/tools/builtins/generate-image.ts";
import {
  describeImageViaProvider,
  loadImageFromDisk,
} from "@/engine/tools/builtins/parse-image.ts";
import { WebFetch } from "@/engine/tools/builtins/webfetch.ts";
import type { ToolHandler } from "@/engine/tools/contract.ts";
import { invalid, parseInput } from "@/engine/tools/websearch/common.ts";
import { searchDuckDuckGo } from "@/engine/tools/websearch/duckduckgo.ts";
import { uuidv4 } from "@/kernel/std/id.ts";
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const AskDesignQuestionsToolHandler: ToolHandler = {
  schema: AskDesignQuestionsTool,
  isConcurrencySafe: false,
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    const input = parseAskDesignQuestionsInput(call.input);
    if (typeof input === "string") {
      return { tool_use_id: call.id, content: input, is_error: true };
    }
    const fork = designForkContextFor(ctx);
    if (!fork) {
      return {
        tool_use_id: call.id,
        content: "design fork context is unavailable",
        is_error: true,
      };
    }
    const requestId = uuidv4();
    fork.emit(
      notify("$/question-pending", {
        requestId,
        title: input.title,
        questions: input.questions,
      }),
    );
    const answer = await awaitQuestion(requestId, ctx.abortSignal);
    if (answer.length === 0) {
      return {
        tool_use_id: call.id,
        content: "(the user did not provide an answer)",
      };
    }

    let parsedAnswer: unknown;
    try {
      parsedAnswer = JSON.parse(answer);
    } catch {
      parsedAnswer = answer;
    }

    const mappedAnswers: Record<string, unknown> = {};

    if (input.questions.length === 1) {
      const q = input.questions[0];
      if (q) {
        if (parsedAnswer && typeof parsedAnswer === "object") {
          const obj = parsedAnswer as Record<string, unknown>;
          if (q.id in obj) {
            mappedAnswers[q.id] = obj[q.id];
          } else if (Array.isArray(parsedAnswer)) {
            mappedAnswers[q.id] = parsedAnswer[0];
          } else {
            mappedAnswers[q.id] = parsedAnswer;
          }
        } else {
          mappedAnswers[q.id] = parsedAnswer;
        }
      }
    } else {
      input.questions.forEach((q, index) => {
        if (parsedAnswer && typeof parsedAnswer === "object") {
          const obj = parsedAnswer as Record<string, unknown>;
          if (q.id in obj) {
            mappedAnswers[q.id] = obj[q.id];
          } else if (Array.isArray(parsedAnswer)) {
            mappedAnswers[q.id] = parsedAnswer[index];
          } else if (String(index) in obj) {
            mappedAnswers[q.id] = obj[String(index)];
          } else {
            mappedAnswers[q.id] = null;
          }
        } else {
          mappedAnswers[q.id] = index === 0 ? parsedAnswer : null;
        }
      });
    }

    return {
      tool_use_id: call.id,
      content: JSON.stringify(mappedAnswers),
    };
  },
};

export const WebDesignTool: ToolHandler = {
  schema: {
    name: "web_search",
    description: "Search the web for visual references, brand guidance, or factual grounding.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        allowedDomains: { type: "array", items: { type: "string" } },
        blockedDomains: { type: "array", items: { type: "string" } },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  isConcurrencySafe: true,
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    const input = parseInput(call);
    if (typeof input === "string") return invalid(call.id, input);
    try {
      const fn = getProviderConfig(ctx.provider)?.webSearch ?? searchDuckDuckGo;
      const payload = await fn(input, ctx);
      return { tool_use_id: call.id, content: JSON.stringify(payload) };
    } catch (err) {
      return invalid(call.id, err instanceof Error ? err.message : String(err));
    }
  },
};

export const GenerateImageDesignTool: ToolHandler = {
  schema: {
    name: "generate_image",
    description:
      "Generate an image asset (hero, illustration, texture) to embed or reference in the design.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        size: { type: "string", enum: ["1024x1024", "1024x1536", "1536x1024"] },
        transparent: { type: "boolean" },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  isConcurrencySafe: false,
  // The generic builtin saves the PNG to the image cache and returns its
  // filesystem path — dead in the sandboxed preview iframe. Hand the model a
  // neutral "os-asset:<file>" ref instead; the runtime resolves it to bytes over
  // the design.image RPC. Errors pass through untouched.
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    const result = await GenerateImage.run(call, ctx);
    if (result.is_error || typeof result.content !== "string") return result;
    return { ...result, content: `os-asset:${basename(result.content)}` };
  },
};

interface ReadImageInput {
  path: string;
}

function parseReadImage(input: unknown): ReadImageInput | string {
  if (!isRecord(input)) return "input must be an object";
  if (typeof input.path !== "string" || input.path.length === 0) {
    return "path must be a non-empty string";
  }
  return { path: input.path };
}

export function isDesignUploadImagePath(path: unknown): path is string {
  if (typeof path !== "string" || !path.startsWith("uploads/")) return false;
  const name = path.slice("uploads/".length);
  return !!name && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\");
}

export function resolveDesignImagePath(path: string, ctx: RequestContext): string | null {
  if (!path.startsWith("uploads/")) {
    return isAbsolute(path) ? path : join(ctx.cwd, path);
  }
  if (!isDesignUploadImagePath(path)) return null;
  const fork = designForkContextFor(ctx);
  if (!fork) return null;
  const name = path.slice("uploads/".length);
  return join(designStorageDir(fork.cwd, fork.designId), "uploads", name);
}

export const ReadImageDesignTool: ToolHandler = {
  schema: {
    name: "read_image",
    description:
      "Read an uploaded image or screenshot as design input — the model sees the pixels directly on a vision-capable provider, otherwise a text description.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  isConcurrencySafe: true,
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    const parsed = parseReadImage(call.input);
    if (typeof parsed === "string") {
      return { tool_use_id: call.id, content: parsed, is_error: true };
    }
    const abs = resolveDesignImagePath(parsed.path, ctx);
    if (!abs) {
      return { tool_use_id: call.id, content: "invalid uploaded image path", is_error: true };
    }
    const image = loadImageFromDisk(abs);
    if (typeof image === "string") {
      return { tool_use_id: call.id, content: image, is_error: true };
    }
    // A vision-capable provider sees the pixels directly for faithful color and
    // layout; otherwise fall back to a provider-generated text description so the
    // model still receives the content.
    if (canSendNatively(ctx.provider, ctx.model)) {
      return {
        tool_use_id: call.id,
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: image.mediaType, data: image.data },
          },
        ],
      };
    }
    const described = await describeImageViaProvider(ctx, image, "");
    if ("error" in described) {
      return { tool_use_id: call.id, content: described.error, is_error: true };
    }
    return { tool_use_id: call.id, content: described.text };
  },
};

const DEFAULT_DESIGN_SYSTEM = {
  designSystemId: "default",
  isDefault: true,
  palette: {
    background: "#0b0b0f",
    surface: "#16161e",
    text: "#ececf2",
    muted: "#9a9aa8",
    accent: "#7c5cff",
    border: "#34343f",
  },
  typography: {
    sans: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
    mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
    scale: ["12px", "14px", "16px", "20px", "24px", "32px", "48px"],
  },
  spacing: ["4px", "8px", "12px", "16px", "24px", "32px", "48px", "64px"],
  radius: ["4px", "8px", "12px", "16px", "9999px"],
};

export const DesignSystemTool: ToolHandler = {
  schema: {
    name: "design_system",
    description: "Resolve the active design system tokens (color, type, spacing, radius) to apply.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  isConcurrencySafe: true,
  async run(call: ToolCall): Promise<ToolResult> {
    return { tool_use_id: call.id, content: JSON.stringify(DEFAULT_DESIGN_SYSTEM) };
  },
};

interface ReadDesignSkillInput {
  name: string;
}

function parseReadDesignSkill(input: unknown): ReadDesignSkillInput | string {
  if (!isRecord(input)) return "input must be an object";
  if (typeof input.name !== "string" || input.name.trim().length === 0) {
    return "name must be a non-empty string";
  }
  return { name: input.name.trim().toLowerCase() };
}

export const ReadDesignSkillTool: ToolHandler = {
  schema: {
    name: "read_design_skill",
    description: "Read the deep craft and guidelines for a specific medium design process.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          enum: [
            "interface",
            "prototype",
            "animation",
            "document",
            "presentation",
            "wireframe",
            "tweakable",
            "api_integration",
            "design_system",
          ],
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  isConcurrencySafe: true,
  async run(call: ToolCall): Promise<ToolResult> {
    const parsed = parseReadDesignSkill(call.input);
    if (typeof parsed === "string")
      return { tool_use_id: call.id, content: parsed, is_error: true };
    const methodology = DESIGN_SKILLS[parsed.name];
    if (!methodology) {
      return {
        tool_use_id: call.id,
        content: `Unknown design skill medium: "${parsed.name}". Supported mediums are: ${Object.keys(
          DESIGN_SKILLS,
        ).join(", ")}`,
        is_error: true,
      };
    }
    return { tool_use_id: call.id, content: methodology };
  },
};

export const UpdateTodosToolHandler: ToolHandler = {
  schema: UpdateTodosTool,
  isConcurrencySafe: false,
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    const input = call.input as {
      todos: Array<{
        label: string;
        status: "pending" | "in_progress" | "completed";
      }>;
    };
    if (!input || !Array.isArray(input.todos)) {
      return { tool_use_id: call.id, content: "todos must be an array", is_error: true };
    }
    const fork = designForkContextFor(ctx);
    if (!fork) {
      return {
        tool_use_id: call.id,
        content: "design fork context is unavailable",
        is_error: true,
      };
    }
    const tasks = input.todos.map((todo, index) => {
      const state =
        todo.status === "in_progress" ? "doing" : todo.status === "completed" ? "done" : "todo";
      return {
        id: `task-${index}`,
        label: todo.label,
        state,
        updatedAt: new Date().toISOString(),
      };
    });
    fork.emit(
      notify("$/tasks", {
        tasks,
      }),
    );
    return {
      tool_use_id: call.id,
      content: `Updated task list with ${tasks.length} item(s).`,
    };
  },
};

// The shared WebFetch builtin registers under its wire name; the design toolset
// exposes it as snake_case web_fetch to sit alongside the other design tools.
// The wrapper only renames — behavior delegates to the builtin.
export const WebFetchDesignTool: ToolHandler = {
  schema: {
    name: "web_fetch",
    description: WebFetch.schema.description,
    inputSchema: WebFetch.schema.inputSchema,
  },
  isConcurrencySafe: true,
  run: (call, ctx) => WebFetch.run(call, ctx),
};

export const DESIGN_AGENT_TOOLS: readonly ToolHandler[] = [
  AskDesignQuestionsToolHandler,
  WebDesignTool,
  ReadImageDesignTool,
  DesignSystemTool,
  ReadDesignSkillTool,
  UpdateTodosToolHandler,
  WebFetchDesignTool,
];
