export const DEEP_SECURITY_REVIEW_SCHEMA = `const SCOPE_SCHEMA = {
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

`;
