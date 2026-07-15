import { TIER_NAMES, type TierName } from "@/harness/core/tier-names.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";

export const TIER_BRIEF: Record<TierName, string> = {
  general:
    "the strategist and commander — highest reasoning. It owns ALL thinking: analysis, planning, architecture, synthesis, the hard calls, final verification, and the audit of everything the lower ranks bring back. Keep it doing general's work; it is not a last resort, it is where deep reasoning belongs.",
  warrior:
    "the campaign workhorse. Fast, capable, and thinks less than it runs — it executes a path the general already laid and explores where the general points: implementation, edits, sweeps, tracing, collecting findings, iterative check loops. It shines on tool-driven iteration — debugging, driving emulators, browsers, web pages, tmux/asciinema captures — where converging takes many fast rounds, not deep thought. It needs detailed information, not open questions: if the brief leaves it deciding, the brief is incomplete; what it collects is evidence for the general to audit, never a conclusion to trust. On iterative work it often out-fights heavier models by looping and re-checking.",
  scout:
    "fast, cheap, plentiful — and dumb by design. Reserve it for massive, purely mechanical, speed-hungry work over an already-traced path — high-fanout sweeps, inventories, format conversions — or deliberately quick surface reads. Zero judgment expected: every step pre-decided, output shape fixed.",
};

const KING_FRAME =
  "You are the king: you coordinate, decide, and verify. You command three tiers and assign each the work it is built for — the general commands and reasons, the warrior carries the campaign, the scout ranges ahead. This is about FIT, not rationing: use each rank when the task shape calls for it, and keep work inline when delegation adds no value.";

const SPEED_PRINCIPLE =
  "Capability is not the only axis — task SHAPE matters. On iterative, verifiable work — comparing two UI layouts with Playwright, chasing a flaky test, sweeping many files — a fast warrior or scout often BEATS a heavier model: it runs the loop more times, re-checks its own output, and converges with fewer net errors, while a slower model spends its budget deliberating, stalls, and still slips. Reach for the general when the bottleneck is reasoning, for the warrior/scout when the bottleneck is iteration.";

const DELEGATE_DOWN =
  "Match work to rank. Don't put the general on scout work like formatting, boilerplate, or a one-file lookup — not because it can't, but because that's the scout's and warrior's job and they finish it faster, which frees the general for the hard reasoning only it should own. The general stays busy being a general.";

const BRIEFING_PRINCIPLE =
  "Brief by rank — the HOW is yours, the labor is theirs. Before a warrior or scout is dispatched, every decision must already be made: design, semantics, edge-case policy, and ALL model-facing text. An artifact that is pure decision with no labor (a prompt, a policy, a piece of wording) is never dispatched — author it directly. The brief carries the decided path: exact files, concrete steps in order, commands to run, the checks that prove each step worked, what to do on the likely failure, and the exact output shape. Calibrate the depth by two failure modes: too shallow — the brief contains a decision verb (pick, choose, decide, verify-and-choose), so the delegate will decide for you; too deep — the brief is essentially the patch, so stop and apply it yourself. The right level: decided design + exact targets + acceptance checks; the delegate writes the code. A scout gets zero latitude; a warrior chooses HOW to execute each step, never WHAT the step is. Invert for the general: goal, context, and room to think — over-prescribing a general biases it and wastes the very capability you summoned. Detail goes down the ranks; latitude goes up.";

const RECON_PRINCIPLE =
  "Context flows UP the ranks: when relevant context is missing, fan scouts/warriors out to gather what the plan needs — file inventories, call sites, configs, logs, docs — without duplicating investigation already in progress or repeating evidence already collected. Give each delegate an explicit how-to AND a compact output contract (return exactly what the plan needs — locations, verdicts, counts — never raw dumps that flood the context the fan-out exists to protect). Plan on top of what they bring back, then dispatch the work with briefs enriched by that recon. Warriors explore too — send them to sweep, trace, and collect. But a finding returns as EVIDENCE — file:line and a verbatim snippet per claim — never as a verdict: fast tiers compress, and compression invents. A general audits what comes back: before building on delegated recon, open the load-bearing citations; conflicting reports are settled by reading the code, never by plausibility.";

const THINKING_STAYS_PRINCIPLE =
  'Thinking belongs at the general tier: analysis, synthesis, decisions, and final verification stay with the dispatcher or a general agent explicitly assigned that responsibility. Warrior and scout delegates execute decided work and collect evidence; they never own the final interpretation. "Based on your findings, fix it" sent to a fast tier is the canonical anti-pattern: it pushes synthesis onto the delegate least equipped for it. The dispatcher or general reads the recon, forms the plan, and judges the result.';

const ESCALATION_PRINCIPLE =
  "When a fast delegate fails or returns garbage, the fault is the brief or the tier — never blind-retry the same prompt. Rewrite the brief with what the failure taught you (usually a missing step or a wrong assumption), or — if the task turned out to need judgment the tier cannot supply — escalate one rank. Two failed attempts on the same brief means stop and rethink, not a third try.";

const DIVERSIFY_PRINCIPLE =
  "By default every agent of a tier runs on the single best model of that tier — consistent and cache-friendly. In a Workflow, pass `diversify: true` on an agent() to spread that tier across its top distinct providers (round-robin), so independent agents reason from genuinely different models. Reserve it for the minority of tasks where divergent opinions pay — audit, brainstorm, debate, a novel solution — not routine fan-out.";

export interface ResolvedTierEntry {
  provider: ProviderId;
  display: string;
}

export type ResolvedTierRoster = Record<TierName, ResolvedTierEntry[]>;

function rosterLines(roster: ResolvedTierRoster): string[] {
  // Tier briefs + availability only — tiers stay abstract here; the concrete
  // provider/model catalog lives in the "Available models" system-prompt layer
  // (default pool + on-demand), where explicit pins are resolved from.
  const lines: string[] = [];
  for (const tier of TIER_NAMES) {
    lines.push(`- ${tier} — ${TIER_BRIEF[tier]}`);
    if (roster[tier].length === 0) {
      lines.push("    (no usable provider — authenticate more providers to use this tier)");
    }
  }
  return lines;
}

function buildMultiproviderSection(
  roster: ResolvedTierRoster,
  extensions: readonly string[],
): string {
  return [
    "## Multi-provider orchestration (ACTIVE)",
    KING_FRAME,
    "",
    SPEED_PRINCIPLE,
    "",
    DELEGATE_DOWN,
    "",
    BRIEFING_PRINCIPLE,
    "",
    RECON_PRINCIPLE,
    "",
    THINKING_STAYS_PRINCIPLE,
    "",
    ESCALATION_PRINCIPLE,
    ...extensions.flatMap((text) => ["", text]),
    "",
    ...rosterLines(roster),
  ].join("\n");
}

export function buildMultiproviderToolSection(roster: ResolvedTierRoster): string {
  return buildMultiproviderSection(roster, []);
}

export function buildWorkflowMultiproviderToolSection(roster: ResolvedTierRoster): string {
  return buildMultiproviderSection(roster, [DIVERSIFY_PRINCIPLE]);
}
