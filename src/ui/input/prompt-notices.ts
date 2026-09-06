import { createAutoClearDispatch } from "@/kernel/std/state/auto-clear-dispatch.ts";
import { setPromptNotice } from "@/store/prompt/index.ts";

const ESCAPE_CLEAR_HOLD_MS = 800;
const NOTICE_HOLD_MS = 3_000;

export class PromptNotices {
  private readonly escapeClear = createAutoClearDispatch({ holdMs: ESCAPE_CLEAR_HOLD_MS });
  private readonly hold = createAutoClearDispatch({ holdMs: NOTICE_HOLD_MS });

  constructor(private readonly requestRender: () => void) {}

  isClearArmed(): boolean {
    return this.escapeClear.isArmed();
  }

  armClear(): void {
    this.escapeClear.arm({ onTimeout: () => this.clear() });
  }

  disarmClear(): void {
    this.escapeClear.clear();
    this.clear();
  }

  show(text: string): void {
    setPromptNotice(text);
    this.hold.arm({ onTimeout: () => setPromptNotice(null) });
    this.requestRender();
  }

  clear(): void {
    this.hold.clear();
    setPromptNotice(null);
    this.requestRender();
  }

  dispose(): void {
    this.disarmClear();
  }
}
