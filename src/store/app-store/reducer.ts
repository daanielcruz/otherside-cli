import { usageReducer } from "@/store/app-store/slices/usage.ts";
import { viewReducer } from "@/store/app-store/slices/view.ts";
import type { AppAction, AppState, EngineSlice } from "@/store/app-store/types.ts";

function engineReducer(prev: EngineSlice, action: AppAction): EngineSlice {
  if (action.type !== "engine/setSlice") return prev;
  return { ...prev, [action.key]: action.value };
}

export function appReducer(prev: AppState, action: AppAction): AppState {
  const nextEngine = engineReducer(prev.engine, action);
  const nextView = viewReducer(prev.view, action);
  const nextUsage = usageReducer(prev.usage, action);
  if (nextEngine === prev.engine && nextView === prev.view && nextUsage === prev.usage) {
    return prev;
  }
  return { ...prev, engine: nextEngine, view: nextView, usage: nextUsage };
}
