import {
  list as listBackgroundTasks,
  subscribe as subscribeBackgroundTasks,
} from "@/engine/background/tasks/background.ts";
import { subscribe as subscribeTasks } from "@/engine/background/tasks/index.ts";
import { appStore } from "@/store/app-store/index.ts";
import type { ExitChord } from "@/store/exit-hint/index.ts";
import { exitHintStore } from "@/store/exit-hint/index.ts";
import { promptStore } from "@/store/prompt/index.ts";
import type {
  StringComponent,
  StringViewContext,
} from "@/terminal-runtime/string-view/component.js";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { bgPillLabelFor } from "@/ui/app/status-text.ts";
import { formatHint, HINT_JOINER, hintFor } from "@/ui/chrome/panel-hints.ts";
import { permissionChip } from "@/ui/chrome/status/bar-input.ts";
import {
  buildStatusBarRight,
  statusBarRefreshMs,
} from "@/ui/chrome/status/string-view-right-region.ts";
import { formatStatusRow, rightLaneBudget } from "@/ui/chrome/status/string-view-row.ts";
import { readStringViewBrokerState } from "@/ui/chrome/status/string-view-state.ts";
import { visiblePanelAgents } from "@/ui/chrome/string-view-running-agents.ts";
import { Color } from "@/ui/theme/theme.ts";

const EXIT_HINTS: Readonly<Record<ExitChord, string>> = {
  "ctrl-c": "Press Ctrl-C again to exit",
  "ctrl-d": "Press Ctrl-D again to exit",
};
const PASTE_EXPAND_HINT = "paste again to expand";
// The mode row's tail belongs to the mode cycle and says so at all times; the task
// shortcut announces itself beside the next task instead, where the list it opens is.
const MODE_CYCLE_HINT = " (shift+tab to cycle)";

export class StringViewStatusBar implements StringComponent {
  private unsubs: (() => void)[] = [];
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private refreshMs: number | null = null;
  private requestRender: (() => void) | undefined;

  mount(ctx: StringViewContext): void {
    this.unmount();
    this.requestRender = ctx.requestRender;
    const onChange = (): void => {
      this.syncRefreshTimer();
      ctx.requestRender();
    };
    this.unsubs = [
      appStore.subscribe(onChange),
      promptStore.subscribe(ctx.requestRender),
      exitHintStore.subscribe(ctx.requestRender),
      subscribeBackgroundTasks(ctx.requestRender),
      subscribeTasks(ctx.requestRender),
    ];
    this.syncRefreshTimer();
    ctx.requestRender();
  }

  unmount(): void {
    this.clearRefreshTimer();
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.requestRender = undefined;
  }

  // The goal's pulsing colour lives on this row now, so this row owns its clock.
  private syncRefreshTimer(): void {
    const intervalMs = statusBarRefreshMs();
    if (intervalMs === this.refreshMs && this.refreshTimer !== undefined) return;
    this.clearRefreshTimer();
    const tick = this.requestRender;
    if (intervalMs === null || tick === undefined) return;
    this.refreshMs = intervalMs;
    this.refreshTimer = setInterval(tick, intervalMs);
    this.refreshTimer.unref?.();
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer !== undefined) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    this.refreshMs = null;
  }

  render(width: number): string[] {
    const rightBudget = rightLaneBudget(width);
    const right = buildStatusBarRight(appStore.getState(), rightBudget);
    const rightSegment =
      right.length > 0 && stringWidth(right) <= rightBudget + 2 ? right : undefined;

    // The twice-to-exit hint takes over the mode row while armed, so it replaces the
    // permission chip in place instead of pushing a transient extra row above it.
    const exitHint = exitHintStore.getState();
    if (exitHint.armed) {
      return [
        formatStatusRow(
          renderTextWithStyles(EXIT_HINTS[exitHint.chord], { color: Color.muted }),
          width,
          rightSegment,
        ),
      ];
    }
    const prompt = promptStore.getState();
    let content = "";
    // The prompt's own transient line outranks the standing chips: it answers the
    // key just pressed, and it leaves on its own a moment later.
    if (prompt.notice !== null) {
      content = renderTextWithStyles(prompt.notice, { color: Color.muted });
    } else if (prompt.pasteExpandHint) {
      content = renderTextWithStyles(PASTE_EXPAND_HINT, { color: Color.muted, dim: true });
    } else if (prompt.search !== null) {
      const label = prompt.search.failed ? "no matching prompt" : "search prompts";
      content =
        renderTextWithStyles(`${label} (${prompt.search.scope}): `, {
          color: Color.muted,
          dim: true,
        }) +
        renderTextWithStyles(prompt.search.query, { color: Color.muted }) +
        renderTextWithStyles(" ", { inverse: true });
    } else if (prompt.bashMode) {
      content = renderTextWithStyles("! for shell mode", { color: Color.bashMode });
    } else if (appStore.getState().view.panelFocused) {
      // The cursor is on the agent rows: the mode row's left side names what the
      // keys do there, in place of the permission chip; the right region stays.
      // A settled row's x closes, a live row's x stops — the hint says which.
      // With a fleet worth stopping (2+ live agents) and room to say so, the
      // stop-all chord joins the hint.
      const view = appStore.getState().view;
      const agents = visiblePanelAgents(listBackgroundTasks(), view.viewingAgentId ?? undefined);
      const focusedAgent = view.panelSelection >= 1 ? agents[view.panelSelection - 1] : undefined;
      const focusedSettled = focusedAgent !== undefined && focusedAgent.status !== "running";
      const runningAgents = agents.filter((task) => task.status === "running").length;
      const hints = [
        formatHint(hintFor("enterView")),
        formatHint(hintFor(focusedSettled ? "xClear" : "xStop")),
      ];
      if (runningAgents >= 2 && width >= 90) hints.push(formatHint(hintFor("stopAllAgents")));
      content = renderTextWithStyles(hints.join(HINT_JOINER), { color: Color.muted });
    } else {
      content = standingContent(prompt.editorMode);
    }
    return [formatStatusRow(content, width, rightSegment)];
  }
}

/**
 * The row when nothing transient has taken it over: the editor mode being typed
 * in, then the permission mode the session is in. Every branch above replaces the
 * row outright, which is what keeps the announcement off a search or an exit
 * warning — those own the line while they are up.
 */
function standingContent(announcement: string | null): string {
  const segments: string[] = [];
  if (announcement !== null) {
    segments.push(renderTextWithStyles(announcement, { color: Color.muted }));
  }
  const chip = permissionChip(readStringViewBrokerState());
  if (chip !== null) {
    segments.push(
      renderTextWithStyles(`${chip.symbol} `, { color: chip.color, bold: true }) +
        renderTextWithStyles(chip.text, { color: chip.color, bold: true }) +
        chipTail(announcement !== null),
    );
  }
  return segments.join(" ");
}

/**
 * What trails the permission chip. A background shell is live state and always
 * says so; the chord that cycles the mode is teaching material, so it gives way
 * while an editor mode shares the row rather than letting the row's own clipping
 * decide which of the two is lost.
 */
function chipTail(announced: boolean): string {
  const shellLabel = bgPillLabelFor(listBackgroundTasks().filter((task) => task.kind === "shell"));
  if (shellLabel === undefined) {
    return announced ? "" : renderTextWithStyles(MODE_CYCLE_HINT, { color: Color.muted });
  }
  const pill = appStore.getState().view.bgPillFocused
    ? renderTextWithStyles(` ${shellLabel} `, {
        color: Color.queueBackground,
        backgroundColor: Color.panelAccent,
        bold: true,
      })
    : renderTextWithStyles(shellLabel, { color: Color.panelAccent });
  return renderTextWithStyles(" · ", { color: Color.muted }) + pill;
}
