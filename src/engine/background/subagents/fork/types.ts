import type { PermissionResolver } from "@/engine/agents/agent-context.ts";
import type { ParsedHooks } from "@/engine/agents/frontmatter.ts";
import type { Worktree } from "@/engine/background/subagents/worktree.ts";
import type { SessionRecord } from "@/engine/session/record/index.ts";
import type { ToolHandler } from "@/engine/tools/contract.ts";
import type { ProviderToolDeclaration } from "@/engine/translator/index.ts";
import type { McpServerSpec } from "@/kernel/mcp/index.ts";
import type { DrainedQueuedMessage, ForkEventSink } from "@/kernel/std/types/events.ts";
import type { ContentBlock, Message } from "@/kernel/std/types/message.ts";
import type { PermissionMode } from "@/kernel/std/types/permission-mode.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export interface SubagentInvocation {
  subagentType: string;
  prompt: string;
  description?: string;
  name?: string | undefined;
  runInBackground?: boolean;
  parentToolCallId?: string | undefined;
  forkId?: string | undefined;
  modelOverride?: string | undefined;
  providerOverride?: string | undefined;
  tierOverride?: string | undefined;
  tierRankOverride?: number | undefined;
  permissionMode?: PermissionMode | undefined;
  cwd?: string | undefined;
  isolation?: "worktree" | undefined;
}

export interface SubagentQuotaExhausted {
  provider: string;
  model: string;
  resetEpochMs: number | null;
  message: string;
}

export interface SubagentResult {
  output: string;
  isError: boolean;
  structured?: unknown;
  stalled?: boolean;
  stopReason?: string;
  outputTokens?: number;
  durationMs?: number;
  quotaExhausted?: SubagentQuotaExhausted;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeDeleted?: boolean;
  worktreeWarning?: string;
}

export type SidechainRecord = Extract<
  SessionRecord,
  {
    type:
      | "user_message"
      | "assistant_message"
      | "tool_call"
      | "tool_result"
      | "usage"
      | "content_replacement";
  }
>;

export interface ForkSpec {
  ctx: RequestContext;
  name: string;
  body: string;
  allowSet: Set<string> | null;
  prompt: string;
  description?: string | undefined;
  sink?: ForkEventSink | undefined;
  streamToolInputFor?: ReadonlySet<string> | undefined;
  parentToolCallId?: string | undefined;
  agentId?: string | undefined;
  forkId?: string | undefined;
  initialMessages?: Message[] | undefined;
  // A resumed run reuses the spawn-time sidecar; rewriting it would replace the
  // original mode/isolation/directive with resume-time fallbacks.
  preserveDurableSpec?: boolean | undefined;
  inheritParentTurn?: boolean | undefined;
  extraDeclarations?: ProviderToolDeclaration[] | undefined;
  scopedTools?: readonly ToolHandler[] | undefined;
  skillMessages?: Message[] | undefined;
  agentHooks?: ParsedHooks | null | undefined;
  allowedAgentTypes?: string[] | undefined;
  allowNestedAgents?: boolean | undefined;
  outputSchema?: Record<string, unknown> | undefined;
  stallMs?: number | undefined;
  isolation?: "worktree" | undefined;
  worktreeKey?: string | undefined;
  // A pre-created worktree the caller owns end-to-end: the fork runs inside it
  // but neither creates nor tears it down (the owner manages the lease and the
  // single cleanup after all retries and the durable result). Absent → the fork
  // self-manages an isolation worktree keyed by worktreeKey/forkId.
  worktree?: Worktree | undefined;
  deferredAllow?: ReadonlySet<string> | undefined;
  maxTurns?: number | undefined;
  // Agent-definition permission mode; pinned unconditionally at spawn. A live
  // broker yolo/accept-edits still wins per decision in permission resolution.
  permissionMode?: PermissionMode | undefined;
  // Distinguishes a definition-pinned mode from a mode inherited through ctx so
  // durable resume can refresh the latter from the live broker.
  permissionModeIsDefinitionPinned?: boolean | undefined;
  // Named background agents cannot bubble permission prompts to the parent.
  // Forks and other user-steered sidechains leave this unset.
  shouldAvoidPermissionPrompts?: boolean | undefined;
  pendingUserInputDrainer?: (() => DrainedQueuedMessage[]) | undefined;
  // Image blocks belonging to `prompt` (agent-view resume with pasted images):
  // persisted with the prompt's user_message record so a later resume rebuilds
  // the conversation with the images, not text alone.
  promptInlineImages?: ContentBlock[] | undefined;
  inlineMcpServers?: readonly McpServerSpec[] | null | undefined;
}

export interface SkillForkInvocation {
  ctx: RequestContext;
  name: string;
  body: string;
  prompt: string;
  parentToolCallId?: string | undefined;
  permissionResolver: PermissionResolver;
}

export interface ForkInvocation {
  directive: string;
  description?: string;
  runInBackground?: boolean;
  parentToolCallId?: string | undefined;
  forkId?: string | undefined;
  name?: string | undefined;
  permissionMode?: PermissionMode | undefined;
  cwd?: string | undefined;
  isolation?: "worktree" | undefined;
}
