import type { SystemInjectionEntry } from "@/engine/session/system-injection-store.ts";
import type { SessionWorktreeState } from "@/engine/session/worktree.ts";
import type { ContentReplacementState } from "@/engine/tool-result-storage/index.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import pkg from "../../../../package.json" with { type: "json" };
import type {
  HookEventRecord,
  SessionMetaRecord,
  SessionRecord,
  SessionStamp,
  UsageRecord,
} from "./schema.ts";

export const OTHERSIDE_VERSION = pkg.version;

// Cap on hook events held in memory. Hook events (goal_set/met/cleared, goal_not_met, goal_paused_bg, etc.) accumulate per turn in workflows with active goals, so keep a capped FIFO array on the session rather than in records[].
// 200 is comfortably above the deepest single-goal iteration count we have seen.
const MAX_IN_MEMORY_HOOK_EVENTS = 200;
// Cap on per-call usage records held in memory. Only fork/estimated usage goes
// here (main-turn usage persists on the assistant_message record). These are
// already aggregated in the offline stats cache; the per-call list is kept
// only to support requestUsageFromRecord on the live session. Usage records DO
// persist to the transcript jsonl; the cap only bounds the live in-memory store.
const MAX_IN_MEMORY_USAGE_RECORDS = 1000;

export class SessionChain {
  headUuid: string | null = null;

  seed(headUuid: string): void {
    this.headUuid = headUuid;
  }
}

export class Session {
  id: string;
  /**
   * Mutable active cwd seen by the model/tools. Switched by session worktree
   * enter/exit via session/RequestContext state — never process.chdir().
   */
  cwd: string;
  /**
   * Project cwd used for transcript / tool-result persistence.
   * Rewritten by /cd when the session project identity relocates, and by
   * worktree enter/exit — the transcript follows the active worktree and
   * returns to the pre-enter project anchor on exit.
   */
  storageCwd: string;
  gitBranch?: string;
  /** Main-session worktree controller state (subagents use a separate map). */
  worktree: SessionWorktreeState | null = null;
  readonly records: SessionRecord[] = [];
  readonly messages: Message[] = [];
  readonly events: { ts: number; kind: string; payload: unknown }[] = [];
  readonly hookEvents: HookEventRecord[] = [];
  readonly usageRecords: UsageRecord[] = [];
  readonly systemInjections: SystemInjectionEntry[] = [];
  readonly additionalWorkingDirectories = new Set<string>();
  eventSeq = 0;
  readonly chain = new SessionChain();
  pendingMeta: SessionMetaRecord | null = null;
  contentReplacementState?: ContentReplacementState;

  constructor(id: string, cwd: string = process.cwd()) {
    this.id = id;
    this.cwd = cwd;
    this.storageCwd = cwd;
  }

  stamp(): SessionStamp {
    // Transcript identity is always the project storage cwd, not the active
    // worktree path. Worktree session state travels as its own transcript
    // record (`worktree_state`), never on this per-line stamp.
    const s: SessionStamp = {
      sessionId: this.id,
      cwd: this.storageCwd,
      version: OTHERSIDE_VERSION,
    };
    if (this.gitBranch) s.gitBranch = this.gitBranch;
    return s;
  }

  append(kind: string, payload: unknown): void {
    this.eventSeq += 1;
    this.events.push({ ts: Date.now(), kind, payload });
    if (this.events.length > 256) {
      this.events.splice(0, this.events.length - 256);
    }
  }

  pushHookEvent(r: HookEventRecord): void {
    this.hookEvents.push(r);
    if (this.hookEvents.length > MAX_IN_MEMORY_HOOK_EVENTS) {
      this.hookEvents.splice(0, this.hookEvents.length - MAX_IN_MEMORY_HOOK_EVENTS);
    }
  }

  pushUsageRecord(r: UsageRecord): void {
    this.usageRecords.push(r);
    if (this.usageRecords.length > MAX_IN_MEMORY_USAGE_RECORDS) {
      this.usageRecords.splice(0, this.usageRecords.length - MAX_IN_MEMORY_USAGE_RECORDS);
    }
  }

  pushSystemInjection(r: SystemInjectionEntry): void {
    this.systemInjections.push(r);
  }

  pushRecord(r: SessionRecord): void {
    this.records.push(r);
    // storageCwd is project identity (updated only by /cd relocate). Active cwd
    // is owned by enter/exit worktree and /cd; only mirror session_meta into
    // active cwd when no session worktree is active.
    if (
      r.type === "session_meta" &&
      typeof r.cwd === "string" &&
      r.cwd.length > 0 &&
      this.worktree === null
    ) {
      this.cwd = r.cwd;
    }
  }
}
