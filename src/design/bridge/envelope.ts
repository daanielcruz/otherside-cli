import type {
  JsonRpcError,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcSuccess,
} from "@/design/types.ts";

export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

export interface ParsedRequest {
  ok: true;
  value: JsonRpcRequest;
}

export interface ParsedError {
  ok: false;
  error: JsonRpcError;
}

export type ParseResult = ParsedRequest | ParsedError;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseId(value: unknown): JsonRpcId {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  return null;
}

function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function parseRequest(input: unknown): ParseResult {
  if (typeof input !== "string") {
    return { ok: false, error: rpcError(null, RPC_PARSE_ERROR, "non-text frame") };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch {
    return { ok: false, error: rpcError(null, RPC_PARSE_ERROR, "invalid json") };
  }
  if (!isRecord(raw)) {
    return { ok: false, error: rpcError(null, RPC_INVALID_REQUEST, "not an object") };
  }
  if (raw.jsonrpc !== "2.0") {
    return { ok: false, error: rpcError(null, RPC_INVALID_REQUEST, "bad jsonrpc version") };
  }
  if (typeof raw.method !== "string" || raw.method.length === 0) {
    return { ok: false, error: rpcError(null, RPC_INVALID_REQUEST, "missing method") };
  }
  return {
    ok: true,
    value: {
      jsonrpc: "2.0",
      method: raw.method,
      id: parseId(raw.id),
      params: raw.params,
    },
  };
}

export function success(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

export function fail(id: JsonRpcId, code: number, message: string): JsonRpcError {
  return rpcError(id, code, message);
}

export function notify(method: string, params: unknown): JsonRpcNotification {
  return { jsonrpc: "2.0", method, params };
}

export function encode(frame: JsonRpcSuccess | JsonRpcError | JsonRpcNotification): string {
  return JSON.stringify(frame);
}
