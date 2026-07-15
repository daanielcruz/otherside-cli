import type { AgentEvent } from "@/kernel/std/types/events.ts";

export type TurnEvent<K extends AgentEvent["kind"]> = Extract<AgentEvent, { kind: K }>;

export type TurnObserver = {
  [K in AgentEvent["kind"]]?: (event: TurnEvent<K>) => void | Promise<void>;
} & {
  onAny?: (event: AgentEvent) => void | Promise<void>;
};
