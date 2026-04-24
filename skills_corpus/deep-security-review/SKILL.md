---
name: deep-security-review
description: Deep bughunter sweep of the entire repository — OWASP Top 10, CWE Top 25, NIST SP 800-53/SSDF, supply-chain, crypto, authn/authz, injection, memory safety, network/TLS, CI/CD. Every finding cites file, line range, snippet, CWE, OWASP category, severity, exploit path, and concrete fix.
---

You are performing a deep, exhaustive security audit of the ENTIRE
repository. This is not a branch-diff review. Treat every file under
source control as attack surface and hunt for real, exploitable bugs.

Operate as an offensive-security reviewer. No hedging, no "consider this",
no "might want to look at". Direct attacker mindset. Fabricated findings
are forbidden — every cite must be traceable to a real file and line.

## Coverage standard

Every audit MUST address the following frames. If a frame does not apply
to this repo, state "N/A — <reason>" explicitly. Silence is not a pass.

- **OWASP Top 10 (2021)**
  - A01 Broken Access Control
  - A02 Cryptographic Failures
  - A03 Injection (SQL, NoSQL, OS command, LDAP, XPath, template,
    header, log, prototype pollution, expression-language)
  - A04 Insecure Design (threat-model gaps, missing rate limits,
    missing anti-automation, trust boundary violations)
  - A05 Security Misconfiguration (default creds, permissive CORS,
    verbose errors, debug endpoints, open admin surfaces)
  - A06 Vulnerable and Outdated Components
  - A07 Identification and Authentication Failures
  - A08 Software and Data Integrity Failures (unsigned updates,
    tampered CI, untrusted deserialization, insecure CI/CD)
  - A09 Security Logging and Monitoring Failures
  - A10 Server-Side Request Forgery
- **CWE Top 25** — walk the current CWE/SANS Top 25 list. Flag every
  instance. Examples: CWE-79 XSS, CWE-20 improper input validation,
  CWE-78 OS command injection, CWE-89 SQL injection, CWE-352 CSRF,
  CWE-22 path traversal, CWE-287 improper authentication, CWE-862
  missing authorization, CWE-863 incorrect authorization, CWE-269
  improper privilege management, CWE-502 deserialization of untrusted
  data, CWE-918 SSRF, CWE-77 command injection, CWE-94 code injection,
  CWE-434 unrestricted file upload, CWE-611 XXE, CWE-798 hardcoded
  credentials, CWE-306 missing auth for critical function, CWE-732
  incorrect permission assignment, CWE-200 exposure of sensitive info,
  CWE-125 out-of-bounds read, CWE-787 out-of-bounds write, CWE-416
  use-after-free, CWE-476 NULL deref, CWE-362 race / TOCTOU,
  CWE-367 TOCTOU on file check, CWE-1321 prototype pollution.
- **NIST SP 800-53 rev 5** — access control (AC), audit and
  accountability (AU), identification and authentication (IA),
  system and communications protection (SC), system and information
  integrity (SI). Flag missing controls in AC-3, AC-6, AU-2, AU-12,
  IA-2, IA-5, SC-8, SC-13, SC-28, SI-10, SI-11.
- **NIST SP 800-218 SSDF** — PW (produce well-secured software),
  PS (protect software), RV (respond to vulnerabilities). Verify
  lockfile integrity, pinned deps, supply-chain provenance, vuln
  disclosure channel.

## Category checklist

Work through every category. For each, either list findings or write
"clean — <one-line reason grounded in evidence>". Empty sections are
not acceptable.

### 1. Supply chain

- Dependency manifest integrity — `Cargo.toml`, `Cargo.lock`,
  `package.json`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`,
  `go.mod`, `go.sum`, `requirements*.txt`, `Pipfile.lock`, `poetry.lock`,
  `Gemfile.lock`. Are versions pinned? Is the lockfile committed and
  consistent with the manifest?
- Typosquat risk — any dep name one edit away from a popular crate /
  package.
- Unsigned artifacts — crates/npm packages without provenance, git
  submodules pointing at forks, HTTP (not HTTPS) URLs in manifests.
- Post-install / build-script abuse — `build.rs`, npm `postinstall`,
  `setup.py` arbitrary code at install time.
- Known-CVE sweep — grep versions of high-value libs (openssl, ring,
  rustls, reqwest, hyper, serde, tokio, actix, express, next, log4j
  analogues) against public advisories.

### 2. Secrets and credentials

- Hardcoded keys, tokens, passwords, API secrets in source.
- `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `*.pfx`, `*.p12`,
  `credentials.json`, `service-account*.json` tracked in git.
- `.gitignore` gaps that would permit future leaks.
- Secrets in test fixtures (even dummy ones — they normalize patterns
  that leak real keys later).
- Secrets passed via command-line args (visible in `ps`).
- Logging of token-bearing headers, Authorization, Set-Cookie,
  request/response bodies with auth material.

### 3. Authentication

- Password handling — plaintext comparison, weak hashing (MD5, SHA1,
  single-iteration SHA256), missing salt, missing peppering, bcrypt
  cost factor < 10, scrypt parameters below current minimums, argon2
  memory/iterations below current minimums.
- JWT handling — `alg: none` acceptance, HS256 verified with a
  public key, missing `exp`/`nbf`/`iat` checks, missing audience /
  issuer pinning, signature verified AFTER payload trust, key
  confusion (HS vs RS), JWK URL taken from token header.
- Session fixation, predictable session IDs, session not regenerated
  on privilege change, missing `HttpOnly` / `Secure` / `SameSite`.
- Multi-factor bypass paths, remember-me tokens with excessive TTL
  or no server-side revocation.
- OAuth / OIDC — missing state / PKCE, redirect_uri allowlist
  overly permissive, implicit grant used where code+PKCE is required,
  token leak via referer.

### 4. Authorization

- Missing auth check on a destructive / privileged handler.
- Per-object access control (IDOR) — `/users/{id}` without verifying
  caller owns / may access that id.
- Role/permission checks done in the client only.
- Privilege escalation paths — user-controlled input that influences
  a role field, admin route gated only by obscurity.
- Trust boundary violations — data from an untrusted source (HTTP
  request, environment variable, file under user control, IPC peer,
  untrusted MCP server, third-party tool output) flowing into a
  sink without re-validation.
- Race conditions in authorization — permission cached across a
  state change, TOCTOU between check and use.

### 5. Injection

For each, list both detection pattern and remediation pattern.

- **SQL** — string-concatenated queries, `format!`/f-string into
  SQL, ORM raw calls with user input.
- **OS command / shell** — `Command::new("sh").arg("-c")`,
  `exec`/`spawn` with concatenated args, `subprocess.run(shell=True)`,
  `os.system`.
- **Code / expression** — `eval`, `Function(...)`, Python `exec`,
  Ruby `instance_eval`, Rhai / Lua / Starlark / JS engines fed
  untrusted source.
- **Template** — Jinja, Handlebars, Tera, Liquid, Mustache, Go
  `html/template` vs `text/template` misuse, user input controlling
  template source not template data.
- **LDAP** — unescaped user input in filter strings.
- **XPath / XQuery** — unescaped input in XPath expressions.
- **NoSQL** — Mongo operators injected via user-controlled keys.
- **Header injection** — CRLF in a user-controlled value reflected
  into response / outbound request headers.
- **Log injection** — CRLF / ANSI sequences / forged log lines
  from user input.
- **Prototype pollution** (JS) — `Object.assign`, `lodash.merge`,
  user-controlled keys like `__proto__` / `constructor`.
- **Deserialization gadgets** — `pickle.loads`, `yaml.load` without
  SafeLoader, Java ObjectInputStream, Ruby `Marshal.load`, PHP
  `unserialize`, `serde` + `deserialize_any` on untrusted JSON/CBOR
  with tagged enums.

### 6. Memory safety (Rust / C / C++)

- `unsafe` blocks — each one must be justified. Flag any that:
  - Deref raw pointers without a provenance argument.
  - Cast between non-`repr(C)` types.
  - Call FFI with incorrect lifetime / ownership assumptions.
  - Transmute references across Send/Sync boundaries.
- FFI boundaries — nul-terminated string assumptions, buffer length
  arguments, error-code propagation, pointer lifetimes.
- Integer overflow — arithmetic on externally controlled sizes
  without `checked_*` / `saturating_*` / explicit wrap.
- `unwrap` / `expect` on user-controlled inputs in request-handling
  paths (DoS via panic).
- Uninitialised reads — `MaybeUninit` used incorrectly, `mem::zeroed`
  on types with non-zero validity.
- C/C++ only: strncpy/strncat off-by-one, `memcpy` with attacker-
  controlled length, format-string bugs, use-after-free, double-
  free, signed/unsigned comparison mixing.

### 7. Cryptography

- Primitive choice — MD5, SHA1, DES, 3DES, RC4, CBC without MAC,
  ECB ever, static IV, predictable nonce counter, GCM nonce reuse,
  non-constant-time compare on MACs / tokens.
- KDF params — PBKDF2 iterations below current OWASP floor,
  scrypt N below current minimum, argon2 memory too low.
- Weak RNG — `rand::thread_rng`-derived material used for keys
  when `OsRng` or a vetted CSPRNG is required; `Math.random()` /
  `rand()` / `srand(time(0))`.
- Certificate validation disabled — `danger_accept_invalid_certs`,
  `rejectUnauthorized: false`, `CURLOPT_SSL_VERIFYPEER = 0`,
  `InsecureSkipVerify: true`.
- Hostname verification disabled separately from cert validation.
- TLS version floor below 1.2; cipher suite override permitting
  NULL / EXPORT / anonymous suites.
- Algorithm downgrade / confusion — accepting arbitrary `alg` from
  a JWT header, accepting arbitrary content-encoding, accepting
  user-chosen KDF.
- Key storage — plaintext private keys on disk, wide file modes,
  keys in env vars logged on startup.

### 8. Network, SSRF, URL handling

- Outbound HTTP from user-controllable URLs without an allowlist.
- URL parsing tricks — `http://evil.com#@trusted.com/`, IPv6
  brackets, URL-encoded host, IP literal bypasses, DNS rebinding
  windows (resolve-then-connect without pinning the resolved IP).
- Metadata service exposure — 169.254.169.254, fd00:ec2::254,
  GCP / Azure equivalents.
- Proxy-awareness — HTTPS_PROXY honoured for untrusted URLs,
  proxy auth leaked on redirect.
- Missing connect / read / total timeouts on client and server.
- Open redirect — 30x to user-controlled absolute URL.

### 9. File and path I/O

- Path traversal — user input joined into a path without
  canonicalisation + allowlist root check.
- Symlink races — open-then-stat where stat-then-open would still
  race; follow-symlinks on trust boundaries.
- Temp file creation — `/tmp/foo` without `O_EXCL`, predictable
  names, world-readable temp dirs.
- Archive extraction — zip/tar extracted without sanitising
  entry paths (Zip Slip, Tar Slip, absolute paths, `..`).
- File modes — `0o777`, `0o666`, `0o644` on files that should be
  `0o600`; permissive directory modes on credential / key stores.
- File upload — missing size limits, missing content-type
  validation, executable permission on uploaded files.

### 10. Client-side surface (if applicable)

- Reflected / stored XSS — `dangerouslySetInnerHTML`, `v-html`,
  `[innerHTML]`, untrusted string into DOM sinks.
- CSRF — state-changing endpoints with cookie auth and no token /
  SameSite=Lax fallback.
- Clickjacking — missing `X-Frame-Options` / `frame-ancestors`.
- CORS — `Access-Control-Allow-Origin: *` combined with
  `Allow-Credentials: true`, reflected Origin with no allowlist.
- Content Security Policy — missing or weakened by
  `unsafe-inline` / `unsafe-eval` / `*`.
- Cookie flags — missing `HttpOnly`, `Secure`, `SameSite`.

### 11. Concurrency, race conditions, TOCTOU

- Shared mutable state without a lock / atomic.
- Check-then-use across a syscall boundary (file existence,
  permission, auth token staleness).
- Double-fetch bugs — reading user-controlled memory twice with
  differing validation.
- Non-reentrant signal handlers.

### 12. Error handling, logging, telemetry

- Stack traces returned to clients.
- Internal paths leaked in error strings.
- PII / secrets / tokens logged (password, authorization header,
  refresh_token, cookie, ssn, credit card, address).
- Unstructured logs that invite log injection.
- Missing security-relevant audit events (auth success, auth
  failure, permission change, admin action, key rotation).

### 13. Build, CI/CD, release pipeline

- `.github/workflows/*.yml` — workflow privileges (`permissions:
  write-all`, contents: write where read suffices), secrets scope
  too broad, self-hosted runners exposed to PRs from forks,
  `pull_request_target` used with untrusted checkout.
- Script injection in workflows — `${{ github.event.issue.title }}`
  interpolated into `run:` / `sh -c`.
- Release signing — artifacts published unsigned, signing key
  stored in plain env var without rotation.
- Container / Dockerfile — `USER root` at runtime, no pinned
  base image digest, secrets baked into layers, `ADD` with remote
  URL.
- Reproducible builds — unpinned git refs, `curl | sh` install
  steps, network fetch during build.

## Methodology

Walk the repo in passes. Do not skip passes.

### Pass 1 — surface map (fast, no findings yet)

1. `git ls-files | head -200` and `ls -la` at the root. Note the
   project shape, language mix, build system, target runtime.
2. Read the dependency manifest(s) and lockfile(s). Record direct
   deps + pinned versions.
3. Read every top-level config file — `*.toml`, `*.yaml`, `*.yml`,
   `*.ini`, `*.cfg`, `*.env.example`, `Dockerfile*`, `.github/**`,
   `.gitlab-ci.yml`, `ci/**`, `scripts/**`, `Makefile`, `justfile`.
4. Read `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `OTHERSIDE.md`
   if present. Note advertised trust boundaries, supported
   deployment modes, declared threat model.

### Pass 2 — trust-boundary deep read

For every file on a trust boundary — authentication, authorization,
cryptography, network request/response handling, deserialization,
shell execution, file I/O with user input, `eval` / `exec`, template
rendering — read the full file. Do not skim. Follow every function
that crosses the boundary into its implementation.

Record per-file:

- Inputs it accepts and their source.
- Sinks it reaches.
- Validation / sanitisation it performs.
- Invariants it assumes callers uphold.

### Pass 3 — sweep by category

Using the category checklist above, walk the repo with targeted
searches per category. Do not rely on greps alone — read every hit
in context. Greps are discovery, not proof.

### Pass 4 — correlate findings

- Chain low-severity findings into plausible exploit paths.
- A hardcoded dev token + a debug endpoint + missing auth = critical,
  not three lows.
- Map each finding to OWASP + CWE + NIST control where applicable.

### Pass 5 — fix drafting

For each finding, write a concrete patch — not "add input
validation", but "replace line 47's `format!("SELECT ... {name}")`
with a parameterised query using `sqlx::query!("SELECT ... $1", name)`".

## Finding format

Every finding MUST carry every field below. A finding missing any
field is incomplete and MUST be revised before reporting.

```
### <short title>

- **Severity**: Critical | High | Medium | Low | Info
- **OWASP**: A0X:YYYY <name> (or N/A)
- **CWE**: CWE-NNN <name>
- **NIST**: <control family + id> (or N/A)
- **Location**: `<path/from/repo/root>:<start_line>-<end_line>`
- **Snippet**:
  ```<language>
  <quoted bytes from the file — no paraphrase>
  ```
- **Why it is exploitable**: <1-4 sentences tracing the untrusted
  source to the vulnerable sink>
- **Proof of concept / exploit path**: <concrete request / input /
  sequence of calls that triggers the bug; if not directly
  reachable, state the precondition>
- **Fix**: <specific, line-referenced change; show before/after
  if >1 line>
- **Residual risk after fix**: <what the fix does NOT cover>
```

Severity rubric:

- **Critical** — unauth remote code execution, unauth full data
  exfiltration, unauth privilege escalation to admin, cryptographic
  break of a production key, complete auth bypass.
- **High** — authenticated RCE/exfil, unauth partial data
  exfil, IDOR across tenants, sensitive-data exposure without
  auth, SSRF to internal metadata.
- **Medium** — auth bypass requiring unusual preconditions,
  stored XSS in an authenticated-only surface, CSRF on a
  destructive authenticated action, weak crypto on non-primary
  data, dependency with known CVE but non-reachable sink.
- **Low** — verbose error messages, missing security headers on a
  non-sensitive response, minor information disclosure.
- **Info** — hardening recommendations, defense-in-depth
  improvements, not currently exploitable but fragile.

## Output format

```
# Deep security review — <repo> @ <commit sha>

## Scope
- Files audited: <N>
- Languages: <list>
- Build system: <name>
- CI: <platform>
- Primary trust boundaries: <list>

## Summary
- N critical · N high · N medium · N low · N info
- Exploit chains identified: <N>
- Highest-severity chain: <one-line>

## Frame coverage
- OWASP A01 — <findings-ids or "clean — reason">
- OWASP A02 — ...
- ... (every A0N, every CWE bucket you touched, every NIST family)

## Findings
<one block per finding in the format above, grouped by severity,
Critical first>

## Exploit chains
<each chain: list the finding ids it combines and the end-to-end
impact>

## Recommendations (defense in depth)
<items that are not findings but would materially reduce attack
surface: add CSP, rotate signing keys, add rate limiting, enable
sandbox, etc.>

## Methodology notes
- Pass 1 artifacts: <list of files read in surface map>
- Pass 2 trust-boundary files: <list>
- Tools used: <rg, grep, cargo audit, npm audit, semgrep, etc. —
  record commands actually run, not ones you "would" run>
- Files NOT audited and why: <be honest; if a path was skipped,
  name it>
```

## Hard rules

- No fabricated findings. Every snippet must match the file byte-
  for-byte at the cited lines.
- No "consider", "might", "potentially" hedging in severity calls.
  Either it is exploitable or it is not — state which.
- No duplicate findings. If the same bug repeats across 20 files,
  list it once with all locations under a single finding.
- No "out of scope" excuses for the categories listed above.
  If a category is N/A, say so and why.
- Do not modify any source file during the audit.
- Do not run code from the audited repo unless explicitly
  sandboxed — read-only recon only.

## Arguments

Optional path filter (e.g. `src/auth/` to scope the audit to a
subtree). If empty, audit the entire repository.
