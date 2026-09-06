import { normalizeChord } from "@/ui/keys/chord.ts";

/**
 * Keys a user may not rebind, and why.
 *
 * Three tiers with two severities. An error rejects the binding outright; a
 * warning applies it but says the terminal may take the key first, because
 * whether it does depends on the emulator rather than on us.
 */

export type ReservedSeverity = "error" | "warning";

export interface ReservedKey {
  severity: ReservedSeverity;
  /** Why the key is held back, phrased for the person who tried to bind it. */
  reason: string;
}

const SESSION_CONTROL = "leaving the session reachable is not negotiable";
const TERMINAL_OWNED = "the terminal claims this before the app sees it";
const PLATFORM_OWNED = "the operating system claims this before the terminal sees it";

/**
 * `ctrl+s` is deliberately absent: modern terminals disable flow control, and
 * the key belongs to the prompt's stash. `ctrl+q` is absent for the same reason.
 */
const RESERVED_KEYS: Readonly<Record<string, ReservedKey>> = {
  // Non-rebindable: the ways out of a turn, a prompt, and the session.
  "ctrl+c": { severity: "error", reason: SESSION_CONTROL },
  "ctrl+d": { severity: "error", reason: SESSION_CONTROL },
  "ctrl+m": { severity: "error", reason: SESSION_CONTROL },
  // Terminal-owned: suspend is usually ours to see, quit never is.
  "ctrl+z": { severity: "warning", reason: TERMINAL_OWNED },
  "ctrl+\\": { severity: "error", reason: TERMINAL_OWNED },
  // Platform-owned on macOS: the window server answers these first.
  "cmd+c": { severity: "error", reason: PLATFORM_OWNED },
  "cmd+q": { severity: "error", reason: PLATFORM_OWNED },
  "cmd+space": { severity: "error", reason: PLATFORM_OWNED },
  "cmd+tab": { severity: "error", reason: PLATFORM_OWNED },
  "cmd+v": { severity: "error", reason: PLATFORM_OWNED },
  "cmd+w": { severity: "error", reason: PLATFORM_OWNED },
  "cmd+x": { severity: "error", reason: PLATFORM_OWNED },
};

/**
 * Whether a chord is held back, and how hard. Only the FIRST step is checked:
 * a prefix that is reserved makes the whole chord unreachable, while a reserved
 * key in a later step is already unreachable on its own and costs nothing here.
 */
export function reservedKeyFor(chord: string): ReservedKey | null {
  const normalized = normalizeChord(chord);
  if (normalized === null) return null;
  const firstStep = normalized.split(" ")[0] ?? "";
  return RESERVED_KEYS[firstStep] ?? null;
}

export function isReservedKey(chord: string): boolean {
  return reservedKeyFor(chord) !== null;
}
