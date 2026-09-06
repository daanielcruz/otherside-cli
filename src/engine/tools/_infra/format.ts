import type { ValidationIssue, ValidationPath } from "./validate.ts";

const MISSING_RECEIVED = "undefined";
const ISSUE_JSON_INDENT = 2;

export function formatValidationError(toolName: string, issues: ValidationIssue[]): string {
  const errorParts = [
    ...missingParams(issues).map((param) => `The required parameter \`${param}\` is missing`),
    ...unexpectedParams(issues).map((param) => `An unexpected parameter \`${param}\` was provided`),
    ...typeMismatches(issues).map(
      ({ param, expected, received }) =>
        `The parameter \`${param}\` type is expected as \`${expected}\` but provided as \`${received}\``,
    ),
  ];
  if (errorParts.length === 0) {
    return JSON.stringify(issues.map(toWireIssue), null, ISSUE_JSON_INDENT);
  }
  const noun = errorParts.length > 1 ? "issues" : "issue";
  return `${toolName} failed due to the following ${noun}:\n${errorParts.join("\n")}`;
}

function missingParams(issues: ValidationIssue[]): string[] {
  return issues.flatMap((issue) =>
    issue.code === "invalid_type" && issue.received === MISSING_RECEIVED
      ? [formatPathForValidation(issue.path)]
      : [],
  );
}

function unexpectedParams(issues: ValidationIssue[]): string[] {
  return issues.flatMap((issue) => (issue.code === "unrecognized_keys" ? issue.keys : []));
}

interface TypeMismatch {
  param: string;
  expected: string;
  received: string;
}

function typeMismatches(issues: ValidationIssue[]): TypeMismatch[] {
  return issues.flatMap((issue) =>
    issue.code === "invalid_type" && issue.received !== MISSING_RECEIVED
      ? [
          {
            param: formatPathForValidation(issue.path),
            expected: issue.expected,
            received: issue.received,
          },
        ]
      : [],
  );
}

function formatPathForValidation(path: ValidationPath): string {
  let out = "";
  for (const [index, segment] of path.entries()) {
    if (typeof segment === "number") {
      out = `${out}[${segment}]`;
      continue;
    }
    out = index === 0 ? segment : `${out}.${segment}`;
  }
  return out;
}

function toWireIssue(issue: ValidationIssue): Record<string, unknown> {
  if (issue.code === "invalid_type") {
    return {
      expected: issue.expected,
      code: issue.code,
      ...(issue.received === "NaN" ? { received: issue.received } : {}),
      path: issue.path,
      message: `Invalid input: expected ${issue.expected}, received ${issue.received}`,
    };
  }
  if (issue.code === "unrecognized_keys") {
    return {
      code: issue.code,
      keys: issue.keys,
      path: issue.path,
      message: unrecognizedKeysMessage(issue.keys),
    };
  }
  if (issue.code === "invalid_value") {
    return {
      code: issue.code,
      values: issue.values,
      path: issue.path,
      message: invalidValueMessage(issue.values),
    };
  }
  return {
    code: issue.code,
    errors: issue.branches.map((branch) => branch.map(toWireIssue)),
    path: issue.path,
    message: "Invalid input",
  };
}

function unrecognizedKeysMessage(keys: string[]): string {
  const noun = keys.length > 1 ? "keys" : "key";
  return `Unrecognized ${noun}: ${keys.map((key) => JSON.stringify(key)).join(", ")}`;
}

function invalidValueMessage(values: unknown[]): string {
  if (values.length === 1) return `Invalid input: expected ${stringifyPrimitive(values[0])}`;
  return `Invalid option: expected one of ${values.map(stringifyPrimitive).join("|")}`;
}

function stringifyPrimitive(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}
