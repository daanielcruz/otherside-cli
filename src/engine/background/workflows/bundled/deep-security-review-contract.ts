import type { WorkflowPhaseSpec } from "@/engine/background/workflows/runtime/parser/types.ts";

export const WORKFLOW_NAME = "deep-security-review";
export const WORKFLOW_DESCRIPTION =
  "Whole-repo security audit harness — a prep agent maps the attack surface, specialized auditors scan each vulnerability class, every candidate is debated for-and-against reachability, survivors are proven and correlated into exploit chains, then a strict report is rendered and independently re-verified. The target repo is read-only; when reportsDir and timestamp are provided, a writer subagent writes the durable report bundle under reportsDir.";
export const WORKFLOW_WHEN_TO_USE =
  'Launched by the /deep-security-review skill when workflows are enabled. Prefer object args { level, target/path, reportsDir, timestamp }; legacy "<level> [path]" is still accepted. Level is high, xhigh, or max (default xhigh); path is an optional subtree to scope the audit (e.g. "src/auth/"). Covers OWASP Top 10, CWE Top 25, NIST SP 800-53/SSDF, supply-chain, secrets, authn/authz, injection, memory safety, crypto, network/SSRF, file I/O, client-side, concurrency/TOCTOU, logging, and CI/CD. Returns reportMarkdown plus structured findings, exploit chains, a severity tally, a verification verdict, and durable artifact paths when a bundle is written.';
export const WORKFLOW_PHASES: WorkflowPhaseSpec[] = [
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

export const CATEGORIES = [
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

export const CROSS_FILE_LENS =
  "Reason ACROSS files, not just within one function. For every candidate, trace the untrusted source to the dangerous sink through callers and callees (Grep the symbols). The strongest signal is a CORRECT sibling: when the same logical operation appears elsewhere in the repo done safely, a divergent call site is an inconsistency — that asymmetry is high-confidence evidence, not a guess. Bugs that span multiple files or non-trivial control flow are exactly what a single-file scan misses; hunt those.";

export const SEVERITY_RUBRIC =
  "Critical = unauth RCE, unauth full data exfil, unauth privilege escalation to admin, complete auth bypass, production cryptographic break. High = authenticated RCE/exfil, unauth partial exfil, cross-tenant IDOR, unauth sensitive-data exposure, SSRF to internal metadata. Medium = auth bypass needing unusual preconditions, stored XSS in an authed-only surface, CSRF on a destructive authed action, weak crypto on non-primary data, known-CVE dep with non-reachable sink. Low = verbose errors, missing headers on non-sensitive responses, minor info disclosure. Info = hardening / defense-in-depth, fragile but not currently exploitable. Critical and High MUST carry a concrete exploit path or they are not Critical/High.";

export const FINDING_FIELDS =
  "Each finding carries: category, file, line, a byte-exact snippet quoted from the source (no paraphrase), severity, cwe (CWE-NNN), owasp (A0X:YYYY or N/A), the untrusted source, the sink, why it is exploitable (source→sink trace), a concrete proof-of-concept / exploit path (or the precondition if not directly reachable), and a specific line-referenced fix.";

export const OUTPUT_FORMAT = [
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
