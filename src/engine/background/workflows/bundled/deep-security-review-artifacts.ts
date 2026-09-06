export const DEEP_SECURITY_REVIEW_ARTIFACTS = `const validationReceipts = [];

function safeSegment(s) {
  return String(s || "unknown").replace(/[^a-zA-Z0-9.-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "unknown";
}
const SAFE_TIMESTAMP = safeSegment(TIMESTAMP);
const BUNDLE_DIR = (REPORTS_DIR && TIMESTAMP) ? REPORTS_DIR + "/deep-security-review-" + SAFE_TIMESTAMP : "";
const ARTIFACT_PATHS = BUNDLE_DIR ? {
  report: BUNDLE_DIR + "/report.md",
  scanManifest: BUNDLE_DIR + "/scan-manifest.json",
  findings: BUNDLE_DIR + "/findings.json",
  coverage: BUNDLE_DIR + "/coverage.json",
  validationReceipts: BUNDLE_DIR + "/validation-receipts.json",
  attackPaths: BUNDLE_DIR + "/attack-paths.json",
} : null;

function artifactPathsFor(includeAttackPaths) {
  if (!ARTIFACT_PATHS) return null;
  const paths = {
    report: ARTIFACT_PATHS.report,
    scanManifest: ARTIFACT_PATHS.scanManifest,
    findings: ARTIFACT_PATHS.findings,
    coverage: ARTIFACT_PATHS.coverage,
    validationReceipts: ARTIFACT_PATHS.validationReceipts,
  };
  if (includeAttackPaths) paths.attackPaths = ARTIFACT_PATHS.attackPaths;
  return paths;
}

function buildWriterPrompt(paths, contents) {
  const artifacts = [];
  for (const key in paths) {
    artifacts.push({ key, path: paths[key], content: contents[key] || "" });
  }
  const payload = { bundleDir: BUNDLE_DIR, reportPath: paths.report, artifacts };
  return "You are the deep-security-review artifact writer. The audited source repository is read-only. Create exactly this bundle directory and write ONLY the artifact paths listed in the JSON payload. Do not touch audited source or any other path. Use Bash only for mkdir -p on the bundle directory and Write/Bash only for the exact files below. Return StructuredOutput exactly as { written, reportPath, bundleDir, errors }; written must map each artifact key to the exact path written, reportPath must equal the report artifact path, bundleDir must equal the bundle directory, and errors must be [] on success.\\n\\nAuthoritative JSON payload:\\n" + JSON.stringify(payload, null, 2);
}

async function writeArtifacts(paths, contents) {
  if (!paths) return null;
  try {
    const writerResult = await safeAgent(buildWriterPrompt(paths, contents), {
      label: "writer",
      phase: "Verify",
      schema: WRITER_SCHEMA,
      tier: "emperor"
    });
    if (!writerResult) {
      return { written: {}, reportPath: "", bundleDir: BUNDLE_DIR, errors: ["artifact writer returned no structured result"] };
    }
    if (!writerResult.errors) writerResult.errors = [];
    if (!writerResult.written) writerResult.written = {};
    return writerResult;
  } catch (err) {
    log("Artifact writer failed: " + String(err.message || err));
    return {
      written: {},
      reportPath: "",
      bundleDir: BUNDLE_DIR,
      errors: ["artifact writer exception: " + String(err.message || err)]
    };
  }
}

function writerIssues(writerResult, expectedPaths) {
  if (!expectedPaths) return [];
  if (!writerResult) return ["artifact writer did not run"];
  const issues = (writerResult.errors || []).slice();
  if (writerResult.bundleDir !== BUNDLE_DIR) issues.push("artifact writer returned unexpected bundleDir");
  if (writerResult.reportPath !== expectedPaths.report) issues.push("artifact writer returned unexpected reportPath");
  for (const key in expectedPaths) {
    if (!writerResult.written || writerResult.written[key] !== expectedPaths[key]) {
      issues.push("artifact writer did not confirm exact path for " + key);
    }
  }
  return issues;
}

function artifactPathsFromWriter(writerResult, expectedPaths) {
  const issues = writerIssues(writerResult, expectedPaths);
  if (issues.length > 0) return undefined;
  return writerResult && writerResult.written ? writerResult.written : undefined;
}

function reportPathFromWriter(writerResult, expectedPaths) {
  const paths = artifactPathsFromWriter(writerResult, expectedPaths);
  return paths ? paths.report : undefined;
}

`;
