import type { Key } from "@/ink";
import { getKeyName } from "./match";
import { chordToString } from "./parser";
import type { KeybindingContextName, ParsedBinding, ParsedKeystroke } from "./types";

export type ChordResolveResult =
  | { type: "match"; action: string }
  | { type: "none" }
  | { type: "unbound" }
  | { type: "chord_started"; pending: ParsedKeystroke[] }
  | { type: "chord_cancelled" };

export function getBindingDisplayText(
  action: string,
  context: KeybindingContextName,
  bindings: ParsedBinding[],
): string | undefined {
  const binding = bindings.findLast((b) => b.action === action && b.context === context);
  return binding ? chordToString(binding.chord) : undefined;
}

const MACOS_DEAD_KEY_REMAP: Record<string, string> = {
  "†": "t",
};

function applyMacosDeadKeyRemap(input: string, key: Key): { input: string; key: Key } {
  if (process.platform !== "darwin") return { input, key };
  if (key.meta || key.ctrl) return { input, key };
  if (!(input in MACOS_DEAD_KEY_REMAP)) return { input, key };
  return {
    input: MACOS_DEAD_KEY_REMAP[input]!,
    key: { ...key, meta: true },
  };
}

function buildKeystroke(rawInput: string, rawKey: Key): ParsedKeystroke | null {
  const { input, key } = applyMacosDeadKeyRemap(rawInput, rawKey);
  const keyName = getKeyName(input, key);
  if (!keyName) return null;

  const effectiveMeta = key.escape ? false : key.meta;

  return {
    key: keyName,
    ctrl: key.ctrl,
    alt: effectiveMeta,
    shift: key.shift,
    meta: effectiveMeta,
    super: key.super,
  };
}

export function keystrokesEqual(a: ParsedKeystroke, b: ParsedKeystroke): boolean {
  return (
    a.key === b.key &&
    a.ctrl === b.ctrl &&
    a.shift === b.shift &&
    (a.alt || a.meta) === (b.alt || b.meta) &&
    a.super === b.super
  );
}

function chordPrefixMatches(prefix: ParsedKeystroke[], binding: ParsedBinding): boolean {
  if (prefix.length >= binding.chord.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    const prefixKey = prefix[i];
    const bindingKey = binding.chord[i];
    if (!prefixKey || !bindingKey) return false;
    if (!keystrokesEqual(prefixKey, bindingKey)) return false;
  }
  return true;
}

function chordExactlyMatches(chord: ParsedKeystroke[], binding: ParsedBinding): boolean {
  if (chord.length !== binding.chord.length) return false;
  for (let i = 0; i < chord.length; i++) {
    const chordKey = chord[i];
    const bindingKey = binding.chord[i];
    if (!chordKey || !bindingKey) return false;
    if (!keystrokesEqual(chordKey, bindingKey)) return false;
  }
  return true;
}

export function resolveKeyWithChordState(args: {
  input: string;
  key: Key;
  activeContexts: KeybindingContextName[];
  bindings: ParsedBinding[];
  pending: ParsedKeystroke[] | null;
}): ChordResolveResult {
  const { input, key, activeContexts, bindings, pending } = args;
  if (key.escape && pending !== null) {
    return { type: "chord_cancelled" };
  }

  const currentKeystroke = buildKeystroke(input, key);
  if (!currentKeystroke) {
    if (pending !== null) {
      return { type: "chord_cancelled" };
    }
    return { type: "none" };
  }

  const testChord = pending ? [...pending, currentKeystroke] : [currentKeystroke];

  const ctxSet = new Set(activeContexts);
  const contextBindings = bindings.filter((b) => ctxSet.has(b.context));

  const chordWinners = new Map<string, string | null>();
  for (const binding of contextBindings) {
    if (binding.chord.length > testChord.length && chordPrefixMatches(testChord, binding)) {
      chordWinners.set(chordToString(binding.chord), binding.action);
    }
  }
  let hasLongerChords = false;
  for (const action of chordWinners.values()) {
    if (action !== null) {
      hasLongerChords = true;
      break;
    }
  }

  if (hasLongerChords) {
    return { type: "chord_started", pending: testChord };
  }

  let exactMatch: ParsedBinding | undefined;
  for (const binding of contextBindings) {
    if (chordExactlyMatches(testChord, binding)) {
      exactMatch = binding;
    }
  }

  if (exactMatch) {
    if (exactMatch.action === null) {
      return { type: "unbound" };
    }
    return { type: "match", action: exactMatch.action };
  }

  if (pending !== null) {
    return { type: "chord_cancelled" };
  }

  return { type: "none" };
}

function chordsEqual(a: ParsedKeystroke[], b: ParsedKeystroke[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ka = a[i];
    const kb = b[i];
    if (!ka || !kb || !keystrokesEqual(ka, kb)) return false;
  }
  return true;
}

export function resolveActionBinding(
  action: string,
  activeScopes: KeybindingContextName[],
  bindings: ParsedBinding[],
): ParsedKeystroke[] | null | undefined {
  const activeSet = new Set(activeScopes);
  const byScope = new Map<KeybindingContextName, ParsedBinding[]>();
  for (const binding of bindings) {
    if (!activeSet.has(binding.context)) continue;
    const existing = byScope.get(binding.context);
    if (existing) existing.push(binding);
    else byScope.set(binding.context, [binding]);
  }

  let sawAction = false;
  for (let i = 0; i < activeScopes.length; i++) {
    const scope = activeScopes[i];
    if (scope === undefined) continue;
    const scopeBindings = byScope.get(scope);
    if (!scopeBindings) continue;

    let matched = false;
    let chord: ParsedKeystroke[] | undefined;
    for (let j = 0; j < scopeBindings.length; j++) {
      const binding = scopeBindings[j];
      if (!binding || binding.action !== action) continue;
      matched = true;
      let shadowed = false;
      for (let k = j + 1; k < scopeBindings.length; k++) {
        const later = scopeBindings[k];
        if (later && chordsEqual(later.chord, binding.chord)) {
          shadowed = true;
          break;
        }
      }
      if (!shadowed) chord = binding.chord;
    }

    if (chord) {
      for (let j = 0; j < i; j++) {
        const higherScope = activeScopes[j];
        if (higherScope === undefined) continue;
        const higherBindings = byScope.get(higherScope);
        if (!higherBindings) continue;
        if (higherBindings.some((b) => b && chordsEqual(b.chord, chord))) {
          return null;
        }
      }
      return chord;
    }

    if (matched) sawAction = true;
  }

  return sawAction ? null : undefined;
}
