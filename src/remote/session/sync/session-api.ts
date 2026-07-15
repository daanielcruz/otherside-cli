// Cortex /v1/sessions surface: upsert, patch, get, delete.
import type { Broker } from "@/kernel/std/types/session.ts";
import { findCatalogModel } from "@/kernel/storage/model-catalog.ts";
import { CortexApiError, cortexFetch } from "@/remote/_infra/cortex.ts";
import { httpError } from "./crypto.ts";
import { appPermissionMode } from "./rails/snapshot.ts";

export function sessionModelFields(broker: Broker): {
  provider: string;
  model: string;
  permission_mode: "accept" | "auto" | "plan" | "yolo";
} {
  const brokerState = broker.read();
  const modelEntry = findCatalogModel(brokerState.model, brokerState.provider);
  return {
    provider: brokerState.provider,
    model: modelEntry?.displayName ?? brokerState.model,
    permission_mode: appPermissionMode(brokerState.permissionMode),
  };
}

export async function getSessionRow(
  sessionId: string,
  accessToken: string,
  _select: string,
): Promise<Response> {
  try {
    const data = await cortexFetch<Record<string, unknown>>(`/v1/sessions/${sessionId}`, {
      method: "GET",
      token: accessToken,
    });
    return new Response(JSON.stringify([data]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    if (err instanceof CortexApiError) {
      return new Response(JSON.stringify({ message: err.message, code: err.code }), {
        status: err.httpStatus || 500,
        headers: { "content-type": "application/json" },
      });
    }
    throw err;
  }
}

export async function remoteSessionExists(
  sessionId: string,
  accessToken: string,
): Promise<boolean | null> {
  try {
    await cortexFetch(`/v1/sessions/${sessionId}`, {
      method: "GET",
      token: accessToken,
    });
    return true;
  } catch (err) {
    if (err instanceof CortexApiError) {
      if (err.code === "not_found") return false;
      if (err.code === "unauthorized" || err.code === "forbidden") return null;
      return null;
    }
    return null;
  }
}

export async function patchSessionRow(
  sessionId: string,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<Response> {
  try {
    const data = await cortexFetch(`/v1/sessions/${sessionId}`, {
      method: "PATCH",
      token: accessToken,
      body,
    });
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    if (err instanceof CortexApiError) {
      return new Response(JSON.stringify({ message: err.message, code: err.code }), {
        status: err.httpStatus || 500,
        headers: { "content-type": "application/json" },
      });
    }
    throw err;
  }
}

export async function upsertSessionRow(
  accessToken: string,
  body: Record<string, unknown>,
): Promise<void> {
  try {
    await cortexFetch("/v1/sessions", {
      method: "POST",
      token: accessToken,
      body,
      idempotencyKey: crypto.randomUUID(),
    });
  } catch (err) {
    if (err instanceof CortexApiError) {
      throw httpError(err.httpStatus || 500, err.message);
    }
    throw err;
  }
}

export async function deleteSessionRow(sessionId: string, accessToken: string): Promise<Response> {
  // Cortex has no DELETE session route — end via patch status=ended.
  return patchSessionRow(sessionId, accessToken, { status: "ended" });
}
