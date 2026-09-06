import { DEEP_SECURITY_REVIEW_AGENTS } from "./deep-security-review-agents.ts";
import { DEEP_SECURITY_REVIEW_ARTIFACTS } from "./deep-security-review-artifacts.ts";
import { DEEP_SECURITY_REVIEW_AUDIT } from "./deep-security-review-audit.ts";
import { DEEP_SECURITY_REVIEW_BOOTSTRAP } from "./deep-security-review-bootstrap.ts";
import { DEEP_SECURITY_REVIEW_IDENTITY } from "./deep-security-review-identity.ts";
import { DEEP_SECURITY_REVIEW_PREFLIGHT } from "./deep-security-review-preflight.ts";
import { DEEP_SECURITY_REVIEW_REPORT } from "./deep-security-review-report.ts";
import { DEEP_SECURITY_REVIEW_SCHEMA } from "./deep-security-review-schema.ts";
import { DEEP_SECURITY_REVIEW_VERDICT } from "./deep-security-review-verdict.ts";

export const DEEP_SECURITY_REVIEW_SCRIPT =
  DEEP_SECURITY_REVIEW_BOOTSTRAP +
  DEEP_SECURITY_REVIEW_SCHEMA +
  DEEP_SECURITY_REVIEW_IDENTITY +
  DEEP_SECURITY_REVIEW_AGENTS +
  DEEP_SECURITY_REVIEW_ARTIFACTS +
  DEEP_SECURITY_REVIEW_VERDICT +
  DEEP_SECURITY_REVIEW_PREFLIGHT +
  DEEP_SECURITY_REVIEW_AUDIT +
  DEEP_SECURITY_REVIEW_REPORT;
