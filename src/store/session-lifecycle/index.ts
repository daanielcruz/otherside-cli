import type { SessionMetaRecord } from "@/engine/session/index.ts";
import type { MutableRef } from "@/kernel/std/types/state.ts";

// Session-lifecycle state owned outside the render root: the pending broker meta, a
// flag that suppresses broker persistence while a rewind/resume rewrites the session,
// and the queue of finalizers run when the session is cleared or replaced.
export const suppressBrokerPersistenceRef: MutableRef<boolean> = { current: false };
export const pendingBrokerMetaRef: MutableRef<SessionMetaRecord | null> = { current: null };
export const sessionFinalizersRef: MutableRef<Array<() => void | Promise<void>>> = {
  current: [],
};
