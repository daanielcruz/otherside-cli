import type {
  ArrayExpression,
  Expression,
  Literal,
  ObjectExpression,
  Property,
  UnaryExpression,
} from "acorn";
import { WorkflowParseError } from "@/engine/background/workflows/runtime/parser/types.ts";

const RESERVED_LITERAL_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type WorkflowLiteral =
  | string
  | number
  | boolean
  | null
  | WorkflowLiteral[]
  | WorkflowLiteralObject;
export type WorkflowLiteralObject = { [key: string]: WorkflowLiteral };

export function readWorkflowLiteral(expression: Expression): WorkflowLiteral {
  if (expression.type === "Literal") return readLiteralValue(expression);
  if (expression.type === "TemplateLiteral")
    return readTemplateLiteral(expression.expressions.length, expression.quasis);
  if (expression.type === "ArrayExpression") return readArrayLiteral(expression);
  if (expression.type === "ObjectExpression") return readObjectLiteral(expression);
  if (expression.type === "UnaryExpression") return readUnaryLiteral(expression);
  throw new WorkflowParseError("Workflow meta must contain literal values only.");
}

function readUnaryLiteral(expression: UnaryExpression): number {
  if (
    expression.operator === "-" &&
    expression.argument.type === "Literal" &&
    typeof expression.argument.value === "number"
  ) {
    return -expression.argument.value;
  }
  throw new WorkflowParseError("Workflow meta only supports negative-number unary expressions.");
}

function readLiteralValue(literal: Literal): WorkflowLiteral {
  const value = literal.value;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }
  throw new WorkflowParseError("Workflow meta literal value is not supported.");
}

function readTemplateLiteral(
  expressionCount: number,
  quasis: { value: { cooked?: string | null } }[],
): string {
  if (expressionCount > 0) {
    throw new WorkflowParseError("Workflow meta template interpolation is not supported.");
  }
  const cooked = quasis[0]?.value.cooked;
  if (typeof cooked !== "string") {
    throw new WorkflowParseError("Workflow meta template literal is invalid.");
  }
  return cooked;
}

function readArrayLiteral(expression: ArrayExpression): WorkflowLiteral[] {
  return expression.elements.map((element) => {
    if (element === null) {
      throw new WorkflowParseError("Workflow meta arrays cannot be sparse.");
    }
    if (element.type === "SpreadElement") {
      throw new WorkflowParseError("Workflow meta arrays cannot use spread elements.");
    }
    return readWorkflowLiteral(element);
  });
}

function readObjectLiteral(expression: ObjectExpression): WorkflowLiteralObject {
  const output: WorkflowLiteralObject = {};
  for (const property of expression.properties) {
    if (property.type === "SpreadElement") {
      throw new WorkflowParseError("Workflow meta objects cannot use spread properties.");
    }
    const key = readPropertyKey(property);
    output[key] = readWorkflowLiteral(property.value);
  }
  return output;
}

function readPropertyKey(property: Property): string {
  if (property.computed || property.method || property.kind !== "init" || property.shorthand) {
    throw new WorkflowParseError("Workflow meta object keys must be plain literal keys.");
  }
  const key = readPlainKey(property.key);
  if (RESERVED_LITERAL_KEYS.has(key)) {
    throw new WorkflowParseError(`Workflow meta key '${key}' is not allowed.`);
  }
  return key;
}

function readPlainKey(key: Expression): string {
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  throw new WorkflowParseError("Workflow meta object keys must be strings or identifiers.");
}
