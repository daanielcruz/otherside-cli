import {
  type PermissionUpdate,
  parseRuleValueText,
  permissionDirectoryGlob,
} from "@/kernel/permissions/types.ts";
import { createDuplexChannel } from "@/kernel/std/stream/duplex.ts";

export type PermissionDecisionValue = "allow" | "deny";

// Virtual tool name labeling the fork-route approval prompt: no registry tool
// backs it, the name only identifies the request on the permission channel.
export const FORK_ROUTE_PERMISSION_TOOL = "AgentModelRoute";

export interface PermissionResult {
  decision: PermissionDecisionValue;
  updates: PermissionUpdate[];
  feedback?: string;
}

export interface PermissionSource {
  name: string;
  depth?: number;
}

export interface PendingPermission {
  id: string;
  toolName: string;
  argsPreview: string;
  input: unknown;
  rule: string | null;
  source?: PermissionSource;
  readOnly?: boolean;
  editDirectory?: string | null;
  suggestions?: PermissionUpdate[];
  // ExitPlanMode only: whether the mode active before entering plan supports
  // an escalation straight to yolo. Neutral flag — no new permission modes.
  bypassAvailable?: boolean;
  resolve: (result: PermissionResult) => void;
}

const channel = createDuplexChannel<PendingPermission, PermissionResult>("perm");

type PermissionPushEmitter = (
  eventType: "permission_request",
  plaintext: string,
) => Promise<void> | void;

let permissionPushEmitter: PermissionPushEmitter | null = null;

export function registerPermissionPushEmitter(emitter: PermissionPushEmitter): void {
  permissionPushEmitter = emitter;
}

export interface PermissionAskRequest {
  toolName: string;
  argsPreview: string;
  rule: string | null;
  input?: unknown;
  source?: PermissionSource;
  readOnly?: boolean;
  editDirectory?: string | null;
  suggestions?: PermissionUpdate[];
  bypassAvailable?: boolean;
}

export function ask(req: PermissionAskRequest, signal?: AbortSignal): Promise<PermissionResult> {
  const {
    toolName,
    argsPreview,
    rule,
    input = null,
    source,
    readOnly,
    editDirectory,
    suggestions,
    bypassAvailable,
  } = req;
  return channel.ask((id, resolve) => {
    const cancellation: PermissionResult = { decision: "deny", updates: [] };
    let abortedBeforePublish = false;
    let resolveAndCleanup: typeof resolve;
    const onAbort = (): void => {
      // `answer` removes a published request before resolving it. If abort wins
      // while this request is still being built, resolve directly; DuplexChannel
      // will then decline to publish it. Either way, later stale answers fail.
      if (!channel.answer(id, cancellation)) {
        abortedBeforePublish = true;
        resolveAndCleanup(cancellation);
      }
    };
    resolveAndCleanup = (value) => {
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      // addEventListener does not replay an abort that happened immediately
      // before registration, so explicitly close that race.
      if (signal.aborted) onAbort();
    }
    if (!abortedBeforePublish) {
      try {
        void permissionPushEmitter?.(
          "permission_request",
          JSON.stringify({ id, tool: toolName, args: argsPreview, rule, source: source?.name }),
        );
      } catch {}
    }
    return {
      id,
      toolName,
      argsPreview,
      input,
      rule,
      resolve: resolveAndCleanup,
      ...(readOnly ? { readOnly } : {}),
      ...(editDirectory ? { editDirectory } : {}),
      ...(suggestions && suggestions.length > 0 ? { suggestions } : {}),
      ...(source ? { source } : {}),
      ...(bypassAvailable ? { bypassAvailable } : {}),
    };
  });
}

export function answer(id: string, result: PermissionResult): boolean {
  return channel.answer(id, result);
}

export function peek(): PendingPermission | null {
  return channel.peek();
}

export function find(id: string): PendingPermission | null {
  return channel.list().find((pending) => pending.id === id) ?? null;
}

export function subscribe(fn: (queue: PendingPermission[]) => void): () => void {
  return channel.subscribe(fn);
}

export function clear(): void {
  channel.clear(() => ({ decision: "deny", updates: [] }));
}

export const PermissionResults = {
  allow(feedback?: string): PermissionResult {
    return feedback
      ? { decision: "allow", updates: [], feedback }
      : { decision: "allow", updates: [] };
  },
  deny(feedback?: string): PermissionResult {
    return feedback
      ? { decision: "deny", updates: [], feedback }
      : { decision: "deny", updates: [] };
  },
  allowAlways(rule: string): PermissionResult {
    return {
      decision: "allow",
      updates: [
        {
          type: "addRules",
          destination: "localSettings",
          rules: [
            {
              source: "localSettings",
              ruleBehavior: "allow",
              ruleValue: parseRuleValueText(rule) ?? { toolName: rule },
            },
          ],
        },
      ],
    };
  },
  allowSession(rule: string, suggestions: PermissionUpdate[] = []): PermissionResult {
    return {
      decision: "allow",
      updates:
        suggestions.length > 0
          ? suggestions
          : [
              {
                type: "addRules",
                destination: "session",
                rules: [
                  {
                    source: "session",
                    ruleBehavior: "allow",
                    ruleValue: parseRuleValueText(rule) ?? { toolName: rule },
                  },
                ],
              },
            ],
    };
  },
  allowSessionEdits(directory?: string | null): PermissionResult {
    const directoryGlob = directory ? permissionDirectoryGlob(directory) : null;
    return {
      decision: "allow",
      updates: [
        { type: "setMode", mode: "accept-edits" },
        ...(directoryGlob
          ? [
              {
                type: "addRules" as const,
                destination: "session" as const,
                rules: ["Edit", "MultiEdit", "Write", "NotebookEdit"].map((toolName) => ({
                  source: "session" as const,
                  ruleBehavior: "allow" as const,
                  ruleValue: { toolName, ruleContent: directoryGlob },
                })),
              },
            ]
          : []),
      ],
    };
  },
  setMode(mode: "default" | "accept-edits" | "plan" | "yolo"): PermissionResult {
    return {
      decision: "allow",
      updates: [{ type: "setMode", mode }],
    };
  },
  planFeedback(feedback: string): PermissionResult {
    return {
      decision: "deny",
      updates: [],
      ...(feedback.trim().length > 0 ? { feedback: feedback.trim() } : {}),
    };
  },
} as const;
