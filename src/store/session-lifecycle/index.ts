import type { MutableRefObject } from "react";
import type { SessionMetaRecord } from "@/engine/session/index.ts";
import type { PendingRewindPersist } from "@/engine/session/rewind.ts";

// Deferred session-lifecycle work owned outside the render root: broker-meta and
// rewind persistence that is flushed before the next turn, a flag that suppresses
// broker persistence while a rewind/resume rewrites the session, and the queue of
// finalizers run when the session is cleared or replaced.
export const suppressBrokerPersistenceRef: MutableRefObject<boolean> = { current: false };
export const pendingBrokerMetaRef: MutableRefObject<SessionMetaRecord | null> = { current: null };
export const pendingRewindPersistRef: MutableRefObject<PendingRewindPersist | null> = {
  current: null,
};
export const sessionFinalizersRef: MutableRefObject<Array<() => void | Promise<void>>> = {
  current: [],
};
