import type { Broker, BrokerState } from "@/store/app-store/broker.ts";
import { dispatch } from "@/store/app-store/index.ts";

export function startBrokerSubscriber(broker: Broker): () => void {
  dispatch({ type: "engine/setSlice", key: "broker", value: broker.read() });
  return broker.subscribe((next) => {
    dispatch({ type: "engine/setSlice", key: "broker", value: next });
  });
}

export function readBrokerSlice(
  engine: Readonly<Record<string, unknown>>,
): BrokerState | undefined {
  const value = engine.broker;
  if (value === undefined) return undefined;
  return value as BrokerState;
}
