export type ValidationPath = (string | number)[];

export type ValidationIssue =
  | { code: "invalid_type"; expected: string; received: string; path: ValidationPath }
  | { code: "unrecognized_keys"; keys: string[]; path: ValidationPath }
  | { code: "invalid_value"; values: unknown[]; path: ValidationPath }
  | { code: "invalid_union"; branches: ValidationIssue[][]; path: ValidationPath };

interface NodeCheck {
  node: Record<string, unknown>;
  value: unknown;
  path: ValidationPath;
}

export function validateToolInput(
  schema: Record<string, unknown>,
  input: unknown,
): ValidationIssue[] {
  return checkNode({ node: schema, value: input, path: [] });
}

function checkNode({ node, value, path }: NodeCheck): ValidationIssue[] {
  if (Array.isArray(node.enum)) return membershipIssues({ values: node.enum, value, path });
  if ("const" in node) return membershipIssues({ values: [node.const], value, path });
  if (Array.isArray(node.anyOf)) return unionIssues({ branches: node.anyOf, value, path });
  if (typeof node.type !== "string") return [];
  if (node.type === "object") return objectIssues({ node, value, path });
  if (node.type === "array") return arrayIssues({ node, value, path });
  if (node.type === "integer") return integerIssues({ value, path });
  return primitiveIssues({ expected: node.type, value, path });
}

function objectIssues({ node, value, path }: NodeCheck): ValidationIssue[] {
  if (!isRecord(value)) {
    return [{ code: "invalid_type", expected: "object", received: receivedName(value), path }];
  }
  const properties = isRecord(node.properties) ? node.properties : {};
  const required = new Set(Array.isArray(node.required) ? node.required : []);
  const issues: ValidationIssue[] = [];
  for (const [key, child] of Object.entries(properties)) {
    if (!isRecord(child)) continue;
    const propValue = value[key];
    if (propValue === undefined && !required.has(key)) continue;
    issues.push(...checkNode({ node: child, value: propValue, path: [...path, key] }));
  }
  if (node.additionalProperties === false) {
    const keys = Object.keys(value).filter((key) => !(key in properties));
    if (keys.length > 0) issues.push({ code: "unrecognized_keys", keys, path });
  }
  return issues;
}

function arrayIssues({ node, value, path }: NodeCheck): ValidationIssue[] {
  if (!Array.isArray(value)) {
    return [{ code: "invalid_type", expected: "array", received: receivedName(value), path }];
  }
  const items = node.items;
  if (!isRecord(items)) return [];
  return value.flatMap((element, index) =>
    checkNode({ node: items, value: element, path: [...path, index] }),
  );
}

interface UnionCheck {
  branches: unknown[];
  value: unknown;
  path: ValidationPath;
}

function unionIssues({ branches, value, path }: UnionCheck): ValidationIssue[] {
  const branchIssues: ValidationIssue[][] = [];
  for (const branch of branches) {
    if (!isRecord(branch)) return [];
    const issues = checkNode({ node: branch, value, path: [] });
    if (issues.length === 0) return [];
    branchIssues.push(issues);
  }
  return [{ code: "invalid_union", branches: branchIssues, path }];
}

interface MembershipCheck {
  values: unknown[];
  value: unknown;
  path: ValidationPath;
}

function membershipIssues({ values, value, path }: MembershipCheck): ValidationIssue[] {
  if (values.some((candidate) => candidate === value)) return [];
  return [{ code: "invalid_value", values, path }];
}

interface IntegerCheck {
  value: unknown;
  path: ValidationPath;
}

function integerIssues({ value, path }: IntegerCheck): ValidationIssue[] {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return [{ code: "invalid_type", expected: "number", received: receivedName(value), path }];
  }
  if (!Number.isInteger(value)) {
    return [{ code: "invalid_type", expected: "int", received: "number", path }];
  }
  return [];
}

interface PrimitiveCheck {
  expected: string;
  value: unknown;
  path: ValidationPath;
}

function primitiveIssues({ expected, value, path }: PrimitiveCheck): ValidationIssue[] {
  if (matchesPrimitive(expected, value)) return [];
  return [{ code: "invalid_type", expected, received: receivedName(value), path }];
}

function matchesPrimitive(expected: string, value: unknown): boolean {
  if (expected === "string") return typeof value === "string";
  if (expected === "boolean") return typeof value === "boolean";
  if (expected === "number") return typeof value === "number" && !Number.isNaN(value);
  if (expected === "null") return value === null;
  return true;
}

function receivedName(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isNaN(value)) return "NaN";
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
