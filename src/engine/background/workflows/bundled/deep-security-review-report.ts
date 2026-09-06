export const DEEP_SECURITY_REVIEW_REPORT = `phase("Report")
const severityOrderedSurvivors = survivors.slice().sort((a, b) => sevRank[a.severity] - sevRank[b.severity])
const sevOrder = severityOrderedSurvivors.slice(0, P.maxFindings).map(c => ({ ...c, state: "reportable" }))
const reportCapDropped = severityOrderedSurvivors.slice(P.maxFindings)

const tally = tallyOf(sevOrder)

const suppressed = dupes.map(c => findingRecord(c, "suppressed", { duplicateOf: c.duplicateOf, suppressedReason: c.suppressedReason || "duplicate semantic identity" }));
const deferred = [
  ...budgetDropped.map(c => findingRecord(c, "deferred", { deferredReason: c.deferredReason || "debate budget exhausted before candidate could be judged" })),
  ...reportCapDropped.map(c => findingRecord(c, "deferred", { deferredReason: "report cap deferred this confirmed finding from markdown output" }))
];
const refutedList = refuted.map(c => findingRecord(c, "refuted", { evidence: c.evidence, refutedReason: c.evidence || "judge verdict REFUTED" }));
const notApplicable = CATEGORIES.filter(c => !inScopeKeys.has(c.key)).map(c => ({
  category: c.key,
  state: "not_applicable",
  reason: ((scope.categories || []).find(x => x.key === c.key)?.reason || "no surface")
}));

if (survivors.length === 0) {
  const coverage = CATEGORIES.map(c => {
    const inScope = inScopeKeys.has(c.key);
    const reason = ((scope.categories || []).find(x => x.key === c.key)?.reason || "no surface");
    return {
      category: c.key,
      focus: c.focus,
      inScope,
      state: inScope ? "refuted" : "not_applicable",
      reason,
      findings: []
    };
  });
  const cleanLines = CATEGORIES.map(c => "- " + c.key + " — " + (inScopeKeys.has(c.key) ? "clean — no exploitable finding survived debate" : "N/A — " + ((scope.categories || []).find(x => x.key === c.key)?.reason || "no surface"))).join("\\n")
  let finalMarkdown = "# Deep security review — " + scope.repo + " @ " + (scope.commitSha || "?") + "\\n" +
    "_Status: complete — " + (TIMESTAMP || "unknown") + "_\\n\\n" +
    "## Scope\\n" + SCOPE_BLOCK + "\\n" +
    "## Preflight / target inspection\\n" + preflightBlock + "\\n" +
    "## Threat model summary\\n" + threatModelBlock + "\\n" +
    "## Summary\\n0 critical · 0 high · 0 medium · 0 low · 0 info. No exploitable vulnerability survived independent debate.\\n\\n" +
    "## Frame coverage\\n" + cleanLines + "\\n\\n" +
    "## Verification status\\nVerdict: PASS\\n\\n" +
    "## Artifact bundle\\n" + (BUNDLE_DIR ? "Bundle directory: " + BUNDLE_DIR + "\\n" : "No bundle directory provided.\\n") + "\\n";

  let writerResult = null;
  let expectedArtifactPaths = null;
  let reportVerdict = { verdict: "PASS", issues: [] };
  if (ARTIFACT_PATHS) {
    expectedArtifactPaths = artifactPathsFor(false);
    const scanManifest = {
      schemaVersion: 1,
      workflowName: "deep-security-review",
      level: LEVEL,
      target: TARGET || undefined,
      repo: scope.repo,
      commitSha: scope.commitSha,
      timestamp: TIMESTAMP || undefined,
      preflight: scope.preflight,
      threatModel: scope.threatModel,
      summary: "No exploitable findings survived debate.",
      tally: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      stats: {
        level: LEVEL,
        lanes: LANES.length,
        candidates: seen.size + dupes.length + budgetDropped.length,
        ruled: ruled.length,
        refuted: refuted.length,
        survivors: 0,
        reported: 0,
        chains: 0,
        dupes: dupes.length,
        budgetDropped: budgetDropped.length,
      },
      coverage,
      reportVerdict,
      artifactPaths: expectedArtifactPaths,
    };
    writerResult = await writeArtifacts(expectedArtifactPaths, {
      report: finalMarkdown,
      scanManifest: JSON.stringify(scanManifest, null, 2),
      findings: JSON.stringify({ reportable: [], suppressed, deferred, refuted: refutedList, notApplicable }, null, 2),
      coverage: JSON.stringify(coverage, null, 2),
      validationReceipts: JSON.stringify(validationReceipts, null, 2),
    });
    reportVerdict = foldWriterVerdict(reportVerdict, writerResult, expectedArtifactPaths);
  }

  return {
    level: LEVEL, target: TARGET || undefined, repo: scope.repo, commitSha: scope.commitSha,
    summary: "No exploitable findings survived debate.",
    tally: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    findings: [], chains: [], reportMarkdown: finalMarkdown,
    reportVerdict,
    preflight: scope.preflight,
    threatModel: scope.threatModel,
    coverage,
    validationReceipts,
    attackPaths: [],
    suppressed,
    deferred,
    refuted: refutedList,
    notApplicable,
    artifactPaths: artifactPathsFromWriter(writerResult, expectedArtifactPaths),
    bundleDir: BUNDLE_DIR || undefined,
    reportPath: reportPathFromWriter(writerResult, expectedArtifactPaths),
    stats: { lanes: LANES.length, candidates: seen.size + dupes.length + budgetDropped.length, ruled: ruled.length, refuted: refuted.length },
  };
}

const findingsForReport = sevOrder.map(c =>
  "### [" + c.id + "] " + c.severity + " — " + c.file + (c.line != null ? ":" + c.line : "") + " (" + c.category + ")\\n" +
  "CWE: " + (c.cwe || "?") + " · OWASP: " + (c.owasp || "N/A") + " · verdict: " + c.verdict + "\\n" +
  "Snippet:\\n" + (c.snippet || "(quote from the file)") + "\\n" +
  "Why exploitable: " + (c.evidence || c.whyExploitable || "") + "\\n" +
  "Source: " + c.source + " → Sink: " + c.sink + "\\n" +
  "Exploit path / PoC: " + (c.poc || c.reachablePath || c.exploitPath || "(state the precondition)") + "\\n"
).join("\\n")

const chainsBlock = chains.length > 0
  ? chains.map(ch => "- [" + (ch.findingIds || []).join(", ") + "] → " + ch.severity + ": " + ch.impact).join("\\n")
  : "(none)"

const coverageBlock = CATEGORIES.map(c => {
  if (!inScopeKeys.has(c.key)) return "- " + c.key + " — N/A — " + ((scope.categories || []).find(x => x.key === c.key)?.reason || "no surface")
  const ids = sevOrder.filter(f => f.category === c.key).map(f => f.id)
  return "- " + c.key + " — " + (ids.length > 0 ? ids.join(", ") : "clean — no surviving finding")
}).join("\\n")

const artifactBundleBlock = BUNDLE_DIR
  ? "Bundle directory: " + BUNDLE_DIR + "\\n" +
    "Written files: report.md, scan-manifest.json, findings.json, coverage.json, validation-receipts.json" + (chains.length > 0 ? ", attack-paths.json" : "") + "\\n"
  : "No artifact bundle written (reportsDir/timestamp not provided).\\n"

const report = await safeAgent(
  "## Render the final security report\\n\\n" + SCOPE_BLOCK + "\\n" +
  "## Preflight / target inspection\\n" + preflightBlock + "\\n" +
  "## Threat model summary\\n" + threatModelBlock + "\\n" +
  "## Artifact bundle\\n" + artifactBundleBlock + "\\n" +
  sevOrder.length + " findings survived independent debate" + (P.prove ? " and proof" : "") + " (" + LEVEL + "-effort).\\n\\n" +
  "## Findings (severity-ordered)\\n" + findingsForReport + "\\n\\n" +
  "## Exploit chains\\n" + chainsBlock + "\\n\\n" +
  "## Frame coverage (precomputed — keep these lines verbatim in the report)\\n" + coverageBlock + "\\n\\n" +
  "## Output format (follow EXACTLY)\\n" + OUTPUT_FORMAT + "\\n\\n" +
  "## Instructions\\n" +
  "1. Render reportMarkdown in the output format above. Group findings by severity, Critical first.\\n" +
  "2. For each finding emit every field (Severity, OWASP, CWE, NIST or N/A, Location, Snippet fenced and byte-exact, Why exploitable, PoC/exploit path, Fix line-referenced, Residual risk). Re-read the cited file to quote the snippet exactly and to draft a concrete fix.\\n" +
  "3. Merge findings that share one root cause into a single block listing all locations. Use their stable IDs (e.g. F-secrets-cwe-798-abcdef).\\n" +
  "4. Fill the Summary tally and the highest-severity chain. Keep the Frame coverage lines provided.\\n" +
  "5. Include the Preflight inspection, Threat model summary, and Artifact bundle information in their respective sections.\\n" +
  "6. Write a 2-3 sentence executive summary.\\n\\nStructured output only — reportMarkdown is the full report text.",
  { label: "render", phase: "Report", schema: REPORT_SCHEMA, tier: "emperor" }
)

const fallbackMarkdown =
  "# Deep security review — " + scope.repo + " @ " + (scope.commitSha || "?") + "\\n" +
  "_Status: complete (unrendered — synthesis failed)_\\n\\n" +
  "## Preflight / target inspection\\n" + preflightBlock + "\\n" +
  "## Threat model summary\\n" + threatModelBlock + "\\n" +
  "## Artifact bundle\\n" + artifactBundleBlock + "\\n" +
  "## Findings\\n" + findingsForReport + "\\n\\n" +
  "## Exploit chains\\n" + chainsBlock + "\\n\\n" +
  "## Frame coverage\\n" + coverageBlock + "\\n";

let finalMarkdown = report ? report.reportMarkdown : fallbackMarkdown

phase("Verify")
let reportVerdict = { verdict: "PARTIAL", issues: ["report-verify did not run"] }
const verify = await safeAgent(
  "## Independent report verification\\n\\n" + SCOPE_BLOCK + "\\n" +
  "Re-read the report below against the actual source files. For each finding: open the cited file at the cited lines and confirm the snippet matches BYTE-FOR-BYTE; confirm every required field is present; confirm Critical/High findings have a concrete exploit path reachable from an attacker-controllable surface (flag any reachable only from already-trusted code); confirm severities are neither inflated nor deflated. Return PASS, or PARTIAL/FAIL with the specific issues to fix.\\n\\n## Report under review\\n" + finalMarkdown + "\\n\\nStructured output only.",
  { label: "report-verify", phase: "Verify", schema: REPORT_VERDICT_SCHEMA, agentType: "verifier", tier: "emperor" }
)
if (verify) {
  reportVerdict = verify
  validationReceipts.push({
    stage: "verify",
    verdict: verify.verdict,
    issues: verify.issues || []
  });
  if (verify.verdict !== "PASS" && (verify.issues || []).length > 0) {
    const fixed = await safeAgent(
      "## Revise the security report to fix verification issues\\n\\n" + SCOPE_BLOCK + "\\n" +
      "A verifier flagged these issues:\\n" + verify.issues.map(s => "- " + s).join("\\n") + "\\n\\n" +
      "Fix them by re-reading the cited files (correct snippets, add missing fields, fix severities, drop unreachable Critical/High claims). Keep the output format. Return the corrected reportMarkdown.\\n\\n## Current report\\n" + finalMarkdown + "\\n\\nStructured output only.",
      { label: "report-fix", phase: "Verify", schema: REPORT_SCHEMA, tier: "emperor" }
    )
    if (fixed && fixed.reportMarkdown) {
      finalMarkdown = fixed.reportMarkdown
      const reverify = await safeAgent(
        "## Re-verify the revised report\\n\\n" + SCOPE_BLOCK + "\\n" +
        "Confirm the earlier issues are resolved. Return PASS, or PARTIAL/FAIL with what remains.\\n\\n## Revised report\\n" + finalMarkdown + "\\n\\nStructured output only.",
        { label: "report-reverify", phase: "Verify", schema: REPORT_VERDICT_SCHEMA, agentType: "verifier", tier: "emperor" }
      )
      if (reverify) {
        reportVerdict = reverify
        validationReceipts.push({
          stage: "reverify",
          verdict: reverify.verdict,
          issues: reverify.issues || []
        });
      }
    }
  }
}

const coverage = CATEGORIES.map(c => {
  const inScope = inScopeKeys.has(c.key);
  const reason = ((scope.categories || []).find(x => x.key === c.key)?.reason || "no surface");
  const ids = inScope ? sevOrder.filter(f => f.category === c.key).map(f => f.id) : [];
  return {
    category: c.key,
    focus: c.focus,
    inScope,
    state: ids.length > 0 ? "reportable" : (inScope ? "refuted" : "not_applicable"),
    reason,
    findings: ids
  };
});
const reportableFindings = sevOrder.map(c => findingRecord(c, "reportable"));
let writerResult = null;
let expectedArtifactPaths = null;
if (ARTIFACT_PATHS) {
  expectedArtifactPaths = artifactPathsFor(chains.length > 0);
  const scanManifest = {
    schemaVersion: 1,
    workflowName: "deep-security-review",
    level: LEVEL,
    target: TARGET || undefined,
    repo: scope.repo,
    commitSha: scope.commitSha,
    timestamp: TIMESTAMP || undefined,
    preflight: scope.preflight,
    threatModel: scope.threatModel,
    summary: report ? report.summary : "Synthesis completed.",
    tally,
    stats: {
      level: LEVEL,
      lanes: LANES.length,
      candidates: seen.size + dupes.length + budgetDropped.length,
      ruled: ruled.length,
      refuted: refuted.length,
      survivors: survivors.length,
      reported: sevOrder.length,
      chains: chains.length,
      dupes: dupes.length,
      budgetDropped: budgetDropped.length,
    },
    coverage,
    reportVerdict,
    artifactPaths: expectedArtifactPaths,
  };
  const artifactContents = {
    report: finalMarkdown,
    scanManifest: JSON.stringify(scanManifest, null, 2),
    findings: JSON.stringify({ reportable: reportableFindings, suppressed, deferred, refuted: refutedList, notApplicable }, null, 2),
    coverage: JSON.stringify(coverage, null, 2),
    validationReceipts: JSON.stringify(validationReceipts, null, 2),
  };
  if (chains.length > 0) artifactContents.attackPaths = JSON.stringify(chains, null, 2);
  writerResult = await writeArtifacts(expectedArtifactPaths, artifactContents);
  reportVerdict = foldWriterVerdict(reportVerdict, writerResult, expectedArtifactPaths);
}

log("Report: " + tally.critical + "C/" + tally.high + "H/" + tally.medium + "M/" + tally.low + "L/" + tally.info + "I · verify " + reportVerdict.verdict)

const finalWriterErrors = writerResult ? (writerResult.errors || []) : [];
const artifactWriteStatus = finalWriterErrors.length > 0
  ? { status: "error", errors: finalWriterErrors }
  : (ARTIFACT_PATHS ? { status: "success", errors: [] } : { status: "idle", errors: [] });
const finalDegradedRouting = degradedRouting;

return {
  level: LEVEL,
  target: TARGET || undefined,
  repo: scope.repo,
  commitSha: scope.commitSha,
  summary: report ? report.summary : "Synthesis failed — returning verified findings unrendered.",
  tally,
  findings: reportableFindings,
  chains,
  refuted: refutedList,
  suppressed,
  deferred,
  notApplicable,
  reportMarkdown: finalMarkdown,
  reportVerdict,
  preflight: scope.preflight,
  threatModel: scope.threatModel,
  coverage,
  validationReceipts,
  attackPaths: chains,
  artifactPaths: artifactPathsFromWriter(writerResult, expectedArtifactPaths),
  bundleDir: BUNDLE_DIR || undefined,
  reportPath: reportPathFromWriter(writerResult, expectedArtifactPaths),
  artifactWriteStatus,
  degradedRouting: finalDegradedRouting,
  stats: {
    level: LEVEL,
    lanes: LANES.length,
    candidates: seen.size + dupes.length + budgetDropped.length,
    ruled: ruled.length,
    refuted: refuted.length,
    survivors: survivors.length,
    reported: sevOrder.length,
    chains: chains.length,
    dupes: dupes.length,
    budgetDropped: budgetDropped.length,
  },
}`;
