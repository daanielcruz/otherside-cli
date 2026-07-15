import { existsSync } from "node:fs";
import { platform as osPlatform, release as osRelease, type as osType } from "node:os";
import { join } from "node:path";
import type { CategorizedLayer, LayerContext } from "@/harness/composer/types.ts";
import { getTrackedCwd } from "@/kernel/std/state/cwd-state.ts";

interface EnvInfo {
  workspaceDir: string;
  isGitRepo: boolean;
  platform: string;
  osVersion: string;
}

let envInfoOverrideForTesting: (Partial<EnvInfo> & { shell?: string }) | null = null;

export function _setEnvInfoOverrideForTesting(
  info: (Partial<EnvInfo> & { shell?: string }) | null,
): void {
  envInfoOverrideForTesting = info;
}

function detectEnvInfo(): EnvInfo {
  const cwd = getTrackedCwd();
  const detected = {
    workspaceDir: cwd,
    isGitRepo: existsSync(join(cwd, ".git")),
    platform: osPlatform(),
    osVersion: `${osType()} ${osRelease()}`,
  };
  return { ...detected, ...envInfoOverrideForTesting };
}

function shellNameFor(shell: string): string {
  if (shell.includes("zsh")) return "zsh";
  if (shell.includes("bash")) return "bash";
  return shell;
}

function shellInfoLine(platform: string): string {
  const shell = (envInfoOverrideForTesting?.shell ?? process.env.SHELL) || "unknown";
  const shellName = shellNameFor(shell);
  if (platform === "win32") {
    return `Shell: ${shellName} (use Unix shell syntax, not Windows — e.g., /dev/null not NUL, forward slashes in paths)`;
  }
  return `Shell: ${shellName}`;
}

function modelDescription(model: string, displayName: string | undefined): string {
  return displayName
    ? `You are powered by the model named ${displayName}. The exact model ID is ${model}.`
    : `You are powered by the model ${model}.`;
}

function modelFamilyLine(tierLines: readonly string[]): string | null {
  if (tierLines.length === 0) return null;
  return `Models on this provider, by tier — ${tierLines.join("; ")}. When building AI applications, default to the most capable (General tier) model.`;
}

const SURFACES_LINE =
  "otherside is available as a CLI in the terminal, with a companion mobile app (iOS/Android) for remote pairing and steering sessions on the go.";

function renderEnvInfo(info: EnvInfo, ctx: LayerContext): string {
  const items: string[] = [
    `Primary working directory: ${info.workspaceDir}`,
    ...(ctx.additionalWorkingDirectories && ctx.additionalWorkingDirectories.size > 0
      ? [`Additional working directories: ${[...ctx.additionalWorkingDirectories].join(", ")}`]
      : []),
    `Is a git repository: ${info.isGitRepo}`,
    `Platform: ${info.platform}`,
    shellInfoLine(info.platform),
    `OS Version: ${info.osVersion}`,
  ];

  if (ctx.model) {
    items.push(modelDescription(ctx.model, ctx.modelDisplayName));
    if (ctx.knowledgeCutoff) items.push(`Assistant knowledge cutoff is ${ctx.knowledgeCutoff}.`);
  }

  // The per-provider model roster is withheld in multiprovider/tier mode so the
  // LLM reasons in tiers, not concrete models.
  if (!ctx.multiproviderEnabled) {
    const familyLine = modelFamilyLine(ctx.modelTierLines ?? []);
    if (familyLine) items.push(familyLine);
  }
  items.push(SURFACES_LINE);

  return [
    "# Environment",
    "You have been invoked in the following environment: ",
    ...items.map((i) => ` - ${i}`),
  ].join("\n");
}

export const envInfoLayer: CategorizedLayer = {
  name: "env-info",
  kind: "system",
  phase: "dynamic",
  render(ctx: LayerContext) {
    return renderEnvInfo(detectEnvInfo(), ctx);
  },
};
