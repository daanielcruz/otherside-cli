import type { MemberExpression, NewExpression } from "acorn";
import { parse } from "acorn";
import * as walk from "acorn-walk";

export function usesNonDeterministicApi(scriptBody: string): boolean {
  let found = false;
  try {
    const ast = parse(scriptBody, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowHashBang: true,
    });
    walk.simple(ast, {
      MemberExpression(node) {
        if (isForbiddenMember(node)) found = true;
      },
      NewExpression(node) {
        if (isArglessDate(node)) found = true;
      },
    });
  } catch {
    return false;
  }
  return found;
}

function isForbiddenMember(node: MemberExpression): boolean {
  if (node.computed || node.object.type !== "Identifier" || node.property.type !== "Identifier") {
    return false;
  }
  return (
    (node.object.name === "Date" && node.property.name === "now") ||
    (node.object.name === "Math" && node.property.name === "random")
  );
}

function isArglessDate(node: NewExpression): boolean {
  return (
    node.callee.type === "Identifier" && node.callee.name === "Date" && node.arguments.length === 0
  );
}
