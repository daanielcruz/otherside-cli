import type { KeyEventData } from "@/terminal-runtime";

/**
 * Apple_Terminal sends the same byte for Enter and Shift+Return, so the
 * missing bit comes from a point-in-time Quartz state query made while the
 * return key is being dispatched. The add-on exposes exactly that read —
 * no event tap, no listener, no permission prompt — and every failure mode
 * (missing add-on, load error, denied query) degrades to plain submit.
 */
interface ShiftProbeModule {
  isShiftPressed(): boolean;
}

let cachedProbe: ShiftProbeModule | null | undefined;

/** The probe belongs only to an interactive Apple_Terminal prompt on darwin. */
export function shouldProbeAppleTerminal(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  return process.platform === "darwin" && env.TERM_PROGRAM === "Apple_Terminal" && isTTY;
}

function loadProbe(): ShiftProbeModule | null {
  if (cachedProbe !== undefined) return cachedProbe;
  try {
    // Static specifier: the compiled binary embeds this exact asset.
    const loaded = require("./native/apple-terminal-modifiers.node") as Partial<ShiftProbeModule>;
    cachedProbe = typeof loaded.isShiftPressed === "function" ? (loaded as ShiftProbeModule) : null;
  } catch {
    cachedProbe = null;
  }
  return cachedProbe;
}

/**
 * True only for an otherwise unmodified return pressed while Shift is
 * physically held. The reader runs solely inside this dispatch — the state
 * is a point-in-time observation, never cached, never applied to pastes.
 */
export function isAppleTerminalShiftReturn(key: KeyEventData, readShift: () => boolean): boolean {
  if (key.name !== "return" || key.isPasted) return false;
  if (key.shift || key.meta || key.ctrl || key.option) return false;
  try {
    return readShift();
  } catch {
    return false;
  }
}

/** The production reader, or null while the gate or the add-on keeps the probe off. */
export function appleTerminalShiftReader(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = process.stdin.isTTY === true,
): (() => boolean) | null {
  if (!shouldProbeAppleTerminal(env, isTTY)) return null;
  const probe = loadProbe();
  if (probe === null) return null;
  return () => {
    try {
      return probe.isShiftPressed();
    } catch {
      return false;
    }
  };
}

/**
 * Whether surfaces may advertise Shift+Return for newline. Outside
 * Apple_Terminal the decoded sequences own the shortcut; inside it, only a
 * loaded probe earns the hint — otherwise the backslash fallback is the
 * honest advertisement.
 */
export function advertisesShiftReturn(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = process.stdin.isTTY === true,
): boolean {
  if (process.platform !== "darwin" || env.TERM_PROGRAM !== "Apple_Terminal") return true;
  return appleTerminalShiftReader(env, isTTY) !== null;
}
