import {
  list as listAgents,
  type SubagentDef,
  type SubagentScope,
} from "@/engine/agents/registry.ts";
import { getProviderConfig } from "@/engine/contract/registry.ts";
import { computeItemCountWindow } from "@/kernel/std/list-window.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { wrapProse } from "@/terminal-runtime/text/ansi-wrap.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { panelLeaves } from "@/ui/chrome/panel-keys.ts";
import { readStringViewBrokerState } from "@/ui/chrome/status/string-view-state.ts";
import {
  FALLBACK_TERMINAL_COLUMNS,
  FALLBACK_TERMINAL_ROWS,
  type FooterPanelSpec,
  footerPanelBodyBudget,
  type ListPanelSpec,
  renderFooterPanel,
  renderListPanel,
  renderPanelRowLine,
} from "@/ui/chrome/string-view-panel.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";
import { Color } from "@/ui/theme/theme.ts";

const CONTENT_PAD = 2;
const DETAIL_ROW_WIDTH = 16;
const BODY_CLIP = 600;

/** Display order for the agent library (matches the React sections). */
const AGENT_LIBRARY_SCOPES: SubagentScope[] = ["user", "project", "builtin"];

const SCOPE_LABEL: Record<SubagentScope, string> = {
  user: "User",
  project: "Project",
  builtin: "Built-in",
};

/**
 * Read-only agent library on the string model. Lists registered subagents ordered by
 * scope (user → project → built-in); Enter opens a definition detail view, Escape/←
 * returns from detail or closes the overlay. Create/edit surfaces are not ported —
 * agent definitions are still managed via markdown loaders.
 */
class AgentsPanel implements StringViewPanel {
  private ctx: StringViewContext | undefined;
  private cursor = 0;
  private detailId: string | null = null;
  /**
   * Width of the last frame drawn. A page jump has to spend the rows the reader is
   * looking at, and how many the chrome takes depends on the width the hints wrapped
   * at — which only the render knows.
   */
  private lastWidth = FALLBACK_TERMINAL_COLUMNS;

  constructor(private readonly close: () => void) {}

  mount(ctx: StringViewContext): void {
    this.ctx = ctx;
    this.clampCursor();
    ctx.requestRender();
  }

  unmount(): void {
    this.ctx = undefined;
  }

  render(width: number): string[] {
    this.lastWidth = width;
    const library = orderedAgentLibrary(listAgents());
    this.clampCursor(library.length);
    const detail = this.detailAgent(library);
    if (detail) return this.renderDetail(detail, width);
    return this.renderList(library, width);
  }

  handleKey(key: KeyEventData): void {
    const library = orderedAgentLibrary(listAgents());
    this.clampCursor(library.length);
    const detail = this.detailAgent(library);

    if (detail) {
      if (panelLeaves(key)) {
        this.detailId = null;
        this.ctx?.requestRender();
        return;
      }
      return;
    }

    const pageRows = this.listPageRows(library);

    switch (key.name) {
      case "up":
        this.cursor = Math.max(0, this.cursor - 1);
        this.ctx?.requestRender();
        return;
      case "down":
        this.cursor = Math.min(Math.max(0, library.length - 1), this.cursor + 1);
        this.ctx?.requestRender();
        return;
      case "pageup":
        this.cursor = pageAgentLibraryIndex(this.cursor, library.length, -1, pageRows);
        this.ctx?.requestRender();
        return;
      case "pagedown":
        this.cursor = pageAgentLibraryIndex(this.cursor, library.length, 1, pageRows);
        this.ctx?.requestRender();
        return;
      case "return": {
        const agent = library[this.cursor];
        if (agent) {
          this.detailId = agent.id;
          this.ctx?.requestRender();
        }
        return;
      }
      case "escape":
      case "left":
        this.close();
        return;
    }

    if (key.sequence === "q") this.close();
  }

  private renderList(library: SubagentDef[], width: number): string[] {
    return renderListPanel(this.listSpec(library), width);
  }

  private listSpec(library: SubagentDef[]): ListPanelSpec {
    const shortKey = resolveProviderShortKey();
    const count = library.length;
    // Counter format comes with the shared item-count window policy.
    const counter = computeItemCountWindow({
      cursor: this.cursor,
      total: count,
      visibleCount: Math.max(1, count),
    }).counter;

    const items = library.map((agent, index) => {
      const model = pickModelLabel(agent, shortKey);
      const bg = agent.background ? " · background" : "";
      // Match the React LibraryPane: description only under the focused row.
      return {
        id: agent.id,
        label: agent.name,
        value: `${SCOPE_LABEL[agent.scope]} · ${model}${bg}`,
        ...(index === this.cursor && agent.description ? { description: agent.description } : {}),
      };
    });

    return {
      command: "/agents",
      title: `Agents ${counter}`,
      items,
      cursor: this.cursor,
      maxRows: this.terminalRows(),
      emptyLabel: "no subagents registered",
      footerHints:
        count === 0
          ? [["Esc", "close"]]
          : [
              ["↑↓", "navigate"],
              ["PgUp/PgDn", "page"],
              ["Enter", "detail"],
              ["Esc", "close"],
            ],
    };
  }

  /**
   * Rows a page jump moves the cursor: the body budget of the list frame,
   * derived from the shared chrome instead of a restated row count.
   */
  private listPageRows(library: SubagentDef[]): number {
    const spec = this.listSpec(library);
    const footerSpec: FooterPanelSpec = { title: spec.title, body: [] };
    if (spec.command !== undefined) footerSpec.command = spec.command;
    if (spec.subtitle !== undefined) footerSpec.subtitle = spec.subtitle;
    if (spec.footerHints !== undefined) footerSpec.footerHints = spec.footerHints;
    return footerPanelBodyBudget(footerSpec, this.terminalRows(), this.lastWidth);
  }

  private terminalRows(): number {
    return this.ctx?.terminalRows?.() ?? FALLBACK_TERMINAL_ROWS;
  }

  private renderDetail(agent: SubagentDef, width: number): string[] {
    const contentWidth = Math.max(1, width - CONTENT_PAD * 2);
    const shortKey = resolveProviderShortKey();
    const body: string[] = [];

    body.push(renderTextWithStyles(agent.name, { color: Color.panelAccent, bold: true }));
    body.push("");

    for (const line of wrapProse(agent.description, contentWidth)) {
      body.push(renderTextWithStyles(line, { color: Color.text }));
    }
    body.push("");

    body.push(
      renderPanelRowLine(
        { label: "Scope", value: SCOPE_LABEL[agent.scope] },
        contentWidth,
        DETAIL_ROW_WIDTH,
      ),
    );
    body.push(
      renderPanelRowLine(
        { label: "Model", value: pickModelLabel(agent, shortKey) },
        contentWidth,
        DETAIL_ROW_WIDTH,
      ),
    );
    body.push(
      renderPanelRowLine(
        { label: "Background", value: agent.background ? "yes" : "no" },
        contentWidth,
        DETAIL_ROW_WIDTH,
      ),
    );
    body.push(
      renderPanelRowLine(
        { label: "Tools", value: formatTools(agent) },
        contentWidth,
        DETAIL_ROW_WIDTH,
      ),
    );

    if (agent.disallowedTools && agent.disallowedTools.length > 0) {
      body.push(
        renderPanelRowLine(
          { label: "Disallowed", value: agent.disallowedTools.join(", ") },
          contentWidth,
          DETAIL_ROW_WIDTH,
        ),
      );
    }
    if (agent.skills && agent.skills.length > 0) {
      body.push(
        renderPanelRowLine(
          { label: "Skills", value: agent.skills.join(", ") },
          contentWidth,
          DETAIL_ROW_WIDTH,
        ),
      );
    }
    if (agent.maxTurns !== undefined) {
      body.push(
        renderPanelRowLine(
          { label: "Max turns", value: String(agent.maxTurns) },
          contentWidth,
          DETAIL_ROW_WIDTH,
        ),
      );
    }
    if (agent.permissionMode !== undefined) {
      body.push(
        renderPanelRowLine(
          { label: "Permissions", value: agent.permissionMode },
          contentWidth,
          DETAIL_ROW_WIDTH,
        ),
      );
    }
    if (agent.sourcePath) {
      body.push(
        renderPanelRowLine(
          { label: "Source", value: agent.sourcePath },
          contentWidth,
          DETAIL_ROW_WIDTH,
        ),
      );
    }

    if (agent.body.trim().length > 0) {
      body.push("");
      body.push(renderTextWithStyles("System prompt", { bold: true, color: Color.text }));
      const clipped =
        agent.body.length > BODY_CLIP ? `${agent.body.slice(0, BODY_CLIP - 1)}…` : agent.body;
      for (const line of wrapProse(clipped, contentWidth)) {
        body.push(renderTextWithStyles(line, { color: Color.muted }));
      }
    }

    const spec: FooterPanelSpec = {
      command: "/agents",
      title: "Agent",
      footerHints: [["←/Esc", "back"]],
      body,
    };
    return renderFooterPanel(spec, width);
  }

  private detailAgent(library: SubagentDef[]): SubagentDef | null {
    if (!this.detailId) return null;
    return library.find((agent) => agent.id === this.detailId) ?? null;
  }

  private clampCursor(count?: number): void {
    const total = count ?? orderedAgentLibrary(listAgents()).length;
    if (total === 0) {
      this.cursor = 0;
      return;
    }
    this.cursor = Math.max(0, Math.min(total - 1, this.cursor));
  }
}

function orderedAgentLibrary(agents: readonly SubagentDef[]): SubagentDef[] {
  return AGENT_LIBRARY_SCOPES.flatMap((scope) => agents.filter((agent) => agent.scope === scope));
}

function pageAgentLibraryIndex(
  index: number,
  count: number,
  direction: 1 | -1,
  visibleRows: number,
): number {
  const next = index + direction * Math.max(1, Math.floor(visibleRows));
  return Math.max(0, Math.min(Math.max(0, count - 1), next));
}

function pickModelLabel(agent: SubagentDef, providerShortKey: string): string {
  const active = agent.model[providerShortKey];
  if (active) return active.model;
  const first = Object.values(agent.model)[0];
  return first ? first.model : "inherit";
}

function resolveProviderShortKey(): string {
  const state = readStringViewBrokerState();
  return getProviderConfig(state.provider)?.provider.shortKey ?? state.provider;
}

function formatTools(agent: SubagentDef): string {
  if (agent.tools === null) return "inherit";
  if (agent.tools.kind === "wildcard") return "*";
  if (agent.tools.tools.length === 0) return "(none)";
  return agent.tools.tools.join(", ");
}

export function createAgentsPanel(close: () => void, _props?: unknown): StringViewPanel {
  return new AgentsPanel(close);
}
