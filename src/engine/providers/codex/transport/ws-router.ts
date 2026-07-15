import type { CodexSessionState } from "@/engine/providers/codex/transport/state.ts";

export const TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.failed",
  "response.error",
  "response.cancelled",
  "response.incomplete",
  "error",
]);

// Terminal frames that report a backend failure. A socket that just carried one
// must not be reused for the next retry attempt: the follow-up response.create
// can be silently ignored by the broken server-side session, leaving the retry
// waiting on the long idle deadlines instead of failing fast on a fresh socket.
export const ERROR_TERMINAL_EVENTS = new Set(["response.failed", "response.error", "error"]);

export const WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached";
export const WEBSOCKET_CONNECTION_LIMIT_REACHED_MESSAGE =
  "Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue.";

type RouterEnvelope = { type?: unknown; response?: { id?: unknown; generate?: unknown } };

export class CodexWsConnectionLimitError extends Error {
  override cause?: unknown;
  constructor(cause?: unknown) {
    super(WEBSOCKET_CONNECTION_LIMIT_REACHED_MESSAGE);
    this.name = "CodexWsConnectionLimitError";
    if (cause !== undefined) this.cause = cause;
  }
}

export class CodexWsClosedBeforeCompletionError extends Error {
  constructor(code: number, reason: string) {
    const reasonText = reason.length > 0 ? `: ${reason}` : "";
    super(`codex ws closed before completion (code ${code}${reasonText})`);
    this.name = "CodexWsClosedBeforeCompletionError";
  }
}

const CONNECTION_LIMIT_LOOSE_MESSAGE = /responses?\s+websocket\s+connection\s+limit\s+reached/i;

export function isCodexWsConnectionLimitCode(code: string): boolean {
  return code === WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE;
}

export function isCodexWsConnectionLimitMessage(text: string): boolean {
  if (text.includes(WEBSOCKET_CONNECTION_LIMIT_REACHED_MESSAGE)) return true;
  return CONNECTION_LIMIT_LOOSE_MESSAGE.test(text);
}

const ERROR_CODE_MAX_RECURSION_DEPTH = 2;

function errorCodeFromErrorEnvelope(value: unknown): string | null {
  function walk(v: unknown, depth: number): string | null {
    if (!v || typeof v !== "object" || depth > ERROR_CODE_MAX_RECURSION_DEPTH) return null;
    const code = Reflect.get(v, "code");
    if (typeof code === "string" && isCodexWsConnectionLimitCode(code)) return code;
    const message = Reflect.get(v, "message");
    if (typeof message === "string" && isCodexWsConnectionLimitMessage(message)) {
      return WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE;
    }
    return walk(Reflect.get(v, "error"), depth + 1) ?? walk(Reflect.get(v, "response"), depth + 1);
  }
  return walk(value, 0);
}

function errorCodeFromEnvelope(parsed: RouterEnvelope): string | null {
  if (parsed.type !== "error" && parsed.type !== "response.error") return null;
  return errorCodeFromErrorEnvelope(parsed);
}

function resolveResponseId(parsed: RouterEnvelope): string | null {
  const envelopeId = parsed.response?.id;
  if (typeof envelopeId === "string" && envelopeId.length > 0) return envelopeId;
  const topId = Reflect.get(parsed, "response_id");
  if (typeof topId === "string" && topId.length > 0) return topId;
  return null;
}

function isPrewarmDrop(
  parsed: RouterEnvelope,
  typeName: string,
  prewarmIds: Set<string>,
): { drop: boolean; learnedId: string | null } {
  const envelope = parsed.response;
  if (envelope && envelope.generate === false) {
    if (typeName === "response.created") {
      const id = typeof envelope.id === "string" ? envelope.id : null;
      return { drop: true, learnedId: id };
    }
    return { drop: true, learnedId: null };
  }
  const respId = resolveResponseId(parsed);
  if (respId && prewarmIds.has(respId)) return { drop: true, learnedId: null };
  return { drop: false, learnedId: null };
}

export interface FrameRouterState {
  queue: Uint8Array[];
  drain: () => void;
  setSawTerminal: (v: boolean) => void;
  setSawErrorTerminal?: (v: boolean) => void;
  setClosed: (v: boolean) => void;
  setError?: (err: Error) => void;
  session: CodexSessionState;
  prewarmIds: Set<string>;
}

const FRAME_DECODER = new TextDecoder();
const FRAME_ENCODER = new TextEncoder();

export function buildWsFrameRouter(
  state: FrameRouterState,
): (data: Buffer | ArrayBuffer | Buffer[]) => void {
  return function handleFrame(data: Buffer | ArrayBuffer | Buffer[]): void {
    let payload: string;
    if (Buffer.isBuffer(data)) payload = data.toString("utf8");
    else if (Array.isArray(data)) payload = Buffer.concat(data).toString("utf8");
    else payload = FRAME_DECODER.decode(new Uint8Array(data));

    let typeName = "";
    let data1Line = payload;
    let parsed: RouterEnvelope = {};
    try {
      const json = JSON.parse(payload);
      if (json && typeof json === "object") parsed = json as RouterEnvelope;
      if (typeof parsed.type === "string") typeName = parsed.type;
      if (payload.includes("\n")) data1Line = JSON.stringify(parsed);
    } catch {}

    if (errorCodeFromEnvelope(parsed) !== null) {
      state.setError?.(new CodexWsConnectionLimitError());
      state.setClosed(true);
      state.drain();
      return;
    }

    const { drop, learnedId } = isPrewarmDrop(parsed, typeName, state.prewarmIds);
    if (learnedId) state.prewarmIds.add(learnedId);

    if (drop) {
      if (typeName && TERMINAL_EVENTS.has(typeName)) {
        const respId = resolveResponseId(parsed);
        if (respId) state.prewarmIds.delete(respId);
      }
      return;
    }

    const sseFrame = typeName
      ? `event: ${typeName}\ndata: ${data1Line}\n\n`
      : `data: ${data1Line}\n\n`;
    const bytes = FRAME_ENCODER.encode(sseFrame);
    state.queue.push(bytes);
    state.drain();
    if (typeName && TERMINAL_EVENTS.has(typeName)) {
      state.setSawTerminal(true);
      if (ERROR_TERMINAL_EVENTS.has(typeName)) state.setSawErrorTerminal?.(true);
      state.setClosed(true);
      state.drain();
    }
  };
}
