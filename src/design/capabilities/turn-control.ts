import { fail, RPC_INVALID_PARAMS, success } from "@/design/bridge/envelope.ts";
import {
  resolveEvalResult,
  resolveLoadReport,
  resolvePermission,
  resolveQuestion,
  resolveScreenshot,
  resolveWebviewLogs,
} from "@/design/pending.ts";
import { cancelDesignTurn } from "@/design/turns.ts";
import type { DesignCapability, JsonRpcId, RpcContext } from "@/design/types.ts";

interface IdInput {
  designId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseId(params: unknown, fallbackDesignId: string): IdInput | string {
  if (params === undefined || params === null) return { designId: fallbackDesignId };
  if (!isRecord(params)) return "params must be an object";
  if (params.designId === undefined) return { designId: fallbackDesignId };
  if (typeof params.designId !== "string" || params.designId.length === 0) {
    return "designId must be a non-empty string";
  }
  return { designId: params.designId };
}

function decisionFrom(value: unknown): "allow" | "deny" {
  return value === "allow" || value === "once" || value === "session" ? "allow" : "deny";
}

function answerText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

function handleCancel(params: unknown, ctx: RpcContext, id: JsonRpcId): void {
  const parsed = parseId(params, ctx.designId);
  if (typeof parsed === "string") {
    ctx.send(fail(id, RPC_INVALID_PARAMS, parsed));
    return;
  }
  ctx.send(success(id, { cancelled: cancelDesignTurn(parsed.designId) }));
}

function handlePermissionRespond(params: unknown, ctx: RpcContext, id: JsonRpcId): void {
  if (!isRecord(params) || typeof params.requestId !== "string") {
    ctx.send(fail(id, RPC_INVALID_PARAMS, "requestId must be a string"));
    return;
  }
  const resolved = resolvePermission(params.requestId, decisionFrom(params.decision));
  ctx.send(success(id, { ok: resolved }));
}

function handleQuestionRespond(params: unknown, ctx: RpcContext, id: JsonRpcId): void {
  if (!isRecord(params) || typeof params.requestId !== "string") {
    ctx.send(fail(id, RPC_INVALID_PARAMS, "requestId must be a string"));
    return;
  }
  const resolved = resolveQuestion(params.requestId, answerText(params.answer));
  ctx.send(success(id, { ok: resolved }));
}

function handleScreenshotRespond(params: unknown, ctx: RpcContext, id: JsonRpcId): void {
  if (!isRecord(params) || typeof params.requestId !== "string") {
    ctx.send(fail(id, RPC_INVALID_PARAMS, "requestId must be a string"));
    return;
  }
  if (typeof params.data === "string" && params.data.length > 0) {
    const resolved = resolveScreenshot(params.requestId, {
      data: params.data,
      mediaType: "image/png",
    });
    ctx.send(success(id, { ok: resolved }));
    return;
  }
  const resolved = resolveScreenshot(params.requestId, null);
  ctx.send(success(id, { ok: resolved }));
}

// Defensive caps for browser-supplied diagnostic payloads: entry counts and
// per-entry length are clamped so a chatty page can't bloat the tool result.
const DIAGNOSTIC_MAX_ENTRIES = 50;
const DIAGNOSTIC_MAX_ENTRY_CHARS = 500;
const EVAL_RESULT_MAX_CHARS = 8000;

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .slice(0, DIAGNOSTIC_MAX_ENTRIES)
    .map((entry) => entry.slice(0, DIAGNOSTIC_MAX_ENTRY_CHARS));
}

function handleLoadReportRespond(params: unknown, ctx: RpcContext, id: JsonRpcId): void {
  if (!isRecord(params) || typeof params.requestId !== "string") {
    ctx.send(fail(id, RPC_INVALID_PARAMS, "requestId must be a string"));
    return;
  }
  const resolved = resolveLoadReport(params.requestId, {
    ok: params.ok === true,
    errors: stringArray(params.errors),
    logs: stringArray(params.logs),
  });
  ctx.send(success(id, { ok: resolved }));
}

function handleWebviewLogsRespond(params: unknown, ctx: RpcContext, id: JsonRpcId): void {
  if (!isRecord(params) || typeof params.requestId !== "string") {
    ctx.send(fail(id, RPC_INVALID_PARAMS, "requestId must be a string"));
    return;
  }
  const resolved = resolveWebviewLogs(params.requestId, { logs: stringArray(params.logs) });
  ctx.send(success(id, { ok: resolved }));
}

function handleEvalResultRespond(params: unknown, ctx: RpcContext, id: JsonRpcId): void {
  if (!isRecord(params) || typeof params.requestId !== "string") {
    ctx.send(fail(id, RPC_INVALID_PARAMS, "requestId must be a string"));
    return;
  }
  const resolved = resolveEvalResult(params.requestId, {
    ok: params.ok === true,
    ...(typeof params.result === "string"
      ? { result: params.result.slice(0, EVAL_RESULT_MAX_CHARS) }
      : {}),
    ...(typeof params.error === "string"
      ? { error: params.error.slice(0, DIAGNOSTIC_MAX_ENTRY_CHARS) }
      : {}),
  });
  ctx.send(success(id, { ok: resolved }));
}

export const TurnCancelCapability: DesignCapability = {
  name: "turn.cancel",
  rpcMethod: { method: "turn.cancel", handler: handleCancel },
};

export const PermissionRespondCapability: DesignCapability = {
  name: "permission.respond",
  rpcMethod: { method: "permission.respond", handler: handlePermissionRespond },
};

export const QuestionRespondCapability: DesignCapability = {
  name: "question.respond",
  rpcMethod: { method: "question.respond", handler: handleQuestionRespond },
};

export const ScreenshotRespondCapability: DesignCapability = {
  name: "design.screenshot",
  rpcMethod: { method: "design.screenshot", handler: handleScreenshotRespond },
};

export const LoadReportRespondCapability: DesignCapability = {
  name: "design.loadReport",
  rpcMethod: { method: "design.loadReport", handler: handleLoadReportRespond },
};

export const WebviewLogsRespondCapability: DesignCapability = {
  name: "design.webviewLogs",
  rpcMethod: { method: "design.webviewLogs", handler: handleWebviewLogsRespond },
};

export const EvalResultRespondCapability: DesignCapability = {
  name: "design.evalResult",
  rpcMethod: { method: "design.evalResult", handler: handleEvalResultRespond },
};
