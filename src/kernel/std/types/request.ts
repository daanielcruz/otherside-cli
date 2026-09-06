import type { EffortLevel } from "@/kernel/std/types/effort.ts";
import type {
  BackgroundController,
  CodexSubAgentLabel,
  ForkEventSink,
  ToolProgressSink,
} from "@/kernel/std/types/events.ts";
import type { HookEntry } from "@/kernel/std/types/hook-entry.ts";
import type { Message, ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { OrchestrationMode } from "@/kernel/std/types/orchestration-mode.ts";
import type { PermissionMode } from "@/kernel/std/types/permission-mode.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";

export type { PermissionMode };

export interface BrokerState {
  provider: ProviderId;
  model: string;
  effort: EffortLevel | null;
  fastMode: boolean;
  permissionMode: PermissionMode;
  prePlanMode?: PermissionMode;
  ultracode?: boolean;
  /** Session-scoped orchestration mode; config only seeds new sessions. */
  orchestrationMode: OrchestrationMode;
}

export interface BrokerHandle {
  read(): Readonly<BrokerState>;
  dispatch(event: { kind: string; [key: string]: unknown }): void;
}

export interface ScopedToolHandler {
  schema: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  };
  run(call: ToolCall, ctx: RequestContext): Promise<ToolResult>;
  coerceInput?(input: unknown): unknown;
  steerValidationError?(input: unknown): string | null;
}

export interface ToolOutputArchive {
  observedCallIds: Set<string>;
  notices: Map<string, string>;
}

export interface RequestContext {
  provider: ProviderId;
  model: string;
  effort: EffortLevel | null;
  fastMode?: boolean;
  // Full off: drop reasoning entirely (effort + transcript). Internal one-shots
  // only (title/summary/classify) — never the main agent or sub-agents.
  disableThinking?: boolean;
  // Keep reasoning (effort + continuity), drop only the displayed summary
  // transcript. Set per sub-agent/fork. Anthropic honors it by omitting the
  // thinking `display` field (bare adaptive → no summary text); a no-op on
  // providers that can't decouple the summary from effort (glm/deepseek/kimi).
  suppressThinkingSummary?: boolean;
  // Session-level setting for Anthropic adaptive thinking summaries. Omitted
  // means visible, preserving the default for contexts built outside the agent.
  showThinkingSummaries?: boolean;
  permissionMode: PermissionMode;
  permissionModeIsFixed?: boolean;
  /** Canonical orchestration boundary carried into tools and prompt assembly. */
  orchestrationMode?: OrchestrationMode;
  // When false, tier dispatch fails a step instead of rerouting around a
  // quota-blocked candidate ("Quota fallback" in /config). Absent = enabled.
  quotaFallbackEnabled?: boolean;
  // Chain of command ("Chain of command" in /config, absent = enabled): a
  // nested agent cannot launch above its own tier — higher requests clamp to
  // the caller's tier. When false, nested launches may request any tier.
  chainOfCommandEnabled?: boolean;
  // Multi-model fork ("Multi-model fork" in /config, absent = disabled): when
  // true an agent spawn or a SendMessage resume may pin a provider/model pair
  // other than the session route, after the user approves the cost prompt.
  multiModelForkEnabled?: boolean;
  // Set after a stream idle timeout: a wedged pooled socket looks healthy to
  // the pool, so every retry through it stalls again. Sticky for the rest of
  // this request; fetch-based streams then bypass the pool (keepalive:false).
  freshConnection?: boolean;
  // Stable across every tool-loop subrequest within one user turn, fresh per
  // new turn. Providers whose wire fingerprint distinguishes "same query,
  // follow-up subrequest" from "new query" (glm) key off this instead of
  // ctx object identity, which churns every makeRequestContext() call.
  turnId?: string;
  // The rewind turn a context's file mutations are snapshotted under, frozen at
  // dispatch. A background sub-agent/skill shares the parent's sessionId but can
  // mutate files long after its spawning turn ends, so resolving the turn from
  // the session-global armed turn misattributes the snapshot to whatever turn is
  // armed now; carrying it here pins the snapshot to the spawning turn instead.
  rewindTurnId?: string;
  // Identifies the executing subagent's inbox id; undefined in the main conversation.
  agentId?: string;
  sessionId: string;
  /**
   * Mutable active cwd seen by the model/tools. Session worktree enter/exit
   * and Agent isolation rewrite this via RequestContext/session state —
   * never process.chdir() (that would corrupt concurrent background agents).
   */
  cwd: string;
  additionalWorkingDirectories?: ReadonlySet<string>;
  // Pre-isolation / project storage cwd. Worktree enter rewrites `cwd` so tools
  // run inside the worktree; persistence (transcripts, tool-results) must stay
  // keyed to the project the session was started in (session.storageCwd), so
  // consumers prefer this / storageCwd when set.
  originalCwd?: string;
  worktreeRoot?: string;
  broker?: BrokerHandle;
  eventSink?: ForkEventSink;
  progressSink?: ToolProgressSink;
  backgroundController?: BackgroundController;
  abortSignal?: AbortSignal;
  subagentLabel?: CodexSubAgentLabel;
  cacheRole?: "title" | "side-question";
  requestRole?: "memory_recall" | "title";
  responseRequestId?: string;
  agentOwnerId?: string;
  parentAgentOwnerId?: string;
  parentThreadId?: string;
  agentic?: boolean;
  parentMessages?: Message[];
  isForkChild?: boolean;
  forkAllowSet?: ReadonlySet<string> | null | undefined;
  forkDeferredAllow?: ReadonlySet<string> | null | undefined;
  scopedToolHandlers?: ReadonlyMap<string, ScopedToolHandler>;
  taskHooks?: { created: HookEntry[]; completed: HookEntry[] };
  toolOutputArchive?: ToolOutputArchive;
  bgTaskId?: string | undefined;
  childTaskIdMap?: Map<string, string> | undefined;
}
