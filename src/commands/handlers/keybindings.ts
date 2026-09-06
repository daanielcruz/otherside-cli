import type { SlashCommand } from "@/commands/catalog.ts";
import type { SlashContext, SlashResult } from "@/commands/types.ts";
import { pluralize } from "@/kernel/std/text/pluralize.ts";
import { editFileExternally } from "@/ui/input/prompt-editor.ts";
import { bindingFilePath, ensureBindingFile, reloadBindings } from "@/ui/keys/binding-file.ts";
import type { OverrideProblem } from "@/ui/keys/overrides.ts";

/**
 * What the reader is told after the editor closes. A refusal is named with where it
 * was written, because the file is hand-edited and "something was wrong" is not
 * enough to fix it.
 */
export function keybindingFeedback(input: {
  path: string;
  created: boolean;
  edited: boolean;
  problems: readonly OverrideProblem[];
}): string {
  const { path, created, edited, problems } = input;
  if (!edited) {
    return created
      ? `Created ${path}. The editor did not run, so nothing was read back.`
      : `${path} is unchanged.`;
  }
  if (problems.length === 0) return `Loaded ${path}.`;
  const count = `${problems.length} ${pluralize(problems.length, "problem")}`;
  return [
    `Loaded ${path} with ${count}:`,
    ...problems.map((problem) => `  ${problem.at}: ${problem.message}`),
  ].join("\n");
}

export function handleKeybindings(
  cmd: SlashCommand,
  _args: string,
  _ctx: SlashContext,
): SlashResult {
  // Create-only: a file that exists is opened as it is, never rewritten from the
  // template, because it is the reader's and they may have spent an hour on it.
  const { path, created } = ensureBindingFile();
  const edited = editFileExternally(path);
  const problems = edited ? reloadBindings().problems : [];
  return {
    kind: "instant",
    command: cmd,
    feedback: keybindingFeedback({ path: bindingFilePath(), created, edited, problems }),
  };
}
