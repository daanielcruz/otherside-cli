import type { ErrorActionId, ErrorMeta } from "@/engine/transport/error-meta.ts";
import { appStore, dispatch } from "@/store/app-store/index.ts";
import { overlayStack } from "@/store/overlay-stack/index.ts";
import { handleSlashRef, runningRef, runSubmittedTurnRef } from "@/store/turn-run/index.ts";
import { pendingErrorRevokeRef } from "@/store/turn-status/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { wrapAnsi, wrapProse } from "@/terminal-runtime/text/ansi-wrap.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { type FooterPanelSpec, renderFooterPanel } from "@/ui/chrome/string-view-panel.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

const RAW_DETAIL_CAP = 4000;
const CONTENT_PAD = 2;

const FALLBACK_META: ErrorMeta = {
  source: "transport",
  errorClass: "other",
  modal: true,
  retryable: false,
  title: "Error",
  summary: "An error occurred.",
  rawDetail: "",
  actions: [{ id: "cancel", label: "Dismiss" }],
};

/**
 * Turn-error chooser on the string model. Summary + numbered actions + collapsible
 * raw detail; Enter (or 1–N) runs the selected recovery action, `d` toggles details,
 * Escape cancels. Meta comes from the opener payload (or `view.errorPanel` in the app
 * store); attempt count / raw-expanded follow the store when present.
 */
class ErrorPanel implements StringViewPanel {
  private ctx: StringViewContext | undefined;
  private unsub: (() => void) | undefined;
  private selected = 0;
  private localRawExpanded = false;
  private readonly propsMeta: ErrorMeta | null;
  private readonly onAction: ((id: ErrorActionId) => void) | undefined;

  constructor(
    private readonly close: () => void,
    props?: unknown,
  ) {
    this.propsMeta = narrowErrorMeta(props);
    this.onAction = narrowErrorAction(props);
  }

  mount(ctx: StringViewContext): void {
    this.ctx = ctx;
    this.unsub = appStore.subscribe(() => {
      this.ctx?.requestRender();
    });
    ctx.requestRender();
  }

  unmount(): void {
    this.unsub?.();
    this.unsub = undefined;
    this.ctx = undefined;
  }

  render(width: number): string[] {
    const { meta, attemptCount, rawExpanded } = this.readState();
    const count = meta.actions.length;
    if (count > 0) this.selected = Math.max(0, Math.min(count - 1, this.selected));

    const title =
      attemptCount > 1 ? `${meta.title} · ${ordinal(attemptCount)} attempt` : meta.title;
    const contentWidth = Math.max(1, width - CONTENT_PAD * 2);
    const body: string[] = [];

    for (const line of wrapPlain(meta.summary, contentWidth)) {
      body.push(renderTextWithStyles(line, { color: Color.text }));
    }
    body.push("");

    meta.actions.forEach((action, idx) => {
      const isSelected = idx === this.selected;
      const marker = renderTextWithStyles(isSelected ? Glyph.chevron : "  ", {
        color: isSelected ? Color.panelAccent : Color.muted,
      });
      const label = renderTextWithStyles(`${idx + 1}. ${action.label}`, {
        color: isSelected ? Color.panelAccent : Color.text,
      });
      body.push(marker + label);
    });

    body.push("");
    body.push(
      renderTextWithStyles(
        rawExpanded
          ? `${Glyph.triangleFilled} Hide details (d)`
          : `${Glyph.triangle} Show details (d)`,
        { color: Color.muted },
      ),
    );

    if (rawExpanded && meta.rawDetail.length > 0) {
      const rawDetail =
        meta.rawDetail.length > RAW_DETAIL_CAP
          ? meta.rawDetail.slice(0, RAW_DETAIL_CAP)
          : meta.rawDetail;
      for (const line of wrapAnsi(rawDetail, contentWidth, {
        hard: true,
        trim: false,
        wordWrap: true,
      }).split("\n")) {
        body.push(renderTextWithStyles(line, { color: Color.muted }));
      }
    }

    const spec: FooterPanelSpec = {
      title,
      footerHints: [
        ["Enter", "confirm"],
        ["d", "details"],
        ["Esc", "cancel"],
      ],
      body,
    };
    return renderFooterPanel(spec, width);
  }

  handleKey(key: KeyEventData): void {
    const { meta } = this.readState();
    const count = meta.actions.length;

    switch (key.name) {
      case "up":
        this.move(-1, count);
        return;
      case "down":
        this.move(1, count);
        return;
      case "tab":
        this.move(key.shift ? -1 : 1, count);
        return;
      case "return":
        this.activate();
        return;
      case "escape":
        this.runAction("cancel");
        return;
    }

    if (key.sequence === "d" || key.sequence === "D") {
      this.toggleRaw();
      return;
    }

    const digit = Number.parseInt(key.sequence ?? "", 10);
    if (Number.isInteger(digit) && digit >= 1 && digit <= count) {
      this.selected = digit - 1;
      this.activate();
    }
  }

  private readState(): {
    meta: ErrorMeta;
    attemptCount: number;
    rawExpanded: boolean;
  } {
    const panel = appStore.getState().view.errorPanel;
    if (panel) {
      // Store is the live source (show + bumpErrorAttempt); props seed when absent.
      return {
        meta: panel.meta,
        attemptCount: panel.attemptCount,
        rawExpanded: panel.rawExpanded,
      };
    }
    return {
      meta: this.propsMeta ?? FALLBACK_META,
      attemptCount: 1,
      rawExpanded: this.localRawExpanded,
    };
  }

  private move(delta: number, count: number): void {
    if (count <= 0) return;
    this.selected = (this.selected + delta + count) % count;
    this.ctx?.requestRender();
  }

  private toggleRaw(): void {
    const panel = appStore.getState().view.errorPanel;
    if (panel) {
      dispatch({ type: "view/toggleErrorRaw" });
      return;
    }
    this.localRawExpanded = !this.localRawExpanded;
    this.ctx?.requestRender();
  }

  private activate(): void {
    const { meta } = this.readState();
    const action = meta.actions[this.selected];
    if (action) this.runAction(action.id);
  }

  private runAction(id: ErrorActionId): void {
    if (this.onAction) {
      this.close();
      this.onAction(id);
      return;
    }
    dispatch({ type: "view/hideErrorPanel" });

    if (id === "retry" || id === "continue-anyway") {
      pendingErrorRevokeRef.current = false;
      if (!runningRef.current) void runSubmittedTurnRef.current("");
    } else if (id === "switch-model") {
      pendingErrorRevokeRef.current = false;
      this.close();
      overlayStack.open("model");
      return;
    } else if (id === "compact") {
      pendingErrorRevokeRef.current = false;
      this.close();
      handleSlashRef.current("/compact");
      return;
    } else {
      // cancel — React revoked the last unanswered user message when the flag was set.
      // Without a Session reference here, leave the flag for a higher layer / next turn.
    }

    this.close();
  }
}

function narrowErrorAction(props: unknown): ((id: ErrorActionId) => void) | undefined {
  if (typeof props !== "object" || props === null) return undefined;
  const action = (props as Record<string, unknown>).onAction;
  return typeof action === "function" ? (action as (id: ErrorActionId) => void) : undefined;
}

function narrowErrorMeta(props: unknown): ErrorMeta | null {
  if (typeof props !== "object" || props === null) return null;
  const record = props as Record<string, unknown>;

  if (isErrorMetaShape(record)) return record as unknown as ErrorMeta;

  // Accept ErrorPanelState-shaped payloads ({ meta, attemptCount, rawExpanded }).
  if (typeof record.meta === "object" && record.meta !== null && isErrorMetaShape(record.meta)) {
    return record.meta as unknown as ErrorMeta;
  }

  return null;
}

function isErrorMetaShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.title === "string" &&
    typeof r.summary === "string" &&
    typeof r.rawDetail === "string" &&
    Array.isArray(r.actions)
  );
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function wrapPlain(text: string, width: number): string[] {
  if (text.length === 0) return [""];
  return wrapProse(text, width);
}

export function createErrorPanel(close: () => void, props?: unknown): StringViewPanel {
  return new ErrorPanel(close, props);
}
