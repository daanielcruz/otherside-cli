import { EFFORT_LEVEL_VALUES, type EffortLevel } from "@/kernel/std/types/effort.ts";
import type { OrchestrationMode } from "@/kernel/std/types/orchestration-mode.ts";
import { PERMISSION_MODES, type PermissionMode } from "@/kernel/std/types/permission-mode.ts";
import type { ProviderId, ProviderModelRoute } from "@/kernel/std/types/provider-ids.ts";
import type { BrokerState } from "@/kernel/std/types/request.ts";

export type { BrokerState };

export interface BrokerModelCatalog {
  findModel: (route: ProviderModelRoute) => { provider: ProviderId } | undefined;
  effortLevelsForModel: (route: ProviderModelRoute) => EffortLevel[];
  defaultEffortForModel: (route: ProviderModelRoute) => EffortLevel | null;
  defaultModelForProvider: (provider: ProviderId) => string;
}

export type BrokerEvent =
  | {
      kind: "set_route";
      route: ProviderModelRoute;
      fastMode?: boolean;
    }
  | { kind: "set_effort"; effort: EffortLevel | null }
  | { kind: "set_ultracode"; enabled: boolean; effort?: EffortLevel }
  | { kind: "toggle_fast_mode" }
  | { kind: "set_fast_mode"; enabled: boolean }
  | { kind: "set_permission_mode"; mode: PermissionMode }
  | { kind: "cycle_permission_mode" }
  | { kind: "set_orchestration_mode"; mode: OrchestrationMode };

const PERMISSION_CYCLE = PERMISSION_MODES;
const EFFORT_RANK = EFFORT_LEVEL_VALUES;

function resolveUltracodeEffort(
  state: BrokerState,
  desired: EffortLevel,
  catalog: BrokerModelCatalog,
): EffortLevel | null {
  const route = { provider: state.provider, model: state.model };
  const levels = catalog.effortLevelsForModel(route);
  if (levels.length === 0) return catalog.defaultEffortForModel(route);
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
    case "set_route": {
      const target = catalog.findModel(event.route);
      const route = target
        ? event.route
        : {
            provider: event.route.provider,
            model: catalog.defaultModelForProvider(event.route.provider),
          };
      return {
        ...state,
        ...route,
        effort: catalog.defaultEffortForModel(route),
        fastMode: event.fastMode ?? state.fastMode,
      };
    }
    case "set_effort":
      return { ...state, effort: event.effort, ultracode: false };
    case "set_ultracode": {
      if (!event.enabled) {
        return {
          ...state,
          ultracode: false,
          effort: catalog.defaultEffortForModel({
            provider: state.provider,
            model: state.model,
          }),
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
    case "set_orchestration_mode":
      return state.orchestrationMode === event.mode
        ? state
        : { ...state, orchestrationMode: event.mode };
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

/**
 * Last-constructed broker for the process. String-view panels that cannot take a
 * Broker prop (e.g. `/model` slash-open) dispatch through this so the live turn
 * path (`broker.read()`) and the app-store mirror stay paired. The session
 * broker constructed at boot overwrites any earlier test fixture.
 */
let processBroker: Broker | undefined;

/** Active process broker when one has been constructed; undefined in pure unit tests. */
export function getProcessBroker(): Broker | undefined {
  return processBroker;
}

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
    processBroker = this;
  }

  read(): Readonly<BrokerState> {
    return this.state;
  }

  /**
   * Give up the process registration, when this broker still holds it. A broker
   * outliving the session that built it would answer for a route nobody is on.
   */
  release(): void {
    if (processBroker === this) processBroker = undefined;
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
