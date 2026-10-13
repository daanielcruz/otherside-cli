import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isProcessAlive } from "@/kernel/std/proc/process-alive.ts";
import { isRecord } from "@/kernel/std/value-guards.ts";
import { savedSchedulePath } from "./index.ts";

// Whether this process fires the project's unowned durable tasks. Several sessions
// can share a project; only the one holding the lease fires them, so none fires twice.
let held = false;
let releaseOnExitArmed = false;

function leasePath(): string {
  return join(dirname(savedSchedulePath()), "scheduled_tasks.lock");
}

function holderPid(path: string): number | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) && typeof parsed.pid === "number" ? parsed.pid : null;
  } catch {
    return null;
  }
}

function createLease(path: string): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), {
      flag: "wx",
    });
    return true;
  } catch {
    return false;
  }
}

function take(): boolean {
  held = true;
  if (!releaseOnExitArmed) {
    releaseOnExitArmed = true;
    process.on("exit", releaseSchedulerLease);
  }
  return true;
}

/**
 * Takes the project's scheduler lease, or confirms this process still holds it. A
 * lease whose holder exited is taken over.
 */
export function claimSchedulerLease(): boolean {
  const path = leasePath();
  if (createLease(path)) return take();
  const holder = holderPid(path);
  if (holder === process.pid) return take();
  held = false;
  if (holder !== null && isProcessAlive(holder)) return false;
  try {
    unlinkSync(path);
  } catch {}
  return createLease(path) ? take() : false;
}

export function holdsSchedulerLease(): boolean {
  return held;
}

export function releaseSchedulerLease(): void {
  if (!held) return;
  held = false;
  const path = leasePath();
  if (holderPid(path) !== process.pid) return;
  try {
    unlinkSync(path);
  } catch {}
}
