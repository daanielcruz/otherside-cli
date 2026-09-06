export const DEEP_SECURITY_REVIEW_AUDIT = `log(LEVEL + " audit: " + scope.repo + " @ " + (scope.commitSha || "?") + " — " + LANES.length + " in-scope classes")

// Robust planner step
const plan = await safeAgent(
  "## Security Planner — category-specific narrow rails\\n\\n" +
  SCOPE_BLOCK + "\\n" +
  "Based on the preparation scope, you must create a detailed scan plan for each in-scope vulnerability class.\\n" +
  "For each category, define narrow 'rails' to focus the auditor. Rails must contain:\\n" +
  "- files: specific key files to inspect\\n" +
  "- globs: patterns to match relevant files (e.g. '**/*.ts')\\n" +
  "- symbols: function or class names related to this class in the codebase\\n" +
  "- entryPoints: where untrusted input for this category enters\\n" +
  "- sinks: dangerous APIs or patterns to look out for\\n" +
  "- safeSiblings: examples of safe/correct patterns in the repo that should be checked for divergence\\n" +
  "Return structured rails for each in-scope category. Structured output only.",
  { label: "planner", phase: "Prep", schema: PLANNER_SCHEMA, tier: "emperor" }
) || { rails: [] }

const AUDITOR_PROMPT = (lane, rail) => {
  const railBlock = rail
    ? "## Scan rails for " + lane.key + "\\n" +
      "Files to inspect: " + (rail.files || []).join(", ") + "\\n" +
      "Globs: " + (rail.globs || []).join(", ") + "\\n" +
      "Symbols: " + (rail.symbols || []).join(", ") + "\\n" +
      "Entry points: " + (rail.entryPoints || []).join(", ") + "\\n" +
      "Sinks: " + (rail.sinks || []).join(", ") + "\\n" +
      "Safe siblings: " + (rail.safeSiblings || []).join(", ") + "\\n" +
      "Rationale: " + rail.rationale + "\\n"
    : "";
  return "## Security auditor — " + lane.key + "\\n\\n" + SCOPE_BLOCK + "\\n" +
    railBlock + "\\n" +
    "Audit ONLY your class: " + lane.focus + "\\n\\n" +
    CROSS_FILE_LENS + "\\n\\n" +
    "Read the relevant files in full — greps are discovery, not proof. Surface up to " + P.perCategory + " candidate findings. " + FINDING_FIELDS + "\\n" +
    "Quote the snippet byte-for-byte from the file. Pass every candidate with a nameable source-to-sink path through — an independent debate judges them next; do not self-censor half-believed candidates, but do not pad with theoretical lint either.\\n" +
    "If the class is genuinely clean here, return an empty list.\\n\\n## Severity\\n" + SEVERITY_RUBRIC + "\\n\\nStructured output only."
}

const PROSECUTOR_PROMPT = (c) =>
  "## Prosecutor — argue this vulnerability is REAL and reachable\\n\\n" + SCOPE_BLOCK + "\\n" +
  candidateBlock(c) + "\\n" +
  "Build the strongest case that an attacker can reach this sink from a trust boundary and cause the claimed impact. Name the entry point, the path, and the trigger. Read the files to ground every step. If, after honest effort, you cannot construct a reachable path, say reachable=false. Structured output only."

const DEFENDER_PROMPT = (c) =>
  "## Defender — argue this is a FALSE POSITIVE\\n\\n" + SCOPE_BLOCK + "\\n" +
  candidateBlock(c) + "\\n" +
  "Try to refute it: is the source actually attacker-controllable? Is the sink guarded elsewhere (a validation, a caller precondition, a sibling that does it safely)? Is the path unreachable, or the severity inflated? Quote the line that exonerates it. If you cannot refute it, say reachable=true. Structured output only."

const JUDGE_PROMPT = (c, pro, def) =>
  "## Judge — rule on this security candidate after the debate\\n\\n" + SCOPE_BLOCK + "\\n" +
  candidateBlock(c) + "\\n" +
  "## Prosecution (real & reachable)\\n" + (pro ? (pro.argument + (pro.evidence ? "\\nEvidence: " + pro.evidence : "")) : "(no argument)") + "\\n\\n" +
  "## Defense (false positive)\\n" + (def ? (def.argument + (def.evidence ? "\\nEvidence: " + def.evidence : "")) : "(no argument)") + "\\n\\n" +
  JUDGE_RUBRIC + "\\n\\nStructured output only."

const JUDGE_SOLO_PROMPT = (c) =>
  "## Judge — rule on this security candidate\\n\\n" + SCOPE_BLOCK + "\\n" +
  candidateBlock(c) + "\\n" +
  "Argue BOTH sides yourself before ruling: first the strongest case it is real and reachable, then the strongest case it is a false positive (guarded elsewhere, unreachable, severity inflated). Read the files to settle it.\\n\\n" +
  JUDGE_RUBRIC + "\\n\\nStructured output only."

const JUDGE_RUBRIC =
  "Rule:\\n" +
  "- CONFIRMED — you can name the inputs/state that reach the sink and the resulting impact. Quote the line.\\n" +
  "- PLAUSIBLE — the mechanism is real but the trigger depends on realistic-but-unconfirmed state (a rare path, concurrency, config). Realistic reachability stays PLAUSIBLE, not refuted.\\n" +
  "- REFUTED — only when constructible from the code: the claim is factually wrong, provably impossible, already guarded in this repo (cite the guard), or pure style with no observable effect.\\n" +
  "Set reachable, and set severity per the rubric (Critical/High REQUIRE a concrete exploit path; downgrade if you cannot name one). " + SEVERITY_RUBRIC

const PROVER_PROMPT = (c) =>
  "## Prover — construct a concrete trigger for this confirmed finding\\n\\n" + SCOPE_BLOCK + "\\n" +
  candidateBlock(c) + "\\nVerdict so far: " + c.verdict + " · severity " + c.severity + "\\n\\n" +
  "Construct the most concrete proof-of-concept the code admits: the exact request/input/call sequence, or the precondition chain if it is not directly triggerable. Read the files to validate each step. " +
  "If no reachable path can be constructed AND the severity is Critical or High, set proven=false and downgrade severity to the highest level its real reachability supports. Structured output only."

function candidateBlock(c) {
  return "## Candidate (" + c.category + ")\\n" +
    "File: " + c.file + (c.line != null ? ":" + c.line : "") + "\\n" +
    (c.snippet ? "Snippet:\\n" + c.snippet + "\\n" : "") +
    "Claim: " + c.summary + "\\n" +
    "Severity guess: " + c.severity + " · CWE: " + (c.cwe || "?") + " · OWASP: " + (c.owasp || "?") + "\\n" +
    "Source: " + c.source + " → Sink: " + c.sink + "\\n" +
    (c.whyExploitable ? "Why: " + c.whyExploitable + "\\n" : "")
}

const seen = new Map()
let debateSlots = P.maxDebate
const dupes = []
const budgetDropped = []

function reserve(c) {
  const key = c.semanticKey || semanticKey(c)
  if (seen.has(key)) {
    const original = seen.get(key)
    dupes.push({ ...c, state: "suppressed", duplicateOf: original.id, suppressedReason: "duplicate semantic identity", id: c.id || original.id, semanticKey: key })
    return false
  }
  if (debateSlots <= 0) {
    budgetDropped.push({ ...c, state: "deferred", deferredReason: "debate budget exhausted before candidate could be judged", semanticKey: key })
    return false
  }
  seen.set(key, c)
  debateSlots--
  return true
}

function debateCandidate(c) {
  const short = (c.file || "").split("/").pop()
  const rule = v => (v ? { ...c, verdict: v.verdict, reachable: v.reachable, severity: v.severity, evidence: v.evidence, exploitPath: v.exploitPath } : null)
  if (P.twoSidedDebate) {
    return parallel([
      () => safeAgent(PROSECUTOR_PROMPT(c), { label: "prosecute:" + short, phase: "Debate", schema: ARGUMENT_SCHEMA }),
      () => safeAgent(DEFENDER_PROMPT(c), { label: "defend:" + short, phase: "Debate", schema: ARGUMENT_SCHEMA }),
    ]).then(([pro, def]) =>
      safeAgent(JUDGE_PROMPT(c, pro, def), { label: "judge:" + short, phase: "Debate", schema: VERDICT_SCHEMA, tier: "emperor" }).then(judgeVerdict => {
        if (judgeVerdict) {
          validationReceipts.push({
            findingId: c.id,
            stage: "debate",
            prosecution: pro ? { reachable: pro.reachable, argument: (pro.argument || "").slice(0, 200) } : null,
            defense: def ? { reachable: def.reachable, argument: (def.argument || "").slice(0, 200) } : null,
            judge: { verdict: judgeVerdict.verdict, reachable: judgeVerdict.reachable, severity: judgeVerdict.severity, evidence: (judgeVerdict.evidence || "").slice(0, 200) }
          });
        }
        return rule(judgeVerdict);
      })
    )
  }
  return safeAgent(JUDGE_SOLO_PROMPT(c), { label: "judge:" + short, phase: "Debate", schema: VERDICT_SCHEMA, tier: "emperor" }).then(judgeVerdict => {
    if (judgeVerdict) {
      validationReceipts.push({
        findingId: c.id,
        stage: "debate",
        judge: { verdict: judgeVerdict.verdict, reachable: judgeVerdict.reachable, severity: judgeVerdict.severity, evidence: (judgeVerdict.evidence || "").slice(0, 200) }
      });
    }
    return rule(judgeVerdict);
  })
}

phase("Scan")

const scanned = await pipeline(
  LANES,
  lane => {
    const rail = (plan.rails || []).find(r => r.category === lane.key) || null;
    return safeAgent(AUDITOR_PROMPT(lane, rail), {
      label: "audit:" + lane.key,
      phase: "Scan",
      schema: CANDIDATES_SCHEMA,
      tier: "daimyo"
    }).then(r => {
      if (!r) return { lane, candidates: [] }
      log("audit:" + lane.key + " — " + r.candidates.length + " candidates")
      return { lane, candidates: r.candidates.slice(0, P.perCategory).map(c => ({ ...c, category: lane.key })) }
    })
  },
  result => {
    const candidatesWithIds = (result.candidates || []).map(assignStableIdentity)
    const novel = candidatesWithIds.filter(reserve)
    return parallel(novel.map(c => () => debateCandidate(c)))
  }
)
let ruled = scanned.flat().filter(Boolean)

if (P.sweep) {
  for (let round = 0; round < P.sweepRounds; round++) {
    phase("Scan")
    const known = ruled.length > 0
      ? ruled.map(c => "- " + c.file + (c.line != null ? ":" + c.line : "") + " — " + c.summary).join("\\n")
      : "(none)"
    const sweep = await safeAgent(
      "## Cross-cutting sweep — gaps only\\n\\n" + SCOPE_BLOCK + "\\n" +
      "## Already found (do NOT re-derive)\\n" + known + "\\n\\n" + CROSS_FILE_LENS + "\\n\\n" +
      "Hunt ONLY for vulnerabilities the per-class auditors miss: bugs that span multiple files, exploit CHAINS across classes, a guard dropped in a refactor, an unsafe call site diverging from a safe sibling. Surface up to " + SWEEP_MAX + " NEW candidates. If nothing new, return an empty list. " + FINDING_FIELDS + "\\n\\nStructured output only.",
      { label: "sweep-" + round, phase: "Scan", schema: CANDIDATES_SCHEMA, tier: "emperor" }
    )
    if (!sweep || sweep.candidates.length === 0) break
    const sweepCandidatesWithIds = sweep.candidates.slice(0, SWEEP_MAX).map(c => assignStableIdentity({ ...c, category: c.category || "cross-cutting" }));
    const novel = sweepCandidatesWithIds.filter(reserve)
    if (novel.length === 0) break
    log("sweep-" + round + " — " + novel.length + " new candidates")
    const swept = await parallel(novel.map(c => () => debateCandidate(c)))
    ruled = ruled.concat(swept.filter(Boolean))
  }
}

let survivors = ruled.filter(c => c.verdict !== "REFUTED")
const refuted = ruled.filter(c => c.verdict === "REFUTED")
log("Debate done: " + ruled.length + " ruled → " + survivors.length + " survive, " + refuted.length + " refuted")

const sevRank = { Critical: 0, High: 1, Medium: 2, Low: 3, Info: 4 }
const needsProof = s => s === "Critical" || s === "High"

if (P.prove && survivors.length > 0) {
  phase("Prove")
  const ordered = survivors.slice().sort((a, b) => sevRank[a.severity] - sevRank[b.severity])
  const toProve = ordered.slice(0, P.maxProve)
  const proven = await parallel(toProve.map(c => () =>
    safeAgent(PROVER_PROMPT(c), { label: "prove:" + (c.file || "").split("/").pop(), phase: "Prove", schema: PROVE_SCHEMA, tier: "emperor" })
      .then(p => {
        if (!p) return c
        const severity = p.severity || c.severity
        validationReceipts.push({
          findingId: c.id,
          stage: "prove",
          proven: p.proven,
          severity,
          poc: p.poc ? p.poc.slice(0, 200) : null
        });
        return { ...c, severity, poc: p.poc, reachablePath: p.reachablePath, proven: p.proven }
      })
  ))
  const provedMap = new Map(toProve.map((c, i) => [c, proven[i]]))
  survivors = ordered.map(c => provedMap.get(c) || c)
  const killed = survivors.filter(c => c.proven === false && needsProof(c.severity))
  if (killed.length > 0) log("Prove: " + killed.length + " High/Critical lacked a reachable path → downgraded")
}

phase("Escalate")
let chains = []
if (survivors.length > 0) {
  const indexed = survivors;
  const findingsBlock = indexed.map(c =>
    "### [" + c.id + "] (" + c.severity + ", " + c.category + ") " + c.file + (c.line != null ? ":" + c.line : "") + "\\n" +
    c.summary + "\\nSource: " + c.source + " → Sink: " + c.sink + (c.exploitPath ? "\\nPath: " + c.exploitPath : "")
  ).join("\\n\\n")
  const escalations = (await parallel(
    Array.from({ length: P.escalators }, (_, i) => () =>
      safeAgent(
        "## Escalator " + (i + 1) + " — correlate findings into exploit chains\\n\\n" + SCOPE_BLOCK + "\\n" +
        "## Confirmed findings\\n" + findingsBlock + "\\n\\n" +
        "Chain findings that compose into a larger attack: a hardcoded dev token + a debug endpoint + a missing auth check is a critical chain, not three lows. For each chain, list the finding ids and the end-to-end impact. Then rerank severity for any finding whose severity changes in chain context (cite the id). Do not invent findings — only correlate the ids above. Structured output only.",
        { label: "escalate-" + i, phase: "Escalate", schema: ESCALATE_SCHEMA, tier: "emperor" }
      )
    )
  )).filter(Boolean)
  const rerank = new Map()
  for (const e of escalations) {
    for (const ch of e.chains || []) chains.push({ ...ch, findingIds: normalizeFindingIds(ch.findingIds, indexed) })
    for (const r of e.reranked || []) {
      const id = normalizeFindingId(r.id, indexed)
      const prev = rerank.get(id)
      if (prev === undefined || sevRank[r.severity] < sevRank[prev]) rerank.set(id, r.severity)
    }
  }
  survivors = indexed.map(c => rerank.has(c.id) ? { ...c, severity: rerank.get(c.id) } : c)
  log("Escalate: " + chains.length + " exploit chain(s)")
}

const tallyOf = list => {
  const t = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
  for (const c of list) {
    const k = (c.severity || "Info").toLowerCase()
    if (t[k] !== undefined) t[k]++
  }
  return t
}

`;
