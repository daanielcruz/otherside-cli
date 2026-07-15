import { Script } from "node:vm";
import type {
  AnyNode,
  ArrowFunctionExpression,
  FunctionDeclaration,
  FunctionExpression,
  Node,
  ReturnStatement,
  VariableDeclaration,
  YieldExpression,
} from "acorn";
import { parse } from "acorn";
import * as walk from "acorn-walk";
import {
  buildVmSafeError,
  WORKFLOW_SCRIPT_FILENAME,
} from "@/engine/background/workflows/runtime/sandbox/errors.ts";

const WORKFLOW_RESERVED_PREFIX = "__wRg$";

export type WorkflowScriptCompileResult =
  | { ok: true; vmScript: Script }
  | { ok: false; error: string };

export function compileWorkflowScript(scriptBody: string): WorkflowScriptCompileResult {
  try {
    Function(`async function _check() {"use strict";\n${scriptBody}\n}`);
    const instrumented = instrumentWorkflowAwaits(scriptBody);
    return {
      ok: true,
      vmScript: new Script(wrapWorkflowScript(instrumented), {
        filename: WORKFLOW_SCRIPT_FILENAME,
      }),
    };
  } catch (error) {
    return { ok: false, error: `SyntaxError: ${formatCompileError(error)}` };
  }
}

function instrumentWorkflowAwaits(scriptBody: string): string {
  const wrapped = `(async () => {"use strict";\n${scriptBody}\n})()`;
  const ast = parse(wrapped, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowHashBang: true,
  });
  rejectUnsupportedNodes(ast);
  const edits = collectAwaitEdits(ast);
  if (edits.length === 0) return scriptBody;
  edits.sort((left, right) => right[0] - left[0]);
  let output = wrapped;
  for (const [position, text] of edits) {
    output = output.slice(0, position) + text + output.slice(position);
  }
  return output.slice(28, output.length - 5);
}

function rejectUnsupportedNodes(ast: Node): void {
  walk.full(ast, (node) => {
    if (hasReservedIdentifier(node)) {
      throw new SyntaxError(`Identifier '${node.name}' is reserved.`);
    }
    if (node.type === "WithStatement") {
      throw new SyntaxError("'with' statements are not supported in workflow scripts.");
    }
  });
}

function hasReservedIdentifier(node: AnyNode): node is AnyNode & { name: string } {
  return (
    "name" in node &&
    typeof node.name === "string" &&
    node.name.startsWith(WORKFLOW_RESERVED_PREFIX)
  );
}

function collectAwaitEdits(ast: Node): Array<[number, string]> {
  const edits: Array<[number, string]> = [];
  const wrap = (node: Node | null | undefined): void => {
    if (!node) return;
    edits.push([node.start, ` ${WORKFLOW_RESERVED_PREFIX}((`], [node.end, "))"]);
  };
  walk.ancestor(ast, {
    AwaitExpression(node) {
      wrap(node.argument);
    },
    ArrowFunctionExpression(node) {
      wrapAsyncArrowExpression(node, wrap);
    },
    ForOfStatement(node) {
      if (node.await) {
        edits.push([node.right.start, ` ${WORKFLOW_RESERVED_PREFIX}a((`], [node.right.end, "))"]);
      }
    },
    ReturnStatement(node, _state, ancestors) {
      wrapAsyncReturn(node, ancestors, wrap, edits);
    },
    VariableDeclaration(node) {
      rejectAwaitUsing(node);
    },
    YieldExpression(node, _state, ancestors) {
      wrapAsyncYield(node, ancestors, wrap, edits);
    },
  });
  return edits;
}

function wrapAsyncArrowExpression(
  node: ArrowFunctionExpression,
  wrap: (node: Node | null | undefined) => void,
): void {
  if (node.async && node.expression) wrap(node.body);
}

function wrapAsyncReturn(
  node: ReturnStatement,
  ancestors: Node[],
  wrap: (node: Node | null | undefined) => void,
  edits: Array<[number, string]>,
): void {
  const fn = enclosingFunction(ancestors);
  if (!fn?.async) return;
  if (!fn.generator) {
    wrap(node.argument);
    return;
  }
  if (node.argument) {
    edits.push(
      [node.argument.start, ` await ${WORKFLOW_RESERVED_PREFIX}((`],
      [node.argument.end, "))"],
    );
  }
}

function wrapAsyncYield(
  node: YieldExpression,
  ancestors: Node[],
  wrap: (node: Node | null | undefined) => void,
  edits: Array<[number, string]>,
): void {
  const fn = enclosingFunction(ancestors);
  if (!(fn?.async && fn.generator)) return;
  if (!node.delegate) {
    wrap(node.argument);
    return;
  }
  if (node.argument) {
    edits.push([node.argument.start, ` ${WORKFLOW_RESERVED_PREFIX}a((`], [node.argument.end, "))"]);
  }
}

function rejectAwaitUsing(node: VariableDeclaration): void {
  if (node.kind === "await using") {
    throw new SyntaxError("'await using' declarations are not supported in workflow scripts.");
  }
}

function enclosingFunction(
  ancestors: Node[],
): FunctionDeclaration | FunctionExpression | ArrowFunctionExpression | undefined {
  for (let index = ancestors.length - 2; index >= 0; index--) {
    const node = ancestors[index];
    if (isFunctionNode(node)) return node;
  }
  return undefined;
}

function isFunctionNode(
  node: Node | undefined,
): node is FunctionDeclaration | FunctionExpression | ArrowFunctionExpression {
  return (
    node?.type === "FunctionDeclaration" ||
    node?.type === "FunctionExpression" ||
    node?.type === "ArrowFunctionExpression"
  );
}

function wrapWorkflowScript(scriptBody: string): string {
  const prefix = WORKFLOW_RESERVED_PREFIX;
  return `((${prefix} => ((${prefix}a) => async () => {"use strict";\n${scriptBody}\n})(${prefix}it => ({[Symbol.asyncIterator](){const ${prefix}ai=${prefix}it[Symbol.asyncIterator];if(${prefix}ai!=null&&typeof ${prefix}ai!=="function")throw new TypeError("@@asyncIterator is not a function");const ${prefix}i=${prefix}ai!=null?${prefix}ai.call(${prefix}it):${prefix}it[Symbol.iterator]();if(${prefix}i===null||(typeof ${prefix}i!=="object"&&typeof ${prefix}i!=="function"))throw new TypeError("Iterator is not an object");const ${prefix}nxt=${prefix}i.next;if(typeof ${prefix}nxt!=="function")throw new TypeError("Iterator.next is not a function");const ${prefix}ret=${prefix}i.return;const ${prefix}thr=${prefix}i.throw;const ${prefix}w=s=>${prefix}(s).then(s=>{if(s===null||(typeof s!=="object"&&typeof s!=="function"))throw new TypeError("Iterator result is not an object");const done=s.done;return ${prefix}(s.value).then(value=>({value,done}))});return{next:v=>${prefix}w(${prefix}nxt.call(${prefix}i,v)),return:v=>${prefix}w(typeof ${prefix}ret==="function"?${prefix}ret.call(${prefix}i,v):{value:v,done:true}),throw:e=>typeof ${prefix}thr==="function"?${prefix}w(${prefix}thr.call(${prefix}i,e)):${prefix}(typeof ${prefix}ret==="function"?${prefix}ret.call(${prefix}i):undefined).then(()=>{throw new TypeError("The iterator does not provide a throw method")})}}})))(Promise.resolve.bind(Promise)))()`;
}

function formatCompileError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(buildVmSafeError(error).message);
}
