import { configPath } from "@/kernel/config/config.ts";
import type { PermissionRule } from "@/kernel/permissions/index.ts";
import { READ_ONLY_PERMISSION_SOURCES } from "@/kernel/permissions/index.ts";
import { loadRules, saveRules } from "@/kernel/permissions/persist.ts";
import { serializeRuleValue } from "@/kernel/permissions/types.ts";
import { clampIndex } from "@/kernel/std/math.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import type { TerminalColor } from "@/terminal-runtime/text/style-model.js";
import { panelLeaves } from "@/ui/chrome/panel-keys.ts";
import { readStringViewBrokerState } from "@/ui/chrome/status/string-view-state.ts";
import {
  type FooterPanelSpec,
  labelColumnWidth,
  type PanelRowSpec,
  renderFooterPanel,
  renderPanelRowLine,
} from "@/ui/chrome/string-view-panel.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";
import { Color } from "@/ui/theme/theme.ts";

const CONTENT_PAD = 2;
const META_ROW_WIDTH = 28;
// Columns kept for the right-aligned rule source (e.g. "projectSettings") + gap.
const RULE_SOURCE_RESERVE = 18;

/**
 * Permissions rules browser on the string model. Lists persisted allow/ask/deny
 * rules across user/project/local (and policy) sources, shows the session
 * permission mode, and lets the user delete editable rules or reload from disk.
 * Escape / left / q close the overlay.
 */
class PermissionsPanel implements StringViewPanel {
  private ctx: StringViewContext | undefined;
  private rules: PermissionRule[] | null = null;
  private idx = 0;
  private feedback: string | null = null;
  private loadSeq = 0;
  private cancelled = false;
  private readonly cwd = process.cwd();

  constructor(private readonly close: () => void) {}

  mount(ctx: StringViewContext): void {
    this.ctx = ctx;
    this.cancelled = false;
    this.refresh();
    ctx.requestRender();
  }

  unmount(): void {
    this.cancelled = true;
    this.loadSeq += 1;
    this.ctx = undefined;
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - CONTENT_PAD * 2);
    const broker = readStringViewBrokerState();
    const loaded = this.rules ?? [];
    const idx = clampIndex(this.idx, loaded.length);

    const body: string[] = [];
    body.push(
      renderPanelRowLine(
        { label: "Session-scoped mode", value: broker.permissionMode },
        contentWidth,
        META_ROW_WIDTH,
      ),
    );
    body.push(
      renderPanelRowLine(
        { label: "Rules file", value: configPath(), muted: true },
        contentWidth,
        META_ROW_WIDTH,
      ),
    );
    body.push("");

    if (this.rules === null) {
      body.push(renderTextWithStyles("loading rules", { color: Color.muted }));
    } else if (loaded.length === 0) {
      body.push(renderTextWithStyles("no persisted rules", { color: Color.muted }));
    } else {
      // Reserve room for the source column so a long rule can't push it off-screen.
      const maxRuleLabel = Math.max(12, contentWidth - RULE_SOURCE_RESERVE);
      const specs = loaded.map((rule, i) => ruleRowSpec(rule, i === idx, maxRuleLabel));
      // Sized to the rules on screen, so every source lands in one column instead
      // of each one sitting a space after a rule of its own length — and never past
      // the reserve, or the column they align in is one the source cannot fit in.
      const column = Math.min(labelColumnWidth(specs.map((spec) => spec.label)), maxRuleLabel);
      for (const spec of specs) {
        body.push(renderPanelRowLine(spec, contentWidth, column));
      }
    }

    if (this.feedback !== null) {
      body.push("");
      body.push(renderTextWithStyles(this.feedback, { color: Color.muted }));
    }

    const spec: FooterPanelSpec = {
      command: "/permissions",
      title: "Permissions",
      footerHints: [
        ["↑↓", "navigate"],
        ["x", "delete rule"],
        ["r", "reload"],
        ["Esc", "close"],
      ],
      body,
    };
    return renderFooterPanel(spec, width);
  }

  handleKey(key: KeyEventData): void {
    if (panelLeaves(key)) {
      this.close();
      return;
    }
    if (key.name === "up") {
      this.moveSelected(-1);
      return;
    }
    if (key.name === "down") {
      this.moveSelected(1);
      return;
    }

    const sequence = key.sequence;
    if (key.ctrl || key.meta || sequence === undefined) return;

    if (sequence === "q") {
      this.close();
      return;
    }
    if (sequence === "r") {
      this.refresh();
      return;
    }
    if (sequence === "x") {
      this.deleteSelected();
    }
  }

  private moveSelected(delta: number): void {
    const count = this.rules?.length ?? 0;
    if (count <= 0) return;
    this.idx = Math.max(0, Math.min(count - 1, clampIndex(this.idx, count) + delta));
    this.ctx?.requestRender();
  }

  private refresh(): void {
    const seq = ++this.loadSeq;
    this.rules = null;
    this.idx = 0;
    this.feedback = null;
    this.ctx?.requestRender();
    void loadRules(this.cwd).then((loaded) => {
      if (this.cancelled || seq !== this.loadSeq) return;
      this.rules = loaded;
      this.idx = 0;
      this.feedback = null;
      this.ctx?.requestRender();
    });
  }

  private deleteSelected(): void {
    const loaded = this.rules ?? [];
    const selected = loaded[clampIndex(this.idx, loaded.length)];
    if (!selected) return;
    if (READ_ONLY_PERMISSION_SOURCES.has(selected.source)) {
      this.feedback = `${selected.source} rules cannot be removed here`;
      this.ctx?.requestRender();
      return;
    }
    const key = ruleKey(selected);
    const next = loaded.filter((rule) => ruleKey(rule) !== key);
    this.rules = next;
    this.idx = Math.min(this.idx, Math.max(0, next.length - 1));
    this.ctx?.requestRender();
    const seq = this.loadSeq;
    void saveRules(next, this.cwd).then(() => {
      if (this.cancelled || seq !== this.loadSeq) return;
      this.feedback = `removed ${serializeRuleValue(selected.ruleValue)}`;
      this.ctx?.requestRender();
    });
  }
}

function ruleKey(rule: PermissionRule): string {
  return `${rule.source}|${rule.ruleBehavior}|${serializeRuleValue(rule.ruleValue)}`;
}

function behaviorColor(behavior: PermissionRule["ruleBehavior"]): TerminalColor | undefined {
  if (behavior === "deny") return Color.error;
  if (behavior === "ask") return Color.warning;
  return undefined;
}

function ruleRowSpec(rule: PermissionRule, selected: boolean, maxLabelWidth: number): PanelRowSpec {
  const color = behaviorColor(rule.ruleBehavior);
  // A serialized rule value can be huge and multi-line (e.g. an embedded workflow
  // script); collapse whitespace to one line and cap it so the row stays single-line.
  const value = serializeRuleValue(rule.ruleValue).replace(/\s+/g, " ").trim();
  const label = truncateEllipsis(`${rule.ruleBehavior} ${value}`, maxLabelWidth);
  return {
    label,
    value: rule.source,
    selected,
    active: rule.ruleBehavior === "allow",
    ...(color !== undefined ? { valueColor: color } : {}),
  };
}

export function createPermissionsPanel(close: () => void, _props?: unknown): StringViewPanel {
  return new PermissionsPanel(close);
}
