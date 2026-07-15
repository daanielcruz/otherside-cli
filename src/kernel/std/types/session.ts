import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { PermissionMode } from "@/kernel/std/types/request.ts";

export interface SessionRecord {
  type: string;
  content?: string;
  thinking?: string;
  isRemote?: boolean;
  inlineImages?: unknown[];
  queueId?: string;
  tool_name?: string;
  args?: unknown;
  call_id?: string;
  meta?: unknown;
  result?: unknown;
  is_error?: boolean;
  source?: string;
  text?: string;
}

export interface Session {
  id: string;
  cwd: string;
  gitBranch?: string;
  records: SessionRecord[];
  usageRecords: SessionRecord[];
}

export interface BrokerStateSnapshot {
  provider: ProviderId;
  model: string;
  permissionMode: PermissionMode;
}

export interface Broker {
  read(): BrokerStateSnapshot;
  subscribe(fn: (state: BrokerStateSnapshot) => void): () => void;
  dispatch(
    action:
      | { kind: "set_provider"; provider: ProviderId; model: string }
      | { kind: "set_permission_mode"; mode: PermissionMode },
  ): void;
}
