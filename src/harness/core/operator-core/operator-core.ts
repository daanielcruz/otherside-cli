import type { CategorizedLayer, LayerContext } from "@/harness/composer/types.ts";
import { injectCyberRiskInstruction, stripCyberRiskMarker } from "@/harness/core/cyber-risk.ts";
import OPERATOR_CORE_FULL_MD from "@/harness/core/operator-core/full.md" with { type: "text" };
import OPERATOR_CORE_LEAN_MD from "@/harness/core/operator-core/lean.md" with { type: "text" };

const SYSTEM_CHANNEL_TOKEN = "_SYSTEM_CHANNEL_BULLET_";

const SYSTEM_CHANNEL_REMINDER_BULLET =
  "`<system-reminder>` tags in messages and tool results are injected by the harness, not the user.";

// Fable receives rule updates via mid-conversation system turns, so its harness
// bullet describes that channel instead of the system-reminder tag framing.
const SYSTEM_CHANNEL_MID_SYSTEM_BULLET =
  "The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results.";

export const operatorCoreLayer: CategorizedLayer = {
  name: "operator-core",
  kind: "system",
  cache: "global-1h",
  phase: "static",
  render(ctx: LayerContext) {
    const core = ctx.lean ? OPERATOR_CORE_LEAN_MD : OPERATOR_CORE_FULL_MD;
    const systemChannel =
      ctx.modelFamily === "fable"
        ? SYSTEM_CHANNEL_MID_SYSTEM_BULLET
        : SYSTEM_CHANNEL_REMINDER_BULLET;
    const withChannel = core.split(SYSTEM_CHANNEL_TOKEN).join(systemChannel);
    const withCyberRisk =
      ctx.provider === "anthropic"
        ? injectCyberRiskInstruction(withChannel)
        : stripCyberRiskMarker(withChannel);
    return `\n${withCyberRisk.trim()}`;
  },
};
