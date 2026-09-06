import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path/posix";
import { resolveTaskLogPath } from "@/engine/background/tasks/output-files.ts";
import { canSendNatively } from "@/engine/model/facts/capabilities-runtime.ts";
import { annotateStderrWithSandboxDenials, cleanupAfterCommand } from "@/engine/sandbox/manager.ts";
import {
  bashCommentLabel,
  classifyCommandOutcome,
  isSilentCommand,
} from "@/engine/tools/_infra/command-analysis/commands.ts";
import {
  detectDestructiveCommand,
  isDestructiveWarnEnabled,
} from "@/engine/tools/_infra/command-analysis/destructive.ts";
import { buildGhRateLimitReminderIfDue } from "@/engine/tools/_infra/command-analysis/gh-rate-limit.ts";
import {
  loadInlineRead,
  parseEmbeddedReadCommands,
} from "@/engine/tools/_infra/command-analysis/inline-read-prefetch.ts";
import { detectInplaceEditTargets } from "@/engine/tools/_infra/command-analysis/inplace-edit.ts";
import {
  buildSedEditDiff,
  parseSedEditInvocation,
  type SedEditDiff,
  type SedEditInfo,
} from "@/engine/tools/_infra/command-analysis/sed-edit.ts";
import { maybeBuildStaleReadHint } from "@/engine/tools/_infra/command-analysis/stale-read.ts";
import {
  defaultShellTimeoutMs,
  getMaxBashTimeoutMs,
} from "@/engine/tools/_infra/command-analysis/timeouts.ts";
import { parseImageDataUri } from "@/engine/tools/_infra/data-uri.ts";
import {
  persistLargeToolResult,
  shouldPersist,
} from "@/engine/tools/_infra/tool-results/persist.ts";
import { runForegroundWithAutoBg } from "@/engine/tools/builtins/auto-bg.ts";
import { spawnBackground } from "@/engine/tools/builtins/background.ts";
import {
  appendShellResetMessage,
  cleanupCwdFile,
  isWithinAllowedWorkingDir,
  maintainProjectWorkingDir,
  newCwdFilePath,
  recoverCwdIfMissing,
  resolveTrackedCwd,
} from "@/engine/tools/builtins/cwd.ts";
import { prepareExecCommand } from "@/engine/tools/builtins/exec.ts";
import { makeBashProgressSink } from "@/engine/tools/builtins/foreground.ts";
import { appendExitCodeNote, mergeStdoutStderr } from "@/engine/tools/builtins/output.ts";
import {
  readScopeKey,
  readSetContains,
  readSetEntries,
  readSetInsert,
} from "@/engine/tools/builtins/read/state.ts";
import { countNonEmptyLines, isReadOrSearchCommand } from "@/engine/tools/builtins/safety.ts";
import { filePathSegment, type ToolArgSegment, type ToolHandler } from "@/engine/tools/contract.ts";
import { BashSchema } from "@/engine/tools/dynamic/Bash.ts";
import { getTrackedCwd, setTrackedCwd } from "@/kernel/std/state/cwd-state.ts";
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { isRecord } from "@/kernel/std/value-guards.ts";
import {
  recordFileMutationResult,
  snapshotBeforeFileMutation,
} from "@/kernel/storage/file-history.ts";

export {
  type AutoBgEligibleSpawn,
  type AutoBgOutcome,
  runForegroundWithAutoBg,
} from "@/engine/tools/builtins/auto-bg.ts";
export {
  type BashSummary,
  killBackground,
  killShellsForOwner,
  listBackground,
  pollBackground,
} from "@/engine/tools/builtins/background.ts";
export {
  appendShellResetMessage,
  recoverCwdIfMissing,
  resolveTrackedCwd,
} from "@/engine/tools/builtins/cwd.ts";
export type { CombinedCap } from "@/engine/tools/builtins/output.ts";
export {
  appendExitCodeNote,
  capHeadCombined,
  mergeStdoutStderr,
  OUTPUT_CAP,
} from "@/engine/tools/builtins/output.ts";
export {
  countNonEmptyLines,
  isAutoBackgroundableCommand,
  isReadOrSearchCommand,
} from "@/engine/tools/builtins/safety.ts";

interface BashInput {
  command?: unknown;
  timeout?: unknown;
  run_in_background?: unknown;
}

function resolveCommandPath(filePath: string, cwd: string): string {
  return isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
}

interface PrimeInlineReadInput {
  scope: string;
  command: string;
  exitCode: number;
  signal: AbortSignal | undefined;
  cwd: string;
}

async function primeInlineReadCache(input: PrimeInlineReadInput): Promise<void> {
  const { scope, command, exitCode, signal, cwd } = input;
  for (const plan of parseEmbeddedReadCommands(command)) {
    if (plan.onlyOnSuccess === true && exitCode !== 0) continue;
    const absolutePath = resolveCommandPath(plan.filePath, cwd);
    if (readSetContains(scope, absolutePath)) continue;
    const loaded = await loadInlineRead(absolutePath, plan, signal);
    if (loaded) readSetInsert(scope, absolutePath, loaded.content, loaded.offset, loaded.limit);
  }
}

function maybeImageToolResult(
  callId: string,
  stdoutRaw: string,
  ctx: RequestContext,
): ToolResult | null {
  const parsed = parseImageDataUri(stdoutRaw);
  if (parsed === null) return null;
  if (!canSendNatively(ctx.provider, ctx.model)) return null;
  return {
    tool_use_id: callId,
    content: [
      { type: "text", text: `[image · ${parsed.mediaType} · ${parsed.data.length} base64 chars]` },
      {
        type: "image",
        source: { type: "base64", media_type: parsed.mediaType, data: parsed.data },
      },
    ],
  };
}

function readTextFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function commandFromInput(input: unknown): string {
  if (!isRecord(input)) return "";
  return typeof input.command === "string" ? input.command : "";
}

function descriptionFromInput(input: unknown): string {
  if (!isRecord(input)) return "";
  return typeof input.description === "string" ? input.description : "";
}

function semanticNumber(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!/^[-+]?\d+(\.\d+)?$/.test(trimmed)) return value;
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : value;
}

function semanticBoolean(value: unknown): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

function coerceBashInput(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const coerced = { ...input };
  if ("timeout" in coerced) coerced.timeout = semanticNumber(coerced.timeout);
  if ("run_in_background" in coerced) {
    coerced.run_in_background = semanticBoolean(coerced.run_in_background);
  }
  if ("dangerouslyDisableSandbox" in coerced) {
    coerced.dangerouslyDisableSandbox = semanticBoolean(coerced.dangerouslyDisableSandbox);
  }
  return coerced;
}

function sedEditFromInput(input: unknown): SedEditInfo | null {
  const command = commandFromInput(input);
  if (command.length === 0) return null;
  return parseSedEditInvocation(command);
}

function bashCommandText(input: unknown): string {
  const command = commandFromInput(input);
  return command.length > 0 ? command : descriptionFromInput(input);
}

function bashCommandSegments(input: unknown): ToolArgSegment[] {
  const text = bashCommandText(input);
  return text.length > 0 ? [{ kind: "text", text }] : [];
}

export const Bash: ToolHandler = {
  schema: BashSchema,
  coerceInput: coerceBashInput,
  render: {
    userFacingLabel(input) {
      return sedEditFromInput(input) !== null ? "Update" : "Bash";
    },
    summarizeArgs(input) {
      const sedInfo = sedEditFromInput(input);
      if (sedInfo !== null) return sedInfo.filePath;
      return bashCommandText(input);
    },
    summarizeArgSegments(input) {
      const sedInfo = sedEditFromInput(input);
      if (sedInfo !== null) return [filePathSegment(sedInfo.filePath)];
      return bashCommandSegments(input);
    },
  },
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    const args = (call.input ?? {}) as BashInput;
    const command = typeof args.command === "string" ? args.command : null;
    if (!command) {
      const obj = (call.input ?? {}) as Record<string, unknown>;
      const keys = Object.keys(obj);
      const desc = typeof obj.description === "string" ? (obj.description as string) : null;
      let hint = "";
      if (desc !== null && keys.length > 0 && !keys.includes("command")) {
        hint = ` You passed \`description\` but no \`command\`. Retry with: {"command": "<shell command to run>", "description": "${desc}"}`;
      } else if (keys.length > 0) {
        hint = ` Received keys: [${keys.join(", ")}]. Retry with the shell command in the \`command\` field.`;
      }
      return {
        tool_use_id: call.id,
        content: `\`command\` is required (the shell command to execute).${hint}`,
        is_error: true,
      };
    }
    const runInBackground =
      typeof args.run_in_background === "boolean" ? args.run_in_background : false;

    const inputDescription =
      typeof (args as { description?: unknown }).description === "string"
        ? (args as { description: string }).description.trim() || null
        : null;
    const commentLabel = bashCommentLabel(command);
    const displayCommand = inputDescription ?? commentLabel ?? command;

    const destructiveWarning = isDestructiveWarnEnabled()
      ? (detectDestructiveCommand(command)?.warning ?? null)
      : null;

    const dangerouslyDisableSandbox =
      typeof (args as { dangerouslyDisableSandbox?: unknown }).dangerouslyDisableSandbox ===
      "boolean"
        ? Boolean((args as { dangerouslyDisableSandbox: boolean }).dangerouslyDisableSandbox)
        : false;

    const isSidechain = !!ctx.subagentLabel;
    if (!isSidechain) recoverCwdIfMissing();
    const executionCwd = isSidechain ? ctx.cwd : getTrackedCwd();
    const inplaceTargets = detectInplaceEditTargets(command, executionCwd);
    for (const target of inplaceTargets) {
      await snapshotBeforeFileMutation(ctx, target);
    }

    const sedEdit = parseSedEditInvocation(command);
    const sedEditPath = sedEdit
      ? isAbsolute(sedEdit.filePath)
        ? sedEdit.filePath
        : resolve(executionCwd, sedEdit.filePath)
      : null;
    const sedEditBefore = sedEditPath !== null ? readTextFileOrNull(sedEditPath) : null;

    const cwdFilePath = runInBackground ? null : newCwdFilePath();
    const {
      execCommand: wrappedCommand,
      sandboxed,
      logTag: sandboxLogTag,
      login,
    } = await prepareExecCommand({ command, dangerouslyDisableSandbox, cwdFilePath });

    let timeoutMs = defaultShellTimeoutMs();
    if (args.timeout !== undefined && args.timeout !== null) {
      const n = typeof args.timeout === "number" ? args.timeout : Number(args.timeout);
      if (!Number.isFinite(n)) {
        return {
          tool_use_id: call.id,
          content: "`timeout` must be a number",
          is_error: true,
        };
      }
      const floored = Math.floor(n);
      if (floored > 0) timeoutMs = Math.min(floored, getMaxBashTimeoutMs());
    }

    if (runInBackground) {
      const r = spawnBackground({
        execCommand: wrappedCommand,
        command,
        displayCommand,
        parentToolCallId: call.id,
        isSidechain,
        cwd: executionCwd,
        login,
        ...(ctx.agentOwnerId !== undefined ? { ownerId: ctx.agentOwnerId } : {}),
        ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
      });
      if ("error" in r) {
        return { tool_use_id: call.id, content: r.error, is_error: true };
      }
      return {
        tool_use_id: call.id,
        content: `Command running in background with ID: ${r.id}. Output is being written to: ${resolveTaskLogPath(r.id)}. You will be notified when it completes. To check interim output, use Read on that file path.`,
        meta: { kind: "bash", status: "background", shell_id: r.id },
      };
    }

    const commandStartTimeMs = Date.now();
    const onStdout = makeBashProgressSink(ctx.progressSink, timeoutMs);
    const autoBgOutcome = await runForegroundWithAutoBg({
      command: wrappedCommand,
      displayCommand,
      parentToolCallId: call.id,
      timeoutMs,
      signal: ctx.abortSignal,
      userBgSignaled: ctx.backgroundController?.signaled,
      isSidechain,
      ...(ctx.agentOwnerId !== undefined ? { ownerId: ctx.agentOwnerId } : {}),
      ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
      ...(onStdout ? { onStdout } : {}),
      originalCommand: command,
      cwd: executionCwd,
      cwdFilePath,
      login,
    });
    if (autoBgOutcome.promoted) {
      return {
        tool_use_id: call.id,
        content: `Command moved to the background with ID: ${autoBgOutcome.shellId}. ${autoBgOutcome.reason}. You will be notified when it completes. Output is being written to: ${resolveTaskLogPath(autoBgOutcome.shellId)}.`,
        meta: { kind: "bash", status: "background", shell_id: autoBgOutcome.shellId },
      };
    }
    let cwdWasReset = false;
    if (cwdFilePath !== null && !isSidechain) {
      try {
        const newCwd = readFileSync(cwdFilePath, "utf8").trim().normalize("NFC");
        if (newCwd.length > 0) {
          const resolution = resolveTrackedCwd({
            newCwd,
            originalCwd: ctx.cwd,
            maintain: maintainProjectWorkingDir(),
            isAllowed: (candidate) =>
              isWithinAllowedWorkingDir(candidate, ctx.cwd, ctx.additionalWorkingDirectories ?? []),
          });
          setTrackedCwd(resolution.cwd);
          cwdWasReset = resolution.didReset;
        }
      } catch {}
    }
    cleanupCwdFile(cwdFilePath);
    const out = autoBgOutcome.result;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const scrubbedFiles = cleanupAfterCommand(commandStartTimeMs);
    let sedEditDiff: SedEditDiff | null = null;
    if (sedEditPath !== null && sedEditBefore !== null && out.exitCode === 0 && !out.timedOut) {
      const sedEditAfter = readTextFileOrNull(sedEditPath);
      if (sedEditAfter !== null) {
        sedEditDiff = buildSedEditDiff({
          filePath: sedEditPath,
          before: sedEditBefore,
          after: sedEditAfter,
        });
      }
    }
    if (out.exitCode === 0 && !out.timedOut) {
      for (const target of inplaceTargets) recordFileMutationResult(ctx, target);
      const imageResult = maybeImageToolResult(call.id, out.stdoutRaw, ctx);
      if (imageResult !== null) return imageResult;
    }
    const annotatedStderrBase = sandboxed
      ? annotateStderrWithSandboxDenials(out.stderr, sandboxLogTag)
      : out.stderr;
    const annotatedStderrScrubbed =
      scrubbedFiles.length > 0
        ? `${annotatedStderrBase}\n[sandbox] scrubbed planted bare-repo files from cwd: ${scrubbedFiles.join(", ")}`
        : annotatedStderrBase;
    const annotatedStderr = cwdWasReset
      ? appendShellResetMessage(annotatedStderrScrubbed, ctx.cwd)
      : annotatedStderrScrubbed;
    const interpreted = classifyCommandOutcome(command, out.exitCode);
    const noOutputExpected = isSilentCommand(command);
    const searchSummary = isReadOrSearchCommand(command)
      ? { lines: countNonEmptyLines(out.stdoutRaw) }
      : null;
    const fullStderrBase = sandboxed
      ? annotateStderrWithSandboxDenials(out.stderrRaw, sandboxLogTag)
      : out.stderrRaw;
    const fullStderr = cwdWasReset
      ? appendShellResetMessage(fullStderrBase, ctx.cwd)
      : fullStderrBase;
    const exitCodeNote =
      interpreted.isError && out.exitCode !== 0 ? `Exit code ${out.exitCode}` : "";
    const stdoutRawWithExit = appendExitCodeNote(out.stdoutRaw, exitCodeNote);
    const stdoutWithExit = appendExitCodeNote(out.stdout, exitCodeNote);
    const fullContent = mergeStdoutStderr(stdoutRawWithExit, fullStderr);
    const persisted = shouldPersist(fullContent.length)
      ? persistLargeToolResult({
          toolName: "Bash",
          callId: call.id,
          content: fullContent,
          cwd: ctx.originalCwd ?? ctx.cwd,
          sessionId: ctx.sessionId,
        })
      : null;
    const contentBase = persisted
      ? persisted.preview
      : mergeStdoutStderr(stdoutWithExit, annotatedStderr);
    const ghReminder = buildGhRateLimitReminderIfDue(command, `${out.stdoutRaw}\n${out.stderrRaw}`);
    const staleReadHint = await maybeBuildStaleReadHint({
      command,
      entries: readSetEntries(readScopeKey(ctx)),
      startTimeMs: commandStartTimeMs,
      cwd: ctx.cwd,
    });
    await primeInlineReadCache({
      scope: readScopeKey(ctx),
      command,
      exitCode: out.exitCode,
      signal: ctx.abortSignal,
      cwd: ctx.cwd,
    });
    const reminders = [destructiveWarning, ghReminder, staleReadHint].filter(
      (reminder): reminder is string => !!reminder,
    );
    const content =
      reminders.length > 0 ? `${reminders.join("\n\n")}\n\n${contentBase}` : contentBase;
    const failed = out.timedOut || interpreted.isError;
    const status = out.timedOut ? "timeout" : interpreted.isError ? "failed" : "completed";
    return {
      tool_use_id: call.id,
      content,
      is_error: failed,
      meta: {
        kind: "bash",
        status,
        exit_code: out.exitCode,
        stdout: out.stdout,
        stderr: annotatedStderr,
        elapsed_ms: out.elapsedMs,
        ...(searchSummary ? { search_summary: searchSummary } : {}),
        ...(noOutputExpected ? { no_output_expected: true } : {}),
        ...(interpreted.message !== undefined
          ? { return_code_interpretation: interpreted.message }
          : {}),
        ...(sedEditDiff ? { sed_edit: sedEditDiff } : {}),
      },
    };
  },
};
