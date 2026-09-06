import { prepareRequestImage } from "@/engine/contract/defaults/prepare-request-images.ts";
import {
  accountFingerprint,
  sameAccountFingerprint,
} from "@/engine/providers/_shared/account-identity.ts";
import { thinkingProvenance } from "@/engine/providers/_shared/thinking-provenance.ts";
import { buildCodexEnvelope } from "@/engine/providers/codex/envelope.ts";
import { MODELS } from "@/engine/providers/codex/models.ts";
import { isEncryptedReasoningRejected } from "@/engine/providers/codex/transport/state.ts";
import CODEX_PREAMBLE from "@/harness/providers/codex/preamble.md" with { type: "text" };
import type { ImageMediaType } from "@/kernel/std/types/image.ts";
import type { ContentBlock, Message } from "@/kernel/std/types/message.ts";
import { toolResultText } from "@/kernel/std/types/message.ts";
import type { ProviderModelRoute } from "@/kernel/std/types/provider-ids.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

interface CodexInputItem {
  type: string;
  [k: string]: unknown;
}

interface CodexFunctionTool {
  type: "function";
  name: string;
  description?: string;
  strict: boolean;
  parameters: unknown;
}

interface CodexWebSearchTool {
  type: "web_search";
  external_web_access?: boolean;
  search_content_types?: string[];
}

interface CodexFreeformTool {
  type: "custom";
  name: string;
  description: string;
  format: { type: "grammar"; syntax: "lark"; definition: string };
}

type CodexTool = CodexFunctionTool | CodexWebSearchTool | CodexFreeformTool;

const WEB_SEARCH_TOOL_NAME = "WebSearch";

interface HarnessToolDecl {
  name?: string;
  description?: string;
  input_schema?: unknown;
}

const EMPTY_SCHEMA = { type: "object", properties: {} };

const CODEX_CALL_ID_MAX = 64;

function codexCallId(id: string): string {
  if (id.length <= CODEX_CALL_ID_MAX) return id;
  let hash = 5381;
  for (let i = 0; i < id.length; i++) hash = ((hash << 5) + hash + id.charCodeAt(i)) >>> 0;
  const suffix = hash.toString(16).padStart(8, "0");
  return `${id.slice(0, CODEX_CALL_ID_MAX - suffix.length - 1)}_${suffix}`;
}

function toolsToCodex(tools: unknown[], useResponsesLite = false): CodexTool[] {
  const out: CodexTool[] = [];
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    const decl = t as HarnessToolDecl;
    if (typeof decl.name !== "string" || decl.name.length === 0) continue;
    if (decl.name === WEB_SEARCH_TOOL_NAME && !useResponsesLite) continue;
    const def: CodexFunctionTool = {
      type: "function",
      name: decl.name,
      strict: false,
      parameters: decl.input_schema ?? EMPTY_SCHEMA,
    };
    if (typeof decl.description === "string") def.description = decl.description;
    out.push(def);
  }
  if (!useResponsesLite) {
    out.push({
      type: "web_search",
      external_web_access: true,
      search_content_types: ["text", "image"],
    });
  }
  return out;
}

function extractInstructions(messages: Message[]): string | null {
  for (const m of messages) {
    if (m.role !== "system") continue;
    const text = m.content
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (text.length > 0) return text;
  }
  return null;
}

function blockToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function inputImage(source: { media_type: string; data: string }): CodexInputItem {
  return {
    type: "input_image",
    image_url: `data:${source.media_type};base64,${source.data}`,
    detail: "high",
  };
}

function messagesToInput(
  messages: Message[],
  route: ProviderModelRoute,
  currentAccount: string | undefined,
  suppressEncryptedReasoning: boolean,
  useResponsesLite = false,
): CodexInputItem[] {
  const out: CodexInputItem[] = [];
  // Hosted web_search calls are replayed by the server, so their local echoes
  // must be dropped; Lite runs WebSearch as a client function, and dropping the
  // results would re-trigger the search on every turn.
  const webSearchCallIds = useResponsesLite ? new Set<string>() : collectWebSearchCallIds(messages);
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      const parts: CodexInputItem[] = [];
      const toolResults = m.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result",
      );
      for (const r of toolResults) {
        if (webSearchCallIds.has(r.tool_use_id)) continue;
        out.push(toolResultToCodex(r, route));
      }
      for (const b of m.content) {
        if (b.type === "text" && b.text.length > 0) {
          parts.push({ type: "input_text", text: b.text });
        } else if (b.type === "image") {
          parts.push(inputImage(b.source));
        }
      }
      if (parts.length > 0) {
        out.push({ type: "message", role: "user", content: parts });
      }
      continue;
    }
    if (m.role === "assistant") {
      const text = blockToText(m.content);
      const toolUses = m.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
      );
      // Encrypted reasoning is bound to the credential that produced it;
      // replaying it under another account is rejected by the endpoint.
      // Provenance is judged per block — a rebuilt message can carry blocks
      // from several producers.
      const reasoning = m.content.find((b): b is Extract<ContentBlock, { type: "thinking" }> => {
        if (b.type !== "thinking") return false;
        if (typeof b.signature !== "string" || b.signature.length === 0) return false;
        const produced = thinkingProvenance(b, m);
        const producedByCodex =
          produced.producedBy === "codex" ||
          (!!produced.producedModel && MODELS.some((model) => model.id === produced.producedModel));
        return producedByCodex && sameAccountFingerprint(produced.producedAccount, currentAccount);
      });
      if (reasoning?.signature && !suppressEncryptedReasoning) {
        const summary =
          reasoning.text.length > 0 ? [{ type: "summary_text", text: reasoning.text }] : [];
        out.push({ type: "reasoning", summary, encrypted_content: reasoning.signature });
      }
      if (text.length > 0) {
        out.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      for (const tu of toolUses) {
        if (tu.name === WEB_SEARCH_TOOL_NAME && !useResponsesLite) {
          continue;
        }
        out.push({
          type: "function_call",
          call_id: codexCallId(tu.id),
          name: tu.name,
          arguments: typeof tu.input === "string" ? tu.input : JSON.stringify(tu.input ?? {}),
          status: "completed",
        });
      }
      continue;
    }
    if (m.role === "tool") {
      const toolResults = m.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result",
      );
      for (const r of toolResults) {
        if (webSearchCallIds.has(r.tool_use_id)) continue;
        out.push(toolResultToCodex(r, route));
      }
    }
  }
  return out;
}

function collectWebSearchCallIds(messages: Message[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.content) {
      if (b.type === "tool_use" && b.name === WEB_SEARCH_TOOL_NAME) {
        ids.add(b.id);
      }
    }
  }
  return ids;
}

const CODEX_OUTPUT_CONTENT_TYPES = new Set([
  "input_text",
  "input_image",
  "output_text",
  "refusal",
  "input_file",
  "computer_screenshot",
  "summary_text",
]);

function isCodexOutputContentArray(parsed: unknown): boolean {
  return (
    Array.isArray(parsed) &&
    parsed.length > 0 &&
    parsed.every(
      (v) =>
        !!v &&
        typeof v === "object" &&
        typeof (v as { type?: unknown }).type === "string" &&
        CODEX_OUTPUT_CONTENT_TYPES.has((v as { type: string }).type),
    )
  );
}

const EMBEDDED_IMAGE_URL = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.*)$/s;

function prepareEmbeddedInputImages(
  items: CodexInputItem[],
  route: ProviderModelRoute,
): CodexInputItem[] {
  return items.map((item) => {
    if (item.type !== "input_image") return item;
    const imageUrl = typeof item.image_url === "string" ? item.image_url : "";
    const match = EMBEDDED_IMAGE_URL.exec(imageUrl);
    if (!match) return { ...item, detail: "high" };
    const mediaType = match[1] as ImageMediaType;
    const data = match[2] ?? "";
    const prepared = prepareRequestImage(
      {
        type: "image",
        source: { type: "base64", media_type: mediaType, data },
      },
      route,
    );
    return {
      ...item,
      image_url: `data:${prepared.source.media_type};base64,${prepared.source.data}`,
      detail: "high",
    };
  });
}

function toolResultToCodex(
  r: Extract<ContentBlock, { type: "tool_result" }>,
  route: ProviderModelRoute,
): CodexInputItem {
  // Binary blocks must ride as content items — flattening to text would strip
  // their bytes into a placeholder before they reach the wire.
  if (Array.isArray(r.content) && r.content.some((b) => b.type === "image" || b.type === "pdf")) {
    const items: CodexInputItem[] = [];
    for (const b of r.content) {
      if (b.type === "text" && b.text.length > 0) {
        items.push({ type: "input_text", text: b.text });
      } else if (b.type === "image") {
        items.push(inputImage(b.source));
      } else if (b.type === "pdf") {
        items.push({
          type: "input_file",
          filename: b.filename,
          file_data: `data:application/pdf;base64,${b.source.data}`,
        });
      }
    }
    return { type: "function_call_output", call_id: codexCallId(r.tool_use_id), output: items };
  }
  const text = toolResultText(r.content);
  let outputValue: unknown = text;
  try {
    const parsed = JSON.parse(text);
    if (isCodexOutputContentArray(parsed)) {
      outputValue = prepareEmbeddedInputImages(parsed as CodexInputItem[], route);
    }
  } catch {}
  return { type: "function_call_output", call_id: codexCallId(r.tool_use_id), output: outputValue };
}

// /responses accepts "max" even though its invalid_value error message still
// lists only none..xhigh (proven by live probe).
function effortFromCtx(effort: string | null): string | null {
  switch (effort) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    case "max":
      return "max";
    default:
      return null;
  }
}

const CACHE_KEY_SUFFIX_TITLE = ":title";
const CACHE_KEY_SUFFIX_FORK = ":fork";

function promptCacheKeyForCtx(ctx: RequestContext): string {
  if (ctx.cacheRole === "title") return `${ctx.sessionId}${CACHE_KEY_SUFFIX_TITLE}`;
  if (ctx.subagentLabel) {
    const forkSuffix = ctx.agentOwnerId
      ? `${CACHE_KEY_SUFFIX_FORK}:${ctx.agentOwnerId}`
      : CACHE_KEY_SUFFIX_FORK;
    return `${ctx.sessionId}${forkSuffix}`;
  }
  return ctx.sessionId;
}

export interface CodexBodyExtras {
  serviceTier?: string | undefined;
}

export function translateRequestCodex(
  ctx: RequestContext,
  messages: Message[],
  tools: unknown[],
  extras: CodexBodyExtras = {},
): unknown {
  const modelEntry = MODELS.find((m) => m.id === ctx.model);
  const modelAugment = modelEntry?.augment;
  const useResponsesLite = modelAugment?.useResponsesLite ?? false;

  const callerInstructions = extractInstructions(messages);
  const instructions =
    ctx.provider === "codex" && callerInstructions
      ? `${CODEX_PREAMBLE}\n\n${callerInstructions}`
      : callerInstructions;
  const codexTools = toolsToCodex(tools, useResponsesLite);

  let input = messagesToInput(
    messages,
    { provider: ctx.provider, model: ctx.model },
    accountFingerprint(ctx.provider),
    isEncryptedReasoningRejected(ctx.sessionId),
    useResponsesLite,
  );

  if (useResponsesLite) {
    const prefix: CodexInputItem[] = [
      {
        type: "additional_tools",
        role: "developer",
        tools: codexTools,
      },
    ];
    if (instructions && instructions.length > 0) {
      prefix.push({
        type: "message",
        role: "developer",
        content: [
          {
            type: "input_text",
            text: instructions,
          },
        ],
      });
    }
    input = [...prefix, ...input];
  }

  return buildCodexEnvelope({
    ctx,
    instructions: useResponsesLite ? null : instructions,
    input,
    tools: useResponsesLite ? undefined : codexTools,
    promptCacheKey: promptCacheKeyForCtx(ctx),
    effort: effortFromCtx(ctx.effort),
    serviceTier: extras.serviceTier,
    useResponsesLite,
    serviceTiers: modelAugment?.serviceTiers,
    defaultVerbosity: modelAugment?.defaultVerbosity,
  });
}
