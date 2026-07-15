import type { Agent } from "@/engine/queue/index.ts";
import {
  type ContextUsageSnapshot,
  contextUsageTotal,
  mergeContextUsageSnapshot,
} from "@/engine/session/usage/snapshot.ts";
import type { UserConfig } from "@/kernel/config/config.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import { AppController } from "@/ui/app/controller.tsx";
import type { OverlayName } from "@/ui/panels/registry.tsx";
import type { TranscriptEntry } from "@/ui/transcript/types";

export { type ContextUsageSnapshot, contextUsageTotal, mergeContextUsageSnapshot };

export interface AppProps {
  broker: Broker;
  session: import("@/engine/session/index.ts").Session;
  agent: Agent;
  config: UserConfig;
  version: string;
  initialOverlay?: OverlayName | undefined;
  initialOverlayChain?: OverlayName[] | undefined;
  initialLoginProvider?: ProviderId | undefined;
  greeting?: string | undefined;
  initialTranscript?: TranscriptEntry[] | undefined;
}

export type { RewindMode } from "@/engine/session/lifecycle/rewind.ts";

export function App(props: AppProps): React.JSX.Element {
  return <AppController {...props} />;
}
