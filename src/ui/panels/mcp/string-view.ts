import {
  approveProjectMcpServer,
  disableMcpServer,
  enableMcpServer,
  rejectProjectMcpServer,
} from "@/kernel/mcp/config.ts";
import { dropClient } from "@/kernel/mcp/index.ts";
import { errorMessage } from "@/kernel/std/errno.ts";
import { wrapIndex } from "@/kernel/std/math.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { panelKey } from "@/ui/chrome/panel-keys.ts";
import { FALLBACK_TERMINAL_ROWS } from "@/ui/chrome/string-view-panel.ts";
import { writeTextToClipboard } from "@/ui/input/paste/clipboard.ts";
import { renderMcpAuth } from "@/ui/panels/mcp/auth-view.ts";
import {
  handleMcpAuthKey,
  type McpAuthState,
  startMcpAuthentication,
} from "@/ui/panels/mcp/authentication.ts";
import {
  groupServerRows,
  isRemote,
  loadMcpRows,
  type McpMenuOption,
  type McpServerRow,
  resolveInspection,
  serverMenuOptions,
} from "@/ui/panels/mcp/data.ts";
import { renderMcpList } from "@/ui/panels/mcp/list.ts";
import { renderMcpServerDetail } from "@/ui/panels/mcp/server-detail.ts";
import { renderMcpToolDetail, renderMcpToolsList } from "@/ui/panels/mcp/tools.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";
import { publishPanelTranscriptLine } from "@/ui/panels/transcript-feedback.ts";

type View = "list" | "server" | "tools" | "tool" | "auth";

/**
 * MCP server manager on the string model. Lists configured servers (grouped by
 * project/local/user/built-in order) with live inspection status; Enter opens a
 * server detail with trust/auth/reconnect/enable-disable actions and a tools drill-
 * down. OAuth paste-auth is supported for remote servers that need it.
 */
class McpPanel implements StringViewPanel {
  private ctx: StringViewContext | undefined;
  private loading = true;
  private error: string | null = null;
  private rows: McpServerRow[] = [];
  private reloadKey = 0;
  private cancelled = false;

  private view: View = "list";
  private serverIndex = 0;
  private menuIndex = 0;
  private toolIndex = 0;
  private detailToolIndex = 0;
  private busy: string | null = null;

  private auth: McpAuthState | null = null;
  private authAbort: AbortController | null = null;
  private authSubmit: ((input: string) => void) | null = null;
  private authSeq = 0;

  constructor(private readonly close: () => void) {}

  mount(ctx: StringViewContext): void {
    this.ctx = ctx;
    this.cancelled = false;
    this.reload();
    ctx.requestRender();
  }

  unmount(): void {
    this.cancelled = true;
    this.authSeq += 1;
    this.authAbort?.abort();
    this.authAbort = null;
    this.authSubmit = null;
    this.ctx = undefined;
  }

  render(width: number): string[] {
    const ordered = this.orderedRows();
    this.clampIndices(ordered);

    switch (this.view) {
      case "server": {
        const server = ordered[this.serverIndex];
        if (!server) return this.renderList(width);
        return renderMcpServerDetail({
          server,
          width,
          busy: this.busy,
          menuIndex: this.menuIndex,
        });
      }
      case "tools": {
        const server = ordered[this.serverIndex];
        if (!server) return this.renderList(width);
        return renderMcpToolsList({
          server,
          width,
          toolIndex: this.toolIndex,
          terminalRows: this.terminalRows(),
        });
      }
      case "tool": {
        const server = ordered[this.serverIndex];
        const tool = server?.inspection.tools[this.detailToolIndex];
        if (!server || !tool) return this.renderList(width);
        return renderMcpToolDetail({ server, tool, width, terminalRows: this.terminalRows() });
      }
      case "auth":
        if (!this.auth) return this.renderList(width);
        return renderMcpAuth(this.auth, width);
      default:
        return this.renderList(width);
    }
  }

  handleKey(key: KeyEventData): void {
    if (this.busy && this.authAbort) {
      if (key.name === "escape") {
        this.authAbort.abort();
      }
      return;
    }
    if (this.busy) return;

    if (panelKey(key) === "close") {
      this.cancelView();
      return;
    }

    if (this.view === "auth") {
      this.handleAuthKey(key);
      return;
    }

    const ordered = this.orderedRows();
    this.clampIndices(ordered);
    if (this.loading || ordered.length === 0) {
      if (key.name === "left") this.close();
      return;
    }

    if (this.view === "list") {
      this.handleListKey(key, ordered);
      return;
    }

    const server = ordered[this.serverIndex];
    if (!server) return;

    if (this.view === "server") {
      this.handleServerKey(key, server);
      return;
    }
    if (this.view === "tools") {
      this.handleToolsKey(key, server);
      return;
    }
    // tool detail is Esc-only (handled above)
    if (this.view === "tool" && key.name === "left") {
      this.view = "tools";
      this.ctx?.requestRender();
    }
  }

  private handleListKey(key: KeyEventData, ordered: McpServerRow[]): void {
    switch (key.name) {
      case "up":
        this.serverIndex = wrapIndex(this.serverIndex - 1, ordered.length);
        this.ctx?.requestRender();
        return;
      case "down":
        this.serverIndex = wrapIndex(this.serverIndex + 1, ordered.length);
        this.ctx?.requestRender();
        return;
      case "return":
        this.menuIndex = 0;
        this.view = "server";
        this.ctx?.requestRender();
        return;
      case "left":
        this.close();
        return;
    }
  }

  private handleServerKey(key: KeyEventData, server: McpServerRow): void {
    const options = serverMenuOptions(server);
    switch (key.name) {
      case "up":
        this.menuIndex = wrapIndex(this.menuIndex - 1, options.length);
        this.ctx?.requestRender();
        return;
      case "down":
        this.menuIndex = wrapIndex(this.menuIndex + 1, options.length);
        this.ctx?.requestRender();
        return;
      case "return": {
        const option = options[this.menuIndex];
        if (option) void this.runServerAction(server, option);
        return;
      }
      case "left":
        this.view = "list";
        this.ctx?.requestRender();
        return;
    }
  }

  private handleToolsKey(key: KeyEventData, server: McpServerRow): void {
    const tools = server.inspection.tools;
    switch (key.name) {
      case "up":
        this.toolIndex = wrapIndex(this.toolIndex - 1, tools.length);
        this.ctx?.requestRender();
        return;
      case "down":
        this.toolIndex = wrapIndex(this.toolIndex + 1, tools.length);
        this.ctx?.requestRender();
        return;
      case "return":
        if (tools[this.toolIndex]) {
          this.detailToolIndex = this.toolIndex;
          this.view = "tool";
          this.ctx?.requestRender();
        }
        return;
      case "left":
        this.view = "server";
        this.ctx?.requestRender();
        return;
    }
  }

  private handleAuthKey(key: KeyEventData): void {
    if (isCopyKey(key) && this.auth?.url) {
      this.copyAuthUrl(this.auth.url);
      return;
    }
    handleMcpAuthKey({
      key,
      auth: this.auth,
      submit: this.authSubmit,
      setAuth: (auth) => this.setAuth(auth),
      cancel: () => this.cancelAuth(),
    });
  }

  private renderList(width: number): string[] {
    return renderMcpList({
      rows: this.rows,
      loading: this.loading,
      error: this.error,
      serverIndex: this.serverIndex,
      terminalRows: this.terminalRows(),
      width,
    });
  }

  private terminalRows(): number {
    return this.ctx?.terminalRows?.() ?? FALLBACK_TERMINAL_ROWS;
  }

  private orderedRows(): McpServerRow[] {
    return groupServerRows(this.rows, process.cwd()).flatMap((group) => group.rows);
  }

  private clampIndices(ordered: McpServerRow[]): void {
    if (ordered.length === 0) {
      this.serverIndex = 0;
      this.menuIndex = 0;
      this.toolIndex = 0;
      this.detailToolIndex = 0;
      return;
    }
    this.serverIndex = Math.max(0, Math.min(ordered.length - 1, this.serverIndex));
    const server = ordered[this.serverIndex];
    const options = serverMenuOptions(server);
    this.menuIndex = Math.max(0, Math.min(Math.max(0, options.length - 1), this.menuIndex));
    const tools = server?.inspection.tools ?? [];
    this.toolIndex = Math.max(0, Math.min(Math.max(0, tools.length - 1), this.toolIndex));
    this.detailToolIndex = Math.max(
      0,
      Math.min(Math.max(0, tools.length - 1), this.detailToolIndex),
    );
  }

  private reload(): void {
    const key = ++this.reloadKey;
    const resolved = new Map<string, McpServerRow["inspection"]>();
    this.loading = true;
    this.error = null;
    this.ctx?.requestRender();

    void loadMcpRows((name, inspection) => {
      resolved.set(name, inspection);
      if (key !== this.reloadKey || this.cancelled) return;
      this.rows = this.rows.map((row) => (row.name === name ? { ...row, inspection } : row));
      this.ctx?.requestRender();
    })
      .then((rows) => {
        if (key !== this.reloadKey || this.cancelled) return;
        this.loading = false;
        this.error = null;
        this.rows = rows.map((row) => {
          const inspection = resolved.get(row.name);
          return inspection ? { ...row, inspection } : row;
        });
        this.serverIndex = Math.min(Math.max(0, rows.length - 1), this.serverIndex);
        this.ctx?.requestRender();
      })
      .catch((error: unknown) => {
        if (key !== this.reloadKey || this.cancelled) return;
        this.loading = false;
        this.error = errorMessage(error);
        this.rows = [];
        this.ctx?.requestRender();
      });
  }

  private cancelView(): void {
    if (this.view === "auth") {
      this.cancelAuth();
      return;
    }
    if (this.view === "tool") {
      this.view = "tools";
      this.ctx?.requestRender();
      return;
    }
    if (this.view === "tools") {
      this.view = "server";
      this.ctx?.requestRender();
      return;
    }
    if (this.view === "server") {
      this.view = "list";
      this.ctx?.requestRender();
      return;
    }
    this.close();
  }

  private cancelAuth(): void {
    this.authSeq += 1;
    this.authAbort?.abort();
    this.authAbort = null;
    this.authSubmit = null;
    this.auth = null;
    this.view = "list";
    this.ctx?.requestRender();
  }

  private setAuth(auth: McpAuthState): void {
    this.auth = auth;
    this.ctx?.requestRender();
  }

  private copyAuthUrl(url: string): void {
    void writeTextToClipboard(url).then((copied) => {
      if (!copied || this.cancelled || this.auth?.url !== url) return;
      this.setAuth({ ...this.auth, urlCopied: true });
      setTimeout(() => this.clearCopiedAuthUrl(url), 2_000);
    });
  }

  private clearCopiedAuthUrl(url: string): void {
    if (this.cancelled || this.auth?.url !== url) return;
    this.setAuth({ ...this.auth, urlCopied: false });
  }

  private async beginAuth(serverName: string, baseUrl: string, scope?: string): Promise<void> {
    const sequence = ++this.authSeq;
    const controller = new AbortController();
    this.authAbort = controller;
    this.authSubmit = null;
    this.auth = {
      serverName,
      url: "",
      status: "running",
      message: "Starting authorization…",
      pasted: "",
    };
    this.view = "auth";
    this.ctx?.requestRender();

    await startMcpAuthentication({
      serverName,
      baseUrl,
      scope,
      controller,
      sequence,
      isCurrent: (currentSequence) => currentSequence === this.authSeq && !this.cancelled,
      setSubmit: (submit) => {
        this.authSubmit = submit;
      },
      setAuth: (auth) => {
        this.auth = auth;
      },
      requestRender: () => this.ctx?.requestRender(),
      reload: () => this.reload(),
    });
  }

  private async runServerAction(server: McpServerRow, option: McpMenuOption): Promise<void> {
    if (option.id === "trust" || option.id === "trustAll" || option.id === "reject") {
      const approved = option.id !== "reject";
      this.busy = `${approved ? "Approving" : "Rejecting"} ${server.name}`;
      this.ctx?.requestRender();
      try {
        if (approved) {
          await approveProjectMcpServer(process.cwd(), server.name, option.id === "trustAll");
        } else {
          await rejectProjectMcpServer(process.cwd(), server.name);
        }
        publishPanelTranscriptLine(
          "/mcp",
          approved ? `MCP "${server.name}" approved` : `MCP "${server.name}" rejected`,
        );
      } finally {
        this.view = "list";
        this.menuIndex = 0;
        this.busy = null;
        this.reload();
      }
      return;
    }

    if (option.id === "tools") {
      this.toolIndex = 0;
      this.detailToolIndex = 0;
      this.view = "tools";
      this.ctx?.requestRender();
      return;
    }

    if (option.id === "authenticate") {
      if (!isRemote(server.config)) return;
      await this.beginAuth(server.name, server.config.url, server.config.oauthScopes);
      return;
    }

    if (option.id === "reconnect") {
      this.busy = `Reconnecting to ${server.name}`;
      this.ctx?.requestRender();
      try {
        await dropClient(server.name, server.config);
        const inspection = await resolveInspection(
          server.name,
          server.config,
          server.enabled,
          false,
        );
        if (!this.cancelled) {
          this.rows = this.rows.map((row) =>
            row.name === server.name ? { ...row, inspection } : row,
          );
        }
      } finally {
        this.busy = null;
        this.ctx?.requestRender();
      }
      return;
    }

    // toggle enable/disable
    this.busy = `${server.enabled ? "Disabling" : "Enabling"} ${server.name}`;
    this.ctx?.requestRender();
    try {
      await dropClient(server.name, server.config);
      await (server.enabled
        ? disableMcpServer(process.cwd(), server.name)
        : enableMcpServer(process.cwd(), server.name));
    } finally {
      this.view = "list";
      this.menuIndex = 0;
      this.busy = null;
      this.reload();
    }
  }
}

function isCopyKey(key: KeyEventData): boolean {
  return !key.ctrl && !key.meta && (key.sequence === "c" || key.sequence === "C");
}

export function createMcpPanel(close: () => void, _props?: unknown): StringViewPanel {
  return new McpPanel(close);
}
