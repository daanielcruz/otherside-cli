import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import { EFFORT_LEVEL_VALUES, type EffortLevel } from "@/kernel/std/types/effort.ts";
import { PERMISSION_MODES, type PermissionMode } from "@/kernel/std/types/permission-mode.ts";
import type { BrokerState } from "@/kernel/std/types/request.ts";

export type { BrokerState };

export interface BrokerModelCatalog {
  findModel: (id: string, provider?: ProviderId) => { provider: ProviderId } | undefined;
  effortLevelsForModel: (id: string, provider?: ProviderId) => EffortLevel[];
  defaultEffortForModel: (id: string, provider?: ProviderId) => EffortLevel | null;
  defaultModelForProvider: (provider: ProviderId) => string;
}

export type BrokerEvent =
  | {
      kind: "set_provider";
      provider: ProviderId;
      model: string;
      fastMode?: boolean;
    }
  | { kind: "set_model"; model: string }
  | { kind: "set_effort"; effort: EffortLevel | null }
  | { kind: "set_ultracode"; enabled: boolean; effort?: EffortLevel }
  | { kind: "toggle_fast_mode" }
  | { kind: "set_fast_mode"; enabled: boolean }
  | { kind: "set_permission_mode"; mode: PermissionMode }
  | { kind: "cycle_permission_mode" };

const PERMISSION_CYCLE = PERMISSION_MODES;
const EFFORT_RANK = EFFORT_LEVEL_VALUES;

function resolveUltracodeEffort(
  state: BrokerState,
  desired: EffortLevel,
  catalog: BrokerModelCatalog,
): EffortLevel | null {
  const levels = catalog.effortLevelsForModel(state.model, state.provider);
  if (levels.length === 0) return catalog.defaultEffortForModel(state.model, state.provider);
  if (levels.includes(desired)) return desired;
  if (desired === "max") return levels[levels.length - 1] ?? desired;
  const desiredRank = EFFORT_RANK.indexOf(desired);
  const below = [...levels]
    .filter((level) => EFFORT_RANK.indexOf(level) <= desiredRank)
    .sort((a, b) => EFFORT_RANK.indexOf(b) - EFFORT_RANK.indexOf(a));
  return below[0] ?? levels[levels.length - 1] ?? desired;
}

export function nextPermissionMode(current: PermissionMode): PermissionMode {
  const cycle = PERMISSION_CYCLE;
  const idx = cycle.indexOf(current);
  if (idx < 0) return cycle[0] ?? "default";
  return cycle[(idx + 1) % cycle.length] ?? "default";
}

export function reduce(
  state: BrokerState,
  event: BrokerEvent,
  catalog: BrokerModelCatalog,
): BrokerState {
  switch (event.kind) {
    case "set_provider": {
      const target = catalog.findModel(event.model, event.provider);
      const model =
        target && target.provider === event.provider
          ? event.model
          : (catalog.defaultModelForProvider(event.provider) ?? event.model);
      return {
        ...state,
        provider: event.provider,
        model,
        effort: catalog.defaultEffortForModel(model, event.provider),
        fastMode: event.fastMode ?? state.fastMode,
      };
    }
    case "set_model": {
      const target = catalog.findModel(event.model);
      if (target && target.provider !== state.provider) {
        return {
          ...state,
          provider: target.provider,
          model: event.model,
          effort: catalog.defaultEffortForModel(event.model, target.provider),
        };
      }
      return {
        ...state,
        model: event.model,
        effort: catalog.defaultEffortForModel(event.model, state.provider),
      };
    }
    case "set_effort":
      return { ...state, effort: event.effort, ultracode: false };
    case "set_ultracode": {
      if (!event.enabled) {
        return {
          ...state,
          ultracode: false,
          effort: catalog.defaultEffortForModel(state.model, state.provider),
        };
      }
      return {
        ...state,
        ultracode: true,
        effort: resolveUltracodeEffort(state, event.effort ?? "high", catalog),
      };
    }
    case "toggle_fast_mode":
      return { ...state, fastMode: !state.fastMode };
    case "set_fast_mode":
      return { ...state, fastMode: event.enabled };
    case "set_permission_mode": {
      if (event.mode === state.permissionMode) return state;
      const next: BrokerState = { ...state, permissionMode: event.mode };
      if (event.mode === "plan") {
        if (state.permissionMode !== "plan" && state.prePlanMode === undefined) {
          next.prePlanMode = state.permissionMode;
        }
      } else {
        delete next.prePlanMode;
      }
      return next;
    }
    case "cycle_permission_mode": {
      const mode = nextPermissionMode(state.permissionMode);
      if (mode === state.permissionMode) return state;
      const next: BrokerState = { ...state, permissionMode: mode };
      if (mode === "plan") {
        if (state.permissionMode !== "plan" && state.prePlanMode === undefined) {
          next.prePlanMode = state.permissionMode;
        }
      } else {
        delete next.prePlanMode;
      }
      return next;
    }
  }
}

type Subscriber<T> = (snapshot: T) => void;
type Selector<T> = (state: BrokerState) => T;

export class Broker {
  private state: BrokerState;
  private readonly catalog: BrokerModelCatalog;
  private readonly stateSubs = new Set<Subscriber<BrokerState>>();
  private readonly selectorSubs: {
    sel: Selector<unknown>;
    last: unknown;
    fn: Subscriber<unknown>;
  }[] = [];

  constructor(initial: BrokerState, catalog: BrokerModelCatalog) {
    this.state = initial;
    this.catalog = catalog;
  }

  read(): Readonly<BrokerState> {
    return this.state;
  }

  dispatch(event: BrokerEvent): void {
    const next = reduce(this.state, event, this.catalog);
    if (next === this.state) return;
    this.state = next;
    for (const fn of this.stateSubs) fn(next);
    for (const sub of this.selectorSubs) {
      const v = sub.sel(next);
      if (v !== sub.last) {
        sub.last = v;
        sub.fn(v);
      }
    }
  }

  subscribe(fn: Subscriber<BrokerState>): () => void {
    this.stateSubs.add(fn);
    return () => {
      this.stateSubs.delete(fn);
    };
  }

  select<T>(selector: Selector<T>, fn: Subscriber<T>): () => void {
    const sub = {
      sel: selector as Selector<unknown>,
      last: selector(this.state) as unknown,
      fn: fn as Subscriber<unknown>,
    };
    this.selectorSubs.push(sub);
    return () => {
      const i = this.selectorSubs.indexOf(sub);
      if (i >= 0) this.selectorSubs.splice(i, 1);
    };
  }
}
