import { codexRawReplayHasRequestRole } from "@/devtools/codex-raw-stream.ts";
import { auxiliaryModelFor } from "@/engine/model/tier/tiers.ts";
import * as providers from "@/engine/providers/registry.ts";
import { sanitizeMessages } from "@/engine/translator/index.ts";
import { streamWithRetry } from "@/engine/transport/_infra/classify/retry.ts";
import type { ComposedHarness } from "@/harness/composer/injections.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export const SESSION_TITLE_PROMPT = `Generate a concise, sentence-case title (3-7 words) that captures the main topic or goal of this coding session. The title should be clear enough that the user recognizes the session in a list. Use sentence case: capitalize only the first word and proper nouns.

Return JSON with a single "title" field.

Good examples:
{"title": "Fix login button on mobile"}
{"title": "Add OAuth authentication"}
{"title": "Debug failing CI tests"}
{"title": "Refactor API client error handling"}

Bad (too vague): {"title": "Code changes"}
Bad (too long): {"title": "Investigate and fix the issue where the login button does not respond on mobile devices"}
Bad (wrong case): {"title": "Fix Login Button On Mobile"}`;

const TITLE_MAX_OUTPUT_TOKENS = 32000;
const SESSION_TITLE_MAX_LENGTH = 200;

export function titleModelFor(ctx: RequestContext): string {
  const model = auxiliaryModelFor(ctx.provider);
  return model === "inherit" ? ctx.model : model;
}

export async function composeSessionTitle(
  ctx: RequestContext,
  firstPrompt: string,
): Promise<string | null> {
  const trimmed = firstPrompt.trim();
  if (trimmed.length === 0) return null;
  if (ctx.provider === "codex" && codexRawReplayHasRequestRole("title") === false) return null;
  const titleCtx: RequestContext = {
    ...ctx,
    model: titleModelFor(ctx),
    agentic: false,
    effort: null,
    disableThinking: true,
    cacheRole: "title",
    requestRole: "title",
  };
  const harness: ComposedHarness = {
    layers: [{ name: "session-title", body: SESSION_TITLE_PROMPT }],
    combined: SESSION_TITLE_PROMPT,
    systemBlocks: [{ text: SESSION_TITLE_PROMPT }],
    userPrepend: [],
    midSystemPromotion: "off",
  };
  const request: Message = {
    role: "user",
    content: [{ type: "text", text: `<session>\n${trimmed}\n</session>` }],
  };
  try {
    const provider = providers.get(titleCtx.provider);
    const composed = provider.composeMessages(harness, sanitizeMessages([request]));
    const body = clampTitleRequest(provider.translateRequest(titleCtx, composed, []));
    let text = "";
    for await (const ev of streamWithRetry(titleCtx, provider, body)) {
      if (ev.kind === "text_delta") text += ev.text;
      if (ev.kind === "stream_reset") text = "";
      if (ev.kind === "error" || ev.kind === "quota_exhausted") {
        debugTitle(`event ${ev.kind}: ${JSON.stringify(ev)}`);
        return null;
      }
      if (ev.kind === "message_stop") break;
    }
    debugTitle(`text: ${JSON.stringify(text)}`);
    return parseTitleResponse(text);
  } catch (err) {
    debugTitle(`thrown: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return null;
  }
}

function debugTitle(message: string): void {
  // Gated: an unconditional stderr write corrupts the inline TUI mid-render.
  if (process.env.OTHERSIDE_TITLE_DEBUG === "1") console.error("[title-debug]", message);
}

export function parseTitleResponse(raw: string): string | null {
  const candidate = jsonObjectFrom(raw.trim());
  if (!candidate || typeof candidate.title !== "string") return null;
  const sanitized = sanitizeTitle(candidate.title);
  return sanitized.length > 0 ? sanitized : null;
}

const LAST_C0_CONTROL = 0x1f;
const FIRST_C1_CONTROL = 0x7f;
const LAST_C1_CONTROL = 0x9f;

function isControlCodePoint(code: number): boolean {
  return code <= LAST_C0_CONTROL || (code >= FIRST_C1_CONTROL && code <= LAST_C1_CONTROL);
}

// Strips HTML/XML tags, markdown emphasis markers, code fences, footnote refs,
// and surrogate-pair emoji from a generated title. Prompt-level guidance can drift
// (especially when LLM tries to format like a chat answer); this is the last-line
// sanitizer that runs before the title is persisted/displayed.
const HTML_TAG_RE = /<\/?[a-z][^>]*>/gi;
const MARKDOWN_FENCE_RE = /```[a-z]*|```/gi;
const MARKDOWN_EMPHASIS_RE = /[*_~`]+/g;
const FOOTNOTE_REF_RE = /\[\^?[0-9]+\]/g;
// Drops anything in the emoji/dingbat/symbol planes — covers 💡, ✳, etc.
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F02F}\u{1F100}-\u{1F1FF}]/gu;
// Variation selectors and zero-width joiners that ride along with emoji.
const VARIATION_SELECTOR_RE = /[\u{FE00}-\u{FE0F}\u{200D}]/gu;

export function sanitizeTitle(raw: string): string {
  let stripped = "";
  for (const ch of raw) {
    stripped += isControlCodePoint(ch.codePointAt(0) ?? 0) ? " " : ch;
  }
  const cleaned = stripped
    .replace(HTML_TAG_RE, " ")
    .replace(MARKDOWN_FENCE_RE, " ")
    .replace(FOOTNOTE_REF_RE, " ")
    .replace(MARKDOWN_EMPHASIS_RE, "")
    .replace(EMOJI_RE, " ")
    .replace(VARIATION_SELECTOR_RE, "")
    // Drop stray balancing characters left over from truncated JSON / markup.
    .replace(/[{}<>[\]]/g, " ");
  return [...cleaned.replace(/\s+/g, " ").trim()].slice(0, SESSION_TITLE_MAX_LENGTH).join("");
}

function jsonObjectFrom(text: string): Record<string, unknown> | null {
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const direct = tryParseObject(unfenced);
  if (direct) return direct;
  const flat = unfenced.match(/\{[^{}]*\}/);
  const fromFlat = flat ? tryParseObject(flat[0]) : null;
  if (fromFlat) return fromFlat;
  const greedy = unfenced.match(/\{[\s\S]*\}/);
  if (!greedy) return null;
  return tryParseObject(greedy[0]);
}

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TITLE_OUTPUT_CONFIG = {
  format: {
    type: "json_schema",
    schema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    },
  },
};

export function clampTitleRequest(body: unknown): unknown {
  if (!isRecord(body)) return body;
  const next = { ...body };

  const target = isRecord(next.request) ? (next.request as Record<string, unknown>) : next;

  if ("contents" in target && "generationConfig" in target && isRecord(target.generationConfig)) {
    const genConfig = { ...target.generationConfig };
    if (typeof genConfig.maxOutputTokens === "number") {
      genConfig.maxOutputTokens = Math.min(genConfig.maxOutputTokens, TITLE_MAX_OUTPUT_TOKENS);
    }
    delete genConfig.thinkingConfig;
    genConfig.responseMimeType = "application/json";
    genConfig.responseSchema = {
      type: "OBJECT",
      properties: { title: { type: "STRING" } },
      required: ["title"],
    };
    target.generationConfig = genConfig;
    target.tools = [];
    return next;
  }

  if (typeof next.max_tokens === "number") {
    next.max_tokens = Math.min(next.max_tokens, TITLE_MAX_OUTPUT_TOKENS);
  }
  next.thinking = { type: "disabled" };
  next.temperature = 1;
  next.tools = [];
  next.output_config = TITLE_OUTPUT_CONFIG;
  return next;
}
