/**
 * Requests that arrive FROM a server.
 *
 * Almost everything on this wire runs the other way, so a message carrying both
 * a method and an id used to be dropped: the server then waited on a reply that
 * was never coming, for as long as it was willing to. Every such message is
 * answered now — with the responder's result, or with the protocol's own "no
 * such method" when nothing here serves it.
 *
 * A responder lives above the kernel, where the user and the hooks are, so it is
 * registered into this table rather than reached down for.
 */

/** JSON-RPC's code for a method the receiver does not implement. */
export const METHOD_NOT_FOUND = -32601;
/** JSON-RPC's code for a responder that threw. */
export const INTERNAL_ERROR = -32603;

export interface InboundRequest {
  /** Which server asked, so a responder can name it to the reader. */
  server: string;
  method: string;
  params: unknown;
  /** Aborted when the connection goes away mid-question. */
  signal: AbortSignal;
}

export type InboundResponder = (request: InboundRequest) => Promise<unknown>;

export interface InboundAnswer {
  result?: unknown;
  error?: { code: number; message: string };
}

const responders = new Map<string, InboundResponder>();

/** Registers the responder for one method. Returns a teardown. */
export function registerInboundResponder(method: string, responder: InboundResponder): () => void {
  responders.set(method, responder);
  return () => {
    if (responders.get(method) === responder) responders.delete(method);
  };
}

export function clearInboundResponders(): void {
  responders.clear();
}

/**
 * The answer to send back. A method nobody serves is not an error on our side —
 * it is the protocol's way of saying so, and it frees the server immediately.
 */
export async function answerInbound(request: InboundRequest): Promise<InboundAnswer> {
  const responder = responders.get(request.method);
  if (responder === undefined) {
    return { error: { code: METHOD_NOT_FOUND, message: `Method not found: ${request.method}` } };
  }
  try {
    return { result: await responder(request) };
  } catch (error) {
    return {
      error: {
        code: INTERNAL_ERROR,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Answers one inbound request over whatever the transport writes with. Every
 * transport that can receive a request calls this, so what a server hears back
 * does not depend on which one carried it.
 */
export async function replyToInbound(options: {
  message: { id: number | string; method: string; params?: unknown };
  server: string;
  signal: AbortSignal;
  send: (reply: object) => void;
}): Promise<void> {
  const { message, server, signal, send } = options;
  const answer = await answerInbound({
    server,
    method: message.method,
    params: message.params,
    signal,
  });
  send({ jsonrpc: "2.0", id: message.id, ...answer });
}

/** Whether a parsed message is a request from the server rather than a reply. */
export function isInboundRequest(
  message: unknown,
): message is { id: number | string; method: string; params?: unknown } {
  if (typeof message !== "object" || message === null) return false;
  const record = message as Record<string, unknown>;
  const id = record.id;
  return typeof record.method === "string" && (typeof id === "number" || typeof id === "string");
}

/**
 * A method with no id: the server telling us something rather than asking. It
 * expects no reply, so an unwatched one is simply not news — but a watched one
 * that never arrives is a catalog going stale behind our back.
 */
export function isInboundNotice(message: unknown): message is { method: string; params?: unknown } {
  if (typeof message !== "object" || message === null) return false;
  const record = message as Record<string, unknown>;
  return typeof record.method === "string" && record.id === undefined;
}

export type NoticeWatcher = (notice: { server: string; params: unknown }) => void;

const watchers = new Map<string, Set<NoticeWatcher>>();

/** Watches one notification method. Returns a teardown. */
export function watchInboundNotice(method: string, watcher: NoticeWatcher): () => void {
  const forMethod = watchers.get(method) ?? new Set<NoticeWatcher>();
  forMethod.add(watcher);
  watchers.set(method, forMethod);
  return () => {
    forMethod.delete(watcher);
    if (forMethod.size === 0) watchers.delete(method);
  };
}

export function clearInboundWatchers(): void {
  watchers.clear();
}

/** Hands a notification to whoever watches it. Nothing watching is not an error. */
export function deliverInboundNotice(notice: {
  server: string;
  method: string;
  params: unknown;
}): void {
  const forMethod = watchers.get(notice.method);
  if (forMethod === undefined) return;
  for (const watcher of [...forMethod]) {
    try {
      watcher({ server: notice.server, params: notice.params });
    } catch {
      // One watcher throwing must not cost the others their notice.
    }
  }
}
