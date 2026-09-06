import { createWorkflowAgentExecution } from "./agent-execution.ts";
import type { WorkflowSubagentBridge, WorkflowSubagentBridgeOptions } from "./bridge-contract.ts";
import { createWorkflowCacheReplay } from "./cache-replay.ts";
import { createWorkflowCombinators } from "./combinators.ts";

export { setWorkflowForkRunnerForTests } from "./agent-execution.ts";
export {
  resolveEffectiveTier,
  resolveWorkflowAgentModelContext,
  resolveWorkflowAgentModelContextDetailed,
} from "./agent-routing.ts";
export {
  WORKFLOW_MAX_AGENTS,
  WORKFLOW_MAX_PARALLEL_ITEMS,
  type WorkflowAgentEvent,
  type WorkflowAgentModelContextDetail,
  type WorkflowSubagentBridge,
  type WorkflowSubagentBridgeOptions,
} from "./bridge-contract.ts";

export async function createWorkflowSubagentBridge(
  options: WorkflowSubagentBridgeOptions,
): Promise<WorkflowSubagentBridge> {
  const cacheReplay = createWorkflowCacheReplay();
  const execution = createWorkflowAgentExecution(options, cacheReplay);
  const combinators = createWorkflowCombinators(options, cacheReplay);
  return {
    agent: execution.runAgent,
    parallel: combinators.runParallel,
    pipeline: combinators.runPipeline,
    agentCount: execution.agentCount,
  };
}
