import type { WorkflowPhaseDescriptor } from "@/engine/background/workflows/runtime/parser/types.ts";
import type { WorkflowDefinition } from "@/engine/background/workflows/runtime/registry/types.ts";

const WORKFLOW_NAME = "deep-security-review";
const WORKFLOW_DESCRIPTION =
  "Whole-repo security audit harness — a prep agent maps the attack surface, specialized auditors scan each vulnerability class, every candidate is debated for-and-against reachability, survivors are proven and correlated into exploit chains, then a strict report is rendered and independently re-verified. The target repo is read-only; when reportsDir and timestamp are provided, a writer subagent writes the durable report bundle under reportsDir.";
const WORKFLOW_WHEN_TO_USE =
  'Launched by the /deep-security-review skill when workflows are enabled. Prefer object args { level, target/path, reportsDir, timestamp }; legacy "<level> [path]" is still accepted. Level is high, xhigh, or max (default xhigh); path is an optional subtree to scope the audit (e.g. "src/auth/"). Covers OWASP Top 10, CWE Top 25, NIST SP 800-53/SSDF, supply-chain, secrets, authn/authz, injection, memory safety, crypto, network/SSRF, file I/O, client-side, concurrency/TOCTOU, logging, and CI/CD. Returns reportMarkdown plus structured findings, exploit chains, a severity tally, a verification verdict, and durable artifact paths when a bundle is written.';
const WORKFLOW_PHASES: WorkflowPhaseDescriptor[] = [
  {
    index: 0,
    title: "Prep / target inspection",
    detail: "Validate target, map surface, threat-model from git, mark which vuln classes apply",
  },
  {
    index: 1,
    title: "Scan",
    detail: "One specialized auditor per in-scope class, streaming into debate",
  },
  {
    index: 2,
    title: "Debate",
    detail: "Prosecutor + defender argue reachability; a judge rules per candidate",
  },
  {
    index: 3,
    title: "Prove",
    detail: "Build a concrete trigger/PoC per survivor; kill unreachable High/Critical",
  },
  {
    index: 4,
    title: "Escalate",
    detail: "Correlate survivors into exploit chains and re-rate severity",
  },
  { index: 5, title: "Report", detail: "Render the report in the strict output format" },
  {
    index: 6,
    title: "Verify",
    detail: "Independent re-read: byte-match snippets, fields, chain reachability",
  },
];

const CATEGORIES = [
  {
    key: "supply-chain",
    focus:
      "Dependency/lockfile integrity, pinned versions, typosquats, postinstall/build-script execution, unsigned artifacts, HTTP manifest URLs, known-CVE versions of high-value libs.",
  },
  {
    key: "secrets",
    focus:
      "Hardcoded keys/tokens/passwords, tracked .env/.pem/.key/credentials.json, secrets in fixtures or CLI args, token-bearing headers or bodies logged, .gitignore gaps.",
  },
  {
    key: "authn",
    focus:
      "Weak/unsalted password hashing, JWT alg-none/HS-with-public-key/missing exp-aud, session fixation or non-regeneration, missing HttpOnly/Secure/SameSite, OAuth/OIDC missing state/PKCE, MFA bypass.",
  },
  {
    key: "authz",
    focus:
      "Missing auth on a privileged/destructive handler, IDOR (per-object access not checked), client-only role checks, user-influenced role fields, trust-boundary data reaching a sink unvalidated, TOCTOU on permission.",
  },
  {
    key: "injection",
    focus:
      "SQL/NoSQL, OS-command/shell, code/eval, template, LDAP, XPath, header (CRLF), log injection, prototype pollution, unsafe deserialization gadgets. Give the detection AND remediation pattern.",
  },
  {
    key: "memory-safety",
    focus:
      "Unjustified unsafe blocks, FFI lifetime/length errors, integer overflow on attacker-controlled sizes, unwrap/expect on request-path inputs (panic DoS), UAF / double-free / OOB (Rust/C/C++).",
  },
  {
    key: "crypto",
    focus:
      "Weak primitives (MD5/SHA1/DES/ECB/static-IV/GCM-nonce-reuse), KDF params below floor, weak RNG for keys, cert/hostname validation disabled, TLS<1.2, algorithm downgrade, plaintext key storage.",
  },
  {
    key: "network-ssrf",
    focus:
      "Outbound HTTP from user-controlled URLs without allowlist, URL-parse bypass tricks, cloud metadata service reach (169.254.169.254), DNS rebinding, missing timeouts, open redirect.",
  },
  {
    key: "file-path",
    focus:
      "Path traversal without canonicalize+root-allowlist, symlink races, temp files without O_EXCL, zip/tar slip on extraction, over-permissive file modes on secrets, missing upload size/type validation.",
  },
  {
    key: "client-side",
    focus:
      "Reflected/stored XSS via dangerouslySetInnerHTML/v-html/innerHTML, CSRF on cookie-auth state changes, clickjacking, CORS allow-* with credentials, weak CSP, missing cookie flags.",
  },
  {
    key: "concurrency-toctou",
    focus:
      "Shared mutable state without lock/atomic, check-then-use across a syscall (existence/permission/token staleness), double-fetch of user memory, non-reentrant signal handlers.",
  },
  {
    key: "error-logging",
    focus:
      "Stack traces or internal paths returned to clients, PII/secrets/tokens logged, unstructured logs inviting injection, missing security-relevant audit events (auth, permission change, admin action).",
  },
  {
    key: "build-cicd",
    focus:
      "Over-broad workflow permissions, pull_request_target with untrusted checkout, ${{ }} script injection into run:, unsigned releases, Dockerfile USER root / baked secrets / unpinned base, curl|sh build steps.",
  },
] as const;

const CROSS_FILE_LENS =
  "Reason ACROSS files, not just within one function. For every candidate, trace the untrusted source to the dangerous sink through callers and callees (Grep the symbols). The strongest signal is a CORRECT sibling: when the same logical operation appears elsewhere in the repo done safely, a divergent call site is an inconsistency — that asymmetry is high-confidence evidence, not a guess. Bugs that span multiple files or non-trivial control flow are exactly what a single-file scan misses; hunt those.";

const SEVERITY_RUBRIC =
  "Critical = unauth RCE, unauth full data exfil, unauth privilege escalation to admin, complete auth bypass, production cryptographic break. High = authenticated RCE/exfil, unauth partial exfil, cross-tenant IDOR, unauth sensitive-data exposure, SSRF to internal metadata. Medium = auth bypass needing unusual preconditions, stored XSS in an authed-only surface, CSRF on a destructive authed action, weak crypto on non-primary data, known-CVE dep with non-reachable sink. Low = verbose errors, missing headers on non-sensitive responses, minor info disclosure. Info = hardening / defense-in-depth, fragile but not currently exploitable. Critical and High MUST carry a concrete exploit path or they are not Critical/High.";

const FINDING_FIELDS =
  "Each finding carries: category, file, line, a byte-exact snippet quoted from the source (no paraphrase), severity, cwe (CWE-NNN), owasp (A0X:YYYY or N/A), the untrusted source, the sink, why it is exploitable (source→sink trace), a concrete proof-of-concept / exploit path (or the precondition if not directly reachable), and a specific line-referenced fix.";

const OUTPUT_FORMAT = [
  "# Deep security review — <repo> @ <commit sha>",
  "_Status: complete — <ISO ts>_",
  "",
  "## Scope",
  "Files audited, languages, build system, CI, primary trust boundaries, and path filter if any.",
  "",
  "## Preflight / target inspection",
  "Target validity, inspected paths, and why the audit did or did not proceed.",
  "",
  "## Threat model summary",
  "Trust boundaries, sensitive assets/operations, attacker entry points, and high-risk paths.",
  "",
  "## Summary",
  "`N critical · N high · N medium · N low · N info`, exploit chains identified, and the highest-severity chain in one line.",
  "",
  "## Frame coverage",
  "One line per vulnerability class: either the finding ids it produced, or `clean — <one-line reason grounded in evidence>`. Never leave a class blank.",
  "",
  "## Findings",
  "One block per finding, grouped by severity (Critical first), each with: Stable ID (F-<category>-<cwe>-<hash>), Severity, OWASP, CWE, NIST (or N/A), Location (path:start-end), Snippet (fenced, byte-exact), Why it is exploitable, Proof of concept / exploit path, Fix (line-referenced), Residual risk after fix. Collapse the same root cause across many locations into ONE finding listing all locations.",
  "",
  "## Exploit chains",
  "Each chain: the stable finding IDs it combines and the end-to-end impact (low+low+low can be a critical chain).",
  "",
  "## Verification status",
  "The independent verifier verdict and findings.",
  "",
  "## Artifact bundle",
  "The absolute directory path and lists of files generated for this review.",
  "",
  "## Recommendations (defense in depth)",
  "Hardening that is not a finding but materially reduces attack surface.",
  "",
  "## Methodology notes",
  "Classes audited vs marked N/A and why, trust-boundary files read, and anything not covered — be honest about gaps.",
].join("\n");

const SCRIPT = `export const meta = {
  name: ${JSON.stringify(WORKFLOW_NAME)},
  description: ${JSON.stringify(WORKFLOW_DESCRIPTION)},
  whenToUse: ${JSON.stringify(WORKFLOW_WHEN_TO_USE)},
  phases: ${JSON.stringify(WORKFLOW_PHASES.map((p) => ({ title: p.title, detail: p.detail })))},
}

const CATEGORIES = ${JSON.stringify(CATEGORIES)}
const CROSS_FILE_LENS = ${JSON.stringify(CROSS_FILE_LENS)}
const SEVERITY_RUBRIC = ${JSON.stringify(SEVERITY_RUBRIC)}
const FINDING_FIELDS = ${JSON.stringify(FINDING_FIELDS)}
const OUTPUT_FORMAT = ${JSON.stringify(OUTPUT_FORMAT)}

const LEVEL_PARAMS = {
  high: { perCategory: 5, twoSidedDebate: false, prove: false, sweep: false, sweepRounds: 0, escalators: 1, maxDebate: 20, maxProve: 0, maxFindings: 15 },
  xhigh: { perCategory: 8, twoSidedDebate: true, prove: true, sweep: true, sweepRounds: 1, escalators: 2, maxDebate: 30, maxProve: 20, maxFindings: 25 },
  max: { perCategory: 8, twoSidedDebate: true, prove: true, sweep: true, sweepRounds: 2, escalators: 2, maxDebate: 40, maxProve: 28, maxFindings: 30 },
}
const SWEEP_MAX = 8

let LEVEL = "xhigh";
let TARGET = "";
let REPORTS_DIR = "";
let TIMESTAMP = "";

if (args && typeof args === "object" && !Array.isArray(args)) {
  REPORTS_DIR = typeof args.reportsDir === "string" ? args.reportsDir : "";
  TIMESTAMP = typeof args.timestamp === "string" ? args.timestamp : "";
  TARGET = typeof args.target === "string" ? args.target.trim() : (typeof args.path === "string" ? args.path.trim() : "");
  const lvlInput = typeof args.level === "string" ? args.level.trim() : "";
  if (Object.prototype.hasOwnProperty.call(LEVEL_PARAMS, lvlInput)) {
    LEVEL = lvlInput;
  } else {
    LEVEL = "xhigh";
  }
} else {
  // Legacy string format
  const RAW_ARGS = (typeof args === "string" ? args : "").trim();
  const FIRST = RAW_ARGS.split(/\\s+/)[0] || "";
  const FIRST_IS_LEVEL = Object.prototype.hasOwnProperty.call(LEVEL_PARAMS, FIRST);
  if (FIRST_IS_LEVEL) {
    LEVEL = FIRST;
    TARGET = RAW_ARGS.slice(FIRST.length).trim();
  } else {
    // missing/invalid level becomes xhigh
    LEVEL = "xhigh";
    TARGET = RAW_ARGS;
  }
}
const P = LEVEL_PARAMS[LEVEL];

const SCOPE_SCHEMA = {
  type: "object", required: ["repo", "summary", "categories", "preflight", "threatModel"],
  properties: {
    repo: { type: "string" },
    commitSha: { type: "string" },
    languages: { type: "array", items: { type: "string" } },
    buildSystem: { type: "string" },
    ci: { type: "string" },
    trustBoundaries: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
    preflight: {
      type: "object",
      required: ["targetValid", "targetReason", "inspectedPaths"],
      properties: {
        targetValid: { type: "boolean" },
        targetReason: { type: "string" },
        inspectedPaths: { type: "array", items: { type: "string" } }
      }
    },
    threatModel: {
      type: "object",
      required: ["summary", "highRiskPaths", "attackSurfaceAreas"],
      properties: {
        summary: { type: "string" },
        highRiskPaths: { type: "array", items: { type: "string" } },
        attackSurfaceAreas: { type: "array", items: { type: "string" } }
      }
    },
    categories: { type: "array", items: {
      type: "object", required: ["key", "inScope", "reason"],
      properties: {
        key: { type: "string" },
        inScope: { type: "boolean" },
        reason: { type: "string" },
      },
    }},
  },
}

const PLANNER_SCHEMA = {
  type: "object",
  required: ["rails"],
  properties: {
    rails: {
      type: "array",
      items: {
        type: "object",
        required: ["category", "files", "globs", "symbols", "entryPoints", "sinks", "safeSiblings", "rationale"],
        properties: {
          category: { type: "string" },
          files: { type: "array", items: { type: "string" } },
          globs: { type: "array", items: { type: "string" } },
          symbols: { type: "array", items: { type: "string" } },
          entryPoints: { type: "array", items: { type: "string" } },
          sinks: { type: "array", items: { type: "string" } },
          safeSiblings: { type: "array", items: { type: "string" } },
          rationale: { type: "string" },
        }
      }
    }
  }
}

const CANDIDATES_SCHEMA = {
  type: "object", required: ["candidates"],
  properties: {
    candidates: { type: "array", items: {
      type: "object", required: ["file", "summary", "severity", "source", "sink"],
      properties: {
        file: { type: "string" },
        line: { type: "number" },
        snippet: { type: "string" },
        summary: { type: "string" },
        severity: { enum: ["Critical", "High", "Medium", "Low", "Info"] },
        cwe: { type: "string" },
        owasp: { type: "string" },
        source: { type: "string" },
        sink: { type: "string" },
        whyExploitable: { type: "string" },
      },
    }},
  },
}
const ARGUMENT_SCHEMA = {
  type: "object", required: ["reachable", "argument"],
  properties: {
    reachable: { type: "boolean" },
    argument: { type: "string" },
    evidence: { type: "string" },
  },
}
const VERDICT_SCHEMA = {
  type: "object", required: ["verdict", "reachable", "severity", "evidence"],
  properties: {
    verdict: { enum: ["CONFIRMED", "PLAUSIBLE", "REFUTED"] },
    reachable: { type: "boolean" },
    severity: { enum: ["Critical", "High", "Medium", "Low", "Info"] },
    evidence: { type: "string" },
    exploitPath: { type: "string" },
  },
}
const PROVE_SCHEMA = {
  type: "object", required: ["proven", "severity"],
  properties: {
    proven: { type: "boolean" },
    poc: { type: "string" },
    reachablePath: { type: "string" },
    severity: { enum: ["Critical", "High", "Medium", "Low", "Info"] },
  },
}
const ESCALATE_SCHEMA = {
  type: "object", required: ["chains", "reranked"],
  properties: {
    chains: { type: "array", items: {
      type: "object", required: ["findingIds", "impact", "severity"],
      properties: {
        findingIds: { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } },
        impact: { type: "string" },
        severity: { enum: ["Critical", "High", "Medium", "Low", "Info"] },
      },
    }},
    reranked: { type: "array", items: {
      type: "object", required: ["id", "severity"],
      properties: {
        id: { anyOf: [{ type: "string" }, { type: "number" }] },
        severity: { enum: ["Critical", "High", "Medium", "Low", "Info"] },
      },
    }},
  },
}
const REPORT_SCHEMA = {
  type: "object", required: ["summary", "tally", "reportMarkdown"],
  properties: {
    summary: { type: "string" },
    tally: { type: "object", properties: {
      critical: { type: "number" }, high: { type: "number" }, medium: { type: "number" }, low: { type: "number" }, info: { type: "number" },
    }},
    reportMarkdown: { type: "string" },
  },
}
const REPORT_VERDICT_SCHEMA = {
  type: "object", required: ["verdict"],
  properties: {
    verdict: { enum: ["PASS", "PARTIAL", "FAIL"] },
    issues: { type: "array", items: { type: "string" } },
  },
}
const WRITER_SCHEMA = {
  type: "object",
  required: ["written", "reportPath", "bundleDir", "errors"],
  properties: {
    written: {
      type: "object",
      required: ["report", "scanManifest", "findings", "coverage", "validationReceipts"],
      properties: {
        report: { type: "string" },
        scanManifest: { type: "string" },
        findings: { type: "string" },
        coverage: { type: "string" },
        validationReceipts: { type: "string" },
        attackPaths: { type: "string" },
      }
    },
    reportPath: { type: "string" },
    bundleDir: { type: "string" },
    errors: { type: "array", items: { type: "string" } },
  }
}

function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

function cleanString(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function normalizeIdentityPart(s) {
  return String(s || "").toLowerCase().replace(/\\s+/g, " ").replace(/["']/g, "").trim();
}

function semanticKey(c) {
  const location = normalizeIdentityPart(c.file || c.path || c.location || "");
  const snippetPart = c.snippet ? "snippet:" + cyrb53(normalizeIdentityPart(c.snippet)).slice(0, 12) : "";
  return [
    normalizeIdentityPart(c.category),
    normalizeIdentityPart(c.cwe || c.owasp || ""),
    normalizeIdentityPart(c.rootCause || c.summary || ""),
    normalizeIdentityPart(c.source || ""),
    normalizeIdentityPart(c.sink || ""),
    normalizeIdentityPart(c.impact || c.exploitPath || c.reachablePath || c.whyExploitable || ""),
    location || snippetPart,
    location ? snippetPart : "",
  ].join("|");
}

const idBySemanticKey = new Map();
const semanticKeyById = new Map();

function stableCandidateIdentity(c) {
  const key = c.semanticKey || semanticKey(c);
  if (idBySemanticKey.has(key)) return { id: idBySemanticKey.get(key), semanticKey: key };
  const cleanCat = cleanString(c.category) || "unknown";
  const cleanCwe = cleanString(c.cwe || c.owasp) || "na";
  const baseId = "F-" + cleanCat + "-" + cleanCwe + "-" + cyrb53(key);
  let finalId = baseId;
  let suffix = 1;
  while (semanticKeyById.has(finalId) && semanticKeyById.get(finalId) !== key) {
    finalId = baseId + "-" + suffix;
    suffix++;
  }
  semanticKeyById.set(finalId, key);
  idBySemanticKey.set(key, finalId);
  return { id: finalId, semanticKey: key };
}

function assignStableIdentity(c) {
  const identity = stableCandidateIdentity(c);
  return { ...c, id: identity.id, semanticKey: identity.semanticKey, state: c.state || "candidate" };
}

function normalizeFindingId(value, findings) {
  if (typeof value === "number") return findings[value] ? findings[value].id : String(value);
  const text = String(value || "").trim();
  if (/^[0-9]+$/.test(text)) {
    const zeroBased = Number(text);
    if (findings[zeroBased]) return findings[zeroBased].id;
    const oneBased = zeroBased - 1;
    if (findings[oneBased]) return findings[oneBased].id;
  }
  return text;
}

function normalizeFindingIds(values, findings) {
  const ids = [];
  for (const value of values || []) {
    const id = normalizeFindingId(value, findings);
    if (id && ids.indexOf(id) === -1) ids.push(id);
  }
  return ids;
}

function findingRecord(c, state, extra = {}) {
  return {
    id: c.id,
    state,
    severity: c.severity,
    category: c.category,
    file: c.file,
    line: c.line,
    cwe: c.cwe,
    owasp: c.owasp,
    verdict: c.verdict,
    summary: c.summary,
    source: c.source,
    sink: c.sink,
    poc: c.poc || c.exploitPath,
    semanticKey: c.semanticKey,
    ...extra,
  };
}

const degradedRouting = [];

async function safeAgent(prompt, options) {
  if (options && options.tier) {
    try {
      return await agent(prompt, options);
    } catch (e) {
      const errMsg = String(e.message || e);
      // Degrade ONLY for explicit routing failures (quota / rate limit / cooldown /
      // provider exhaustion). Config and schema errors (InputValidationError,
      // StructuredOutput* mismatches) and any unexpected exception must surface —
      // silently retrying on default routing would mask real bugs.
      const isConfigOrSchema =
        errMsg.includes("InputValidationError") || errMsg.includes("StructuredOutput");
      const isRouting =
        !isConfigOrSchema &&
        (errMsg.includes("No usable provider") ||
          errMsg.includes("rate limit") ||
          errMsg.includes("quota") ||
          errMsg.includes("429") ||
          errMsg.includes("529") ||
          errMsg.includes("exhausted") ||
          errMsg.includes("cooldown") ||
          errMsg.includes("throttled"));
      if (!isRouting) throw e;
      log("Routing degraded for " + (options.label || "agent") + ", using default routing: " + errMsg);
      degradedRouting.push("Degraded routing for " + (options.label || "agent") + ": " + errMsg);

      const fallbackOptions = {};
      for (const k in options) {
        if (k !== "tier") {
          fallbackOptions[k] = options[k];
        }
      }
      return await agent(prompt, fallbackOptions);
    }
  }
  return await agent(prompt, options);
}

const validationReceipts = [];

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

function addReportIssue(verdictObj, issue) {
  const current = verdictObj || { verdict: "PARTIAL", issues: [] };
  const issues = (current.issues || []).slice();
  issues.push(issue);
  return { verdict: current.verdict === "FAIL" ? "FAIL" : "PARTIAL", issues };
}

function foldWriterVerdict(verdictObj, writerResult, expectedPaths) {
  const issues = writerIssues(writerResult, expectedPaths);
  let next = verdictObj;
  for (const issue of issues) next = addReportIssue(next, issue);
  return next;
}

phase("Prep / target inspection")
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

log(LEVEL + " audit: " + scope.repo + " @ " + (scope.commitSha || "?") + " — " + LANES.length + " in-scope classes")

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

phase("Report")
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

export const DEEP_SECURITY_REVIEW_WORKFLOW: WorkflowDefinition = {
  source: "built-in",
  name: WORKFLOW_NAME,
  description: WORKFLOW_DESCRIPTION,
  whenToUse: WORKFLOW_WHEN_TO_USE,
  phases: WORKFLOW_PHASES,
  script: SCRIPT,
  hidden: true,
};
