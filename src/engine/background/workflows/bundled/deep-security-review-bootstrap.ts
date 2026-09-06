import {
  CATEGORIES,
  CROSS_FILE_LENS,
  FINDING_FIELDS,
  OUTPUT_FORMAT,
  SEVERITY_RUBRIC,
  WORKFLOW_DESCRIPTION,
  WORKFLOW_NAME,
  WORKFLOW_PHASES,
  WORKFLOW_WHEN_TO_USE,
} from "./deep-security-review-contract.ts";

export const DEEP_SECURITY_REVIEW_BOOTSTRAP = `export const meta = {
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

`;
