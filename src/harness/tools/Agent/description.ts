import { applyTokens } from "@/harness/composer/tokens.ts";
import {
  buildMultiproviderToolSection,
  type ResolvedTierRoster,
} from "@/harness/core/tier-guidance.ts";
import tool from "@/harness/tools/Agent/tool.json" with { type: "json" };
import { isAgentAutoBackgroundEnabled } from "@/kernel/config/agent-auto-background.ts";

// Auto-background rewrites the launch-semantics prose at compose time so the
// static JSON stays byte-identical for the env-disabled path. Swap targets:
// the "## Foreground vs background" section (body + offAddendum), the two
// usage bullets (foreground-vs-background, optional-background), and the lean
// bullet naming `run_in_background`, which the schema drops.
const BACKGROUND_SECTION = `## Background execution

Agents always run in the **background**: the tool returns immediately with a task id, and the agent's result arrives later as a completion notification (a user-role message in a later turn). The launch tool result is only a receipt — never treat it as the agent's answer.

- Do NOT sleep, poll, or read the agent's transcript while it runs — the notification will come on its own.
- Do NOT fabricate or predict the agent's result in any form; before the notification lands you know nothing about what it found. If the user asks meanwhile, give status, not a guess.
- Do NOT re-launch an agent because its result "hasn't arrived yet" — first check whether an agent you already launched covers that scope.
- Independent agents: launch them all in a single message with multiple tool calls.
- Dependent work (B needs A's result): launch A, then continue other work or end your response; launch B in the turn where A's notification arrives — never in the same message as A.`;

const FOREGROUND_BULLET =
  "- **Foreground vs background**: Use foreground (default) when you need the agent's results before you can proceed — e.g., research agents whose findings inform your next steps. Use background when you have genuinely independent work to do in parallel.";
const BACKGROUND_BULLET =
  "- **Background execution**: Every agent runs in the background; its result arrives as a completion notification in a later turn. Sequence dependent agents across notification turns; batch independent agents in one message.";
const OPTIONAL_BACKGROUND_BULLET =
  "- You can optionally run agents in the background using the run_in_background parameter. When an agent runs in the background, you will be automatically notified when it completes — do NOT sleep, poll, or proactively check on its progress. Continue with other work or respond to the user instead.";
const ALWAYS_BACKGROUND_BULLET =
  "- Agents always run in the background. When an agent runs in the background, you will be automatically notified when it completes — do NOT sleep, poll, or proactively check on its progress. Continue with other work or respond to the user instead.";
const LEAN_OPTIONAL_BACKGROUND_BULLET =
  "\n- `run_in_background: true` runs the agent asynchronously; you'll be notified when it completes.";

export function applyBackgroundDefault(text: string): string {
  if (!isAgentAutoBackgroundEnabled()) return text;
  const out = text
    .replace(FOREGROUND_BULLET, BACKGROUND_BULLET)
    .replace(OPTIONAL_BACKGROUND_BULLET, ALWAYS_BACKGROUND_BULLET)
    .replace(LEAN_OPTIONAL_BACKGROUND_BULLET, "");
  const marker = "## Foreground vs background";
  const start = out.indexOf(marker);
  if (start === -1) return out;
  const nextHeading = out.indexOf("\n## ", start + marker.length);
  const end = nextHeading === -1 ? out.length : nextHeading;
  return out.slice(0, start) + BACKGROUND_SECTION + out.slice(end);
}

function stripForkGuidance(text: string): string {
  const heading = "## When to fork";
  const start = text.indexOf(heading);
  if (start === -1) return text;
  const nextHeading = text.indexOf("\n## ", start + heading.length);
  const end = nextHeading === -1 ? text.length : nextHeading + 1;
  return `${text.slice(0, start)}${text.slice(end)}`.replace(/\n{3,}/g, "\n\n");
}

export interface AgentDescriptionOptions {
  lean?: boolean;
  mainAgent?: boolean;
  /** Open "When to use" with what a delegated agent costs before when to reach for one. */
  delegationCostFirst?: boolean;
}

export function buildAgentDescription(opts: AgentDescriptionOptions = {}): string {
  const base = applyTokens(
    ((opts.lean ?? true) ? tool.description.base.lean : tool.description.base.full).trimEnd(),
    {
      "{{WHEN_TO_USE}}": opts.delegationCostFirst
        ? tool.description.whenToUse.costFirst
        : tool.description.whenToUse.standard,
    },
  );
  const description = applyBackgroundDefault(`${base}\n\n${tool.description.offAddendum}`);
  return opts.mainAgent === false ? stripForkGuidance(description) : description;
}

export function buildTierAwareAgentDescription(
  roster: ResolvedTierRoster,
  mainAgent = true,
): string {
  const section = buildMultiproviderToolSection(roster);
  const description = applyBackgroundDefault(
    `${tool.description.preamble}\n${section}\n${tool.description.body}`,
  );
  return mainAgent ? description : stripForkGuidance(description);
}
