// Session-scoped sticky-on latches for wire fingerprint beta headers.
// Once a beta is first activated, keep sending the header for the rest of the session so toggles do not bust the prompt cache.

let fastModeLatched = false;
let afkLatched = false;

export function latchFastModeIf(active: boolean): boolean {
  if (active && !fastModeLatched) fastModeLatched = true;
  return fastModeLatched;
}

export function getFastModeLatched(): boolean {
  return fastModeLatched;
}

export function latchAfkIf(active: boolean): boolean {
  if (active && !afkLatched) afkLatched = true;
  return afkLatched;
}

export function getAfkLatched(): boolean {
  return afkLatched;
}

export function _resetWireLatchesForTests(): void {
  fastModeLatched = false;
  afkLatched = false;
}
