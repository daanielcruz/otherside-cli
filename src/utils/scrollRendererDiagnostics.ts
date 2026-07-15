export type ScrollDiagnostics = {
  useDecayCurve: boolean;
  useAdaptiveDrain: boolean;
  base: number;
  xtermJs: boolean;
  wheelFlood: boolean;
  jediTerm: boolean;
  termProgram: string;
  termProgramVersion: string;
  xtversion: string;
  wtSession: boolean;
  scrollSpeedEnv: string;
  platform: NodeJS.Platform;
};

export function logWheelEventOut(
  _applied: number,
  _pendingDelta: number,
  _mode: "adaptive" | "proportional",
): void {}

export function getScrollRendererDiagnostics(): ScrollDiagnostics {
  return {
    useDecayCurve: false,
    useAdaptiveDrain: false,
    base: 1,
    xtermJs: false,
    wheelFlood: false,
    jediTerm: false,
    termProgram: process.env.TERM_PROGRAM ?? "",
    termProgramVersion: process.env.TERM_PROGRAM_VERSION ?? "",
    xtversion: "",
    wtSession: !!process.env.WT_SESSION,
    scrollSpeedEnv: process.env.OTHERSIDE_SCROLL_SPEED ?? "",
    platform: process.platform,
  };
}
