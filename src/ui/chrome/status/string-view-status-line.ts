import { DEFAULT_OUTPUT_STYLE } from "@/harness/routines/output-styles/built-in.ts";
import { resolveConfig } from "@/kernel/config/resolver.ts";
import { onSettingsChanged } from "@/kernel/config/settings-watch.ts";
import { appStore } from "@/store/app-store/index.ts";
import {
  expireCurrentNotice,
  submitOrchestrationNotice,
  tickRegionRefresh,
} from "@/store/app-store/right-region-notices.ts";
import { selectNextDeadlineAt } from "@/store/app-store/slices/right-region.ts";
import type {
  StringComponent,
  StringViewContext,
} from "@/terminal-runtime/string-view/component.js";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { viewedThread } from "@/ui/app/viewed-thread.ts";
import {
  buildStatuslineInput,
  fastModeStatuslineSuffix,
  nextOrchestrationNotice,
  renderNativeStatusline,
} from "@/ui/chrome/status/line-input.ts";
import {
  buildStatusLineRight,
  statusLineRefreshMs,
} from "@/ui/chrome/status/string-view-right-region.ts";
import { formatStatusRow, rightLaneBudget } from "@/ui/chrome/status/string-view-row.ts";
import { readStringViewBrokerState } from "@/ui/chrome/status/string-view-state.ts";
import { Color } from "@/ui/theme/theme.ts";

export class StringViewStatusLine implements StringComponent {
  private unsub: (() => void) | undefined;
  private unwatchSettings: (() => void) | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private refreshMs: number | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private deadlineAt: number | null = null;
  private requestRender: (() => void) | undefined;
  /**
   * Held rather than resolved per paint: the row repaints on every keystroke and
   * config lives on disk. Re-read when a settings file settles, which is the only
   * moment the answer can differ.
   */
  private outputStyle = DEFAULT_OUTPUT_STYLE;

  mount(ctx: StringViewContext): void {
    this.unsub?.();
    this.unwatchSettings?.();
    this.requestRender = ctx.requestRender;
    this.readOutputStyle();
    this.unsub = appStore.subscribe(() => {
      this.syncRefreshTimer();
      this.syncDeadlineTimer();
      ctx.requestRender();
    });
    this.unwatchSettings = onSettingsChanged(() => {
      this.readOutputStyle();
      ctx.requestRender();
    });
    this.syncRefreshTimer();
    this.syncDeadlineTimer();
    ctx.requestRender();
  }

  unmount(): void {
    this.clearRefreshTimer();
    this.clearDeadlineTimer();
    this.unsub?.();
    this.unsub = undefined;
    this.unwatchSettings?.();
    this.unwatchSettings = undefined;
    this.requestRender = undefined;
  }

  private readOutputStyle(): void {
    this.outputStyle = resolveConfig(process.cwd()).outputStyle ?? DEFAULT_OUTPUT_STYLE;
  }

  render(width: number): string[] {
    // The transient mode notice fires on the truth this row paints — at startup
    // and on every switch. The main broker is the unit observed: a viewed agent's
    // thread swapping in must not read as a mode change.
    const notice = nextOrchestrationNotice(readStringViewBrokerState().orchestrationMode);
    if (notice !== null) submitOrchestrationNotice(notice);

    // The row states the route and the context of whatever document is open, so an
    // agent's own numbers replace the leader's while its document is on screen.
    const thread = viewedThread();
    const state = thread.broker;
    const appState = appStore.getState();
    const usage = thread.context;
    const input = buildStatuslineInput({
      state,
      sessionId: "",
      version: "",
      cwd: process.cwd(),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      outputStyle: this.outputStyle,
    });
    // Effort rides the promptbar badge now; the status row keeps the native line
    // (fast-mode token highlighted) minus the effort suffix.
    const native = renderNativeStatusline(input);
    const fastToken = fastModeStatuslineSuffix(state);
    const left = highlightStatusline(native, fastToken);

    const rightBudget = rightLaneBudget(width);
    const right = buildStatusLineRight(appState, rightBudget);
    // Drop anything the helper returned wider than the budget (it should not).
    const beside = right.length > 0 && stringWidth(right) <= rightBudget + 2 ? right : undefined;

    return [formatStatusRow(left, width, beside)];
  }

  private syncRefreshTimer(): void {
    const intervalMs = statusLineRefreshMs(appStore.getState());
    if (intervalMs === this.refreshMs && this.refreshTimer !== undefined) return;
    this.clearRefreshTimer();
    const tick = this.requestRender;
    if (intervalMs === null || tick === undefined) return;
    this.refreshMs = intervalMs;
    this.refreshTimer = setInterval(tick, intervalMs);
    this.refreshTimer.unref?.();
  }

  private syncDeadlineTimer(): void {
    const now = Date.now();
    const deadlineAt = selectNextDeadlineAt(appStore.getState().rightRegion, now);
    if (deadlineAt === this.deadlineAt && this.deadlineTimer !== undefined) return;
    this.clearDeadlineTimer();
    if (deadlineAt === null) return;
    this.deadlineAt = deadlineAt;
    this.deadlineTimer = setTimeout(
      () => {
        this.deadlineTimer = undefined;
        this.deadlineAt = null;
        const tick = Date.now();
        expireCurrentNotice(tick);
        tickRegionRefresh(tick);
      },
      Math.max(0, deadlineAt - now),
    );
    this.deadlineTimer.unref?.();
  }

  private clearDeadlineTimer(): void {
    if (this.deadlineTimer !== undefined) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = undefined;
    this.deadlineAt = null;
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer !== undefined) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    this.refreshMs = null;
  }
}

function highlightStatusline(text: string, fastToken: string | null): string {
  if (fastToken === null) return renderTextWithStyles(text, { color: Color.muted });
  const start = text.lastIndexOf(fastToken);
  if (start < 0) return renderTextWithStyles(text, { color: Color.muted });
  return (
    renderTextWithStyles(text.slice(0, start), { color: Color.muted }) +
    renderTextWithStyles(fastToken, { color: Color.fastMode, bold: true }) +
    renderTextWithStyles(text.slice(start + fastToken.length), { color: Color.muted })
  );
}
