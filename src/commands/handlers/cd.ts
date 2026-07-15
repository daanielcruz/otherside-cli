import type { SlashCommand } from "@/commands/catalog.ts";
import type { SlashContext, SlashResult } from "@/commands/types.ts";
import { pathIsDirectory, relocateSession } from "@/engine/session/relocate-cwd.ts";
import { askGroup } from "@/kernel/channels/ask.ts";
import { isPathTrusted, setPathTrusted } from "@/kernel/config/project-trust.ts";
import { cdRuleRefusalMessage, checkCdPermission } from "@/kernel/permissions/cd.ts";
import { expandPath } from "@/kernel/std/fs/expand-path.ts";

export type ValidateCdTargetResult =
  | { result: "ok"; directory: string }
  | { result: "same"; directory: string }
  | { result: "not_found"; path: string }
  | { result: "not_a_directory"; path: string; parent: string }
  | {
      result: "blocked_by_rule";
      directory: string;
      check: Exclude<ReturnType<typeof checkCdPermission>, { result: "allowed" }>;
    };

export async function validateCdTarget(
  inputPath: string,
  baseCwd: string,
): Promise<ValidateCdTargetResult> {
  const targetPath = expandPath(inputPath, baseCwd);
  const checked = await pathIsDirectory(targetPath);
  if (!checked.ok) {
    if (checked.reason === "not_a_directory") {
      return {
        result: "not_a_directory",
        path: checked.path,
        parent: checked.parent ?? targetPath,
      };
    }
    return { result: "not_found", path: checked.path };
  }

  const canonicalPath = checked.canonical;
  let baseCanonical = baseCwd.normalize("NFC");
  try {
    const { realpathSync } = await import("node:fs");
    baseCanonical = realpathSync(baseCwd).normalize("NFC");
  } catch {
    // keep normalized base
  }
  if (canonicalPath === baseCanonical) {
    return { result: "same", directory: canonicalPath };
  }

  const permissionResult = checkCdPermission(
    { requestedPath: targetPath, canonicalPath },
    { baseCwd },
  );
  if (permissionResult.result !== "allowed") {
    return { result: "blocked_by_rule", directory: canonicalPath, check: permissionResult };
  }
  return { result: "ok", directory: canonicalPath };
}

function feedbackResult(cmd: SlashCommand, message: string): SlashResult {
  return { kind: "instant", command: cmd, feedback: message };
}

async function confirmTrust(directory: string): Promise<boolean> {
  const result = await askGroup([
    {
      question: `${directory}\nThis session hasn't worked here before. Is this a directory you created or one you trust?\nOtherside'll be able to read, edit, and execute files here.`,
      header: "Directory trust",
      multiSelect: false,
      options: [
        {
          label: "Yes, move here",
          description: "Trust this directory and change the working directory",
        },
        {
          label: "No, stay put",
          description: "Cancel and keep the current working directory",
        },
      ],
    },
  ]);
  if (result.declined) return false;
  const answer = result.answers[0]?.answer ?? "";
  return answer.startsWith("Yes");
}

export async function handleCd(
  cmd: SlashCommand,
  args: string,
  ctx: SlashContext,
): Promise<SlashResult> {
  const pathStr = args.trim();
  if (!pathStr) {
    return feedbackResult(cmd, "Usage: /cd <path>");
  }

  const baseCwd = ctx.session.cwd;
  const target = await validateCdTarget(pathStr, baseCwd);
  switch (target.result) {
    case "not_found":
      return feedbackResult(cmd, `Couldn't find a directory at ${target.path}.`);
    case "not_a_directory":
      return feedbackResult(
        cmd,
        `${target.path} is not a directory. Did you mean ${target.parent}?`,
      );
    case "same":
      return feedbackResult(cmd, `Already in ${target.directory}.`);
    case "blocked_by_rule":
      return feedbackResult(cmd, cdRuleRefusalMessage(target.directory, target.check));
  }

  const finalPath = target.directory;

  if (!isPathTrusted(finalPath)) {
    const accepted = await confirmTrust(finalPath);
    if (!accepted) {
      return feedbackResult(cmd, `Staying in ${ctx.session.cwd}`);
    }
    await setPathTrusted(finalPath);
  }

  try {
    const { modelMessage } = await relocateSession(ctx.session, finalPath, "cd_command");
    try {
      ctx.agent.pushInjection(modelMessage);
    } catch {
      // Injection is best-effort; the cwd change still stands.
    }
    return feedbackResult(cmd, `Moved to ${finalPath}`);
  } catch {
    return feedbackResult(
      cmd,
      `Couldn't move to ${finalPath} — the directory may no longer exist, or the session couldn't be moved. Staying in ${ctx.session.cwd}.`,
    );
  }
}
