import type { CategorizedLayer, LayerContext } from "@/harness/composer/types.ts";
import { injectCyberRiskInstruction, stripCyberRiskMarker } from "@/harness/core/cyber-risk.ts";
import OPERATOR_CORE_FULL_MD from "@/harness/core/operator-core/full.md" with { type: "text" };
import OPERATOR_CORE_LEAN_MD from "@/harness/core/operator-core/lean.md" with { type: "text" };

const SYSTEM_CHANNEL_TOKEN = "_SYSTEM_CHANNEL_BULLET_";

const INTRO_DEFAULT_MISSION = "helps users with software engineering tasks.";
const INTRO_STYLED_MISSION =
  'helps users according to your "Output Style" below, which describes how you should respond to user queries.';

/** With a style active, the intro defers to the style and its coding guidance may leave. */
function applyOutputStyle(core: string, ctx: LayerContext): string {
  if (ctx.outputStyle === null) return core;
  const styled = core.replace(INTRO_DEFAULT_MISSION, INTRO_STYLED_MISSION);
  if (ctx.outputStyle.keepCodingInstructions === true) return styled;
  return stripSection(styled, "# Doing tasks");
}

function stripSection(text: string, heading: string): string {
  const start = text.indexOf(`${heading}\n`);
  if (start === -1) return text;
  const next = text.indexOf("\n# ", start);
  const head = text.slice(0, start);
  return next === -1 ? head : head + text.slice(next + 1);
}

const SYSTEM_CHANNEL_REMINDER_BULLET =
  "`<system-reminder>` tags in messages and tool results are injected by the harness, not the user.";

// Models on the mid-system block path receive rule updates via mid-conversation
// system turns, so their harness bullet describes that channel instead of the
// system-reminder tag framing.
const SYSTEM_CHANNEL_MID_SYSTEM_BULLET =
  "The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results.";

export const operatorCoreLayer: CategorizedLayer = {
  name: "operator-core",
  kind: "system",
  cache: "global-1h",
  phase: "static",
  render(ctx: LayerContext) {
    const core = applyOutputStyle(ctx.lean ? OPERATOR_CORE_LEAN_MD : OPERATOR_CORE_FULL_MD, ctx);
    const systemChannel = ctx.supportsMidSystem
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
