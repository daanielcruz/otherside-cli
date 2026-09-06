import type { SlashCommand } from "@/commands/catalog.ts";
import type { SlashContext, SlashResult } from "@/commands/types.ts";
import { isWorkflowEnabled } from "@/engine/background/workflows/runtime/gate.ts";
import {
  defaultEffortForModel,
  effortLevelDescription,
  effortLevelsForModel,
  modelDisplayWithContext,
} from "@/engine/model/catalog.ts";
import { DEFAULT_CONFIG, updateConfig } from "@/kernel/config/config.ts";
import { type EffortLevel, isEffortLevel } from "@/kernel/std/types/effort.ts";
import { providerDisplayName } from "@/kernel/std/types/provider-ids.ts";

export function setEffortFeedback(level: EffortLevel): string {
  const description = effortLevelDescription(level);
  return `Set effort level to ${level} (saved as your default for new sessions): ${description}`;
}

export function handleEffort(cmd: SlashCommand, args: string, ctx: SlashContext): SlashResult {
  if (!args) {
    ctx.openOverlay(cmd.name);
    return { kind: "panel", command: cmd };
  }
  const normalized = args.toLowerCase();
  if (normalized === "help" || normalized === "-h" || normalized === "--help") {
    return {
      kind: "panel",
      command: cmd,
      feedback: "Usage: /effort [low|medium|high|xhigh|max|auto|current]",
    };
  }
  const state = ctx.broker.read();
  const levels = effortLevelsForModel({ provider: state.provider, model: state.model });
  if (normalized === "current" || normalized === "status") {
    if (levels.length === 0) {
      return {
        kind: "panel",
        command: cmd,
        feedback: `Effort controls are not available for ${providerDisplayName(state.provider)} ${modelDisplayWithContext({ provider: state.provider, model: state.model })}.`,
      };
    }
    return {
      kind: "panel",
      command: cmd,
      feedback: `Current effort level: ${state.effort}`,
    };
  }
  if (normalized === "auto" || normalized === "unset") {
    if (levels.length === 0) {
      return {
        kind: "panel",
        command: cmd,
        feedback: `Effort controls are not available for ${providerDisplayName(state.provider)}.`,
      };
    }
    void updateConfig((current) => {
      delete current.effortLevel;
    });
    const effort = defaultEffortForModel({ provider: state.provider, model: state.model });
    return {
      kind: "panel",
      command: cmd,
      feedback: `Set effort auto (${effort})`,
      pendingChange: { kind: "set_effort", effort },
    };
  }
  if (normalized === "ultracode") {
    if (!isWorkflowEnabled(ctx.config ?? DEFAULT_CONFIG)) {
      return {
        kind: "panel",
        command: cmd,
        feedback:
          "Ultracode needs workflows enabled (see /config). Valid options are: low, medium, high, xhigh, max, auto",
      };
    }
    void updateConfig((current) => {
      current.ultracode = true;
    });
    return {
      kind: "panel",
      command: cmd,
      feedback:
        levels.length > 0
          ? `ultracode with ${ctx.config?.ultracodeEffort ?? "high"} effort`
          : "ultracode",
      pendingChange: { kind: "set_ultracode", enabled: true },
    };
  }
  if (!isEffortLevel(normalized)) {
    return {
      kind: "panel",
      command: cmd,
      feedback: `Invalid effort level: ${args}. Valid options are: low, medium, high, xhigh, max, auto`,
    };
  }
  if (!levels.includes(normalized)) {
    const available = levels.length > 0 ? levels.join(", ") : "none";
    return {
      kind: "panel",
      command: cmd,
      feedback: `Effort level ${normalized} is not available for ${providerDisplayName(state.provider)} ${modelDisplayWithContext({ provider: state.provider, model: state.model })}. Available: ${available}.`,
    };
  }
  void updateConfig((current) => {
    current.effortLevel = normalized;
  });
  return {
    kind: "panel",
    command: cmd,
    feedback: setEffortFeedback(normalized),
    pendingChange: { kind: "set_effort", effort: normalized },
  };
}
