import { loadConfigSync, updateConfig } from "@/kernel/config/config.ts";
import { dispatch } from "@/store/app-store/index.ts";

/**
 * Whether the task list stays open once every task is done. The choice outlives the
 * session that made it, so this owns both the live state and the record of it.
 */
export function readTaskListExpanded(): boolean {
  return loadConfigSync().global?.taskListExpanded === true;
}

export function restoreTaskListExpansion(): void {
  dispatch({ type: "view/setTasksExpanded", value: readTaskListExpanded() });
}

export function setTaskListExpanded(expanded: boolean): void {
  dispatch({ type: "view/setTasksExpanded", value: expanded });
  void updateConfig((config) => {
    config.global = { ...config.global, taskListExpanded: expanded };
  }).catch(() => {});
}
