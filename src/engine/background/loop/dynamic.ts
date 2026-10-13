import * as cron from "@/engine/background/cron/index.ts";
import {
  CACHE_LEAD_MS,
  PROMPT_CACHE_TTL_MS,
  RECURRING_MAX_AGE_MS,
} from "@/engine/background/cron/timing.ts";

const MIN_DELAY_SECONDS = 60;
const MAX_DELAY_SECONDS = 3600;
/** The fallback wakeup armed when a tick ends without the model scheduling the next one. */
const KEEPALIVE_DELAY_SECONDS = 1200;
/** Fallbacks allowed in a row before a loop the model keeps declining to reschedule ends. */
const KEEPALIVE_BUDGET = 1;

export interface LoopWakeup {
  scheduledFor: number;
  clampedDelaySeconds: number;
  wasClamped: boolean;
}

interface LoopChain {
  startedAt: number;
  lastScheduledFor: number;
  agedOut?: true;
}

// One chain per /loop prompt: how long it has been running, for the age limit.
const chains = new Map<string, LoopChain>();
let keepalivesInARow = 0;
// The prompt of a wakeup that fired and has not opened its turn yet, then of the
// tick that turn runs; the tick's turn ending without a new wakeup arms the fallback.
let firedPrompt: string | null = null;
let tickPrompt: string | null = null;

function pendingWakeups(): cron.ScheduledTask[] {
  return cron.tasks().filter((task) => task.kind === "loop");
}

export function hasPendingLoopWakeup(): boolean {
  return pendingWakeups().length > 0;
}

function roundUpToMinute(ms: number): number {
  const at = new Date(ms);
  if (at.getSeconds() > 0 || at.getMilliseconds() > 0) at.setMinutes(at.getMinutes() + 1);
  at.setSeconds(0, 0);
  return at.getTime();
}

function clampDelay(requested: number): number {
  if (Number.isNaN(requested) || requested === Number.NEGATIVE_INFINITY) return MIN_DELAY_SECONDS;
  if (requested === Number.POSITIVE_INFINITY) return MAX_DELAY_SECONDS;
  return Math.max(MIN_DELAY_SECONDS, Math.min(MAX_DELAY_SECONDS, Math.round(requested)));
}

/**
 * When a wakeup `delaySeconds` from `now` fires: on a whole minute, and for a delay
 * meant to stay inside the prompt-cache window, pulled back a minute at a time until
 * it lands with a margin before the cache expires.
 */
function wakeupTarget(delaySeconds: number, now: number): { at: number; createdAt: number } {
  const requestedAt = now + delaySeconds * 1000;
  let at = roundUpToMinute(requestedAt);
  if (delaySeconds * 1000 <= PROMPT_CACHE_TTL_MS) {
    const latest = PROMPT_CACHE_TTL_MS - CACHE_LEAD_MS;
    while (at - now > latest && at - 60_000 >= now + MIN_DELAY_SECONDS * 1000) at -= 60_000;
  }
  return { at, createdAt: requestedAt < at ? requestedAt : at - 1 };
}

function forget(prompts: readonly string[]): void {
  for (const prompt of prompts) chains.delete(prompt);
}

/**
 * Arms the next wakeup of a dynamic /loop, replacing any pending one. Null when the
 * loop has run for the maximum age: it ends instead of re-arming.
 */
export function scheduleLoopWakeup(
  requestedDelaySeconds: number,
  prompt: string,
  options: { reason?: string; keepalive?: true } = {},
): LoopWakeup | null {
  if (options.keepalive === undefined) keepalivesInARow = 0;
  const now = Date.now();
  cron.removeMany(pendingWakeups().map((task) => task.id));
  const prior = chains.get(prompt);
  const lapsed = prior !== undefined && now > prior.lastScheduledFor + MAX_DELAY_SECONDS * 1000;
  const startedAt = prior === undefined || lapsed ? now : prior.startedAt;
  if (now - startedAt >= RECURRING_MAX_AGE_MS) {
    if (prior?.agedOut === undefined) {
      chains.set(prompt, {
        startedAt,
        lastScheduledFor: now - (MAX_DELAY_SECONDS - MIN_DELAY_SECONDS) * 1000,
        agedOut: true,
      });
    }
    return null;
  }
  const clampedDelaySeconds = clampDelay(requestedDelaySeconds);
  const { at, createdAt } = wakeupTarget(clampedDelaySeconds, now);
  const target = new Date(at);
  cron.create({
    cron: `${target.getMinutes()} ${target.getHours()} * * *`,
    prompt,
    recurring: false,
    durable: false,
    kind: "loop",
    scheduledFor: at,
    createdAt,
    ...(options.reason !== undefined ? { reason: options.reason } : {}),
    ...(options.keepalive !== undefined ? { keepalive: options.keepalive } : {}),
  });
  chains.set(prompt, { startedAt, lastScheduledFor: at });
  if (options.keepalive !== undefined) keepalivesInARow += 1;
  return {
    scheduledFor: at,
    clampedDelaySeconds,
    wasClamped:
      !Number.isFinite(requestedDelaySeconds) ||
      clampedDelaySeconds !== Math.round(requestedDelaySeconds),
  };
}

/**
 * Ends the dynamic loop — the model stopped it, or the user interrupted — so no
 * pending wakeup starts another tick. Returns how many pending wakeups were cancelled.
 */
export function endDynamicLoop(): number {
  const pending = pendingWakeups();
  cron.removeMany(pending.map((task) => task.id));
  forget([...pending.map((task) => task.prompt), ...(tickPrompt !== null ? [tickPrompt] : [])]);
  firedPrompt = null;
  tickPrompt = null;
  keepalivesInARow = 0;
  return pending.length;
}

/** A wakeup fired; its turn opens once the session is idle. */
export function noteLoopWakeupFired(prompt: string): void {
  firedPrompt = prompt;
}

/** The turn a fired wakeup queued has started running its tick. */
export function beginLoopTick(): void {
  tickPrompt = firedPrompt;
  firedPrompt = null;
}

/**
 * A turn ended. When it ran a loop tick that scheduled no next wakeup, a fallback
 * wakeup keeps the loop alive once; a second tick in a row without one ends it.
 */
export function settleLoopTick(): void {
  const prompt = tickPrompt;
  tickPrompt = null;
  if (prompt === null || hasPendingLoopWakeup()) return;
  if (keepalivesInARow >= KEEPALIVE_BUDGET) {
    endDynamicLoop();
    return;
  }
  scheduleLoopWakeup(KEEPALIVE_DELAY_SECONDS, prompt, { keepalive: true });
}

export function resetLoopRuntimeForTests(): void {
  chains.clear();
  keepalivesInARow = 0;
  firedPrompt = null;
  tickPrompt = null;
}
