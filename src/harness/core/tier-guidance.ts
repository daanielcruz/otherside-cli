import { TIER_NAMES, type TierName } from "@/harness/core/tier-names.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";

export const TIER_BRIEF: Record<TierName, string> = {
  emperor:
    "the highest reasoning rank. It owns ALL thinking: analysis, planning, architecture, synthesis, the hard calls, final verification, and the audit of everything the lower ranks bring back. Keep it doing emperor's work; it is not a last resort, it is where deep reasoning belongs.",
  shogun:
    "complex execution with judgment. It campaigns over a direction the emperor already set: tactical planning, multi-step implementation, review and verification passes — it sequences the work and adapts when the field shifts, but strategy, final calls, and the last word stay above it. Send it work that needs competent decisions inside a decided direction.",
  daimyo:
    "the fast capable workhorse. It thinks less than it runs — code edits, sweeps, tracing, collecting findings, iterative check loops. It shines on tool-driven iteration — debugging, driving emulators, browsers, web pages, tmux/asciinema captures — where converging takes many fast rounds, not deep thought. It needs detailed information, not open questions: if the brief leaves it deciding, the brief is incomplete; what it collects is evidence for the upper ranks to audit, never a conclusion to trust. On iterative work it often out-fights heavier models by looping and re-checking.",
  samurai:
    "cheapest, fastest, plentiful — and deliberately occasional: route here ONLY by explicit tier selection, for massive, purely mechanical, speed-hungry work over an already-traced path — high-fanout sweeps, inventories, format conversions — or deliberately quick surface reads. Zero judgment expected: every step pre-decided, output shape fixed.",
};

const RULER_FRAME =
  "You are the ruler: you coordinate, decide, and verify. You command four ranks and assign each the work it is built for — the emperor reasons, the shogun campaigns with judgment, the daimyo carries the iteration, the samurai sweeps the mechanical. This is about FIT, not rationing: use each rank when the task shape calls for it, and keep work inline when delegation adds no value.";

const SPEED_PRINCIPLE =
  "Capability is not the only axis — task SHAPE matters. On iterative, verifiable work — comparing two UI layouts with Playwright, chasing a flaky test, sweeping many files — a fast daimyo or samurai often BEATS a heavier model: it runs the loop more times, re-checks its own output, and converges with fewer net errors, while a slower model spends its budget deliberating, stalls, and still slips. Reach for the emperor when the bottleneck is reasoning, for the daimyo/samurai when the bottleneck is iteration.";

const DELEGATE_DOWN =
  "Match work to rank. Don't put the emperor on samurai work like formatting, boilerplate, or a one-file lookup — not because it can't, but because that's the daimyo's and samurai's job and they finish it faster, which frees the emperor for the hard reasoning only it should own. The emperor stays busy being an emperor.";

const BRIEFING_PRINCIPLE =
  "Brief by rank — the HOW is yours, the labor is theirs. Before a daimyo or samurai is dispatched, every decision must already be made: design, semantics, edge-case policy, and ALL model-facing text. An artifact that is pure decision with no labor (a prompt, a policy, a piece of wording) is never dispatched — author it directly. The brief carries the decided path: exact files, concrete steps in order, commands to run, the checks that prove each step worked, what to do on the likely failure, and the exact output shape. Calibrate the depth by two failure modes: too shallow — the brief contains a decision verb (pick, choose, decide, verify-and-choose), so the delegate will decide for you; too deep — the brief is essentially the patch, so stop and apply it yourself. The right level: decided design + exact targets + acceptance checks; the delegate writes the code. A samurai gets zero latitude; a daimyo chooses HOW to execute each step, never WHAT the step is. A shogun receives the direction and the constraints, and owns the tactical sequence inside them. Invert for the emperor: goal, context, and room to think — over-prescribing an emperor biases it and wastes the very capability you summoned. Detail goes down the ranks; latitude goes up.";

const RECON_PRINCIPLE =
  "Context flows UP the ranks: when relevant context is missing, fan daimyos out to gather what the plan needs — file inventories, call sites, configs, logs, docs — without duplicating investigation already in progress or repeating evidence already collected. Give each delegate an explicit how-to AND a compact output contract (return exactly what the plan needs — locations, verdicts, counts — never raw dumps that flood the context the fan-out exists to protect). Plan on top of what they bring back, then dispatch the work with briefs enriched by that recon. Daimyos explore too — send them to sweep, trace, and collect. But a finding returns as EVIDENCE — file:line and a verbatim snippet per claim — never as a verdict: fast tiers compress, and compression invents. An emperor audits what comes back: before building on delegated recon, open the load-bearing citations; conflicting reports are settled by reading the code, never by plausibility.";

const THINKING_STAYS_PRINCIPLE =
  'Thinking belongs at the emperor tier: analysis, synthesis, decisions, and final verification stay with the dispatcher or an emperor agent explicitly assigned that responsibility. Daimyo and samurai delegates execute decided work and collect evidence; they never own the final interpretation. "Based on your findings, fix it" sent to a fast tier is the canonical anti-pattern: it pushes synthesis onto the delegate least equipped for it. The dispatcher or emperor reads the recon, forms the plan, and judges the result.';

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
    "## Multi-provider orchestration (ACTIVE — feudalism)",
    RULER_FRAME,
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
