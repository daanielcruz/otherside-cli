import { invoke, type MethodTable } from "@/design/bridge/dispatch.ts";
import { parseRequest } from "@/design/bridge/envelope.ts";
import type { RpcContext } from "@/design/types.ts";
import { decryptEvent } from "@/remote/crypto/e2ee.ts";
import { type RatchetCacheEntry, ratchetKeyFor } from "@/remote/session/sync/crypto.ts";

const DEC = new TextDecoder();
const REORDER_WINDOW = 16;
// Safe to evict: counterAcceptable already rejects anything below watermark - REORDER_WINDOW,
// so entries this old are never consulted again.
const PROCESSED_EVENT_CAP = 5000;

export interface InboundState {
  processed: Set<string>;
  ratchet: Map<string, RatchetCacheEntry>;
  watermark: Map<string, number>;
}

export function createInboundState(): InboundState {
  return { processed: new Set(), ratchet: new Map(), watermark: new Map() };
}

function counterAcceptable(state: InboundState, sender: string, counter: number): boolean {
  const high = state.watermark.get(sender) ?? 0;
  if (counter > high) return true;
  return counter > high - REORDER_WINDOW;
}

export interface InboundDeps {
  state: InboundState;
  sessionHash: string;
  sessionKey: Uint8Array;
  selfDeviceId: string;
  methodTable: MethodTable;
  ctx: RpcContext;
  onAttach: (webDeviceId: string, webPubB64: string, confirmTokenB64: string) => void;
}

export async function handleRelayRow(
  record: Record<string, unknown>,
  deps: InboundDeps,
): Promise<void> {
  const type = typeof record.type === "string" ? record.type : "";
  const sender = typeof record.sender_device_id === "string" ? record.sender_device_id : "";
  if (sender.length === 0 || sender === deps.selfDeviceId) return;

  if (type === "design_attach") {
    const payload = record.payload as
      | { web_device_id?: string; web_pub_b64?: string; confirm_token?: string }
      | undefined;
    if (
      payload &&
      typeof payload.web_device_id === "string" &&
      typeof payload.web_pub_b64 === "string" &&
      typeof payload.confirm_token === "string"
    ) {
      deps.onAttach(payload.web_device_id, payload.web_pub_b64, payload.confirm_token);
    }
    return;
  }
  if (type !== "design_delta") return;

  const payload = record.payload as { c?: number; n?: string; ct?: string; v?: number } | undefined;
  const counter = payload?.c;
  if (!payload || typeof counter !== "number" || counter <= 0) return;
  const dedupeKey = `${sender}:${counter}`;
  if (deps.state.processed.has(dedupeKey)) return;
  if (!counterAcceptable(deps.state, sender, counter)) return;

  let plaintext: string;
  try {
    const ratchetKey = ratchetKeyFor(deps.state.ratchet, deps.sessionKey, sender, counter);
    const bytes = decryptEvent({
      ratchetKey,
      sessionId: deps.sessionHash,
      eventType: "design_delta",
      senderDeviceId: sender,
      envelope: {
        v: (payload.v ?? 1) as 1,
        c: counter,
        n: payload.n ?? "",
        ct: payload.ct ?? "",
      },
    });
    plaintext = DEC.decode(bytes);
  } catch {
    return;
  }
  deps.state.processed.add(dedupeKey);
  if (deps.state.processed.size > PROCESSED_EVENT_CAP) {
    const oldest = deps.state.processed.values().next().value;
    if (oldest) deps.state.processed.delete(oldest);
  }
  const high = deps.state.watermark.get(sender) ?? 0;
  if (counter > high) deps.state.watermark.set(sender, counter);

  const parsed = parseRequest(plaintext);
  if (!parsed.ok) {
    deps.ctx.send(parsed.error);
    return;
  }
  // Detached on purpose: llm.stream only resolves when the whole turn ends, so
  // awaiting it here would freeze the poll loop for minutes — pings, steers and
  // aborts would sit unread and the web would declare the CLI dead. Handlers run
  // synchronously up to their first await (turn registration included), so
  // row-order still decides steer-vs-new-turn; invoke() reports failures itself.
  void invoke(
    deps.methodTable,
    parsed.value.method,
    parsed.value.params,
    deps.ctx,
    parsed.value.id ?? null,
  );
}
