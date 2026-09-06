import type { WorkflowPhaseSpec } from "@/engine/background/workflows/runtime/parser/types.ts";
import type { WorkflowDefinition } from "@/engine/background/workflows/runtime/registry/types.ts";

const WORKFLOW_NAME = "ultraplan";
const WORKFLOW_DESCRIPTION =
  "Workflow-backed deep planning — fan-out explorer agents map the codebase, competing approaches are drafted and independently critiqued, then merged into one ordered, verifiable implementation plan.";
const WORKFLOW_WHEN_TO_USE =
  'Deep, multi-agent implementation planning for a non-trivial change. Pass args as "<level> <task>" — level is high, xhigh, or max (default high); task is the change to plan (a feature, refactor, or free-form instruction, e.g. "add OAuth login", "split the parser into modules", "only plan changes under src/engine"). Produces a final plan with context, an ordered step list naming files, reuse notes, a dependency diagram, risks, and a verification section. It is read-only — it explores and designs, it does not write any code.';
const WORKFLOW_PHASES: WorkflowPhaseSpec[] = [
  { index: 0, title: "Scope", detail: "Restate the task and decompose it into exploration areas" },
  {
    index: 1,
    title: "Explore",
    detail: "One explorer agent per area — map files, reusable code, and constraints",
  },
  {
    index: 2,
    title: "Design",
    detail: "Competing approaches drafted from the exploration (minimal / pragmatic / robust)",
  },
  {
    index: 3,
    title: "Critique",
    detail: "Independent reviewer per approach — gaps, risks, missed reuse (xhigh/max)",
  },
  {
    index: 4,
    title: "Synthesize",
    detail: "Merge into one ordered plan with diagram, files, and verification",
  },
];

const STANCE_MINIMAL = `**Minimal** — the smallest, most surgical change that fully satisfies the
requirement. Reuse existing code and patterns to the maximum, touch as few
files as possible, and add no new abstraction. Prefer extending what exists
over introducing new structure.`;
const STANCE_PRAGMATIC = `**Pragmatic** — the balanced approach: solve the requirement cleanly without
over-engineering. Reuse where it is natural, add structure only where it pays
for itself, and keep the change reviewable in one sitting.`;
const STANCE_ROBUST = `**Robust** — the deeper, more general solution. Fix the root cause rather than
the symptom and generalize the underlying mechanism instead of layering
special cases. Accept a larger change now if it prevents fragile band-aids
later. Special cases bolted onto shared infrastructure are a smell.`;

const VERDICT_LADDER = `- **SOUND** — implementable as written, reuses what already exists, no major gaps.
- **NEEDS_WORK** — viable but has fixable gaps, an unhandled case, or missed reuse.
- **FLAWED** — wrong altitude, breaks an existing call site, or ignores a stated constraint.`;

const STANCE_DEFS = [
  { label: "minimal", text: STANCE_MINIMAL },
  { label: "pragmatic", text: STANCE_PRAGMATIC },
  { label: "robust", text: STANCE_ROBUST },
];

const SCRIPT = `export const meta = {
  name: ${JSON.stringify(WORKFLOW_NAME)},
  description: ${JSON.stringify(WORKFLOW_DESCRIPTION)},
  whenToUse: ${JSON.stringify(WORKFLOW_WHEN_TO_USE)},
  phases: ${JSON.stringify(WORKFLOW_PHASES.map((p) => ({ title: p.title, detail: p.detail })))},
}

// ultraplan: Scope → Explore (fan-out per area) → Design (competing stances) → Critique (xhigh/max) → Synthesize
// Mirrors the interactive ultraplan flow (explore → design → review → final plan) as an autonomous workflow.
// Task is passed via Workflow({name: 'ultraplan', args: '<level> <task>'}).
//   high  → 3 explore areas, 1 approach (pragmatic), no critique → plan
//   xhigh → 5 explore areas, 2 approaches (minimal+robust), critique → plan
//   max   → 5 explore areas, 3 approaches (minimal+pragmatic+robust), critique → plan
const LEVEL_PARAMS = {
  high: { exploreAreas: 3, stances: ["pragmatic"], critique: false },
  xhigh: { exploreAreas: 5, stances: ["minimal", "robust"], critique: true },
  max: { exploreAreas: 5, stances: ["minimal", "pragmatic", "robust"], critique: true },
}

const RAW_ARGS = (typeof args === "string" ? args : "").trim()
const FIRST = RAW_ARGS.split(/\\s+/)[0] || ""
// Own-property check so Object.prototype keys ("constructor", "toString") never parse as a level.
const FIRST_IS_LEVEL = Object.prototype.hasOwnProperty.call(LEVEL_PARAMS, FIRST)
const LEVEL = FIRST_IS_LEVEL ? FIRST : "high"
const TASK = (FIRST_IS_LEVEL ? RAW_ARGS.slice(FIRST.length).trim() : RAW_ARGS)
const P = LEVEL_PARAMS[LEVEL]

if (!TASK) {
  return { error: "No task provided. Pass it as args: Workflow({name: 'ultraplan', args: '<level> <task>'})." }
}

// Stance definitions shared with the interactive flow (one source of truth).
const STANCE_DEFS = ${JSON.stringify(STANCE_DEFS)}
const VERDICT_LADDER = ${JSON.stringify(VERDICT_LADDER)}
const STANCES = P.stances.map(l => STANCE_DEFS.find(s => s.label === l)).filter(Boolean)

// ─── Schemas ───
const SCOPE_SCHEMA = {
  type: "object", required: ["task", "summary", "areas"],
  properties: {
    task: { type: "string" },
    summary: { type: "string" },
    conventions: { type: "string" },
    areas: { type: "array", minItems: 1, maxItems: 6, items: {
      type: "object", required: ["label", "focus"],
      properties: {
        label: { type: "string" },
        focus: { type: "string" },
        rationale: { type: "string" },
      },
    }},
  },
}
const EXPLORE_SCHEMA = {
  type: "object", required: ["summary"],
  properties: {
    summary: { type: "string" },
    relevantFiles: { type: "array", items: {
      type: "object", required: ["path"],
      properties: { path: { type: "string" }, role: { type: "string" } },
    }},
    reusable: { type: "array", items: {
      type: "object", required: ["name"],
      properties: { name: { type: "string" }, path: { type: "string" }, use: { type: "string" } },
    }},
    patterns: { type: "string" },
    constraints: { type: "string" },
    risks: { type: "string" },
  },
}
const APPROACH_SCHEMA = {
  type: "object", required: ["title", "summary", "steps"],
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    steps: { type: "array", items: {
      type: "object", required: ["action"],
      properties: { action: { type: "string" }, files: { type: "array", items: { type: "string" } } },
    }},
    reuse: { type: "string" },
    tradeoffs: { type: "string" },
    risks: { type: "string" },
  },
}
const CRITIQUE_SCHEMA = {
  type: "object", required: ["verdict", "assessment"],
  properties: {
    verdict: { enum: ["SOUND", "NEEDS_WORK", "FLAWED"] },
    assessment: { type: "string" },
    gaps: { type: "array", items: { type: "string" } },
    missedReuse: { type: "string" },
    risks: { type: "string" },
  },
}
const PLAN_SCHEMA = {
  type: "object", required: ["context", "approach", "steps", "verification"],
  properties: {
    context: { type: "string" },
    approach: { type: "string" },
    diagram: { type: "string" },
    steps: { type: "array", items: {
      type: "object", required: ["action"],
      properties: {
        action: { type: "string" },
        files: { type: "array", items: { type: "string" } },
        notes: { type: "string" },
      },
    }},
    reuse: { type: "array", items: {
      type: "object", required: ["name"],
      properties: { name: { type: "string" }, path: { type: "string" } },
    }},
    risks: { type: "array", items: { type: "string" } },
    verification: { type: "string" },
    openQuestions: { type: "array", items: { type: "string" } },
  },
}

// ─── Phase 0: Scope — restate the task, decompose into exploration areas ───
phase("Scope")
log(LEVEL + " plan: " + TASK.slice(0, 80) + (TASK.length > 80 ? "…" : ""))
const scope = await agent(
  "Establish the scope of an implementation-planning task. Do NOT design the solution yet — only map what must be explored.\\n\\n" +
  "## Task to plan\\n\\"" + TASK + "\\"\\n\\n" +
  "## Your job\\n" +
  "1. Restate the task in one or two sentences: what outcome is wanted, and any scope restriction the wording implies (honor 'only ...' / 'focus on ...').\\n" +
  "2. Read any OTHERSIDE.md / README that bears on the task and note conventions a planner must respect.\\n" +
  "3. Decompose the work into " + P.exploreAreas + " distinct EXPLORATION AREAS — independent parts of the codebase a planner must understand before designing. Pick areas that suit the task. Examples:\\n" +
  "   - existing implementation / entry points · data model & types · call sites & integration points · tests & fixtures · config & build\\n" +
  "   - for a feature: where similar features live · the seams to hook into · shared utilities to reuse · the UI/CLI surface · test patterns\\n" +
  "Each area needs a short label and a focus (what its explorer should find). Avoid overlap.\\n\\n" +
  "Structured output only.",
  { label: "scope", schema: SCOPE_SCHEMA }
)
if (!scope) {
  return { error: "Scope agent returned no result — cannot establish the planning scope." }
}
const AREAS = scope.areas.slice(0, P.exploreAreas)
log("Decomposed into " + AREAS.length + " areas: " + AREAS.map(a => a.label).join(", "))

const SCOPE_BLOCK =
  "## Planning scope\\n" +
  "Task: " + scope.task + "\\n\\n" +
  "## What is wanted\\n" + scope.summary + "\\n\\n" +
  "## Conventions\\n" + (scope.conventions || "(none noted)") + "\\n"

// ─── Phase 1: Explore — one agent per area, in parallel ───
phase("Explore")
const EXPLORE_PROMPT = area =>
  "## Codebase explorer — " + area.label + "\\n\\n" + SCOPE_BLOCK + "\\n" +
  "## Your area\\n**" + area.label + "** — " + area.focus + "\\n\\n" +
  "Use Glob, Grep, and Read to investigate ONLY your area. Read real code — do not guess. Report:\\n" +
  "1. The files most relevant to the task in your area, each with its role.\\n" +
  "2. Existing functions, utilities, or patterns that should be REUSED instead of writing new code — name each with its path and how to use it.\\n" +
  "3. Conventions and constraints any plan must respect.\\n" +
  "4. Risks or gotchas in this area.\\n\\n" +
  "If your area turns up nothing relevant, say so in the summary and return empty lists. Structured output only."

const explorations = (await parallel(
  AREAS.map(area => () =>
    agent(EXPLORE_PROMPT(area), { label: "explore:" + area.label, phase: "Explore", schema: EXPLORE_SCHEMA })
      .then(r => {
        if (!r) return null
        log(area.label + ": " + ((r.relevantFiles && r.relevantFiles.length) || 0) + " files, " + ((r.reusable && r.reusable.length) || 0) + " reusable")
        return { ...r, label: area.label }
      })
  )
)).filter(Boolean)

if (explorations.length === 0) {
  return { level: LEVEL, task: TASK, summary: "Exploration produced no findings — cannot plan.", steps: [], stats: { areas: AREAS.length, explored: 0 } }
}

const EXPLORE_BLOCK =
  "## Task\\n" + scope.task + "\\n\\n## Exploration findings\\n" +
  explorations.map(e =>
    "### " + e.label + "\\n" + e.summary + "\\n" +
    (e.relevantFiles && e.relevantFiles.length
      ? "Files:\\n" + e.relevantFiles.map(f => "  - " + f.path + (f.role ? " — " + f.role : "")).join("\\n") + "\\n" : "") +
    (e.reusable && e.reusable.length
      ? "Reuse:\\n" + e.reusable.map(r => "  - " + r.name + (r.path ? " (" + r.path + ")" : "") + (r.use ? " — " + r.use : "")).join("\\n") + "\\n" : "") +
    (e.patterns ? "Patterns: " + e.patterns + "\\n" : "") +
    (e.constraints ? "Constraints: " + e.constraints + "\\n" : "") +
    (e.risks ? "Risks: " + e.risks + "\\n" : "")
  ).join("\\n") + "\\n"

// ─── Phases 2+3 prompt builders ───
const DESIGN_PROMPT = stance =>
  "## Implementation planner — " + stance.label + " approach\\n\\n" + EXPLORE_BLOCK + "\\n" +
  "## Your stance\\n" + stance.text + "\\n\\n" +
  "Design a concrete implementation approach for the task above, committed to your stance. Provide:\\n" +
  "1. A title and a 2-3 sentence summary of the approach.\\n" +
  "2. An ORDERED list of steps. Each step is a concrete action that names the file(s) it touches.\\n" +
  "3. Which existing code from the exploration you reuse (name it with its path).\\n" +
  "4. The tradeoffs of this approach and its main risks.\\n\\n" +
  "Ground every step in the explored files — do not invent files that were not found. Structured output only."

const renderApproach = a =>
  "**" + a.title + "** (" + a.stance + ")\\n" + a.summary + "\\nSteps:\\n" +
  a.steps.map((s, i) => "  " + (i + 1) + ". " + s.action + (s.files && s.files.length ? " [" + s.files.join(", ") + "]" : "")).join("\\n") +
  "\\nReuse: " + (a.reuse || "—") + "\\nTradeoffs: " + (a.tradeoffs || "—") + "\\nRisks: " + (a.risks || "—")

const CRITIQUE_PROMPT = a =>
  "## Plan reviewer\\n\\n" + EXPLORE_BLOCK + "\\n" +
  "## Approach under review\\n" + renderApproach(a) + "\\n\\n" +
  "Your job is to verify that this plan is grounded in the ACTUAL CODE, not just the exploration summary above.\\n\\n" +
  "## Step 1 — Read the real files\\n" +
  "Use Glob, Grep, and Read to open the critical files listed in the exploration findings. " +
  "For each step in the approach that names a file, read it and check: does the step's action match what the code actually looks like? " +
  "Does the plan assume a function, type, or pattern that does not exist? Does it miss a call site that would break?\\n\\n" +
  "## Step 2 — Check alignment with the original task\\n" +
  "Re-read the task statement. Does this approach actually deliver what was asked, or does it solve a slightly different problem?\\n\\n" +
  "## Step 3 — Return your verdict\\n" +
  VERDICT_LADDER + "\\n\\n" +
  "Then name concrete gaps you found by reading the code (missing steps, wrong file, unhandled call site, missed reuse), any reuse the approach missed, and risks. " +
  "Quote the specific line or function that proves each gap. Structured output only."

// ─── Phases 2+3: Design → Critique, no barrier between stances (pipeline) ───
phase("Design")
// Each stance's design feeds directly into its critique without waiting for
// other stances to finish — mirrors code-review's finder → verifier streaming.
// When critique is disabled (high), the second stage is a no-op passthrough.
const reviewed = (await pipeline(
  STANCES,

  stance => agent(DESIGN_PROMPT(stance), { label: "design:" + stance.label, phase: "Design", schema: APPROACH_SCHEMA })
    .then(r => {
      if (!r) return null
      log("design:" + stance.label + " — " + r.title + " (" + r.steps.length + " steps)")
      return { ...r, stance: stance.label }
    }),

  approach => {
    if (!approach) return null
    if (!P.critique) return { approach, critique: null }
    return agent(CRITIQUE_PROMPT(approach), { label: "critique:" + approach.stance, phase: "Critique", schema: CRITIQUE_SCHEMA })
      .then(c => {
        if (c) log("critique:" + approach.stance + " → " + c.verdict)
        return { approach, critique: c }
      })
  }
)).filter(Boolean)

const approaches = reviewed.map(r => r.approach)

if (approaches.length === 0) {
  return { level: LEVEL, task: TASK, summary: "No implementation approach was produced.", steps: [], stats: { areas: AREAS.length, explored: explorations.length, approaches: 0 } }
}

// ─── Phase 4: Synthesize — merge into one final plan ───
phase("Synthesize")
const synthBlock = reviewed.map((r, i) =>
  "### Candidate [" + i + "]\\n" + renderApproach(r.approach) +
  (r.critique
    ? "\\nCritic verdict: " + r.critique.verdict + "\\nAssessment: " + r.critique.assessment +
      (r.critique.gaps && r.critique.gaps.length ? "\\nGaps: " + r.critique.gaps.join("; ") : "") +
      (r.critique.missedReuse ? "\\nMissed reuse: " + r.critique.missedReuse : "") +
      (r.critique.risks ? "\\nRisks: " + r.critique.risks : "")
    : "") + "\\n"
).join("\\n")

const plan = await agent(
  "## Synthesis: final implementation plan\\n\\n" + EXPLORE_BLOCK + "\\n" +
  approaches.length + " candidate approach(es) were drafted" + (P.critique ? " and independently critiqued" : "") + " (" + LEVEL + "-effort planning).\\n\\n" +
  synthBlock + "\\n" +
  "## Instructions\\n" +
  "1. Choose the best approach (or merge the strongest parts of several), guided by the critiques — prefer the right altitude and maximum reuse of existing code.\\n" +
  "2. Write a **context** paragraph: why this change is being made and the intended outcome.\\n" +
  "3. State the chosen **approach** in 2-3 sentences and why it wins over the alternatives.\\n" +
  "4. Provide a **diagram**: a mermaid block (or ascii) showing the dependency order / data flow / before-after shape of the change. Keep it to the nodes that carry the structure. If the change is linear with no shape, return an empty string.\\n" +
  "5. Give an ORDERED **steps** list — each a concrete action naming the file(s) it touches, with notes for anything non-obvious. This is what an implementer will follow without being able to ask questions.\\n" +
  "6. List the existing code to **reuse** (name + path), the **risks**, a **verification** section (how to test end-to-end: commands, tests, manual checks), and any **openQuestions**.\\n\\n" +
  "Do not invent files that were not surfaced by exploration. Structured output only.",
  { label: "synthesize", schema: PLAN_SCHEMA }
)

const stats = {
  level: LEVEL,
  areas: AREAS.length,
  explored: explorations.length,
  approaches: approaches.length,
  critiqued: P.critique ? reviewed.filter(r => r.critique).length : 0,
}

// Synthesis skipped/errored — salvage the best candidate raw rather than
// discarding the whole run. Prefer a SOUND-rated approach when critiques exist.
if (!plan) {
  const fallback = (reviewed.find(r => r.critique && r.critique.verdict === "SOUND") || reviewed[0]).approach
  return {
    level: LEVEL,
    task: TASK,
    summary: "Synthesis step was skipped or failed — returning the strongest unmerged candidate.",
    approach: fallback.title,
    steps: fallback.steps.map(s => ({ action: s.action, files: s.files })),
    risks: fallback.risks ? [fallback.risks] : [],
    verification: "(synthesis skipped — verify the steps above manually)",
    stats,
  }
}

return {
  level: LEVEL,
  task: TASK,
  ...plan,
  stats,
}`;

export const ULTRAPLAN_WORKFLOW: WorkflowDefinition = {
  source: "built-in",
  name: WORKFLOW_NAME,
  description: WORKFLOW_DESCRIPTION,
  whenToUse: WORKFLOW_WHEN_TO_USE,
  phases: WORKFLOW_PHASES,
  script: SCRIPT,
};
