import type { CategorizedLayer, LayerContext } from "@/harness/composer/types.ts";

const BANG_COMMAND_BULLET =
  "If you need the user to run a shell command themselves (e.g., an interactive login like `gcloud auth login`), suggest they type `! <command>` in the prompt — the `!` prefix runs the command in this session so its output lands directly in the conversation.";

const SKILL_BULLET =
  "When the user types `/<skill-name>`, invoke it via Skill. Only use skills listed in the user-invocable skills section — don't guess.";

const AGENT_DELEGATION_BULLET =
  "Use the Agent tool with specialized agents when the task at hand matches the agent's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but they should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing - if you delegate research to a subagent, do not also perform the same searches yourself.";

const EXPLORE_BULLET =
  "For broad codebase exploration or research that'll take more than 3 queries, spawn Agent with subagent_type=Explore. Otherwise use `find` or `grep` via the Bash tool directly.";

const FORK_BULLET =
  'Calling Agent with subagent_type: "fork" creates a fork — it inherits your full conversation context, runs in the background, and keeps its tool output out of your context — so you can keep chatting with the user while it works. Reach for it when research or multi-step implementation work would otherwise fill your context with raw output you won\'t need again. Other subagent_type values (or omitting it) start fresh agents with no context. **If you ARE the fork** — execute directly; do not re-delegate.';

function buildSessionGuidance(lean: boolean, sonnet: boolean): string {
  const bullets = [BANG_COMMAND_BULLET];
  if (!lean) bullets.push(sonnet ? FORK_BULLET : AGENT_DELEGATION_BULLET);
  if (!lean && !sonnet) bullets.push(EXPLORE_BULLET);
  bullets.push(SKILL_BULLET);
  return ["# Session-specific guidance", ...bullets.map((b) => ` - ${b}`)].join("\n");
}

export const sessionGuidanceLayer: CategorizedLayer = {
  name: "session-guidance",
  kind: "system",
  cache: "1h",
  phase: "dynamic",
  render(ctx: LayerContext) {
    return buildSessionGuidance(!!ctx.lean, ctx.modelFamily === "sonnet");
  },
};

const MULTIPROVIDER_SESSION_BULLETS: readonly string[] = [
  "Multi-provider orchestration is ACTIVE. Match the tier to the task shape: `general` for strategy, synthesis, hard calls, final judgment, and auditing what delegates bring back; `warrior` for implementation, exploration/collection, and tool-driven iteration (debugging, browsers, emulators, tmux captures); `scout` for massive, purely mechanical fan-out.",
  "Do not default to the strongest model for every delegated task. Fast scout/warrior models often beat general models on search, UI loops, flaky tests, and broad file sweeps because they can iterate faster.",
  "The HOW is yours, the labor is theirs: make every decision (design, semantics, model-facing text) BEFORE dispatching a warrior/scout, and write the how-to into its prompt (steps, exact files, commands, checks, output shape) — a brief containing a decision verb is not ready. Delegated findings return as evidence (file:line + snippet), never verdicts — audit the load-bearing ones yourself before building on them.",
];

export const multiproviderGuidanceLayer: CategorizedLayer = {
  name: "multiprovider-guidance",
  kind: "system",
  cache: "1h",
  phase: "dynamic",
  render(ctx: LayerContext) {
    if (!ctx.multiproviderEnabled) return null;
    return [
      "# Multi-provider orchestration",
      ...MULTIPROVIDER_SESSION_BULLETS.map((b) => ` - ${b}`),
    ].join("\n");
  },
};
