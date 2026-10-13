// While an interactive surface owns the keyboard, an interrupt signal is a key the
// user pressed that the terminal turned into a signal — its line discipline was
// left cooked by something else. The owner answers it like the key; nobody exits.

type InterruptOwner = () => void;

let owner: InterruptOwner | null = null;

/** Routes SIGINT to `handler` until the returned release is called. */
export function claimInterrupt(handler: InterruptOwner): () => void {
  owner = handler;
  return () => {
    if (owner === handler) owner = null;
  };
}

export function interruptIsClaimed(): boolean {
  return owner !== null;
}

/** Hands a SIGINT to its owner; false when nobody claimed it and the caller may exit. */
export function deliverClaimedInterrupt(): boolean {
  if (owner === null) return false;
  owner();
  return true;
}
