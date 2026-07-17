import type { PluginInstallation } from "./installations.ts";
import type { LoadedPlugin, PluginLoadError } from "./loader.ts";

export type PluginStateError = Readonly<PluginLoadError>;

export interface PluginStateWarning {
  readonly path: string;
  readonly warning: string;
}

export interface LoadedPluginState {
  readonly enabled: readonly LoadedPlugin[];
  readonly disabled: readonly LoadedPlugin[];
  readonly errors: readonly PluginStateError[];
  readonly warnings: readonly PluginStateWarning[];
}

export interface PluginDesiredState {
  readonly enabled: readonly string[];
  readonly disabled: readonly string[];
}

export interface PluginDiskState {
  readonly installations: readonly PluginInstallation[];
}

export type InstallationStatus = "pending" | "installing" | "installed" | "failed";

export interface MarketplaceInstallationTarget {
  readonly type: "marketplace";
  readonly name: string;
}

export interface PluginInstallationTarget {
  readonly type: "plugin";
  readonly id: string;
  readonly name: string;
}

export type InstallationTarget = MarketplaceInstallationTarget | PluginInstallationTarget;

export interface MarketplaceInstallationStatus {
  readonly name: string;
  readonly status: InstallationStatus;
  readonly error?: string;
}

export interface PluginInstallationStatus {
  readonly id: string;
  readonly name: string;
  readonly status: InstallationStatus;
  readonly error?: string;
}

export interface PluginInstallationState {
  readonly marketplaces: readonly MarketplaceInstallationStatus[];
  readonly plugins: readonly PluginInstallationStatus[];
}

export type InstallationUpdate = InstallationTarget & {
  readonly status: InstallationStatus;
  readonly error?: string;
};

export type InstallationResult = InstallationTarget & {
  readonly status: "installed" | "failed";
  readonly error?: string;
};

export interface PluginStateSnapshot extends LoadedPluginState {
  readonly desired: PluginDesiredState;
  readonly disk: PluginDiskState;
  readonly installationStatus: PluginInstallationState;
  readonly needsRefresh: boolean;
}

export interface PluginStateSeed {
  readonly enabled?: readonly LoadedPlugin[];
  readonly disabled?: readonly LoadedPlugin[];
  readonly errors?: readonly PluginStateError[];
  readonly warnings?: readonly PluginStateWarning[];
  readonly desired?: PluginDesiredState;
  readonly disk?: PluginDiskState;
  readonly installationStatus?: PluginInstallationState;
  readonly needsRefresh?: boolean;
}

type Listener = () => void;

type StateParts = {
  enabled: readonly LoadedPlugin[];
  disabled: readonly LoadedPlugin[];
  errors: readonly PluginStateError[];
  warnings: readonly PluginStateWarning[];
  desired: PluginDesiredState;
  disk: PluginDiskState;
  installationStatus: PluginInstallationState;
  needsRefresh: boolean;
};

export interface PluginStateStore {
  getSnapshot(): PluginStateSnapshot;
  subscribe(listener: Listener): () => void;
  replaceSnapshot(next: PluginStateSnapshot): void;
  replaceLoadedState(next: LoadedPluginState): void;
  replaceDesiredState(next: PluginDesiredState): void;
  replaceDiskState(next: PluginDiskState): void;
  markNeedsRefresh(needsRefresh?: boolean): void;
  beginInstallation(target: InstallationTarget): void;
  updateInstallation(update: InstallationUpdate): void;
  finishInstallation(result: InstallationResult): void;
  replaceErrors(errors: readonly PluginStateError[]): void;
  replaceWarnings(warnings: readonly PluginStateWarning[]): void;
  recordError(error: PluginStateError): void;
  recordWarning(warning: PluginStateWarning): void;
  recoverError(error: PluginStateError): void;
  recoverWarning(warning: PluginStateWarning): void;
  clearErrors(): void;
  clearWarnings(): void;
}

const EMPTY_LOADED_STATE: LoadedPluginState = {
  enabled: [],
  disabled: [],
  errors: [],
  warnings: [],
};

const EMPTY_DESIRED_STATE: PluginDesiredState = {
  enabled: [],
  disabled: [],
};

const EMPTY_DISK_STATE: PluginDiskState = {
  installations: [],
};

const EMPTY_INSTALLATION_STATE: PluginInstallationState = {
  marketplaces: [],
  plugins: [],
};

function copyArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function copyErrors(errors: readonly PluginStateError[]): readonly PluginStateError[] {
  return Object.freeze(errors.map((error) => Object.freeze({ ...error })));
}

function copyWarnings(warnings: readonly PluginStateWarning[]): readonly PluginStateWarning[] {
  return Object.freeze(warnings.map((warning) => Object.freeze({ ...warning })));
}

function copyDesiredState(state: PluginDesiredState): PluginDesiredState {
  return Object.freeze({
    enabled: Object.freeze([...state.enabled]),
    disabled: Object.freeze([...state.disabled]),
  });
}

function copyDiskState(state: PluginDiskState): PluginDiskState {
  return Object.freeze({
    installations: Object.freeze(
      state.installations.map((installation) => Object.freeze({ ...installation })),
    ),
  });
}

function copyInstallationState(state: PluginInstallationState): PluginInstallationState {
  return Object.freeze({
    marketplaces: Object.freeze(state.marketplaces.map((entry) => Object.freeze({ ...entry }))),
    plugins: Object.freeze(state.plugins.map((entry) => Object.freeze({ ...entry }))),
  });
}

function makeSnapshot(parts: StateParts): PluginStateSnapshot {
  return Object.freeze({
    enabled: copyArray(parts.enabled),
    disabled: copyArray(parts.disabled),
    errors: copyErrors(parts.errors),
    warnings: copyWarnings(parts.warnings),
    desired: copyDesiredState(parts.desired),
    disk: copyDiskState(parts.disk),
    installationStatus: copyInstallationState(parts.installationStatus),
    needsRefresh: parts.needsRefresh,
  });
}

function initialParts(seed: PluginStateSeed | undefined): StateParts {
  return {
    enabled: seed?.enabled ?? EMPTY_LOADED_STATE.enabled,
    disabled: seed?.disabled ?? EMPTY_LOADED_STATE.disabled,
    errors: seed?.errors ?? EMPTY_LOADED_STATE.errors,
    warnings: seed?.warnings ?? EMPTY_LOADED_STATE.warnings,
    desired: seed?.desired ?? EMPTY_DESIRED_STATE,
    disk: seed?.disk ?? EMPTY_DISK_STATE,
    installationStatus: seed?.installationStatus ?? EMPTY_INSTALLATION_STATE,
    needsRefresh: seed?.needsRefresh ?? false,
  };
}

function sameArray<T>(left: readonly T[], right: readonly T[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  );
}

function sameErrors(
  left: readonly PluginStateError[],
  right: readonly PluginStateError[],
): boolean {
  return (
    left.length === right.length &&
    left.every((error, index) => {
      const other = right[index];
      return (
        error.pluginId === other?.pluginId &&
        error.path === other?.path &&
        error.stage === other?.stage &&
        error.code === other?.code &&
        error.message === other?.message &&
        error.recoveryHint === other?.recoveryHint
      );
    })
  );
}

function sameWarnings(
  left: readonly PluginStateWarning[],
  right: readonly PluginStateWarning[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (warning, index) =>
        warning.path === right[index]?.path && warning.warning === right[index]?.warning,
    )
  );
}

function sameDesiredState(left: PluginDesiredState, right: PluginDesiredState): boolean {
  return sameArray(left.enabled, right.enabled) && sameArray(left.disabled, right.disabled);
}

function sameInstallation(left: PluginInstallation, right: PluginInstallation): boolean {
  const leftFields = left as unknown as Record<string, unknown>;
  const rightFields = right as unknown as Record<string, unknown>;
  const leftKeys = Object.keys(leftFields).sort();
  const rightKeys = Object.keys(rightFields).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && Object.is(leftFields[key], rightFields[key]),
    )
  );
}

function sameDiskState(left: PluginDiskState, right: PluginDiskState): boolean {
  return (
    left.installations.length === right.installations.length &&
    left.installations.every((installation, index) => {
      const other = right.installations[index];
      return other !== undefined && sameInstallation(installation, other);
    })
  );
}

function errorKey(error: PluginStateError): string {
  return [error.pluginId ?? "", error.path, error.stage, error.code, error.message].join("\u0000");
}

function warningKey(warning: PluginStateWarning): string {
  return `${warning.path}\u0000${warning.warning}`;
}

function validateTarget(target: InstallationTarget): void {
  if (target.type === "marketplace") {
    if (target.name.length === 0) throw new TypeError("Marketplace installation name is required");
    return;
  }
  if (target.id.length === 0 || target.name.length === 0) {
    throw new TypeError("Plugin installation id and name are required");
  }
}

function statusEntry(
  target: InstallationTarget,
  status: InstallationStatus,
  error: string | undefined,
): MarketplaceInstallationStatus | PluginInstallationStatus {
  if (target.type === "marketplace") {
    return error === undefined
      ? { name: target.name, status }
      : { name: target.name, status, error };
  }
  return error === undefined
    ? { id: target.id, name: target.name, status }
    : { id: target.id, name: target.name, status, error };
}

function installationStatusForTarget(
  state: PluginInstallationState,
  target: InstallationTarget,
): InstallationStatus | undefined {
  if (target.type === "marketplace") {
    return state.marketplaces.find((entry) => entry.name === target.name)?.status;
  }
  return state.plugins.find((entry) => entry.id === target.id)?.status;
}

export function createPluginStateStore(seed?: PluginStateSeed): PluginStateStore {
  let snapshot = makeSnapshot(initialParts(seed));
  const listeners = new Set<Listener>();

  function notify(next: PluginStateSnapshot): void {
    snapshot = next;
    for (const listener of listeners) listener();
  }

  function update(nextParts: StateParts): void {
    const next = makeSnapshot(nextParts);
    if (Object.is(next, snapshot)) return;
    notify(next);
  }

  function replaceSnapshot(next: PluginStateSnapshot): void {
    update({
      enabled: next.enabled,
      disabled: next.disabled,
      errors: next.errors,
      warnings: next.warnings,
      desired: next.desired,
      disk: next.disk,
      installationStatus: next.installationStatus,
      needsRefresh: next.needsRefresh,
    });
  }

  function replaceLoadedState(next: LoadedPluginState): void {
    const unchanged =
      sameArray(snapshot.enabled, next.enabled) &&
      sameArray(snapshot.disabled, next.disabled) &&
      sameErrors(snapshot.errors, next.errors) &&
      sameWarnings(snapshot.warnings, next.warnings) &&
      snapshot.needsRefresh === false;
    if (unchanged) return;
    update({
      ...snapshot,
      enabled: next.enabled,
      disabled: next.disabled,
      errors: next.errors,
      warnings: next.warnings,
      needsRefresh: false,
    });
  }

  function replaceDesiredState(next: PluginDesiredState): void {
    if (sameDesiredState(snapshot.desired, next)) return;
    update({ ...snapshot, desired: next, needsRefresh: true });
  }

  function replaceDiskState(next: PluginDiskState): void {
    if (sameDiskState(snapshot.disk, next)) return;
    update({ ...snapshot, disk: next, needsRefresh: true });
  }

  function markNeedsRefresh(needsRefresh = true): void {
    if (snapshot.needsRefresh === needsRefresh) return;
    update({ ...snapshot, needsRefresh });
  }

  function beginInstallation(target: InstallationTarget): void {
    validateTarget(target);
    const installationStatus = { ...snapshot.installationStatus };
    if (target.type === "marketplace") {
      const nextEntry = statusEntry(target, "pending", undefined) as MarketplaceInstallationStatus;
      const index = installationStatus.marketplaces.findIndex(
        (entry) => entry.name === target.name,
      );
      const marketplaces = [...installationStatus.marketplaces];
      if (index < 0) marketplaces.push(nextEntry);
      else marketplaces[index] = nextEntry;
      update({ ...snapshot, installationStatus: { ...installationStatus, marketplaces } });
      return;
    }
    const nextEntry = statusEntry(target, "pending", undefined) as PluginInstallationStatus;
    const index = installationStatus.plugins.findIndex((entry) => entry.id === target.id);
    const plugins = [...installationStatus.plugins];
    if (index < 0) plugins.push(nextEntry);
    else plugins[index] = nextEntry;
    update({ ...snapshot, installationStatus: { ...installationStatus, plugins } });
  }

  function updateInstallation(progress: InstallationUpdate): void {
    validateTarget(progress);
    const currentStatus = installationStatusForTarget(snapshot.installationStatus, progress);
    if (currentStatus === undefined) return;
    if (currentStatus === progress.status) {
      const current =
        progress.type === "marketplace"
          ? snapshot.installationStatus.marketplaces.find((entry) => entry.name === progress.name)
          : snapshot.installationStatus.plugins.find((entry) => entry.id === progress.id);
      if (current?.error === progress.error) return;
    }
    const installationStatus = { ...snapshot.installationStatus };
    if (progress.type === "marketplace") {
      const marketplaces = installationStatus.marketplaces.map((entry) =>
        entry.name === progress.name
          ? (statusEntry(
              progress,
              progress.status,
              progress.error,
            ) as MarketplaceInstallationStatus)
          : entry,
      );
      update({ ...snapshot, installationStatus: { ...installationStatus, marketplaces } });
      return;
    }
    const plugins = installationStatus.plugins.map((entry) =>
      entry.id === progress.id
        ? (statusEntry(progress, progress.status, progress.error) as PluginInstallationStatus)
        : entry,
    );
    update({ ...snapshot, installationStatus: { ...installationStatus, plugins } });
  }

  function finishInstallation(result: InstallationResult): void {
    validateTarget(result);
    const currentStatus = installationStatusForTarget(snapshot.installationStatus, result);
    if (currentStatus === undefined) return;
    updateInstallation(result);
    if (result.status === "installed") markNeedsRefresh();
  }

  function replaceErrors(errors: readonly PluginStateError[]): void {
    if (sameErrors(snapshot.errors, errors)) return;
    update({ ...snapshot, errors });
  }

  function replaceWarnings(warnings: readonly PluginStateWarning[]): void {
    if (sameWarnings(snapshot.warnings, warnings)) return;
    update({ ...snapshot, warnings });
  }

  function recordError(error: PluginStateError): void {
    const key = errorKey(error);
    if (snapshot.errors.some((current) => errorKey(current) === key)) return;
    replaceErrors([...snapshot.errors, error]);
  }

  function recordWarning(warning: PluginStateWarning): void {
    const key = warningKey(warning);
    if (snapshot.warnings.some((current) => warningKey(current) === key)) return;
    replaceWarnings([...snapshot.warnings, warning]);
  }

  function recoverError(error: PluginStateError): void {
    const key = errorKey(error);
    const errors = snapshot.errors.filter((current) => errorKey(current) !== key);
    replaceErrors(errors);
  }

  function recoverWarning(warning: PluginStateWarning): void {
    const key = warningKey(warning);
    const warnings = snapshot.warnings.filter((current) => warningKey(current) !== key);
    replaceWarnings(warnings);
  }

  function clearErrors(): void {
    replaceErrors([]);
  }

  function clearWarnings(): void {
    replaceWarnings([]);
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    replaceSnapshot,
    replaceLoadedState,
    replaceDesiredState,
    replaceDiskState,
    markNeedsRefresh,
    beginInstallation,
    updateInstallation,
    finishInstallation,
    replaceErrors,
    replaceWarnings,
    recordError,
    recordWarning,
    recoverError,
    recoverWarning,
    clearErrors,
    clearWarnings,
  };
}

export const pluginStateStore = createPluginStateStore();

export function getSnapshot(): PluginStateSnapshot {
  return pluginStateStore.getSnapshot();
}

export function subscribe(listener: Listener): () => void {
  return pluginStateStore.subscribe(listener);
}

export function replaceSnapshot(next: PluginStateSnapshot): void {
  pluginStateStore.replaceSnapshot(next);
}

export function replaceLoadedState(next: LoadedPluginState): void {
  pluginStateStore.replaceLoadedState(next);
}

export function replaceDesiredState(next: PluginDesiredState): void {
  pluginStateStore.replaceDesiredState(next);
}

export function replaceDiskState(next: PluginDiskState): void {
  pluginStateStore.replaceDiskState(next);
}

export function markNeedsRefresh(needsRefresh = true): void {
  pluginStateStore.markNeedsRefresh(needsRefresh);
}

export function beginInstallation(target: InstallationTarget): void {
  pluginStateStore.beginInstallation(target);
}

export function updateInstallation(update: InstallationUpdate): void {
  pluginStateStore.updateInstallation(update);
}

export function finishInstallation(result: InstallationResult): void {
  pluginStateStore.finishInstallation(result);
}

export function replaceErrors(errors: readonly PluginStateError[]): void {
  pluginStateStore.replaceErrors(errors);
}

export function replaceWarnings(warnings: readonly PluginStateWarning[]): void {
  pluginStateStore.replaceWarnings(warnings);
}

export function recordError(error: PluginStateError): void {
  pluginStateStore.recordError(error);
}

export function recordWarning(warning: PluginStateWarning): void {
  pluginStateStore.recordWarning(warning);
}

export function recoverError(error: PluginStateError): void {
  pluginStateStore.recoverError(error);
}

export function recoverWarning(warning: PluginStateWarning): void {
  pluginStateStore.recoverWarning(warning);
}

export function clearErrors(): void {
  pluginStateStore.clearErrors();
}

export function clearWarnings(): void {
  pluginStateStore.clearWarnings();
}
