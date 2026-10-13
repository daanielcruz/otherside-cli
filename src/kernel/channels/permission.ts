import { directoryPathPattern } from "@/kernel/permissions/path-rules.ts";
import { type PermissionUpdate, parseRuleValueText } from "@/kernel/permissions/types.ts";
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
  /**
   * Every command rule a lasting approval saves when it saves more than one rule, or
   * saves rules alongside directory grants; `rule` is null then.
   */
  rules?: readonly string[];
  source?: PermissionSource;
  readOnly?: boolean;
  editDirectory?: string | null;
  suggestions?: PermissionUpdate[];
  /** Outside directories the offered grant opens for reading. */
  readDirectories?: readonly string[];
  /** Directories the offered grant opens for a command's file writes. */
  writeDirectories?: readonly string[];
  /** Why the call needs the user, stated above the question when the cause is worth naming. */
  reason?: string;
  /** The working directory the call runs in, named by approvals scoped to it. */
  cwd?: string;
  /** Whether the call no longer needs the user, asked again whenever the permission context changes. */
  recheck?: () => Promise<boolean>;
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
  rules?: readonly string[];
  input?: unknown;
  source?: PermissionSource;
  readOnly?: boolean;
  editDirectory?: string | null;
  suggestions?: PermissionUpdate[];
  readDirectories?: readonly string[];
  writeDirectories?: readonly string[];
  reason?: string;
  cwd?: string;
  recheck?: () => Promise<boolean>;
}

export function ask(req: PermissionAskRequest, signal?: AbortSignal): Promise<PermissionResult> {
  const {
    toolName,
    argsPreview,
    rule,
    rules,
    input = null,
    source,
    readOnly,
    editDirectory,
    suggestions,
    readDirectories,
    writeDirectories,
    reason,
    cwd,
    recheck,
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
      ...(rules && rules.length > 0 ? { rules } : {}),
      ...(readOnly ? { readOnly } : {}),
      ...(editDirectory ? { editDirectory } : {}),
      ...(suggestions && suggestions.length > 0 ? { suggestions } : {}),
      ...(readDirectories && readDirectories.length > 0 ? { readDirectories } : {}),
      ...(writeDirectories && writeDirectories.length > 0 ? { writeDirectories } : {}),
      ...(reason ? { reason } : {}),
      ...(cwd ? { cwd } : {}),
      ...(recheck ? { recheck } : {}),
      ...(source ? { source } : {}),
    };
  });
}

export function answer(id: string, result: PermissionResult): boolean {
  return channel.answer(id, result);
}

/**
 * The rules or the mode just changed: every waiting request that can settle without
 * the user checks again, and one that is now allowed closes as allowed.
 */
export function notifyPermissionContextChanged(): void {
  for (const pending of channel.list()) {
    const recheck = pending.recheck;
    if (recheck === undefined) continue;
    void recheck().then(
      (settled) => {
        if (settled) channel.answer(pending.id, PermissionResults.allow());
      },
      () => {},
    );
  }
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
    return PermissionResults.allowAlwaysAll([rule]);
  },
  allowAlwaysAll(rules: readonly string[]): PermissionResult {
    return {
      decision: "allow",
      updates: [
        {
          type: "addRules",
          destination: "localSettings",
          rules: rules.map((rule) => ({
            source: "localSettings" as const,
            ruleBehavior: "allow" as const,
            ruleValue: parseRuleValueText(rule) ?? { toolName: rule },
          })),
        },
      ],
    };
  },
  /** The call's own suggestions when it has them, otherwise its rule for the session. */
  allowSession(rule: string | null, suggestions: PermissionUpdate[] = []): PermissionResult {
    if (suggestions.length > 0 || rule === null) {
      return { decision: "allow", updates: suggestions };
    }
    return {
      decision: "allow",
      updates: [
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
  /**
   * Accept-edits for the session. An outside directory is opened for edits the way
   * {@link directoryEditGrant} opens one.
   */
  allowSessionEdits(directory?: string | null): PermissionResult {
    return {
      decision: "allow",
      updates: [
        { type: "setMode", mode: "accept-edits" },
        ...(directory ? directoryEditGrant([directory], [directory], "session") : []),
      ],
    };
  },
} as const;

const EDIT_RULE_TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit"] as const;

/**
 * Opens directories for edits: an allow rule per edit tool for each of `directories`,
 * which covers files not created yet, and `workingDirectories` joined as working
 * directories, so reads and Bash writes there pass too. A directory already in the
 * workspace needs only the rules.
 */
export function directoryEditGrant(
  directories: readonly string[],
  workingDirectories: readonly string[],
  destination: "session" | "localSettings",
): PermissionUpdate[] {
  if (directories.length === 0) return [];
  const rules = directories.flatMap((directory) =>
    EDIT_RULE_TOOLS.map((toolName) => ({
      source: destination,
      ruleBehavior: "allow" as const,
      ruleValue: { toolName, ruleContent: directoryPathPattern(directory) },
    })),
  );
  const updates: PermissionUpdate[] = [{ type: "addRules", destination, rules }];
  if (workingDirectories.length > 0) {
    updates.push({ type: "addDirectories", dirs: [...workingDirectories], destination });
  }
  return updates;
}
