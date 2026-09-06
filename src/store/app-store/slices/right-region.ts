/**
 * Pure right-status-region notice controller.
 *
 * Two kinds of notice:
 * - ephemeralSolo: exactly one visible notice at a time across the whole region;
 *   immediate preempts; priority then FIFO; remaining time survives preempt/pause.
 * - persistentWithCounter: token counter + one highest-priority persistent notice.
 *
 * Both carry a lane, which decides WHICH chrome row shows them: `statusline` is the
 * model/context row and `statusbar` is the mode row. The lane never changes how many
 * notices are visible — one ephemeral is visible region-wide, on whichever row it
 * belongs to — so a lane can never cost the chrome an extra row.
 */
import type { AppAction } from "@/store/app-store/types.ts";

export type NoticePriority = "immediate" | "high" | "medium" | "low";

export type NoticeTone = "muted" | "warning" | "error" | "success" | "primary" | "design";

export type PersistentNoticeLane = "statusline" | "statusbar";

export const DEFAULT_EPHEMERAL_MS = 8_000;
export const VOICE_ERROR_MS = 10_000;
export const CLIPBOARD_COPY_NATIVE_MS = 2_000;
export const CLIPBOARD_COPY_TMUX_MS = 4_000;
export const CLIPBOARD_COPY_WARNING_MS = 6_000;
export const CLIPBOARD_IMAGE_MS = 8_000;
export const CLIPBOARD_IMAGE_COOLDOWN_MS = 30_000;
export const ORCHESTRATION_NOTICE_MS = 8_000;
export const PLUGIN_NOTICE_MS = 8_000;
export const GOAL_REFRESH_MS = 60_000;

const PRIORITY_RANK: Record<NoticePriority, number> = {
  immediate: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export interface EphemeralNoticeInput {
  readonly key: string;
  readonly text: string;
  /** Which chrome row shows it. Default `statusline`. */
  readonly lane?: PersistentNoticeLane;
  readonly tone?: NoticeTone;
  readonly priority?: NoticePriority;
  /** null = manual removal only (voice phases). Default 8000. */
  readonly durationMs?: number | null;
  readonly cooldownMs?: number;
  /** Replace same-key payload instead of dedupe-ignore. */
  readonly fold?: boolean;
  /** When folding the visible notice, restart its duration clock. Default false. */
  readonly restartOnFold?: boolean;
  readonly invalidates?: readonly string[];
  readonly requeueOnPreempt?: boolean;
  readonly bold?: boolean;
  readonly dim?: boolean;
  /** Trailing hint rendered after the text in the same tone color, dimmed. */
  readonly dimSuffix?: string;
}

export interface PersistentNoticeInput {
  readonly key: string;
  readonly text: string;
  readonly lane?: PersistentNoticeLane;
  readonly tone?: NoticeTone;
  readonly priority?: NoticePriority;
  readonly bold?: boolean;
  readonly dim?: boolean;
  /** Periodic re-publish signal (e.g. goal elapsed). */
  readonly refreshEveryMs?: number;
}

export interface EphemeralNotice {
  readonly key: string;
  readonly text: string;
  readonly lane: PersistentNoticeLane;
  readonly tone: NoticeTone;
  readonly priority: NoticePriority;
  readonly durationMs: number | null;
  readonly fold: boolean;
  readonly restartOnFold: boolean;
  readonly invalidates: readonly string[];
  readonly requeueOnPreempt: boolean;
  readonly bold: boolean;
  readonly dim: boolean;
  readonly dimSuffix: string | null;
  readonly sequence: number;
  /** Absolute wall-clock deadline while running; null when paused/preempted/manual. */
  readonly expiresAt: number | null;
  /** Remaining ms while paused or preempted. */
  readonly remainingMs: number | null;
}

export interface PersistentNotice {
  readonly key: string;
  readonly text: string;
  readonly lane: PersistentNoticeLane;
  readonly tone: NoticeTone;
  readonly priority: NoticePriority;
  readonly bold: boolean;
  readonly dim: boolean;
  readonly sequence: number;
  readonly refreshEveryMs: number | null;
  readonly lastPublishedAt: number;
}

interface NoticeCooldown {
  readonly at: number;
}

export interface RightRegionSlice {
  readonly ephemeralCurrent: EphemeralNotice | null;
  readonly ephemeralQueue: readonly EphemeralNotice[];
  readonly persistents: readonly PersistentNotice[];
  readonly counterText: string | null;
  readonly cooldowns: Readonly<Record<string, NoticeCooldown>>;
  readonly nextSequence: number;
  readonly paused: boolean;
  readonly refreshGeneration: number;
}

export const initialRightRegionSlice: RightRegionSlice = {
  ephemeralCurrent: null,
  ephemeralQueue: [],
  persistents: [],
  counterText: null,
  cooldowns: {},
  nextSequence: 1,
  paused: false,
  refreshGeneration: 0,
};

export type RightRegionAction =
  | {
      readonly type: "rightRegion/submitEphemeral";
      readonly notice: EphemeralNoticeInput;
      readonly now: number;
    }
  | { readonly type: "rightRegion/removeNotice"; readonly key: string; readonly now: number }
  | {
      readonly type: "rightRegion/upsertPersistent";
      readonly notice: PersistentNoticeInput;
      readonly now: number;
    }
  | { readonly type: "rightRegion/removePersistent"; readonly key: string }
  | { readonly type: "rightRegion/setCounter"; readonly text: string | null }
  | { readonly type: "rightRegion/expireCurrent"; readonly now: number }
  | { readonly type: "rightRegion/setPaused"; readonly paused: boolean; readonly now: number }
  | { readonly type: "rightRegion/tickRefresh"; readonly now: number }
  | { readonly type: "rightRegion/reset" };

function rankOf(priority: NoticePriority): number {
  return PRIORITY_RANK[priority];
}

function compareNotices(
  a: { priority: NoticePriority; sequence: number },
  b: { priority: NoticePriority; sequence: number },
): number {
  const byPriority = rankOf(a.priority) - rankOf(b.priority);
  if (byPriority !== 0) return byPriority;
  return a.sequence - b.sequence;
}

function pickNext(queue: readonly EphemeralNotice[]): EphemeralNotice | undefined {
  if (queue.length === 0) return undefined;
  return queue.reduce((best, item) => (compareNotices(item, best) < 0 ? item : best));
}

function freezeRemaining(notice: EphemeralNotice, now: number): EphemeralNotice {
  if (notice.expiresAt === null) return notice;
  const remainingMs = Math.max(0, notice.expiresAt - now);
  return { ...notice, expiresAt: null, remainingMs };
}

function armDeadline(notice: EphemeralNotice, now: number): EphemeralNotice {
  if (notice.durationMs === null) {
    return { ...notice, expiresAt: null, remainingMs: null };
  }
  const remaining =
    notice.remainingMs !== null && notice.remainingMs >= 0 ? notice.remainingMs : notice.durationMs;
  return {
    ...notice,
    expiresAt: now + remaining,
    remainingMs: null,
  };
}

function materializeEphemeral(
  input: EphemeralNoticeInput,
  sequence: number,
  now: number,
  running: boolean,
): EphemeralNotice {
  const durationMs = input.durationMs === undefined ? DEFAULT_EPHEMERAL_MS : input.durationMs;
  const base: EphemeralNotice = {
    key: input.key,
    text: input.text,
    lane: input.lane ?? "statusline",
    tone: input.tone ?? "warning",
    priority: input.priority ?? "medium",
    durationMs,
    fold: input.fold === true,
    restartOnFold: input.restartOnFold === true,
    invalidates: input.invalidates ?? [],
    requeueOnPreempt: input.requeueOnPreempt !== false,
    bold: input.bold === true,
    dim: input.dim === true,
    dimSuffix: input.dimSuffix ?? null,
    sequence,
    expiresAt: null,
    remainingMs: durationMs,
  };
  if (!running) return base;
  return armDeadline(base, now);
}

function shouldRequeueAfterPreemption(notice: EphemeralNotice, incoming: EphemeralNotice): boolean {
  if (incoming.invalidates.includes(notice.key)) return false;
  if (notice.priority === "immediate") {
    return notice.requeueOnPreempt;
  }
  return true;
}

function removeKeyFromQueue(
  queue: readonly EphemeralNotice[],
  key: string,
): readonly EphemeralNotice[] {
  if (!queue.some((item) => item.key === key)) return queue;
  return queue.filter((item) => item.key !== key);
}

function promote(
  state: RightRegionSlice,
  now: number,
  current: EphemeralNotice | null,
  queue: readonly EphemeralNotice[],
): RightRegionSlice {
  if (current !== null) {
    return { ...state, ephemeralCurrent: current, ephemeralQueue: queue };
  }
  const next = pickNext(queue);
  if (next === undefined) {
    return { ...state, ephemeralCurrent: null, ephemeralQueue: queue };
  }
  const remaining = removeKeyFromQueue(queue, next.key);
  const armed = state.paused ? next : armDeadline(next, now);
  return { ...state, ephemeralCurrent: armed, ephemeralQueue: remaining };
}

function cooldownBlocks(
  cooldowns: RightRegionSlice["cooldowns"],
  input: EphemeralNoticeInput,
  now: number,
): boolean {
  if (input.cooldownMs === undefined || input.cooldownMs <= 0) return false;
  const last = cooldowns[input.key];
  return last !== undefined && now - last.at < input.cooldownMs;
}

function recordCooldown(
  cooldowns: RightRegionSlice["cooldowns"],
  input: EphemeralNoticeInput,
  now: number,
): RightRegionSlice["cooldowns"] {
  if (input.cooldownMs === undefined || input.cooldownMs <= 0) return cooldowns;
  return { ...cooldowns, [input.key]: { at: now } };
}

function submitEphemeral(
  state: RightRegionSlice,
  input: EphemeralNoticeInput,
  now: number,
): RightRegionSlice {
  const current = state.ephemeralCurrent;
  if (cooldownBlocks(state.cooldowns, input, now)) return state;

  if (current !== null && current.key === input.key) {
    if (input.fold !== true) return state;
    const folded = materializeEphemeral(input, current.sequence, now, false);
    const keepRemaining = input.restartOnFold !== true;
    const merged: EphemeralNotice = {
      ...folded,
      remainingMs: keepRemaining
        ? (current.remainingMs ??
          (current.expiresAt !== null ? Math.max(0, current.expiresAt - now) : folded.remainingMs))
        : folded.durationMs,
      expiresAt: null,
    };
    const running = !state.paused && merged.durationMs !== null;
    const nextCurrent = running ? armDeadline(merged, now) : merged;
    return {
      ...state,
      ephemeralCurrent: nextCurrent,
      cooldowns: recordCooldown(state.cooldowns, input, now),
    };
  }

  const queueIndex = state.ephemeralQueue.findIndex((item) => item.key === input.key);
  if (queueIndex !== -1) {
    if (input.fold !== true) return state;
    const existing = state.ephemeralQueue[queueIndex]!;
    const folded = materializeEphemeral(input, existing.sequence, now, false);
    const queue = state.ephemeralQueue.slice();
    queue[queueIndex] = folded;
    return {
      ...state,
      ephemeralQueue: queue,
      cooldowns: recordCooldown(state.cooldowns, input, now),
    };
  }

  const sequence = state.nextSequence;
  const withSeq: RightRegionSlice = { ...state, nextSequence: sequence + 1 };
  const incoming = materializeEphemeral(input, sequence, now, false);
  const cooldowns = recordCooldown(state.cooldowns, input, now);

  if (incoming.priority === "immediate") {
    let queue = withSeq.ephemeralQueue;
    let nextCurrent: EphemeralNotice | null = current;
    if (current !== null) {
      const frozen = freezeRemaining(current, now);
      if (shouldRequeueAfterPreemption(frozen, incoming)) {
        queue = [frozen, ...removeKeyFromQueue(queue, frozen.key)];
      }
      for (const key of incoming.invalidates) {
        queue = removeKeyFromQueue(queue, key);
      }
      nextCurrent = null;
    } else {
      for (const key of incoming.invalidates) {
        queue = removeKeyFromQueue(queue, key);
      }
    }
    const armed = state.paused ? incoming : armDeadline(incoming, now);
    return {
      ...withSeq,
      ephemeralCurrent: armed,
      ephemeralQueue: queue,
      cooldowns,
    };
  }

  // Non-immediate: invalidate current if requested, else enqueue.
  if (current !== null && incoming.invalidates.includes(current.key)) {
    const queue = [...removeKeyFromQueue(withSeq.ephemeralQueue, incoming.key), incoming];
    return promote({ ...withSeq, cooldowns }, now, null, queue);
  }

  if (current === null) {
    const armed = state.paused ? incoming : armDeadline(incoming, now);
    return {
      ...withSeq,
      ephemeralCurrent: armed,
      ephemeralQueue: withSeq.ephemeralQueue,
      cooldowns,
    };
  }

  return {
    ...withSeq,
    ephemeralQueue: [...withSeq.ephemeralQueue, incoming],
    cooldowns,
  };
}

function removeNotice(state: RightRegionSlice, key: string, now: number): RightRegionSlice {
  const current = state.ephemeralCurrent;
  const queue = removeKeyFromQueue(state.ephemeralQueue, key);
  const cooldown = state.cooldowns[key];
  const cooldowns =
    cooldown === undefined
      ? state.cooldowns
      : Object.fromEntries(
          Object.entries(state.cooldowns).filter(([entryKey]) => entryKey !== key),
        );
  if (current?.key === key) {
    return promote({ ...state, ephemeralQueue: queue, cooldowns }, now, null, queue);
  }
  if (queue === state.ephemeralQueue && cooldown === undefined) return state;
  return { ...state, ephemeralQueue: queue, cooldowns };
}

function upsertPersistent(
  state: RightRegionSlice,
  input: PersistentNoticeInput,
  now: number,
): RightRegionSlice {
  const existing = state.persistents.find((item) => item.key === input.key);
  const sequence = existing?.sequence ?? state.nextSequence;
  const nextSequence = existing ? state.nextSequence : state.nextSequence + 1;
  const next: PersistentNotice = {
    key: input.key,
    text: input.text,
    lane: input.lane ?? existing?.lane ?? "statusline",
    tone: input.tone ?? "muted",
    priority: input.priority ?? "medium",
    bold: input.bold === true,
    dim: input.dim === true,
    sequence,
    refreshEveryMs: input.refreshEveryMs ?? existing?.refreshEveryMs ?? null,
    lastPublishedAt: now,
  };
  // Same payload: keep lastPublishedAt so refresh cadence is not reset by re-renders.
  if (
    existing &&
    existing.text === next.text &&
    existing.lane === next.lane &&
    existing.tone === next.tone &&
    existing.priority === next.priority &&
    existing.bold === next.bold &&
    existing.dim === next.dim &&
    existing.refreshEveryMs === next.refreshEveryMs
  ) {
    return state;
  }
  const persistents = existing
    ? state.persistents.map((item) => (item.key === input.key ? next : item))
    : [...state.persistents, next];
  return { ...state, persistents, nextSequence };
}

function removePersistent(state: RightRegionSlice, key: string): RightRegionSlice {
  if (!state.persistents.some((item) => item.key === key)) return state;
  return {
    ...state,
    persistents: state.persistents.filter((item) => item.key !== key),
  };
}

function setPaused(state: RightRegionSlice, paused: boolean, now: number): RightRegionSlice {
  if (state.paused === paused) return state;
  const current = state.ephemeralCurrent;
  if (paused) {
    return {
      ...state,
      paused: true,
      ephemeralCurrent: current ? freezeRemaining(current, now) : null,
    };
  }
  return {
    ...state,
    paused: false,
    ephemeralCurrent: current ? armDeadline(current, now) : null,
  };
}

function expireCurrent(state: RightRegionSlice, now: number): RightRegionSlice {
  const current = state.ephemeralCurrent;
  if (current === null) return state;
  if (state.paused) return state;
  if (current.expiresAt !== null && now < current.expiresAt) return state;
  if (current.durationMs === null && current.expiresAt === null) return state;
  return promote(state, now, null, state.ephemeralQueue);
}

function tickRefresh(state: RightRegionSlice, now: number): RightRegionSlice {
  let changed = false;
  const persistents = state.persistents.map((item) => {
    if (item.refreshEveryMs === null) return item;
    if (now < item.lastPublishedAt + item.refreshEveryMs) return item;
    changed = true;
    return { ...item, lastPublishedAt: now };
  });
  if (!changed) return state;
  return {
    ...state,
    persistents,
    refreshGeneration: state.refreshGeneration + 1,
  };
}

export function rightRegionReducer(prev: RightRegionSlice, action: AppAction): RightRegionSlice {
  switch (action.type) {
    case "rightRegion/submitEphemeral":
      return submitEphemeral(prev, action.notice, action.now);
    case "rightRegion/removeNotice":
      return removeNotice(prev, action.key, action.now);
    case "rightRegion/upsertPersistent":
      return upsertPersistent(prev, action.notice, action.now);
    case "rightRegion/removePersistent":
      return removePersistent(prev, action.key);
    case "rightRegion/setCounter":
      return prev.counterText === action.text ? prev : { ...prev, counterText: action.text };
    case "rightRegion/expireCurrent":
      return expireCurrent(prev, action.now);
    case "rightRegion/setPaused":
      return setPaused(prev, action.paused, action.now);
    case "rightRegion/tickRefresh":
      return tickRefresh(prev, action.now);
    case "rightRegion/reset":
      return initialRightRegionSlice;
    default:
      return prev;
  }
}

export interface RightRegionSegment {
  readonly key: string;
  readonly text: string;
  readonly tone: NoticeTone;
  readonly bold: boolean;
  readonly dim: boolean;
  readonly dimSuffix: string | null;
}

export interface RightRegionView {
  /** The transient notice currently on screen, if any. */
  readonly ephemeral: readonly RightRegionSegment[];
  /** The lasting readout: highest-priority notice for the lane, then the counter. */
  readonly persistent: readonly RightRegionSegment[];
  readonly nextDeadlineAt: number | null;
}

export function selectHighestPersistent(
  persistents: readonly PersistentNotice[],
  lane: PersistentNoticeLane = "statusline",
): PersistentNotice | null {
  const candidates = persistents.filter((notice) => notice.lane === lane);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, item) => (compareNotices(item, best) < 0 ? item : best));
}

export function selectNextDeadlineAt(state: RightRegionSlice, now: number): number | null {
  const deadlines: number[] = [];
  if (!state.paused && state.ephemeralCurrent?.expiresAt !== null) {
    const expiresAt = state.ephemeralCurrent?.expiresAt;
    if (expiresAt !== undefined && expiresAt !== null) deadlines.push(expiresAt);
  }
  for (const item of state.persistents) {
    if (item.refreshEveryMs === null) continue;
    deadlines.push(item.lastPublishedAt + item.refreshEveryMs);
  }
  if (deadlines.length === 0) return null;
  const next = Math.min(...deadlines);
  // Clamp past deadlines to now so the scheduler fires immediately.
  return next < now ? now : next;
}

export function selectRightRegionView(
  state: RightRegionSlice,
  now: number,
  lane: PersistentNoticeLane = "statusline",
): RightRegionView {
  const visible = state.ephemeralCurrent;
  const current = visible !== null && visible.lane === lane ? visible : null;
  const persistent: RightRegionSegment[] = [];
  const highest = selectHighestPersistent(state.persistents, lane);
  if (highest !== null) {
    persistent.push({
      key: highest.key,
      text: highest.text,
      tone: highest.tone,
      bold: highest.bold,
      dim: highest.dim,
      dimSuffix: null,
    });
  }
  if (lane === "statusline" && state.counterText !== null && state.counterText.length > 0) {
    persistent.push({
      key: "tokens",
      text: state.counterText,
      tone: "muted",
      bold: false,
      dim: false,
      dimSuffix: null,
    });
  }

  return {
    ephemeral:
      current === null
        ? []
        : [
            {
              key: current.key,
              text: current.text,
              tone: current.tone,
              bold: current.bold,
              dim: current.dim,
              dimSuffix: current.dimSuffix,
            },
          ],
    persistent,
    nextDeadlineAt: selectNextDeadlineAt(state, now),
  };
}
