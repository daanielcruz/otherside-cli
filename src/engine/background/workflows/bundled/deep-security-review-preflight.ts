export const DEEP_SECURITY_REVIEW_PREFLIGHT = `phase("Prep / target inspection")
const PATH_NOTE = TARGET
  ? "Scope the audit to this subtree only: " + TARGET + ". Treat paths outside it as out of scope.\\n"
  : "Audit the entire repository.\\n"
const CATEGORY_LIST = CATEGORIES.map(c => "- " + c.key + ": " + c.focus).join("\\n")

const scope = await safeAgent(
  "You are the preparation agent for a whole-repo security audit. Act like an attacker mapping the target, not a checklist auditor.\\n\\n" +
  PATH_NOTE + "\\n" +
  "## Tasks\\n" +
  "1. Run 'git rev-parse --short HEAD' for the commit sha and 'git ls-files' to learn the project shape.\\n" +
  "2. Identify languages, build system, CI platform, dependency manifests, and the PRIMARY trust boundaries (where attacker-controllable input enters: HTTP/RPC handlers, CLI flags, env vars, file ingest, IPC peers, deserialization, shell execution).\\n" +
  "3. Perform preflight inspection on the target: verify if the target path is valid/exists and list the inspected paths. If TARGET is empty, default to checking the whole repository.\\n" +
  "4. Formulate a threat-model by summarizing the threat model, high-risk paths, and attack surface areas based on code shape/history.\\n" +
  "5. For EVERY vulnerability class below, decide inScope (the repo has surface for it) or not, with a one-line reason. Silence is not a pass — mark N/A classes explicitly with a reason.\\n\\n" +
  "## Vulnerability classes\\n" + CATEGORY_LIST + "\\n\\n" +
  "Return the scope object. Structured output only.",
  { label: "prep", phase: "Prep", schema: SCOPE_SCHEMA, tier: "emperor" }
)
if (!scope) {
  return { error: "Prep agent returned no result — cannot establish the audit scope." }
}


const inScopeKeys = new Set((scope.categories || []).filter(c => c.inScope).map(c => c.key))
const LANES = CATEGORIES.filter(c => inScopeKeys.has(c.key))

const SCOPE_BLOCK =
  "## Audit scope\\n" +
  "Repo: " + scope.repo + " @ " + (scope.commitSha || "unknown") + "\\n" +
  "Languages: " + ((scope.languages || []).join(", ") || "unknown") + "\\n" +
  "Build: " + (scope.buildSystem || "unknown") + " · CI: " + (scope.ci || "unknown") + "\\n" +
  "Trust boundaries:\\n" + ((scope.trustBoundaries || []).map(t => "  - " + t).join("\\n") || "  (none identified)") + "\\n" +
  "Surface summary: " + scope.summary + "\\n" +
  (TARGET ? "Path filter: " + TARGET + " (audit only this subtree)\\n" : "")

const preflightBlock = "Target valid: " + (scope.preflight && scope.preflight.targetValid ? "Yes" : "No") + "\\n" +
  "Target reason: " + (scope.preflight && scope.preflight.targetReason || "N/A") + "\\n" +
  "Inspected paths: " + ((scope.preflight && scope.preflight.inspectedPaths || []).join(", ") || "N/A") + "\\n";

const threatModelBlock = "Summary: " + (scope.threatModel && scope.threatModel.summary || "N/A") + "\\n" +
  "High risk paths: " + ((scope.threatModel && scope.threatModel.highRiskPaths || []).join(", ") || "N/A") + "\\n" +
  "Attack surface areas: " + ((scope.threatModel && scope.threatModel.attackSurfaceAreas || []).join(", ") || "N/A") + "\\n";

if (TARGET && scope.preflight && scope.preflight.targetValid === false) {
  const reason = scope.preflight.targetReason || "Invalid target path";
  const issue = "Preflight target validation failed: " + reason;
  const coverage = CATEGORIES.map(c => ({
    category: c.key,
    focus: c.focus,
    inScope: false,
    state: "deferred",
    reason: issue,
    findings: []
  }));
  const notApplicable = CATEGORIES.map(c => ({ category: c.key, state: "not_applicable", reason: issue }));
  let reportVerdict = { verdict: "FAIL", issues: [issue] };
  const finalMarkdown = "# Deep security review — " + (scope.repo || "unknown repo") + " @ " + (scope.commitSha || "?") + "\\n" +
    "_Status: failed — target inspection failed — " + (TIMESTAMP || "unknown") + "_\\n\\n" +
    "## Scope\\n" + SCOPE_BLOCK + "\\n" +
    "## Preflight / target inspection\\n" + preflightBlock + "\\n" +
    "## Threat model summary\\n" + threatModelBlock + "\\n" +
    "## Summary\\n0 critical · 0 high · 0 medium · 0 low · 0 info. Audit did not proceed because the requested target is invalid.\\n\\n" +
    "## Frame coverage\\n" + CATEGORIES.map(c => "- " + c.key + " — deferred — " + issue).join("\\n") + "\\n\\n" +
    "## Verification status\\nVerdict: FAIL — " + issue + "\\n\\n" +
    "## Artifact bundle\\n" + (BUNDLE_DIR ? "Bundle directory: " + BUNDLE_DIR + "\\n" : "No bundle directory provided.\\n") + "\\n" +
    "## Methodology notes\\nTarget inspection stopped the audit before source scanning so the whole repository was not silently audited.\\n";
  let writerResult = null;
  let expectedArtifactPaths = null;
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
      stats: { level: LEVEL, lanes: 0, candidates: 0, ruled: 0, refuted: 0, survivors: 0, reported: 0, chains: 0, dupes: 0, budgetDropped: 0 },
      reportVerdict,
      artifactPaths: expectedArtifactPaths,
    };
    writerResult = await writeArtifacts(expectedArtifactPaths, {
      report: finalMarkdown,
      scanManifest: JSON.stringify(scanManifest, null, 2),
      findings: JSON.stringify({ reportable: [], suppressed: [], deferred: [], refuted: [], notApplicable }, null, 2),
      coverage: JSON.stringify(coverage, null, 2),
      validationReceipts: JSON.stringify(validationReceipts, null, 2),
    });
    reportVerdict = foldWriterVerdict(reportVerdict, writerResult, expectedArtifactPaths);
  }
  return {
    error: issue,
    level: LEVEL, target: TARGET || undefined, repo: scope.repo, commitSha: scope.commitSha,
    summary: "Target validation failed; no source audit was performed.",
    tally: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    findings: [], chains: [], reportMarkdown: finalMarkdown,
    reportVerdict,
    preflight: scope.preflight,
    threatModel: scope.threatModel,
    coverage,
    validationReceipts,
    attackPaths: [],
    suppressed: [],
    deferred: [],
    refuted: [],
    notApplicable,
    artifactPaths: artifactPathsFromWriter(writerResult, expectedArtifactPaths),
    bundleDir: BUNDLE_DIR || undefined,
    reportPath: reportPathFromWriter(writerResult, expectedArtifactPaths),
    stats: { lanes: 0, candidates: 0, ruled: 0, refuted: 0 },
  };
}

if (LANES.length === 0) {
  const coverage = CATEGORIES.map(c => {
    const inScope = inScopeKeys.has(c.key);
    const reason = ((scope.categories || []).find(x => x.key === c.key)?.reason || "no surface");
    return {
      category: c.key,
      focus: c.focus,
      inScope,
      state: inScope ? "reportable" : "not_applicable",
      reason,
      findings: []
    };
  });
  const notApplicable = CATEGORIES.filter(c => !inScopeKeys.has(c.key)).map(c => ({
    category: c.key,
    state: "not_applicable",
    reason: ((scope.categories || []).find(x => x.key === c.key)?.reason || "no surface")
  }));
  const cleanLines = CATEGORIES.map(c => "- " + c.key + " — N/A — " + ((scope.categories || []).find(x => x.key === c.key)?.reason || "no surface")).join("\\n")
  let finalMarkdown = "# Deep security review — " + scope.repo + " @ " + (scope.commitSha || "?") + "\\n" +
    "_Status: complete — " + (TIMESTAMP || "unknown") + "_\\n\\n" +
    "## Scope\\n" + SCOPE_BLOCK + "\\n" +
    "## Preflight / target inspection\\n" + preflightBlock + "\\n" +
    "## Threat model summary\\n" + threatModelBlock + "\\n" +
    "## Summary\\n0 critical · 0 high · 0 medium · 0 low · 0 info. Prep marked every vulnerability class N/A for this target — nothing to audit.\\n\\n" +
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
      summary: "Prep marked every vulnerability class N/A for this target — nothing to audit.",
      tally: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      stats: {
        level: LEVEL,
        lanes: 0,
        candidates: 0,
        ruled: 0,
        refuted: 0,
        survivors: 0,
        reported: 0,
        chains: 0,
        dupes: 0,
        budgetDropped: 0,
      },
      coverage,
      reportVerdict,
      artifactPaths: expectedArtifactPaths,
    };
    writerResult = await writeArtifacts(expectedArtifactPaths, {
      report: finalMarkdown,
      scanManifest: JSON.stringify(scanManifest, null, 2),
      findings: JSON.stringify({ reportable: [], suppressed: [], deferred: [], refuted: [], notApplicable }, null, 2),
      coverage: JSON.stringify(coverage, null, 2),
      validationReceipts: JSON.stringify(validationReceipts, null, 2),
    });
    reportVerdict = foldWriterVerdict(reportVerdict, writerResult, expectedArtifactPaths);
  }

  return {
    level: LEVEL, target: TARGET || undefined, repo: scope.repo, commitSha: scope.commitSha,
    summary: "Prep marked every vulnerability class N/A for this target — nothing to audit.",
    tally: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    findings: [], chains: [], reportMarkdown: finalMarkdown,
    reportVerdict,
    preflight: scope.preflight,
    threatModel: scope.threatModel,
    coverage,
    validationReceipts,
    attackPaths: [],
    suppressed: [],
    deferred: [],
    refuted: [],
    notApplicable,
    artifactPaths: artifactPathsFromWriter(writerResult, expectedArtifactPaths),
    bundleDir: BUNDLE_DIR || undefined,
    reportPath: reportPathFromWriter(writerResult, expectedArtifactPaths),
    stats: { lanes: 0, candidates: 0, ruled: 0, refuted: 0 },
  };
}

`;
