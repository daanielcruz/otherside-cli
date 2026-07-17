import type { BackgroundTask } from "./background.ts";

export interface TreeNode {
  task: BackgroundTask;
  visibleParentId: string | undefined;
  depth: number;
  hasLaterSibling: boolean;
  transitiveHiddenCount: number;
}

export function buildPanelTree(
  tasks: BackgroundTask[],
  focusedTaskId: string | undefined,
): {
  orderedVisibleNodes: TreeNode[];
  allNodesMap: Map<string, TreeNode>;
} {
  const liveIds = new Set(tasks.map((t) => t.id));

  // A task with no historical parent is a root. A task whose parent was
  // evicted is only a root when this exact run was explicitly reparented.
  const getVisibleParentId = (t: BackgroundTask): string | undefined | null => {
    if (t.parentTaskId === undefined) return undefined;
    if (liveIds.has(t.parentTaskId)) return t.parentTaskId;
    return t.reparentedGeneration !== undefined && t.reparentedGeneration === t.runGeneration
      ? undefined
      : null;
  };

  // Build parent-children map. Hidden orphan branches are intentionally not
  // inserted: traversing only from roots hides the orphan and all descendants.
  const childrenMap = new Map<string, BackgroundTask[]>();
  const roots: BackgroundTask[] = [];

  for (const t of tasks) {
    const parentId = getVisibleParentId(t);
    if (parentId === null) continue;
    if (parentId === undefined) {
      roots.push(t);
    } else {
      let list = childrenMap.get(parentId);
      if (!list) {
        list = [];
        childrenMap.set(parentId, list);
      }
      list.push(t);
    }
  }

  // Sort roots and children by startedAt
  roots.sort((a, b) => a.startedAt - b.startedAt);
  for (const list of childrenMap.values()) {
    list.sort((a, b) => a.startedAt - b.startedAt);
  }

  // Depth computation map
  const depths = new Map<string, number>();
  const computeDepth = (taskId: string): number => {
    if (depths.has(taskId)) return depths.get(taskId)!;
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return 1;
    const parentId = getVisibleParentId(task);
    if (parentId === undefined || parentId === null) {
      depths.set(taskId, 1);
      return 1;
    }
    const d = computeDepth(parentId) + 1;
    depths.set(taskId, d);
    return d;
  };

  for (const t of tasks) {
    computeDepth(t.id);
  }

  // Focus-scoped visibility: children of the focused row + its siblings + the ancestor chain.
  // Unrelated roots are hidden while a nested agent is focused.
  const visibleIds = new Set<string>();
  const ancestorChainIds = new Set<string>();

  if (focusedTaskId && liveIds.has(focusedTaskId)) {
    // 1. Ancestor chain (including focused)
    let currId: string | undefined = focusedTaskId;
    while (currId !== undefined) {
      visibleIds.add(currId);
      ancestorChainIds.add(currId);
      const currTask = tasks.find((t) => t.id === currId);
      const parentId = currTask ? getVisibleParentId(currTask) : undefined;
      currId = parentId === null ? undefined : parentId;
    }

    // 2. Siblings of the focused task (all roots when focused is a root)
    const focusedTask = tasks.find((t) => t.id === focusedTaskId);
    if (focusedTask) {
      const parentId = getVisibleParentId(focusedTask);
      const siblings =
        parentId === undefined || parentId === null ? roots : childrenMap.get(parentId) || [];
      for (const sib of siblings) {
        visibleIds.add(sib.id);
      }
    }

    // 3. Children of the focused task
    const children = childrenMap.get(focusedTaskId) || [];
    for (const child of children) {
      visibleIds.add(child.id);
    }
  } else {
    for (const r of roots) {
      visibleIds.add(r.id);
    }
  }

  // Count transitive hidden descendants for each task
  const allDescendantsMap = new Map<string, string[]>();
  const getTransitiveDescendants = (taskId: string): string[] => {
    if (allDescendantsMap.has(taskId)) return allDescendantsMap.get(taskId)!;
    const directChildren = childrenMap.get(taskId) || [];
    const desc: string[] = [];
    for (const child of directChildren) {
      desc.push(child.id);
      desc.push(...getTransitiveDescendants(child.id));
    }
    allDescendantsMap.set(taskId, desc);
    return desc;
  };

  const transitiveHiddenCounts = new Map<string, number>();
  for (const t of tasks) {
    const desc = getTransitiveDescendants(t.id);
    const hiddenCount = desc.filter((id) => !visibleIds.has(id)).length;
    transitiveHiddenCounts.set(t.id, hiddenCount);
  }

  // Ancestor-chain rows never show the (+N) hidden-descendant badge.
  for (const id of ancestorChainIds) {
    transitiveHiddenCounts.set(id, 0);
  }

  // Flatten tree in parent-before-child order
  const allNodesMap = new Map<string, TreeNode>();
  const orderedVisibleNodes: TreeNode[] = [];

  const traverse = (task: BackgroundTask, parentChildren: BackgroundTask[], index: number) => {
    const parentId = getVisibleParentId(task);
    if (parentId === null) return;
    const depth = depths.get(task.id) ?? 1;
    const hasLaterSibling = index < parentChildren.length - 1;
    const transitiveHiddenCount = transitiveHiddenCounts.get(task.id) ?? 0;

    const node: TreeNode = {
      task,
      visibleParentId: parentId,
      depth,
      hasLaterSibling,
      transitiveHiddenCount,
    };

    allNodesMap.set(task.id, node);

    if (visibleIds.has(task.id)) {
      orderedVisibleNodes.push(node);
    }

    const children = childrenMap.get(task.id) || [];
    for (let i = 0; i < children.length; i++) {
      traverse(children[i]!, children, i);
    }
  };

  for (let i = 0; i < roots.length; i++) {
    traverse(roots[i]!, roots, i);
  }

  return { orderedVisibleNodes, allNodesMap };
}
