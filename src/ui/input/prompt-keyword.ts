import { isWorkflowKeywordTriggerEnabled } from "@/engine/background/workflows/runtime/gate.ts";
import { resolveConfig } from "@/kernel/config/resolver.ts";
import { onSettingsChanged } from "@/kernel/config/settings-watch.ts";
import { promptStore, setPromptKeywordDismissed } from "@/store/prompt/index.ts";

/**
 * What the prompt knows about the keyword that opts a turn into orchestration:
 * whether writing it does anything at all, and whether this draft turned it off.
 *
 * The setting is read on mount and when a settings file settles, never per
 * paint — the prompt repaints on every keystroke and the answer is on disk.
 */
export class PromptKeyword {
  private enabled = true;
  private unwatch: (() => void) | undefined;

  constructor(private readonly requestRender: () => void) {}

  mount(): void {
    this.unmount();
    this.read();
    this.unwatch = onSettingsChanged(() => {
      this.read();
      this.requestRender();
    });
  }

  unmount(): void {
    this.unwatch?.();
    this.unwatch = undefined;
  }

  /** Whether writing the keyword opts the turn in, so the draft can say so. */
  triggerEnabled(): boolean {
    return this.enabled;
  }

  dismissed(): boolean {
    return promptStore.getState().keywordDismissed;
  }

  /** Turns this draft's keyword off, or back on. */
  toggleDismissal(): void {
    setPromptKeywordDismissed(!this.dismissed());
    this.requestRender();
  }

  private read(): void {
    this.enabled = isWorkflowKeywordTriggerEnabled(resolveConfig(process.cwd()));
  }
}
