import type { PermissionMode } from "@/kernel/std/types/request.ts";
import {
  type BrokerState,
  getProcessBroker,
  nextPermissionMode,
} from "@/store/app-store/broker.ts";
import { appStore, dispatch } from "@/store/app-store/index.ts";
import { applyBrokerEvent, readBrokerSlice } from "@/store/subscribers/broker.ts";

export const STRING_VIEW_DEMO_BROKER_STATE: BrokerState = {
  provider: "codex",
  model: "gpt-5.6-sol",
  effort: "high",
  fastMode: true,
  permissionMode: "yolo",
  orchestrationMode: "disabled",
};

/**
 * The route the chrome states. The live broker is the truth and answers first, so a
 * frame painted between a route change and its mirror write still names the new route;
 * the mirror answers where no process broker exists, and the stand-in route only ever
 * answers a store that carries nothing at all.
 */
export function readStringViewBrokerState(): BrokerState {
  return (
    getProcessBroker()?.read() ??
    readBrokerSlice(appStore.getState().engine) ??
    STRING_VIEW_DEMO_BROKER_STATE
  );
}

/**
 * The shift+tab step, wherever it is pressed: the session's permission mode advances
 * one place in the cycle. One writer so the chat and the confirmation surface move the
 * same mode the same way. Answers the mode the session now runs in.
 */
export function cycleStringViewPermissionMode(): PermissionMode {
  const mode = nextPermissionMode(readStringViewBrokerState().permissionMode);
  applyBrokerEvent({ kind: "cycle_permission_mode" }, { permissionMode: mode });
  return mode;
}

export function seedStringViewBrokerState(): void {
  if (readBrokerSlice(appStore.getState().engine) !== undefined) return;
  if (getProcessBroker() !== undefined) return;
  dispatch({ type: "engine/setSlice", key: "broker", value: STRING_VIEW_DEMO_BROKER_STATE });
}
