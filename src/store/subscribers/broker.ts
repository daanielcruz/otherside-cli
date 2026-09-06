import {
  type Broker,
  type BrokerEvent,
  type BrokerState,
  getProcessBroker,
} from "@/store/app-store/broker.ts";
import { appStore, dispatch } from "@/store/app-store/index.ts";

export function startBrokerSubscriber(broker: Broker): () => void {
  dispatch({ type: "engine/setSlice", key: "broker", value: broker.read() });
  return broker.subscribe((next) => {
    dispatch({ type: "engine/setSlice", key: "broker", value: next });
  });
}

/**
 * Merge a partial update over the current broker route and mirror it into the
 * engine slice. The live broker answers for the baseline when present so a patch
 * written mid-transition never resurrects stale fields from the mirror.
 */
export function applyBrokerPatch(patch: Partial<BrokerState>): void {
  const baseline = getProcessBroker()?.read() ?? readBrokerSlice(appStore.getState().engine);
  dispatch({ type: "engine/setSlice", key: "broker", value: { ...baseline, ...patch } });
}

/**
 * Route a state change through the live broker when one exists — its subscriber
 * mirrors the result into the store — and fall back to patching the mirror when
 * no broker runs (demos, tests). Writing only the mirror while a broker is live
 * changes nothing: reads answer from the broker and its next event overwrites
 * the slice.
 */
export function applyBrokerEvent(event: BrokerEvent, fallbackPatch: Partial<BrokerState>): void {
  const live = getProcessBroker();
  if (live !== undefined) {
    live.dispatch(event);
    return;
  }
  applyBrokerPatch(fallbackPatch);
}

export function readBrokerSlice(
  engine: Readonly<Record<string, unknown>>,
): BrokerState | undefined {
  const value = engine.broker;
  if (value === undefined) return undefined;
  return value as BrokerState;
}
