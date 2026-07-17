import {
  accountFingerprint,
  sameAccountFingerprint,
} from "@/engine/providers/_shared/account-identity.ts";
import { isGeminiFamily } from "@/engine/providers/_shared/families.ts";
import { streamErrorToHttpError } from "@/engine/providers/_shared/retry.ts";
import { thinkingProvenance } from "@/engine/providers/_shared/thinking-provenance.ts";
import { readRawToolDecl } from "@/engine/providers/_shared/tool-decl.ts";
import { usageFromGemini } from "@/engine/providers/_shared/usage.ts";
import { parseSse } from "@/kernel/std/stream/sse.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";
import type { ContentBlock, Message } from "@/kernel/std/types/message.ts";
import { toolResultText } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export interface GeminiPart {
  [k: string]: unknown;
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiThinkingConfig {
  thinkingLevel?: string;
  thinkingBudget?: number;
  includeThoughts: boolean;
}

const SYNTHETIC_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

const SCHEMA_KEYS_DROP = new Set([
  "additionalProperties",
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "$comment",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "patternProperties",
  "const",
  "examples",
  "prefixItems",
  "if",
  "then",
  "else",
  "not",
  "contains",
  "propertyNames",
  "dependentSchemas",
  "dependentRequired",
  "unevaluatedProperties",
  "unevaluatedItems",
  "additionalItems",
]);

export function encodeGeminiToolName(name: string): string {
  if (name.startsWith("$")) return `core_${name.slice(1)}`;
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
}

export function decodeGeminiToolName(name: string): string {
  if (name.startsWith("core_")) return `$${name.slice(5)}`;
  return name;
}

export function geminiSanitizeSchema(node: unknown): unknown {
  if (!node || typeof node !== "object" || Array.isArray(node)) return node;
  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SCHEMA_KEYS_DROP.has(k)) continue;
    if (k === "properties" && v && typeof v === "object" && !Array.isArray(v)) {
      const inner: Record<string, unknown> = {};
      for (const [ik, iv] of Object.entries(v as Record<string, unknown>)) {
        inner[ik] = geminiSanitizeSchema(iv);
      }
      out[k] = inner;
    } else if (k === "items") {
      out[k] = Array.isArray(v) ? v.map(geminiSanitizeSchema) : geminiSanitizeSchema(v);
    } else if (k === "allOf" || k === "anyOf" || k === "oneOf") {
      out[k] = Array.isArray(v) ? v.map(geminiSanitizeSchema) : v;
    } else if (k === "enum" && Array.isArray(v)) {
      out[k] = v.map((item) => (typeof item === "string" ? item : String(item)));
    } else {
      out[k] = v;
    }
  }
  if (!("type" in out) && "properties" in out) {
    out.type = "object";
  }
  return out;
}

interface GeminiToolDecl {
  name: string;
  description?: string;
  parameters: unknown;
}

export function geminiToolsToFunctionDeclarations(tools: unknown[]): GeminiPart[] {
  const decls: GeminiToolDecl[] = [];
  for (const t of tools) {
    const fields = readRawToolDecl(t);
    if (!fields) continue;
    const name = encodeGeminiToolName(fields.name);
    const description = fields.description;
    const parameters = geminiSanitizeSchema(fields.parameters);
    const decl: GeminiToolDecl = { name, parameters };
    if (description !== undefined) decl.description = description;
    decls.push(decl);
  }
  if (decls.length === 0) return [];
  return [{ functionDeclarations: decls }];
}

function geminiBlockText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function geminiCollectToolUseNames(messages: Message[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") out.set(block.id, block.name);
    }
  }
  return out;
}

function geminiToolResponsePart(
  r: Extract<ContentBlock, { type: "tool_result" }>,
  toolNames: Map<string, string>,
  wrapOutput: boolean,
  supportsPdf: boolean,
): GeminiPart {
  const text =
    supportsPdf && Array.isArray(r.content)
      ? toolResultText(r.content.filter((part) => part.type !== "pdf"))
      : toolResultText(r.content);
  let response: unknown;
  if (wrapOutput) {
    response = { output: text };
  } else {
    try {
      const parsed = JSON.parse(text);
      response =
        parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { output: text };
    } catch {
      response = { output: text };
    }
  }
  return {
    functionResponse: {
      id: r.tool_use_id,
      name: encodeGeminiToolName(toolNames.get(r.tool_use_id) ?? r.tool_use_id),
      response,
    },
  };
}

function appendPdfParts(
  contents: GeminiContent[],
  result: Extract<ContentBlock, { type: "tool_result" }>,
  supportsPdf: boolean,
): void {
  if (!supportsPdf || !Array.isArray(result.content)) return;
  const parts = result.content
    .filter((part): part is Extract<typeof part, { type: "pdf" }> => part.type === "pdf")
    .map((part) => ({
      inlineData: { mimeType: "application/pdf", data: part.source.data },
    }));
  if (parts.length > 0) contents.push({ role: "user", parts });
}

function appendToolResponse(contents: GeminiContent[], fr: GeminiPart): void {
  const last = contents[contents.length - 1];
  if (last && last.role === "user") {
    const allFr =
      last.parts.length > 0 &&
      last.parts.every((p) => typeof p === "object" && p !== null && "functionResponse" in p);
    if (allFr) {
      last.parts.push(fr);
      return;
    }
  }
  contents.push({ role: "user", parts: [fr] });
}

export interface GeminiContentsResult {
  systemText: string;
  contents: GeminiContent[];
}

export function geminiBuildContents(
  messages: Message[],
  sessionContext?: string | undefined,
  framing?: GeminiFraming,
): GeminiContentsResult {
  const contents: GeminiContent[] = [];
  let systemText = "";
  const toolNames = geminiCollectToolUseNames(messages);
  const wrapOutput = framing?.wrapToolOutput ?? false;
  const supportsPdf = framing?.supportsPdf ?? false;

  if (sessionContext && sessionContext.length > 0) {
    contents.push({ role: "user", parts: [{ text: sessionContext }] });
  }

  for (const msg of messages) {
    if (msg.role === "system") {
      const text = geminiBlockText(msg.content);
      if (text.length > 0) {
        systemText = systemText.length > 0 ? `${systemText}\n\n${text}` : text;
      }
      continue;
    }
    if (msg.role === "user") {
      const parts: GeminiPart[] = [];
      for (const b of msg.content) {
        if (b.type === "text" && b.text.length > 0) {
          parts.push({ text: b.text });
        } else if (b.type === "image") {
          parts.push({
            inlineData: { mimeType: b.source.media_type, data: b.source.data },
          });
        }
      }
      const toolResults = msg.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result",
      );
      for (const r of toolResults) {
        appendToolResponse(contents, geminiToolResponsePart(r, toolNames, wrapOutput, supportsPdf));
        appendPdfParts(contents, r, supportsPdf);
      }
      if (parts.length > 0) {
        contents.push({ role: "user", parts });
      }
      continue;
    }
    if (msg.role === "assistant") {
      const parts: GeminiPart[] = [];
      // Thinking replay is judged by the block's own provenance — a rebuilt
      // message can carry blocks from several producers, so a foreign block
      // never replays even inside a gemini-stamped message. Messages without
      // a same-family block fall back to the message stamp (synthetic
      // signature attach for tool-only turns keeps working).
      const thinkingBlock = msg.content.find(
        (b): b is Extract<ContentBlock, { type: "thinking" }> =>
          b.type === "thinking" && isGeminiFamily(thinkingProvenance(b, msg).producedBy),
      );
      const produced = thinkingBlock ? thinkingProvenance(thinkingBlock, msg) : msg;
      const sameFamily = isGeminiFamily(produced.producedBy);
      const activeModel = framing?.currentModel;
      const sameModel =
        typeof activeModel === "string" &&
        activeModel.length > 0 &&
        produced.producedModel === activeModel;
      // A stored thought signature only replays when produced by the same
      // credential that signs this request; cross-account replay is invalid.
      const sameAccount = sameAccountFingerprint(produced.producedAccount, framing?.currentAccount);
      const thinkingSignature =
        sameFamily &&
        sameModel &&
        sameAccount &&
        thinkingBlock &&
        typeof thinkingBlock.signature === "string" &&
        thinkingBlock.signature.length > 0
          ? thinkingBlock.signature
          : undefined;
      const targetUsedClaude = framing?.targetUsedClaude ?? false;
      const replayThoughtSignature =
        thinkingSignature ?? (targetUsedClaude ? undefined : SYNTHETIC_THOUGHT_SIGNATURE);
      if (
        framing?.replayThinking &&
        sameFamily &&
        thinkingBlock &&
        thinkingBlock.text.length > 0 &&
        replayThoughtSignature !== undefined
      ) {
        parts.push({
          text: thinkingBlock.text,
          thought: true,
          thoughtSignature: replayThoughtSignature,
        });
      }
      const text = geminiBlockText(msg.content);
      if (text.length > 0) parts.push({ text });
      const toolUses = msg.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
      );
      const attachSignature = sameFamily || (framing?.alwaysSignFunctionCall ?? false);
      let attachedThoughtSignature = false;
      for (const tu of toolUses) {
        const args =
          typeof tu.input === "object" && tu.input !== null
            ? tu.input
            : tu.input === undefined
              ? {}
              : tu.input;
        const part: GeminiPart = { functionCall: { id: tu.id, name: tu.name, args } };
        if (!attachedThoughtSignature && attachSignature && replayThoughtSignature !== undefined) {
          part.thoughtSignature = replayThoughtSignature;
          attachedThoughtSignature = true;
        }
        parts.push(part);
      }
      if (parts.length === 0) parts.push({ text: "" });
      contents.push({ role: "model", parts });
      continue;
    }
    if (msg.role === "tool") {
      const toolResults = msg.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result",
      );
      for (const r of toolResults) {
        appendToolResponse(contents, geminiToolResponsePart(r, toolNames, wrapOutput, supportsPdf));
        appendPdfParts(contents, r, supportsPdf);
      }
    }
  }

  return { systemText, contents };
}

export interface GeminiFraming {
  replayThinking?: boolean;
  wrapToolOutput?: boolean;
  alwaysSignFunctionCall?: boolean;
  currentModel?: string;
  currentAccount?: string;
  targetUsedClaude?: boolean;
  supportsPdf?: boolean;
}

export interface GeminiRequestInput {
  ctx: RequestContext;
  messages: Message[];
  tools: unknown[];
  thinkingConfig: GeminiThinkingConfig | null;
  sessionContext?: string | undefined;
  framing?: GeminiFraming;
}

export function buildGeminiRequest(input: GeminiRequestInput): GeminiContentsResult & {
  body: Record<string, unknown>;
} {
  // Derived fresh at request build so a credential switch (even mid-turn
  // from another client) gates signature replay on the very next request.
  const currentAccount = accountFingerprint(input.ctx.provider);
  const framing: GeminiFraming = {
    ...input.framing,
    currentModel: input.ctx.model,
    ...(currentAccount ? { currentAccount } : {}),
  };
  const { systemText, contents } = geminiBuildContents(
    input.messages,
    input.sessionContext,
    framing,
  );

  const body: Record<string, unknown> = { contents };

  if (systemText.length > 0) {
    body.systemInstruction = { parts: [{ text: systemText }] };
  }

  const toolsArr = geminiToolsToFunctionDeclarations(input.tools);
  if (toolsArr.length > 0) {
    body.tools = toolsArr;
  }

  const generationConfig: Record<string, unknown> = {};
  const thinking = input.thinkingConfig;
  if (thinking) {
    const tc: Record<string, unknown> = {
      includeThoughts:
        input.ctx.disableThinking === true || input.ctx.suppressThinkingSummary === true
          ? false
          : thinking.includeThoughts,
    };
    if (thinking.thinkingLevel !== undefined) tc.thinkingLevel = thinking.thinkingLevel;
    if (thinking.thinkingBudget !== undefined) tc.thinkingBudget = thinking.thinkingBudget;
    generationConfig.thinkingConfig = tc;
  }
  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig;
  }

  return { systemText, contents, body };
}

export function mapGeminiFinishReason(reason: string, sawTool: boolean): string {
  switch (reason) {
    case "STOP":
      return sawTool ? "tool_calls" : "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "content_filter";
    case "MALFORMED_FUNCTION_CALL":
      return "error";
    case "LANGUAGE":
    case "OTHER":
      return "stop";
    default:
      return "stop";
  }
}

interface GeminiToolBuf {
  id: string;
  name: string;
  buffer: string;
}

export interface GeminiResponseErrorHandlers {
  onRateLimit(body: string): never;
  onHttpError(code: number, body: string): never;
}

export function translateGeminiResponse(
  raw: AsyncIterable<Uint8Array>,
  handlers: GeminiResponseErrorHandlers,
): AsyncIterable<ProviderEvent> {
  return geminiResponseGenerator(raw, handlers);
}

async function* geminiResponseGenerator(
  raw: AsyncIterable<Uint8Array>,
  handlers: GeminiResponseErrorHandlers,
): AsyncIterable<ProviderEvent> {
  let started = false;
  let finished = false;
  let sawTool = false;
  let sawContent = false;
  let toolCounter = 0;
  const tools = new Map<string, GeminiToolBuf>();

  for await (const ev of parseSse(raw)) {
    if (!ev.data) continue;
    if (finished) continue;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const response = (payload.response ?? payload) as Record<string, unknown>;

    if (!started) {
      started = true;
      yield { kind: "message_start" };
    }

    const usage = usageFromGemini(response.usageMetadata);
    if (usage) yield usage;

    if (typeof payload.error === "object" && payload.error !== null) {
      const err = payload.error as Record<string, unknown>;
      const status = typeof err.status === "string" ? err.status : "";
      const code = typeof err.code === "number" ? err.code : 0;
      const body = JSON.stringify({ error: err });
      if (status === "RESOURCE_EXHAUSTED" || code === 429) {
        handlers.onRateLimit(body);
      }
      handlers.onHttpError(code || 500, body);
    }

    const candidates = Array.isArray(response.candidates)
      ? (response.candidates as Array<Record<string, unknown>>)
      : [];

    for (const cand of candidates) {
      const content = (cand.content ?? {}) as Record<string, unknown>;
      const parts = Array.isArray(content.parts)
        ? (content.parts as Array<Record<string, unknown>>)
        : [];
      for (const part of parts) {
        if (typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0) {
          yield { kind: "thinking_signature", signature: part.thoughtSignature };
        }
        if (typeof part.text === "string" && part.text.length > 0) {
          sawContent = true;
          if (part.thought === true) {
            yield { kind: "thinking_delta", text: part.text };
          } else {
            yield { kind: "text_delta", text: part.text };
          }
          continue;
        }
        const fc = part.functionCall as Record<string, unknown> | undefined;
        if (fc && typeof fc === "object") {
          const name = typeof fc.name === "string" ? fc.name : "";
          if (!name) continue;
          const args =
            fc.args !== undefined && fc.args !== null
              ? fc.args
              : (Object.create(null) as Record<string, unknown>);
          const fcId = typeof fc.id === "string" && fc.id.length > 0 ? fc.id : null;
          const id = fcId ?? `${name}_${Date.now()}_${toolCounter++}`;
          tools.set(id, { id, name, buffer: "" });
          sawTool = true;
          sawContent = true;
          const decodedName = decodeGeminiToolName(name);
          yield { kind: "tool_call_start", id, name: decodedName };
          yield { kind: "tool_call_complete", id, name: decodedName, input: args };
        }
      }

      const fr = typeof cand.finishReason === "string" ? cand.finishReason : "";
      if (fr && fr !== "FINISH_REASON_UNSPECIFIED") {
        finished = true;
        yield { kind: "message_stop", stop_reason: mapGeminiFinishReason(fr, sawTool) };
        break;
      }
    }
  }

  if (!finished) {
    if (sawContent) {
      throw streamErrorToHttpError({
        provider: "gemini",
        rawBody: JSON.stringify({
          error: { type: "api_error", message: "stream closed before finishReason" },
        }),
        fallbackStatus: 500,
      });
    }
    yield { kind: "message_stop", stop_reason: sawTool ? "tool_calls" : "stop" };
  }
}
