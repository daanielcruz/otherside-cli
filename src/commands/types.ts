import type { SlashCommand } from "@/commands/catalog.ts";
import type { Agent } from "@/engine/queue/index.ts";
import type { Session } from "@/engine/session/index.ts";
import type { ContextUsageData } from "@/engine/session/usage/context.ts";
import type { ErrorMeta } from "@/engine/transport/error-meta.ts";
import type { UserConfig } from "@/kernel/config/config.ts";
import type { PendingChange } from "@/store/app-store/actions.ts";
import type { Broker } from "@/store/app-store/broker.ts";

export interface SlashLifecycle {
  onSessionFinalize: (handler: () => void | Promise<void>) => void;
}

export interface SlashContext {
  broker: Broker;
  config?: UserConfig | undefined;
  session: Session;
  agent: Agent;
  exit: () => void;
  clearTranscript: () => void;
  lifecycle?: SlashLifecycle;
  version?: string;
  onCompactSucceeded?: (
    dropped: number,
    durationMs: number,
    truncated: number,
    summary?: string,
  ) => void;
  onCompactRetry?: (attempt: number, maxAttempts: number, delayMs: number, reason: string) => void;
  onCompactProgress?: (charsDelta: number) => void;
  onCompactStart?: (info: { preTokens: number }) => void;
  onCompactDone?: (info: {
    mode: "summary" | "failed";
    durationMs: number;
    truncatedMessages: number;
    preTokens: number;
    summary?: string;
    error?: string;
    restoredFiles?: { path: string; numLines: number }[];
  }) => void;
  openOverlay: (name: string, initialTab?: string) => void;
  showErrorPanel?: (meta: ErrorMeta) => void;
  enterBtwMode?: (question: string) => void;
  getServerInputTokens?: () => number;
}

export type { PendingChange };

export interface SlashResult {
  kind:
    | "instant"
    | "toggle"
    | "anchor"
    | "panel"
    | "skill"
    | "workflow"
    | "auth"
    | "external"
    | "unknown";
  command?: SlashCommand;
  feedback?: string;
  shouldQuery?: boolean;
  goalEvent?:
    | { kind: "goal_set"; condition: string; setAt: number }
    | { kind: "goal_cleared"; condition: string };
  contextUsage?: ContextUsageData;
  pendingChange?: PendingChange;
  restoreInput?: string;
}

export type SlashHandler = (
  cmd: SlashCommand,
  args: string,
  ctx: SlashContext,
) => SlashResult | Promise<SlashResult>;

export function isAbortMessage(msg: string): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return (
    m.includes("aborted") ||
    m.includes("abort error") ||
    m.includes("request was aborted") ||
    m.includes("user abort") ||
    m === "abort" ||
    m.includes("operation was canceled") ||
    m.includes("operation was cancelled")
  );
}
