/** A mutable box shared between the code that sets a value and the code that reads it later. */
export interface MutableRef<T> {
  current: T;
}

/** A replacement value, or a function deriving it from the current one. */
export type StateUpdate<T> = T | ((previous: T) => T);

/** Accepts either form of update. */
export type StateSetter<T> = (update: StateUpdate<T>) => void;
