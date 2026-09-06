import { sanitizeTitle } from "@/engine/session/index.ts";
import { appStore } from "@/store/app-store/index.ts";
import { getSessionTitle, sessionTitleStore } from "@/store/session-title/index.ts";
import { OSC, osc } from "@/terminal-runtime/terminal/operating-system-command.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";

export const FALLBACK_CAPTION = "Otherside CLI";
export const IDLE_CAPTION_MARK = "¤";
export const BUSY_CAPTION_MARKS = ["⠂", "⠐"] as const;
export const CAPTION_STEP_MS = 960;

const DISABLE_FLAG_FALSE_VALUES = new Set(["", "0", "false", "no", "off", "n"]);

export function captionSuppressed(
  raw: string | undefined = process.env.OTHERSIDE_DISABLE_TERMINAL_TITLE,
): boolean {
  return raw !== undefined && !DISABLE_FLAG_FALSE_VALUES.has(raw.toLowerCase());
}

export function captionText(title: string | null): string {
  const text = title !== null ? sanitizeTitle(title) : "";
  return text.length > 0 ? text : FALLBACK_CAPTION;
}

export function captionMark(busy: boolean, motionStep: number): string {
  if (!busy) return IDLE_CAPTION_MARK;
  const marks = BUSY_CAPTION_MARKS;
  return marks[((motionStep % marks.length) + marks.length) % marks.length] ?? marks[0];
}

export interface CaptionRequest {
  readonly title: string | null;
  readonly busy: boolean;
  readonly motionStep: number;
  readonly suppressed?: boolean;
}

export function buildWindowCaption(request: CaptionRequest): string | null {
  if (request.suppressed ?? captionSuppressed()) return null;
  return `${captionMark(request.busy, request.motionStep)} ${captionText(request.title)}`;
}

export function writeWindowCaption(
  windowLabel: string | null,
  write: (bytes: string) => void,
): void {
  if (windowLabel === null) return;
  const plainCaption = stripAnsi(windowLabel);
  if (process.platform === "win32") {
    process.title = plainCaption;
    return;
  }
  write(osc(OSC.SET_TITLE_AND_ICON, plainCaption));
}

export interface WindowCaptionOptions {
  emit?: (bytes: string) => void;
  readBusy?: () => boolean;
  readTitle?: () => string | null;
}

export function startWindowCaption(settings: WindowCaptionOptions = {}): () => void {
  const output =
    settings.emit ??
    ((bytes: string) => {
      process.stdout.write(bytes);
    });
  const busyNow = settings.readBusy ?? (() => appStore.getState().view.busy);
  const titleOfSession = settings.readTitle ?? getSessionTitle;
  let motionStep = 0;
  let lastCaption: string | null | undefined;
  let animationClock: ReturnType<typeof setInterval> | undefined;

  const publish = (): void => {
    const windowLabel = buildWindowCaption({
      title: titleOfSession(),
      busy: busyNow(),
      motionStep,
    });
    if (windowLabel === lastCaption) return;
    lastCaption = windowLabel;
    writeWindowCaption(windowLabel, output);
  };

  const alignClock = (): void => {
    const busy = busyNow();
    if (busy && animationClock === undefined) {
      animationClock = setInterval(() => {
        motionStep += 1;
        publish();
      }, CAPTION_STEP_MS);
      if (typeof animationClock === "object" && "unref" in animationClock) {
        animationClock.unref();
      }
      return;
    }
    if (!busy && animationClock !== undefined) {
      clearInterval(animationClock);
      animationClock = undefined;
      motionStep = 0;
    }
  };

  const refreshCaptionState = (): void => {
    alignClock();
    publish();
  };

  refreshCaptionState();
  const detachTitle = sessionTitleStore.subscribe(refreshCaptionState);
  const detachView = appStore.subscribe(refreshCaptionState);

  return () => {
    detachTitle();
    detachView();
    if (animationClock !== undefined) clearInterval(animationClock);
  };
}
