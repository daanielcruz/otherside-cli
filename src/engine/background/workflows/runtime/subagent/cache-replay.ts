import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

interface CacheReplayState {
  exhausted: boolean;
  prevKey: string;
  callIndex: number;
}

export interface CacheExecutionScope {
  path: string;
  chain: CacheReplayState;
  operationIndex: number;
}

function mergeCacheBranchKeys(path: string, prevKey: string, branchKeys: string[]): string {
  const digest = createHash("sha256")
    .update("workflow-cache-branches\0")
    .update(path)
    .update("\0")
    .update(prevKey)
    .update("\0")
    .update(JSON.stringify(branchKeys))
    .digest("hex");
  return `branch:${digest}`;
}

export interface WorkflowCacheReplay {
  activeScope: () => CacheExecutionScope;
  runInScope: <Result>(scope: CacheExecutionScope, action: () => Result) => Result;
  runBatch: <Item, Result>(
    kind: "parallel" | "pipeline",
    identity: string,
    items: readonly Item[],
    runItem: (item: Item, index: number) => Promise<Result>,
  ) => Promise<Result[]>;
}

export function createWorkflowCacheReplay(): WorkflowCacheReplay {
  const rootCacheScope: CacheExecutionScope = {
    path: "root",
    chain: { exhausted: false, prevKey: "", callIndex: 0 },
    operationIndex: 0,
  };
  const cacheScopeStorage = new AsyncLocalStorage<CacheExecutionScope>();
  const activeScope = (): CacheExecutionScope => cacheScopeStorage.getStore() ?? rootCacheScope;
  const runInScope = <Result>(scope: CacheExecutionScope, action: () => Result): Result =>
    cacheScopeStorage.run(scope, action);

  const runBatch = async <Item, Result>(
    kind: "parallel" | "pipeline",
    identity: string,
    items: readonly Item[],
    runItem: (item: Item, index: number) => Promise<Result>,
  ): Promise<Result[]> => {
    const parent = activeScope();
    const operationIndex = parent.operationIndex;
    parent.operationIndex += 1;
    const operationPath = `${parent.path}/${kind}:${operationIndex}:${identity}`;
    const parentPrevKey = parent.chain.prevKey;
    const scopes = items.map<CacheExecutionScope>((_, index) => ({
      path: `${operationPath}/item:${index}`,
      chain: {
        exhausted: parent.chain.exhausted,
        prevKey: parentPrevKey,
        callIndex: 0,
      },
      operationIndex: 0,
    }));
    const results = await Promise.all(
      items.map((item, index) => cacheScopeStorage.run(scopes[index]!, () => runItem(item, index))),
    );
    parent.chain.exhausted ||= scopes.some((scope) => scope.chain.exhausted);
    parent.chain.prevKey = mergeCacheBranchKeys(
      operationPath,
      parentPrevKey,
      scopes.map((scope) => scope.chain.prevKey),
    );
    return results;
  };

  return { activeScope, runInScope, runBatch };
}
