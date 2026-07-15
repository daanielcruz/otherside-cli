import type { CompactState } from "@/engine/queue/runtime/compact/orchestration.ts";
import type { UsageSnapshot } from "@/engine/session/compact/token-count.ts";
import type { Session } from "@/engine/session/index.ts";
import type { InjectionQueue } from "@/harness/composer/injections.ts";
import type { UserConfig } from "@/kernel/config/config.ts";
import type { DrainedQueuedMessage } from "@/kernel/std/types/events.ts";
import type { BrokerHandle } from "@/kernel/std/types/request.ts";

export interface AgentDeps {
  broker: BrokerHandle;
  session: Session;
  config: UserConfig;
  getLastUsage?: () => UsageSnapshot | null;
}

export interface TurnLoopHost {
  cancelled: boolean;
  currentTurnId: string | null;
  activeAbortController: AbortController | null;
  readonly activeToolAbortControllers: Set<AbortController>;
  readonly injections: InjectionQueue;
  readonly deps: AgentDeps;
  readonly compactState: CompactState;
  readonly sessionAllowedToolPatterns: Set<string>;
  readonly loadedNestedMemoryPaths: Set<string>;
  readonly nestedMemoryByPath: Map<string, string>;
  readonly pendingUserInputDrainer: (() => DrainedQueuedMessage[]) | null;
  cancel(): void;
  getNestedMemorySnapshot(): { path: string; content: string }[];
}
