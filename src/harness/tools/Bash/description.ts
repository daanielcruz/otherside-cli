import { applyTokens } from "@/harness/composer/tokens.ts";
import tool from "@/harness/tools/Bash/tool.json" with { type: "json" };

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;

export interface SandboxPromptInfo {
  enabled: boolean;
  filesystem?:
    | {
        denyRead?: string[];
        allowReadWithinDeny?: string[];
        allowWrite?: string[];
        denyWriteWithinAllow?: string[];
      }
    | undefined;
  network?:
    | {
        enabled?: boolean;
        allowLocalBinding?: boolean;
        allowAllUnixSockets?: boolean;
      }
    | undefined;
}

export interface BashTimeoutLimits {
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  defaultBackgroundTimeoutMs: number;
  maxBackgroundTimeoutMs: number;
  /** Whether a background shell is stopped at a time limit; the texts name it only then. */
  backgroundDeadline: boolean;
}

type BackgroundDeadlineText = keyof typeof tool.backgroundDeadline;

export interface BashDescriptionInput extends BashTimeoutLimits {
  lean?: boolean;
  /** Lean only: steer the model toward the dedicated file tools instead of shell reads. */
  dedicatedToolSteer?: boolean;
  sandbox: SandboxPromptInfo;
  includeGit: boolean;
}

// Fills the timeout numbers into the Bash description and input schema. The
// background-limit sentence goes in first so its own numbers are filled too.
export function bashTimeoutTokens(
  limits: BashTimeoutLimits,
  deadlineText: BackgroundDeadlineText,
): Record<string, string> {
  return {
    "{{BACKGROUND_DEADLINE}}": limits.backgroundDeadline
      ? tool.backgroundDeadline[deadlineText]
      : "",
    "{{DEFAULT_TIMEOUT_MS}}": String(limits.defaultTimeoutMs),
    "{{MAX_TIMEOUT_MS}}": String(limits.maxTimeoutMs),
    "{{DEFAULT_TIMEOUT_MIN}}": String(limits.defaultTimeoutMs / MS_PER_MINUTE),
    "{{MAX_TIMEOUT_MIN}}": String(limits.maxTimeoutMs / MS_PER_MINUTE),
    "{{DEFAULT_BACKGROUND_TIMEOUT_MS}}": String(limits.defaultBackgroundTimeoutMs),
    "{{MAX_BACKGROUND_TIMEOUT_MS}}": String(limits.maxBackgroundTimeoutMs),
    "{{DEFAULT_BACKGROUND_TIMEOUT_MIN}}": String(limits.defaultBackgroundTimeoutMs / MS_PER_MINUTE),
    "{{MAX_BACKGROUND_TIMEOUT_HOURS}}": String(limits.maxBackgroundTimeoutMs / MS_PER_HOUR),
  };
}

function buildSandboxSection(sandbox: SandboxPromptInfo): string {
  if (!sandbox.enabled) return "";
  const fs = sandbox.filesystem;
  const network = sandbox.network;
  const lines: string[] = [
    "",
    "## Command sandbox",
    "Your bash commands run inside a macOS sandbox-exec profile. The sandbox controls which directories and network hosts commands may access without an explicit override.",
    "",
    "Restrictions:",
  ];
  if (fs?.denyRead && fs.denyRead.length > 0) {
    lines.push(`- Read denied for: ${JSON.stringify(fs.denyRead)}`);
    if (fs.allowReadWithinDeny && fs.allowReadWithinDeny.length > 0) {
      lines.push(`  - Re-allowed within: ${JSON.stringify(fs.allowReadWithinDeny)}`);
    }
  } else {
    lines.push("- Read: all paths allowed.");
  }
  if (fs?.allowWrite) {
    lines.push(`- Write only inside: ${JSON.stringify(fs.allowWrite)}`);
    if (fs.denyWriteWithinAllow && fs.denyWriteWithinAllow.length > 0) {
      lines.push(`  - But denied within: ${JSON.stringify(fs.denyWriteWithinAllow)}`);
    }
  } else {
    lines.push(
      "- Write only inside: current working directory + ~/.otherside + /tmp/otherside + standard /dev devices.",
    );
  }
  lines.push(
    "- Mandatory deny (always): dotfiles like .gitconfig, .zshrc, .bashrc, .mcp.json, plus .git/hooks and .git/config — even when those paths sit inside an otherwise allowed directory.",
  );
  if (network?.enabled === false) {
    if (network.allowLocalBinding) {
      lines.push("- Network: blocked except local loopback binds.");
    } else if (network.allowAllUnixSockets) {
      lines.push("- Network: TCP blocked; Unix sockets fully open.");
    } else {
      lines.push("- Network: outbound blocked.");
    }
  } else {
    lines.push("- Network: unrestricted.");
  }
  lines.push(
    "",
    "Handling sandbox-denied commands:",
    "- If a command fails with `Operation not permitted` on a path you needed (especially writes outside the working directory), the sandbox blocked it. Tell the user briefly, then either pick a path inside the allowed set OR re-run with `dangerouslyDisableSandbox: true` if the operation is genuinely required.",
    "- Treat each `dangerouslyDisableSandbox: true` invocation individually. Even if you used it once, default the next command back to sandbox mode.",
    "- Do NOT request `dangerouslyDisableSandbox: true` to write to sensitive paths like ~/.bashrc, ~/.ssh/*, or credential files.",
    "- For temporary files prefer the current working directory or `$TMPDIR` (the sandbox-writable tmp dir) over `/tmp` directly.",
  );
  return lines.join("\n");
}

function composeBashPrompt(
  base: string,
  git: string,
  input: BashDescriptionInput,
  deadlineText: BackgroundDeadlineText,
): string {
  const tokens = bashTimeoutTokens(input, deadlineText);
  const sandboxSection = buildSandboxSection(input.sandbox);
  const parts = [applyTokens(base, tokens).trimEnd()];
  if (sandboxSection.length > 0) parts.push("", sandboxSection);
  if (input.includeGit) parts.push("", git);
  return parts.join("\n");
}

export function buildBashDescription(input: BashDescriptionInput): string {
  if (!input.lean) {
    return composeBashPrompt(tool.description.full, tool.description.git, input, "full");
  }
  const lean = applyTokens(tool.description.lean, {
    "{{DEDICATED_TOOL_STEER}}":
      (input.dedicatedToolSteer ?? true) ? tool.description.leanDedicatedToolSteer : "",
  });
  return composeBashPrompt(lean, tool.description.gitLean, input, "lean");
}
