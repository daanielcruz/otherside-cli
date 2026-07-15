import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { EffortLevel } from "@/kernel/std/types/effort.ts";

export type PendingChange =
  | {
      kind: "set_model";
      provider: ProviderId;
      model: string;
      fastMode?: boolean;
      persistDefault?: boolean;
    }
  | { kind: "set_effort"; effort: EffortLevel | null }
  | { kind: "set_ultracode"; enabled: boolean }
  | { kind: "set_fast_mode"; enabled: boolean }
  | { kind: "set_goal"; condition: string; metaMessage?: string };
