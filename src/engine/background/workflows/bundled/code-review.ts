import type { WorkflowPhaseDescriptor } from "@/engine/background/workflows/runtime/parser/types.ts";
import type { WorkflowDefinition } from "@/engine/background/workflows/runtime/registry/types.ts";

const WORKFLOW_NAME = "code-review";
const WORKFLOW_DESCRIPTION =
  "Workflow-backed code review — one finder agent per review angle, an independent verifier for every candidate, then a ranked, capped findings report.";
const WORKFLOW_WHEN_TO_USE =
  'Launched by the /code-review skill at high, xhigh, or max effort when workflows are enabled. Pass args as "<level> [target]" — level is high, xhigh, or max; target is an optional PR number, branch, ref range, path, or free-form review instructions (e.g. "only review src/foo.ts", "focus on error handling").';
const WORKFLOW_PHASES: WorkflowPhaseDescriptor[] = [
  { index: 0, title: "Scope", detail: "Pin the diff command, changed files, and conventions" },
  {
    index: 1,
    title: "Find",
    detail: "One finder agent per review angle (correctness + cleanup), streaming into verify",
  },
  {
    index: 2,
    title: "Verify",
    detail: "One independent verifier per candidate — CONFIRMED / PLAUSIBLE / REFUTED",
  },
  { index: 3, title: "Sweep", detail: "Fresh finder hunting only for gaps (xhigh/max)" },
  { index: 4, title: "Synthesize", detail: "Merge duplicates, rank, cap the report" },
];

const ANGLE_A = `### Angle A — line-by-line diff scan

Read every hunk in the diff, line by line. Then Read the enclosing function for
each hunk — bugs in unchanged lines of a touched function are in scope (the PR
re-exposes or fails to fix them). For every line ask: what input, state, timing,
or platform makes this line wrong? Look for inverted/wrong conditions,
off-by-one, null/undefined deref, missing \`await\`, falsy-zero checks,
wrong-variable copy-paste, error swallowed in catch, unescaped regex metachars.
`;
const ANGLE_B = `### Angle B — removed-behavior auditor

For every line the diff DELETES or replaces, name the invariant or behavior it
enforced, then search the new code for where that invariant is re-established.
If you can't find it, that's a candidate: a removed guard, a dropped error
path, a narrowed validation, a deleted test that was covering a real case.
`;
const ANGLE_C = `### Angle C — cross-file tracer

For each function the diff changes, find its callers (Grep for the symbol) and
check whether the change breaks any call site: a new precondition, a changed
return shape, a new exception, a timing/ordering dependency. Also check callees:
does a parallel change in the same PR make a call unsafe?
`;
const ANGLE_D = `### Angle D — language-pitfall specialist

Scan for the classic pitfalls of the diff's language/framework — for example:
JS falsy-zero, \`==\` coercion, closure-captured loop var; Python mutable default
args, late-binding closures; Go nil-map write, range-var capture; SQL injection;
timezone/DST drift; float equality. Flag any instance the diff introduces.
`;
const ANGLE_E = `### Angle E — wrapper/proxy correctness

When the PR adds or modifies a type that wraps another (cache, proxy, decorator,
adapter): check that every method routes to the wrapped instance and not back
through a registry/session/global — e.g. a caching provider holding a
\`delegate\` field that resolves IDs via \`session.get(...)\` instead of
\`delegate.get(...)\` will re-enter the cache or recurse. Also check that the
wrapper forwards all the methods the callers actually use.
`;

const REUSE_BODY = `Flag new code that re-implements something the codebase
already has — Grep shared/utility modules and files adjacent to the change,
and name the existing helper to call instead.
`;
const SIMPLIFICATION = `### Simplification

Flag unnecessary complexity the diff adds: redundant or derivable state,
copy-paste with slight variation, deep nesting, dead code left behind. Name
the simpler form that does the same job.
`;
const EFFICIENCY = `### Efficiency

Flag wasted work the diff introduces: redundant computation or repeated I/O,
independent operations run sequentially, blocking work added to startup or
hot paths. Also flag long-lived objects built from closures or captured
environments — they keep the entire enclosing scope alive for the object's
lifetime (a memory leak when that scope holds large values); prefer a
class/struct that copies only the fields it needs. Name the cheaper
alternative.
`;
const ALTITUDE = `### Altitude

Check that each change is implemented at the right depth, not as a fragile
bandaid. Special cases layered on shared infrastructure are a sign the fix
isn't deep enough — prefer generalizing the underlying mechanism over adding
special cases.
`;

const VERDICT_LADDER = `- **CONFIRMED** — can name the inputs/state that trigger it and the wrong
  output or crash. Quote the line.
- **PLAUSIBLE** — mechanism is real, trigger is uncertain (timing, env,
  config). State what would confirm it.
- **REFUTED** — factually wrong (code doesn't say that) or guarded elsewhere.
  Quote the line that proves it.`;
const VERDICT_LADDER_RECALL = `**PLAUSIBLE by default** — do not refute a candidate for being "speculative" or
"depends on runtime state" when the state is realistic: concurrency races,
nil/undefined on a rare-but-reachable path (error handler, cold cache, missing
optional field), falsy-zero treated as missing, off-by-one on a boundary the
code does not exclude, retry storms / partial failures, regex/allowlist that
lost an anchor. These are PLAUSIBLE.

**REFUTED** only when constructible from the code: factually wrong (quote the
actual line); provably impossible (type/constant/invariant — show it); already
handled in this diff (cite the guard); or pure style with no observable effect.`;
const CLEANUP_PRECEDENCE =
  "Cleanup and altitude candidates use the same `file`/`line`/`summary` shape; in\n`failure_scenario`, state the concrete cost (what is duplicated, wasted, or\nharder to maintain) instead of a crash. Correctness bugs always outrank\ncleanup and altitude findings when the output cap forces a cut.\n";
const SWEEP_GAP_FOCUS = `moved/extracted code that dropped a guard
or anchor; second-tier footguns (dataclass default evaluated once, \`hash()\`
non-determinism, lock-scope shrink, predicate methods with side effects);
setup/teardown asymmetry in tests; config defaults flipped.`;

const CORRECTNESS_ANGLES = [ANGLE_A, ANGLE_B, ANGLE_C, ANGLE_D, ANGLE_E].map((text, i) => ({
  label: `angle-${"ABCDE"[i]}`,
  text,
}));
const CLEANUP_ANGLES = [
  { label: "reuse", text: `### Reuse\n\n${REUSE_BODY}` },
  { label: "simplification", text: SIMPLIFICATION },
  { label: "efficiency", text: EFFICIENCY },
  { label: "altitude", text: ALTITUDE },
];

const SCRIPT = `export const meta = {
  name: ${JSON.stringify(WORKFLOW_NAME)},
  description: ${JSON.stringify(WORKFLOW_DESCRIPTION)},
  whenToUse: ${JSON.stringify(WORKFLOW_WHEN_TO_USE)},
  phases: ${JSON.stringify(WORKFLOW_PHASES.map((p) => ({ title: p.title, detail: p.detail })))},
}

// code-review: Scope → pipeline(per-angle Find → dedup → Verify) → Sweep (xhigh/max) → Synthesize
// Effort parameterization mirrors the inline /code-review cells:
//   high  → 3 correctness + 4 cleanup angles \xD7 6 → ≤10 findings
//   xhigh → 5 correctness + 4 cleanup angles \xD7 8 → sweep → ≤15 findings
//   max   → same structure as xhigh (the API reasoning effort differs, not the fan-out)
const LEVEL_PARAMS = {
  high: { correctnessAngles: 3, perAngle: 6, maxFindings: 10, sweep: false },
  xhigh: { correctnessAngles: 5, perAngle: 8, maxFindings: 15, sweep: true },
  max: { correctnessAngles: 5, perAngle: 8, maxFindings: 15, sweep: true },
}
const MAX_VERIFY = 25
const SWEEP_MAX = 8

const RAW_ARGS = (typeof args === "string" ? args : "").trim()
const FIRST = RAW_ARGS.split(/\\s+/)[0] || ""
// Own-property check so Object.prototype keys ("constructor", "toString") never parse as a level.
const FIRST_IS_LEVEL = Object.prototype.hasOwnProperty.call(LEVEL_PARAMS, FIRST)
const LEVEL = FIRST_IS_LEVEL ? FIRST : "high"
const TARGET = FIRST_IS_LEVEL ? RAW_ARGS.slice(FIRST.length).trim() : RAW_ARGS
const P = LEVEL_PARAMS[LEVEL]

// Prompt fragments shared with the inline /code-review cells (one source of truth).
const CORRECTNESS_ANGLES = ${JSON.stringify(CORRECTNESS_ANGLES)}
const CLEANUP_ANGLES = ${JSON.stringify(CLEANUP_ANGLES)}
const VERDICT_LADDER = ${JSON.stringify(VERDICT_LADDER)}
const VERDICT_LADDER_RECALL = ${JSON.stringify(VERDICT_LADDER_RECALL)}
const CLEANUP_PRECEDENCE = ${JSON.stringify(CLEANUP_PRECEDENCE)}
const SWEEP_GAP_FOCUS = ${JSON.stringify(SWEEP_GAP_FOCUS)}

// ─── Schemas ───
const SCOPE_SCHEMA = {
  type: "object", required: ["diffCommand", "files", "summary"],
  properties: {
    diffCommand: { type: "string" },
    files: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
    conventions: { type: "string" },
  },
}
const CANDIDATES_SCHEMA = {
  type: "object", required: ["candidates"],
  properties: {
    candidates: { type: "array", items: {
      type: "object", required: ["file", "summary", "failure_scenario"],
      properties: {
        file: { type: "string" },
        line: { type: "number" },
        summary: { type: "string" },
        failure_scenario: { type: "string" },
      },
    }},
  },
}
const VERDICT_SCHEMA = {
  type: "object", required: ["verdict", "evidence"],
  properties: {
    verdict: { enum: ["CONFIRMED", "PLAUSIBLE", "REFUTED"] },
    evidence: { type: "string" },
  },
}
const REPORT_SCHEMA = {
  type: "object", required: ["summary", "findings"],
  properties: {
    summary: { type: "string" },
    findings: { type: "array", items: {
      type: "object", required: ["file", "summary", "failure_scenario", "verdict"],
      properties: {
        file: { type: "string" },
        line: { type: "number" },
        summary: { type: "string" },
        failure_scenario: { type: "string" },
        verdict: { enum: ["CONFIRMED", "PLAUSIBLE"] },
      },
    }},
  },
}

// ─── Phase 0: Scope ───
phase("Scope")
const scope = await agent(
  "Establish the scope of a code review.\\n\\n" +
  (TARGET
    ? "Review target / instructions (passed by the user, verbatim): \\"" + TARGET + "\\". If it names a PR number, branch, ref range, or file path, build the matching git diff command for it; if it is a free-form instruction (e.g. only review certain files, focus on certain areas), honor any scope restriction when building the diff command and start from the current branch diff ('git diff @{upstream}...HEAD', falling back to 'git diff main...HEAD' or 'git diff HEAD~1') for whatever it does not narrow.\\n"
    : "No explicit target — review the current branch: prefer 'git diff @{upstream}...HEAD' (fall back to 'git diff main...HEAD' or 'git diff HEAD~1'), and if there are uncommitted changes also include 'git diff HEAD'.\\n") +
  "\\n1. Determine the exact diff command(s) for the review and run them to confirm they produce a non-empty diff.\\n" +
  "2. List the changed files.\\n" +
  "3. Summarize what changed in one paragraph.\\n" +
  "4. Read OTHERSIDE.md files relevant to the changed files and note conventions a reviewer should know.\\n\\n" +
  "Return diffCommand exactly as a reviewer should run it. Structured output only.",
  { label: "scope", schema: SCOPE_SCHEMA }
)
if (!scope) {
  return { error: "Scope agent returned no result — cannot establish the review scope." }
}
if (!scope.files || scope.files.length === 0) {
  return { level: LEVEL, target: TARGET || undefined, summary: "No changes found to review.", findings: [], stats: { finders: 0, candidates: 0, verified: 0 } }
}
log(LEVEL + " review: " + scope.files.length + " changed files")

const SCOPE_BLOCK =
  "## Review scope\\n" +
  "Diff command: " + scope.diffCommand + "\\n" +
  "Changed files (" + scope.files.length + "):\\n" +
  scope.files.map(f => "  - " + f).join("\\n") + "\\n\\n" +
  "## What changed\\n" + scope.summary + "\\n\\n" +
  "## Conventions\\n" + (scope.conventions || "(none noted)") + "\\n" +
  // The user's verbatim target/instructions ride along to every finder,
  // verifier, and sweep agent so focus areas and skip requests are honored,
  // not just used for diff scoping.
  (TARGET
    ? "\\n## User instructions (verbatim)\\n" + TARGET + "\\nHonor any scope restrictions or focus areas stated above — they take precedence over your angle's default breadth. Do not surface findings the instructions ask to skip.\\n"
    : "")

// ─── Prompts ───
const FINDER_PROMPT = f =>
  "## Code-review finder — " + f.label + "\\n\\n" + SCOPE_BLOCK + "\\n" +
  "Run the diff command above and review ONLY through the lens of your assigned angle:\\n\\n" +
  f.text + "\\n" +
  (f.kind === "cleanup" ? CLEANUP_PRECEDENCE + "\\n" : "") +
  "Surface up to " + P.perAngle + " candidate findings, each with file, line, a one-line summary, and a concrete failure_scenario. " +
  "Pass every candidate with a nameable failure scenario through — do not silently drop half-believed candidates; an independent verifier judges them next. " +
  "If nothing qualifies, return an empty list.\\n\\nStructured output only."

const VERIFIER_PROMPT = c =>
  "## Code-review verifier\\n\\n" + SCOPE_BLOCK + "\\n" +
  "## Candidate finding\\n" +
  "File: " + c.file + (c.line != null ? ":" + c.line : "") + "\\n" +
  "Summary: " + c.summary + "\\n" +
  "Failure scenario: " + c.failure_scenario + "\\n\\n" +
  "Run the diff command above, read the relevant file(s), and return exactly one verdict:\\n\\n" +
  VERDICT_LADDER + "\\n\\n" + VERDICT_LADDER_RECALL + "\\n\\n" +
  "Structured output only. Evidence must quote or cite the relevant line(s)."

// ─── Dedup + verify-budget state — accumulates as finders complete (pipeline has no barrier) ───
const dedupKey = c => c.file + ":" + (c.line != null ? Math.round(c.line / 5) * 5 : "x:" + c.summary.toLowerCase().slice(0, 40))
const seen = new Map()
const dupes = []
const budgetDropped = []
let verifySlots = MAX_VERIFY

function verifyCandidate(c) {
  const short = (c.file || "").split("/").pop()
  return agent(VERIFIER_PROMPT(c), { label: "verify:" + short, phase: "Verify", schema: VERDICT_SCHEMA })
    .then(v => (v ? { ...c, verdict: v.verdict, evidence: v.evidence } : null))
}

// ─── Find → dedup → Verify, no barrier between finders ───
const FINDERS = CORRECTNESS_ANGLES.slice(0, P.correctnessAngles)
  .map(a => ({ ...a, kind: "correctness" }))
  .concat(CLEANUP_ANGLES.map(a => ({ ...a, kind: "cleanup" })))

const finderResults = await pipeline(
  FINDERS,

  f => agent(FINDER_PROMPT(f), { label: f.label, phase: "Find", schema: CANDIDATES_SCHEMA }).then(r => {
    if (!r) return { finder: f, candidates: [] }
    log(f.label + ": " + r.candidates.length + " candidates")
    return { finder: f, candidates: r.candidates.slice(0, P.perAngle) }
  }),

  result => {
    const novel = result.candidates.filter(c => {
      const key = dedupKey(c)
      if (seen.has(key)) {
        dupes.push(c)
        return false
      }
      if (verifySlots <= 0) {
        budgetDropped.push(c)
        return false
      }
      seen.set(key, true)
      verifySlots--
      return true
    })
    return parallel(novel.map(c => () => verifyCandidate({ ...c, kind: result.finder.kind })))
  }
)

let verified = finderResults.flat().filter(Boolean)

// ─── Sweep (xhigh/max): one fresh finder hunting only for gaps ───
if (P.sweep) {
  phase("Sweep")
  const knownBlock = verified.length > 0
    ? verified.map(c => "- " + c.file + (c.line != null ? ":" + c.line : "") + " — " + c.summary).join("\\n")
    : "(none)"
  const sweep = await agent(
    "## Code-review sweep — gaps only\\n\\n" + SCOPE_BLOCK + "\\n" +
    "## Already-found candidates (do NOT re-derive or re-confirm these)\\n" + knownBlock + "\\n\\n" +
    "Re-read the diff and the enclosing functions looking ONLY for defects not already listed. " +
    "Focus on what the first pass tends to miss: " + SWEEP_GAP_FOCUS + "\\n\\n" +
    "Surface up to " + SWEEP_MAX + " additional candidates. If nothing new, return an empty list — do not pad.\\n\\nStructured output only.",
    { label: "sweep", phase: "Sweep", schema: CANDIDATES_SCHEMA }
  )
  if (sweep && sweep.candidates.length > 0) {
    const novel = sweep.candidates.slice(0, SWEEP_MAX).filter(c => !seen.has(dedupKey(c)))
    log("sweep: " + novel.length + " new candidates")
    const sweepVerified = await parallel(novel.map(c => () => verifyCandidate({ ...c, kind: "correctness" })))
    verified = verified.concat(sweepVerified.filter(Boolean))
  }
}

const surviving = verified.filter(c => c.verdict !== "REFUTED")
const refuted = verified.filter(c => c.verdict === "REFUTED")
log("Verify done: " + verified.length + " verified → " + surviving.length + " kept, " + refuted.length + " refuted")

const stats = {
  level: LEVEL,
  finders: FINDERS.length,
  candidates: seen.size + dupes.length + budgetDropped.length,
  verified: verified.length,
  refuted: refuted.length,
  dupes: dupes.length,
  budgetDropped: budgetDropped.length,
}

if (surviving.length === 0) {
  return {
    level: LEVEL, target: TARGET || undefined,
    summary: "No findings survived verification.",
    findings: [],
    stats,
  }
}

// ─── Synthesize: rank, merge semantic dupes, cap ───
phase("Synthesize")
// Correctness bugs outrank cleanup findings when the cap forces a cut;
// CONFIRMED outranks PLAUSIBLE within each group.
const rank = c => (c.kind === "cleanup" ? 2 : 0) + (c.verdict === "PLAUSIBLE" ? 1 : 0)
const ranked = surviving.slice().sort((a, b) => rank(a) - rank(b))
const block = ranked.map((c, i) =>
  "### [" + i + "] " + c.file + (c.line != null ? ":" + c.line : "") + " (" + c.verdict + (c.kind === "cleanup" ? ", cleanup" : "") + ")\\n" +
  c.summary + "\\nFailure scenario: " + c.failure_scenario + "\\nVerifier evidence: " + c.evidence + "\\n"
).join("\\n")

const report = await agent(
  "## Synthesis: final code-review report\\n\\n" +
  ranked.length + " findings survived independent verification (" + LEVEL + "-effort review).\\n\\n" + block + "\\n" +
  "## Instructions\\n" +
  "1. Merge findings that describe the same defect (same root cause) — combine their evidence.\\n" +
  "2. Rank most-severe first. Correctness bugs always outrank cleanup findings.\\n" +
  "3. Keep at most " + P.maxFindings + " findings; drop the least severe beyond the cap.\\n" +
  "4. Write a 2-3 sentence summary of the review.\\n\\nStructured output only.",
  { label: "synthesize", schema: REPORT_SCHEMA }
)

// Synthesis skipped/errored — salvage the verified findings unmerged rather
// than discarding the run.
const findings = report
  ? report.findings.slice(0, P.maxFindings)
  : ranked.slice(0, P.maxFindings).map(c => ({
      file: c.file, line: c.line, summary: c.summary, failure_scenario: c.failure_scenario, verdict: c.verdict,
    }))

return {
  level: LEVEL,
  target: TARGET || undefined,
  summary: report ? report.summary : "Synthesis step was skipped or failed — returning verified findings unmerged.",
  findings,
  refuted: refuted.map(c => ({ file: c.file, line: c.line, summary: c.summary })),
  stats: { ...stats, reported: findings.length },
}`;

export const CODE_REVIEW_WORKFLOW: WorkflowDefinition = {
  source: "built-in",
  name: WORKFLOW_NAME,
  description: WORKFLOW_DESCRIPTION,
  whenToUse: WORKFLOW_WHEN_TO_USE,
  phases: WORKFLOW_PHASES,
  script: SCRIPT,
  hidden: true,
};
