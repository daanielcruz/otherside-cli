import type { PermissionMode } from "@/kernel/std/types/permission-mode.ts";
import type { ProviderId, ProviderModelRoute } from "@/kernel/std/types/provider-ids.ts";

export interface SessionRecord {
  type: string;
  /**
   * Transcript identity, stamped when the line is written. It is the only name
   * for a record that survives the array being rebuilt or trimmed on resume,
   * so anything that must still point at the same record across loads holds
   * this rather than a position.
   */
  uuid?: string;
  content?: string;
  thinking?: string;
  isRemote?: boolean;
  remoteEnabled?: boolean;
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
  /**
   * True when `records` stands for history rather than reproducing it: a large
   * resume aggregates the turns it did not materialize. A position into the
   * array names nothing under this, and a write rebuilding the transcript from
   * it must refuse.
   */
  recordsArePartial?: boolean;
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
      | { kind: "set_route"; route: ProviderModelRoute }
      | { kind: "set_permission_mode"; mode: PermissionMode },
  ): void;
}
