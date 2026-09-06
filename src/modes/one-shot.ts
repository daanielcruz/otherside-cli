import { OTHERSIDE_VERSION } from "@/boot/version.ts";
import { runLogout } from "@/engine/contract/login.ts";
import type { CliMode } from "@/modes/args.ts";

/**
 * Runs the modes that answer on the terminal and leave (version, help, logout,
 * statusline) or reject the launch outright (error, piped). Returns false when
 * the mode carries a real session (interactive/print) for the caller to boot.
 */
export async function maybeRunTerminalMode(mode: CliMode): Promise<boolean> {
  if (mode.kind === "error") {
    process.stderr.write(`${mode.message}\n`);
    process.exit(mode.code);
  }
  if (mode.kind === "version") {
    process.stdout.write(`otherside ${OTHERSIDE_VERSION}\n`);
    return true;
  }
  if (mode.kind === "help") {
    process.stdout.write(
      [
        `otherside ${OTHERSIDE_VERSION} — multi-provider coding agent`,
        "",
        "usage:",
        "  otherside              interactive TUI",
        "  otherside --yolo       skip permission prompts",
        "  otherside --permission-mode <default|accept-edits|plan|yolo>",
        "  otherside --resume <id> resume a saved session",
        "  otherside -c | --continue resume the most recent session for the current cwd",
        "  otherside --provider antigravity --model gemini-3.1-pro-high",
        "  otherside -w | --worktree [name]  Create a new git worktree for this session (name, #<pr>, or a PR URL)",
        "  otherside --worktree [name] --tmux  also create a companion tmux session in the worktree",
        "  otherside logout --provider antigravity",
        "  otherside -p | --print <prompt>                 run in non-interactive print mode (useful for scripts/pipes)",
        "  otherside -p <prompt> --output-format <format>  output format: text (default), json, or stream-json",
        "  otherside -p <prompt> --include-partial-messages include partial message chunks (requires stream-json format)",
        "  otherside -p <prompt> --max-turns <number>      limit maximum execution turns",
        "  otherside -p <prompt> --max-budget-usd <usd>    limit maximum USD budget for API calls",
        "  otherside -p <prompt> --json-schema <schema>    validate structured output via JSON schema",
        "  otherside --version",
        "",
      ].join("\n"),
    );
    return true;
  }
  if (mode.kind === "logout") {
    const lines = await runLogout(mode.provider);
    process.stdout.write(`${lines.join("\n")}\n`);
    return true;
  }
  if (mode.kind === "statusline") {
    const { runStatuslineMode } = await import("@/modes/statusline/index.ts");
    await runStatuslineMode();
    return true;
  }
  if (mode.kind === "piped") {
    process.stdout.write(`piped mode — Phase 12\n`);
    process.exit(1);
  }
  return false;
}
