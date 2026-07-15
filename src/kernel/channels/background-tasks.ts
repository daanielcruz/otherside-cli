export type BackgroundTaskStatus = "running" | "completed" | "error" | "killed";

export interface BackgroundTaskSnapshot {
  id: string;
  subject?: string;
  status: BackgroundTaskStatus;
  owner?: string | null;
  blockedBy?: readonly string[];
  isBackgrounded?: boolean;
  parentToolCallId?: string;
  agentName?: string;
  description?: string;
  actions?: readonly unknown[];
  inputTokens?: number;
  outputTokens?: number;
  endedAt?: number;
  startedAt?: number;
}

export interface BackgroundTaskProvider {
  list(): BackgroundTaskSnapshot[];
  subscribe(fn: () => void): () => void;
  subscribeCompletion(fn: (task: BackgroundTaskSnapshot) => void): () => void;
}

let provider: BackgroundTaskProvider | null = null;

export function registerBackgroundTaskProvider(impl: BackgroundTaskProvider): void {
  provider = impl;
}

function requireBackgroundTaskProvider(): BackgroundTaskProvider {
  if (provider === null) {
    throw new Error("Background task provider is not registered");
  }
  return provider;
}

export function listBackgroundTasks(): BackgroundTaskSnapshot[] {
  return requireBackgroundTaskProvider().list();
}

export function subscribeBackgroundTasks(fn: () => void): () => void {
  return requireBackgroundTaskProvider().subscribe(fn);
}

export function subscribeBackgroundTaskCompletion(
  fn: (task: BackgroundTaskSnapshot) => void,
): () => void {
  return requireBackgroundTaskProvider().subscribeCompletion(fn);
}

export function _resetBackgroundTaskProviderForTests(): void {
  provider = null;
}
