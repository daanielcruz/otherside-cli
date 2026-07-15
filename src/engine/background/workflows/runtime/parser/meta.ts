import type { ExportNamedDeclaration, ObjectExpression, Program, VariableDeclarator } from "acorn";
import { parse } from "acorn";
import {
  readWorkflowLiteral,
  type WorkflowLiteral,
  type WorkflowLiteralObject,
} from "@/engine/background/workflows/runtime/parser/literal.ts";
import {
  type ParsedWorkflowScript,
  WORKFLOW_SCRIPT_MAX_BYTES,
  type WorkflowMeta,
  WorkflowParseError,
  type WorkflowPhaseDescriptor,
} from "@/engine/background/workflows/runtime/parser/types.ts";

const META_EXPORT_NAME = "meta";
const LEADING_SEMICOLON_NEWLINE = /^[;\s]*\n/;

export function parseWorkflowScript(script: string): ParsedWorkflowScript {
  assertScriptSize(script);
  const program = parseProgram(script);
  const metaExport = findFirstMetaExport(program.body);
  assertNoTrailingExports(program.body, metaExport.end);
  const literal = readWorkflowLiteral(readMetaExpression(metaExport));
  const meta = normalizeWorkflowMeta(literal);
  return { meta, body: readWorkflowBody(script, metaExport.end) };
}

function readWorkflowBody(script: string, metaEnd: number): string {
  return script.slice(metaEnd).replace(LEADING_SEMICOLON_NEWLINE, "").trimStart();
}

// Meta-first rule: only the meta export may live at the top level. A later
// export would otherwise compile as plain code once the meta declaration is
// consumed, silently changing what the script exports.
function assertNoTrailingExports(body: Program["body"], metaEnd: number): void {
  for (const node of body) {
    if (node.start < metaEnd) continue;
    if (
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportDefaultDeclaration" ||
      node.type === "ExportAllDeclaration"
    ) {
      throw new WorkflowParseError(
        "Workflow scripts may not export anything besides meta (meta-first rule).",
      );
    }
  }
}

function assertScriptSize(script: string): void {
  if (script.length > WORKFLOW_SCRIPT_MAX_BYTES) {
    throw new WorkflowParseError(`Workflow script exceeds ${WORKFLOW_SCRIPT_MAX_BYTES} bytes.`);
  }
}

function parseProgram(script: string): Program {
  try {
    return parse(script, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowHashBang: true,
    });
  } catch (error) {
    throw new WorkflowParseError(formatSyntaxError(error));
  }
}

function findFirstMetaExport(body: Program["body"]): ExportNamedDeclaration {
  const first = body[0];
  if (!first || first.type !== "ExportNamedDeclaration" || !isMetaExport(first)) {
    throw new WorkflowParseError(
      "Workflow script must start with export const meta = {...} (meta-first rule).",
    );
  }
  return first;
}

function isMetaExport(node: ExportNamedDeclaration): boolean {
  const declaration = node.declaration;
  if (!declaration || declaration.type !== "VariableDeclaration" || declaration.kind !== "const") {
    return false;
  }
  if (node.specifiers.length > 0 || node.source) return false;
  return declaration.declarations.length === 1 && isMetaDeclaration(declaration.declarations[0]);
}

function isMetaDeclaration(declaration: VariableDeclarator | undefined): boolean {
  if (!declaration || declaration.id.type !== "Identifier") return false;
  return declaration.id.name === META_EXPORT_NAME && declaration.init?.type === "ObjectExpression";
}

function readMetaExpression(node: ExportNamedDeclaration): ObjectExpression {
  const declaration = node.declaration;
  if (!declaration || declaration.type !== "VariableDeclaration") {
    throw new WorkflowParseError("Workflow meta declaration is invalid.");
  }
  const declarator = declaration.declarations[0];
  if (!declarator?.init || declarator.init.type !== "ObjectExpression") {
    throw new WorkflowParseError("Workflow meta must be an object literal.");
  }
  return declarator.init;
}

function normalizeWorkflowMeta(literal: WorkflowLiteral): WorkflowMeta {
  const record = requireObject(literal, "Workflow meta must be an object literal.");
  const name = requireString(record.name, "Workflow meta name must be a non-empty string.");
  const description = requireString(
    record.description,
    "Workflow meta description must be a non-empty string.",
  );
  const phases = collectPhases(record.phases);
  const optional = readOptionalMetaFields(record);
  return { name, description, ...(phases !== undefined && { phases }), ...optional };
}

function readOptionalMetaFields(
  record: WorkflowLiteralObject,
): Pick<WorkflowMeta, "title" | "whenToUse"> {
  const output: Pick<WorkflowMeta, "title" | "whenToUse"> = {};
  if (record.title !== undefined) {
    output.title = requireString(record.title, "Workflow meta title must be a string.");
  }
  if (record.whenToUse !== undefined) {
    output.whenToUse = requireString(record.whenToUse, "Workflow meta whenToUse must be a string.");
  }
  return output;
}

function collectPhases(value: WorkflowLiteral | undefined): WorkflowPhaseDescriptor[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: WorkflowPhaseDescriptor[] = [];
  for (let i = 0; i < value.length; i++) {
    const phase = value[i];
    if (phase === null || typeof phase !== "object" || Array.isArray(phase)) continue;
    const rec = phase as WorkflowLiteralObject;
    if (typeof rec.title !== "string") continue;
    const entry: WorkflowPhaseDescriptor = { index: i, title: rec.title };
    if (typeof rec.detail === "string") entry.detail = rec.detail;
    if (typeof rec.model === "string") entry.model = rec.model;
    out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

function requireObject(value: WorkflowLiteral, message: string): WorkflowLiteralObject {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value;
  throw new WorkflowParseError(message);
}

function requireString(value: WorkflowLiteral | undefined, message: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new WorkflowParseError(message);
}

function formatSyntaxError(error: unknown): string {
  if (error instanceof SyntaxError) return `Workflow script syntax error: ${error.message}`;
  if (error instanceof Error) return `Workflow script parse error: ${error.message}`;
  return "Workflow script parse error.";
}
