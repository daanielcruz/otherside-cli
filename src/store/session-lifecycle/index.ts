import type { SessionMetaRecord } from "@/engine/session/index.ts";
import type { PendingRewindPersist } from "@/engine/session/rewind.ts";
import type { MutableRef } from "@/kernel/std/types/state.ts";

// Deferred session-lifecycle work owned outside the render root: broker-meta and
// rewind persistence that is flushed before the next turn, a flag that suppresses
// broker persistence while a rewind/resume rewrites the session, and the queue of
// finalizers run when the session is cleared or replaced.
export const suppressBrokerPersistenceRef: MutableRef<boolean> = { current: false };
export const pendingBrokerMetaRef: MutableRef<SessionMetaRecord | null> = { current: null };
export const pendingRewindPersistRef: MutableRef<PendingRewindPersist | null> = {
  current: null,
};
export const sessionFinalizersRef: MutableRef<Array<() => void | Promise<void>>> = {
  current: [],
};
