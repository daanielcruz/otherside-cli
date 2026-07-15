export type AutoClearScheduler = (callback: () => void, ms: number) => () => void;

export interface AutoClearOptions {
  readonly holdMs: number;
  readonly scheduler?: AutoClearScheduler;
}

export interface AutoClearArmOptions<K> {
  readonly key?: K;
  readonly onTimeout?: () => void;
}

export interface AutoClearDispatch<K = string> {
  arm(options?: AutoClearArmOptions<K>): void;
  clear(): void;
  isArmed(key?: K): boolean;
  readonly pendingKey: K | null;
}

const defaultScheduler: AutoClearScheduler = (callback, ms) => {
  const handle = setTimeout(callback, ms);
  return () => {
    clearTimeout(handle);
  };
};

export function createAutoClearDispatch<K = string>(
  options: AutoClearOptions,
): AutoClearDispatch<K> {
  const { holdMs } = options;
  const scheduler = options.scheduler ?? defaultScheduler;
  let cancel: (() => void) | null = null;
  let pendingKey: K | null = null;
  let armedAt = 0;

  const clear = (): void => {
    if (cancel !== null) {
      cancel();
      cancel = null;
    }
    pendingKey = null;
    armedAt = 0;
  };

  const arm = (armOptions?: AutoClearArmOptions<K>): void => {
    clear();
    const key = armOptions?.key ?? null;
    const onTimeout = armOptions?.onTimeout;
    pendingKey = key;
    armedAt = Date.now();
    cancel = scheduler(() => {
      cancel = null;
      pendingKey = null;
      armedAt = 0;
      onTimeout?.();
    }, holdMs);
  };

  const isArmed = (key?: K): boolean => {
    if (cancel === null) return false;
    if (Date.now() - armedAt > holdMs) return false;
    if (key === undefined) return true;
    return pendingKey === key;
  };

  return {
    arm,
    clear,
    isArmed,
    get pendingKey(): K | null {
      return pendingKey;
    },
  };
}
