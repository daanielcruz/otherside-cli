import { configPath, loadConfigSync } from "@/kernel/config/config.ts";
import type { HookEntry, HookEvent } from "@/kernel/hooks/index.ts";
import { listAllSessionHooks } from "@/kernel/hooks/session-registry.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { wrapAnsi, wrapProse } from "@/terminal-runtime/text/ansi-wrap.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import {
  type FooterPanelSpec,
  renderFooterPanel,
  renderPanelRowLine,
} from "@/ui/chrome/string-view-panel.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";
import { Color } from "@/ui/theme/theme.ts";

const CONTENT_PAD = 2;
const SETTINGS_ROW_WIDTH = 22;
const HOOK_ROW_WIDTH = 24;
const COMMAND_CLIP = 100;

// The events the panel surfaces, in display order (a subset of the full registry).
const HOOK_EVENTS: HookEvent[] = [
  "preToolUse",
  "postToolUse",
  "userPromptSubmit",
  "stop",
  "subagentStop",
  "preCompact",
];

interface HookRow {
  event: HookEvent;
  entry: HookEntry | null;
  via?: string;
}

/**
 * Read-only hooks browser on the string model. Lists the configured hooks (from
 * settings.json) merged with any session-registered hooks, one selectable row per
 * hook; editing happens in the settings file, so navigation only moves the selection
 * and Escape closes.
 */
class HooksPanel implements StringViewPanel {
  private ctx: StringViewContext | undefined;
  private cursor = 0;
  private readonly sessionId: string;

  constructor(
    private readonly close: () => void,
    props?: unknown,
  ) {
    this.sessionId = readSessionId(props);
  }

  mount(ctx: StringViewContext): void {
    this.ctx = ctx;
    ctx.requestRender();
  }

  unmount(): void {
    this.ctx = undefined;
  }

  render(width: number): string[] {
    const rows = this.rows();
    const contentWidth = Math.max(1, width - CONTENT_PAD * 2);
    const configuredCount = rows.filter((row) => row.entry !== null).length;

    const body: string[] = [];
    body.push(renderTextWithStyles(`${configuredCount} hooks configured`, { color: Color.text }));
    body.push("");
    body.push(
      renderTextWithStyles(`read-only · edit ${configPath()} to modify hooks`, {
        color: Color.muted,
      }),
    );
    body.push(
      renderPanelRowLine(
        { label: "Settings file", value: configPath(), muted: true },
        contentWidth,
        SETTINGS_ROW_WIDTH,
      ),
    );
    body.push("");

    rows.forEach((row, index) => {
      const selected = index === this.cursor;
      if (row.entry === null) {
        body.push(
          renderPanelRowLine(
            { label: row.event, value: "no hooks configured", selected, muted: true },
            contentWidth,
            HOOK_ROW_WIDTH,
          ),
        );
        return;
      }
      const label = row.via ? `${row.event} (via: ${row.via})` : row.event;
      const matcher = row.entry.matcher.length > 0 ? row.entry.matcher : "<any>";
      body.push(
        renderPanelRowLine(
          { label, value: matcher, selected, active: true },
          contentWidth,
          HOOK_ROW_WIDTH,
        ),
      );
      const detail = clip(
        row.entry.type === "prompt" ? `prompt: ${row.entry.prompt}` : row.entry.command,
        COMMAND_CLIP,
      );
      const detailWidth = Math.max(1, contentWidth - CONTENT_PAD);
      const wrappedDetail =
        row.entry.type === "prompt"
          ? wrapProse(detail, detailWidth)
          : wrapAnsi(detail, detailWidth, {
              hard: true,
              trim: false,
              wordWrap: true,
            }).split("\n");
      for (const line of wrappedDetail) {
        body.push("  " + renderTextWithStyles(line, { color: Color.muted }));
      }
    });

    const spec: FooterPanelSpec = {
      command: "/hooks",
      title: "Hooks",
      footerHints: [
        ["↑↓", "navigate"],
        ["Esc", "close"],
      ],
      body,
    };
    return renderFooterPanel(spec, width);
  }

  handleKey(key: KeyEventData): void {
    const count = this.rows().length;
    switch (key.name) {
      case "up":
        this.cursor = Math.max(0, this.cursor - 1);
        this.ctx?.requestRender();
        return;
      case "down":
        this.cursor = Math.min(Math.max(0, count - 1), this.cursor + 1);
        this.ctx?.requestRender();
        return;
      case "escape":
        this.close();
        return;
    }
    if (key.sequence === "q") this.close();
  }

  private rows(): HookRow[] {
    const hooks = loadConfigSync().hooks ?? {};
    const sessionHooks = listAllSessionHooks(this.sessionId);
    const rows: HookRow[] = [];
    for (const event of HOOK_EVENTS) {
      const configured = hooks[event] ?? [];
      const session = sessionHooks.get(event) ?? [];
      if (configured.length === 0 && session.length === 0) {
        rows.push({ event, entry: null });
        continue;
      }
      for (const entry of configured) rows.push({ event, entry });
      for (const item of session) rows.push({ event, entry: item.entry, via: item.via });
    }
    return rows;
  }
}

function readSessionId(props: unknown): string {
  if (typeof props === "object" && props !== null && "sessionId" in props) {
    const value = (props as { sessionId?: unknown }).sessionId;
    if (typeof value === "string") return value;
  }
  return "";
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function createHooksPanel(close: () => void, props?: unknown): StringViewPanel {
  return new HooksPanel(close, props);
}
