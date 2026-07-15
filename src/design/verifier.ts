import { notify } from "@/design/bridge/envelope.ts";
import { ReadDesignTool } from "@/design/capabilities/design-tools.ts";
import { drainVerificationPaths } from "@/design/capabilities/verification-tools.ts";
import {
  type DesignForkContext,
  designForkContextFor,
  registerDesignFork,
  unregisterDesignFork,
} from "@/design/fork-context.ts";
import { awaitEvalResult, awaitScreenshot, awaitWebviewLogs } from "@/design/pending.ts";
import { recordToolEnd, recordToolStart } from "@/design/tool-cards.ts";
import type { DesignSnapshot, RpcContext } from "@/design/types.ts";
import { stableArtifactId } from "@/design/types.ts";
import { runForkLoopExternal } from "@/engine/background/subagents/dispatcher.ts";
import { canSendNatively } from "@/engine/model/capabilities-runtime.ts";
import { describeImageViaProvider } from "@/engine/tools/builtins/parse-image.ts";
import type { ToolHandler } from "@/engine/tools/contract.ts";
import { uuidv4 } from "@/kernel/std/id.ts";
import type { ForkEvent } from "@/kernel/std/types/events.ts";
import type { Message, ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

// Capture + e2ee encrypt + relay round-trip for a ~500KB PNG runs 10-20s live;
// 8s starved every first attempt.
const SCREENSHOT_TIMEOUT_MS = 30_000;
const DIAGNOSTIC_TIMEOUT_MS = 15_000;
const VERIFIER_TIMEOUT_MS = 300_000;
const VERIFIER_SOURCE_CAP = 24000;

export type VerifierVerdict = "done" | "needs_work";

// A run can also end without any verdict (crash, timeout, dead preview). That
// outcome is distinct from "done": unverified work must never read as passed.
export type VerifierOutcome = VerifierVerdict | "inconclusive";

export interface VerifierFinding {
  path: string;
  description: string;
}

// Mutable per-run state shared with the verifier's tools via closure: the file
// most recently rendered (diagnostics target) and the reported verdict.
export interface VerifierRunState {
  lastShownPath: string | null;
  verdict: VerifierVerdict | null;
  description: string;
}

export function truncateVerifierSource(source: string | undefined): string {
  if (!source) return "";
  return source.length > VERIFIER_SOURCE_CAP
    ? `${source.slice(0, VERIFIER_SOURCE_CAP)}\n… (source truncated)`
    : source;
}

export const VERIFIER_FORK_BODY = `You are a verification fork, split off after a design turn to check one finished screen. You are not
the main design agent and you never edit anything — your single deliverable is a verdict.

Do exactly this, in order:
1. show_html on the file under verification (request the screenshot when available).
2. get_webview_logs — any console errors, uncaught exceptions, or failed resource loads?
3. Study the screenshot: clipping, overflow, cut-off or overlapping text, broken spacing or alignment,
   unreadable contrast, missing content the conversation promised.
4. When something looks off, probe it with eval_js before reporting: read the computed style and
   bounding rect of the suspect element AND its parent, and name the constraint that actually causes
   the symptom (box-sizing, flex min-height, a percentage height with no resolved parent height) so
   the fix targets the cause, not the pixel.
5. If the source references var(--*) custom properties, collect every property defined in the loaded
   stylesheets with eval_js and report any referenced name that is never defined.
6. Call verification_feedback ONCE with your verdict — that is your only exit. A text-only reply is a
   dead end; the verdict must arrive through the tool call.

Verdict bar: needs_work is for real, actionable defects only — broken layout, console errors, missing
content, unresolved design tokens. Taste differences and nitpicks are a "done". When the verdict is
needs_work, the description must say what is broken, how you know (which console line, which visual
defect, which probe result), and the root cause you diagnosed.

Never mutate the page: no localStorage/sessionStorage/indexedDB writes or clears, no DOM edits — the
render surface is shared with the user's live view. Probe, read, and report.`;

function forkUnavailable(callId: string): ToolResult {
  return { tool_use_id: callId, content: "design fork context is unavailable", is_error: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requestScreenshot(
  fork: DesignForkContext,
  path: string,
  signal: AbortSignal | undefined,
): Promise<{ data: string; mediaType: "image/png" } | null> {
  const requestId = uuidv4();
  fork.emit(
    notify("$/screenshot-request", {
      requestId,
      designId: fork.designId,
      artifactId: stableArtifactId(fork.designId, path),
      path,
    }),
  );
  const timeout = AbortSignal.timeout(SCREENSHOT_TIMEOUT_MS);
  return awaitScreenshot(requestId, signal ? AbortSignal.any([signal, timeout]) : timeout);
}

function diagnosticSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(DIAGNOSTIC_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// The verifier's tools close over the run state so show_html can set the
// diagnostics target and verification_feedback can deposit the verdict.
export function makeVerifierTools(state: VerifierRunState): ToolHandler[] {
  const showHtml: ToolHandler = {
    schema: {
      name: "show_html",
      description:
        "Render a screen file in the verification viewport. Pass screenshot: true to get the rendered pixels back inline with this result. The user's view is not affected.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          screenshot: { type: "boolean" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    isConcurrencySafe: false,
    async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
      const input = isRecord(call.input) ? call.input : {};
      const path = typeof input.path === "string" ? input.path : "";
      if (path.length === 0) {
        return { tool_use_id: call.id, content: "path must be a non-empty string", is_error: true };
      }
      const fork = designForkContextFor(ctx);
      const snapshot = fork?.snapshots.get(fork.designId);
      if (!fork || !snapshot) return forkUnavailable(call.id);
      if (!snapshot.files.some((file) => file.path === path)) {
        return { tool_use_id: call.id, content: `no such screen: ${path}`, is_error: true };
      }
      const wantsScreenshot = input.screenshot === true;
      const shot = await requestScreenshot(fork, path, ctx.abortSignal);
      state.lastShownPath = path;
      if (!wantsScreenshot) {
        return { tool_use_id: call.id, content: `Rendered ${path} in the verifier viewport.` };
      }
      if (!shot) {
        return {
          tool_use_id: call.id,
          content: `Rendered ${path}, but the screenshot did not come back — inspect via get_webview_logs and eval_js instead.`,
        };
      }
      if (canSendNatively(ctx.provider, ctx.model)) {
        return {
          tool_use_id: call.id,
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: shot.mediaType, data: shot.data },
            },
            { type: "text", text: `Rendered ${path}.` },
          ],
        };
      }
      const described = await describeImageViaProvider(
        ctx,
        { data: shot.data, mediaType: shot.mediaType },
        "Describe this rendered design screen factually: layout, text content, any visible defects (clipping, overflow, overlap, misalignment, contrast problems).",
      );
      if ("error" in described) {
        return { tool_use_id: call.id, content: `Rendered ${path}. (screenshot not describable)` };
      }
      return {
        tool_use_id: call.id,
        content: `Rendered ${path}. Screenshot description:\n${described.text}`,
      };
    },
  };

  const getWebviewLogs: ToolHandler = {
    schema: {
      name: "get_webview_logs",
      description:
        "Get console logs and errors from the screen most recently rendered with show_html.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    isConcurrencySafe: false,
    async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
      const fork = designForkContextFor(ctx);
      if (!fork) return forkUnavailable(call.id);
      if (!state.lastShownPath) {
        return { tool_use_id: call.id, content: "call show_html first", is_error: true };
      }
      const requestId = uuidv4();
      fork.emit(
        notify("$/webview-logs-request", {
          requestId,
          designId: fork.designId,
          path: state.lastShownPath,
        }),
      );
      const payload = await awaitWebviewLogs(requestId, diagnosticSignal(ctx.abortSignal));
      if (!payload) {
        return { tool_use_id: call.id, content: "(no logs: web preview unavailable)" };
      }
      return {
        tool_use_id: call.id,
        content: payload.logs.length > 0 ? payload.logs.join("\n") : "(no logs)",
      };
    },
  };

  const evalJs: ToolHandler = {
    schema: {
      name: "eval_js",
      description:
        "Evaluate JavaScript inside the screen most recently rendered with show_html and return the serialized result — probe computed styles, bounding rects, and defined CSS custom properties. Read-only: never write or clear storage, never mutate the DOM.",
      inputSchema: {
        type: "object",
        properties: { code: { type: "string" } },
        required: ["code"],
        additionalProperties: false,
      },
    },
    isConcurrencySafe: false,
    async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
      const input = isRecord(call.input) ? call.input : {};
      const code = typeof input.code === "string" ? input.code : "";
      if (code.length === 0) {
        return { tool_use_id: call.id, content: "code must be a non-empty string", is_error: true };
      }
      const fork = designForkContextFor(ctx);
      if (!fork) return forkUnavailable(call.id);
      if (!state.lastShownPath) {
        return { tool_use_id: call.id, content: "call show_html first", is_error: true };
      }
      const requestId = uuidv4();
      fork.emit(
        notify("$/eval-request", {
          requestId,
          designId: fork.designId,
          path: state.lastShownPath,
          code,
        }),
      );
      const payload = await awaitEvalResult(requestId, diagnosticSignal(ctx.abortSignal));
      if (!payload) {
        return { tool_use_id: call.id, content: "(no result: web preview unavailable)" };
      }
      if (!payload.ok) {
        return {
          tool_use_id: call.id,
          content: payload.error ?? "evaluation failed",
          is_error: true,
        };
      }
      return { tool_use_id: call.id, content: payload.result ?? "undefined" };
    },
  };

  const verificationFeedback: ToolHandler = {
    schema: {
      name: "verification_feedback",
      description:
        "Report your verification verdict and terminate. Call this ONCE when you are done checking. verdict 'done' when the output is correct; 'needs_work' ONLY for real, actionable problems — the description must say what is broken and how you know.",
      inputSchema: {
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["done", "needs_work"] },
          description: {
            type: "string",
            description: "Required when verdict is needs_work; omit when done.",
          },
        },
        required: ["verdict"],
        additionalProperties: false,
      },
    },
    isConcurrencySafe: false,
    async run(call: ToolCall): Promise<ToolResult> {
      const input = isRecord(call.input) ? call.input : {};
      const verdict = input.verdict === "needs_work" ? "needs_work" : "done";
      const description = typeof input.description === "string" ? input.description : "";
      if (verdict === "needs_work" && description.length === 0) {
        return {
          tool_use_id: call.id,
          content: "description is required when verdict is needs_work",
          is_error: true,
        };
      }
      state.verdict = verdict;
      state.description = description;
      return { tool_use_id: call.id, content: "Verdict recorded — you are done. Stop." };
    },
  };

  return [showHtml, getWebviewLogs, evalJs, verificationFeedback, ReadDesignTool];
}

// Names the bridge permission resolver must auto-allow when a verifier fork is
// running (they are not part of the main design allow set).
export const VERIFIER_TOOL_NAMES: ReadonlySet<string> = new Set([
  "show_html",
  "get_webview_logs",
  "eval_js",
  "verification_feedback",
  ReadDesignTool.schema.name,
]);

export function finalVerdict(state: VerifierRunState): {
  verdict: VerifierOutcome;
  description: string;
} {
  if (state.verdict === null) {
    return { verdict: "inconclusive", description: "(verifier ended without a verdict)" };
  }
  return { verdict: state.verdict, description: state.description };
}

async function runDesignVerifier(args: {
  ctx: RpcContext;
  designId: string;
  requestContext: RequestContext;
  path: string;
  source: string | undefined;
}): Promise<{ verdict: VerifierOutcome; description: string }> {
  const { ctx, designId, requestContext, path, source } = args;
  const state: VerifierRunState = { lastShownPath: null, verdict: null, description: "" };
  const tools = makeVerifierTools(state);
  const declarations = tools.map((tool) => ({
    name: tool.schema.name,
    description: tool.schema.description,
    input_schema: tool.schema.inputSchema,
  }));
  const allowSet = new Set(tools.map((tool) => tool.schema.name));
  let verifierForkId: string | null = null;
  const sink = (event: ForkEvent): void => {
    if (event.kind === "fork_start") {
      verifierForkId = event.forkId;
      registerDesignFork(event.forkId, {
        designId,
        cwd: ctx.cwd,
        snapshots: ctx.snapshots,
        emit: ctx.emit,
      });
      return;
    }
    if (event.kind === "fork_tool_dispatch_start") {
      // Persist verifier cards too (lane "verifier") so a reload rebuilds the
      // verifier activity group instead of dropping it from the timeline.
      recordToolStart(ctx, designId, event.toolCallId, event.toolName, event.input, "verifier");
      ctx.emit(
        notify("$/tool", {
          id: event.toolCallId,
          name: event.toolName,
          phase: "running",
          lane: "verifier",
          preview: event.input,
        }),
      );
      return;
    }
    if (event.kind === "fork_tool_dispatch_complete") {
      recordToolEnd(
        ctx,
        designId,
        event.toolCallId,
        event.toolName,
        event.isError,
        event.content,
        "verifier",
      );
      ctx.emit(
        notify("$/tool", {
          id: event.toolCallId,
          name: event.toolName,
          phase: event.isError ? "error" : "done",
          lane: "verifier",
          preview: event.content,
        }),
      );
    }
  };
  const timeout = AbortSignal.timeout(VERIFIER_TIMEOUT_MS);
  const baseSignal = requestContext.abortSignal;
  const verifierContext: RequestContext = {
    ...requestContext,
    abortSignal: baseSignal ? AbortSignal.any([baseSignal, timeout]) : timeout,
  };
  const prompt = [
    `Verify this file now: ${path}`,
    "",
    "Current source of the file under verification:",
    "```html",
    truncateVerifierSource(source),
    "```",
  ].join("\n");
  const spec = {
    ctx: verifierContext,
    name: "design-verifier",
    body: VERIFIER_FORK_BODY,
    allowSet,
    deferredAllow: new Set<string>(),
    description: "Design verification",
    extraDeclarations: declarations,
    scopedTools: tools,
    sink,
  };
  try {
    // Seed the screenshot inline when the provider can see pixels natively so
    // the verifier starts from the render instead of burning a show_html call;
    // show_html stays available for a re-render after fixes or probes.
    const fork: DesignForkContext = {
      designId,
      cwd: ctx.cwd,
      snapshots: ctx.snapshots,
      emit: ctx.emit,
    };
    const shot = canSendNatively(requestContext.provider, requestContext.model)
      ? await requestScreenshot(fork, path, verifierContext.abortSignal)
      : null;
    if (shot) {
      state.lastShownPath = path;
      const initialMessages: Message[] = [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: shot.mediaType, data: shot.data },
            },
            { type: "text", text: `${prompt}\n\nThe rendered screenshot is attached above.` },
          ],
        },
      ];
      await runForkLoopExternal({ ...spec, prompt, initialMessages });
    } else {
      await runForkLoopExternal({ ...spec, prompt });
    }
  } catch {
    // A crashed verifier must never fail the design turn — treat as no verdict.
  } finally {
    if (verifierForkId) unregisterDesignFork(verifierForkId);
  }
  return finalVerdict(state);
}

/**
 * Run the background verifier for every screen queued by
 * ready_for_verification this turn, sequentially, re-reading each screen's
 * current content at run time. Returns only the needs_work findings.
 */
export async function drainVerificationQueue(args: {
  ctx: RpcContext;
  designId: string;
  requestContext: RequestContext;
}): Promise<VerifierFinding[]> {
  const { ctx, designId, requestContext } = args;
  const findings: VerifierFinding[] = [];
  for (const path of drainVerificationPaths(designId)) {
    if (requestContext.abortSignal?.aborted) break;
    const snapshot: DesignSnapshot | undefined = ctx.snapshots.get(designId);
    const file = snapshot?.files.find((entry) => entry.path === path);
    if (!file) continue;
    let result = await runDesignVerifier({
      ctx,
      designId,
      requestContext,
      path,
      source: file.content,
    });
    // One fresh run covers the transient failures (relay stall, provider
    // hiccup). A second inconclusive is surfaced as-is: the timeline shows a
    // verifier that never reached a verdict, never a silent pass.
    if (result.verdict === "inconclusive" && !requestContext.abortSignal?.aborted) {
      result = await runDesignVerifier({
        ctx,
        designId,
        requestContext,
        path,
        source: file.content,
      });
    }
    if (result.verdict === "needs_work") {
      findings.push({ path, description: result.description });
    }
  }
  return findings;
}
