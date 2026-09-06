import type { UserConfig } from "@/kernel/config/config.ts";
import { consumeInternalWrite } from "@/kernel/config/internal-writes.ts";
import { type WatchedSettingScope, watchSettingsFiles } from "@/kernel/config/settings-watch.ts";
import type { ConfigChangeCtx } from "./events.ts";
import type { HookOutcome } from "./exec.ts";
import { fireHookEntries, listHookEntries, matches } from "./handler.ts";
import { hookStopsFlow, jsonObjectFromStdout } from "./response.ts";

/**
 * ConfigChange, and the watch that gives it something to rule on.
 *
 * The event is a gate rather than an announcement: a settings file changing on
 * disk is put to the session's hooks first, and a hook that refuses means every
 * reader goes on reading config as it was.
 */

/**
 * Watches the settings files a session resolves config from, ruling on each
 * settled change before anything is told about it.
 */
export function startSettingsWatch(config: UserConfig, sessionId: string, cwd: string): void {
  watchSettingsFiles(cwd, {
    accept: async (change) => {
      // A write this session made is not news to it, and asking hooks to rule on
      // a change already committed to would give them a decision to unmake.
      if (consumeInternalWrite(change.path)) return true;
      const { blocked } = await fireConfigChangeHooks(config, {
        source: CONFIG_CHANGE_SOURCES[change.scope],
        filePath: change.path,
        sessionId,
        cwd,
      });
      return !blocked;
    },
  });
}

/**
 * Runs the hooks that asked about this scope and says whether they refused.
 *
 * Managed policy is the exception — it is administered rather than chosen, so its
 * hooks run for the record and their refusal is not honoured.
 */
export async function fireConfigChangeHooks(
  config: UserConfig,
  ctx: ConfigChangeCtx,
): Promise<{ outcomes: HookOutcome[]; blocked: boolean }> {
  const entries = [...(config.hooks?.configChange ?? []), ...listHookEntries("configChange")];
  const outcomes = await fireHookEntries(
    entries.filter((entry) => matches(entry.matcher, ctx.source)),
    { kind: "configChange", ctx },
  );
  const blocked = ctx.source !== "policy_settings" && outcomes.some(hookOutcomeBlocks);
  return { outcomes, blocked };
}

const CONFIG_CHANGE_SOURCES: Record<WatchedSettingScope, ConfigChangeCtx["source"]> = {
  user: "user_settings",
  project: "project_settings",
  local: "local_settings",
  policy: "policy_settings",
};

const BLOCKING_EXIT_CODE = 2;

/** A hook refused: the blocking exit code, or a stdout that says so. */
function hookOutcomeBlocks(outcome: HookOutcome): boolean {
  if (outcome.kind === "prompt_blocked") return true;
  if (outcome.kind === "non_zero_exit") return outcome.code === BLOCKING_EXIT_CODE;
  if (outcome.kind !== "ok") return false;
  return (
    hookStopsFlow(outcome.stdout) || jsonObjectFromStdout(outcome.stdout)?.decision === "block"
  );
}
