import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import { BUILTINS } from "@/engine/tools/builtins/index.ts";
import * as tools from "@/engine/tools/registry.ts";

export function registerAllBuiltins(): void {
  registerAllProviders();
  tools.assertBuiltinsHaveSchemas(BUILTINS);
  for (const handler of BUILTINS) tools.registerWithNamespace("builtin", handler);
  tools.registerAlias("RunWorkflow", "Workflow");
  tools.registerAlias("AgentOutputTool", "TaskOutput");
  tools.registerAlias("BashOutputTool", "TaskOutput");
  tools.registerAlias("AgentOutput", "TaskOutput");
  tools.registerAlias("BashOutput", "TaskOutput");
  tools.registerAlias("KillShell", "TaskStop");
  tools.registerAlias("KillBash", "TaskStop");
  tools.registerAlias("ReadMcpResourceDir", "ReadMcpResourceDirTool");
}
