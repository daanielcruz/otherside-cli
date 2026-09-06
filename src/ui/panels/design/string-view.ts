import { signOutRemote } from "@/backend/index.ts";
import {
  type DeviceAuthPending,
  getPendingDeviceAuth,
  type OAuthProvider,
  oauthLogin,
  subscribeDeviceAuth,
} from "@/backend/shared/oauth.ts";
import { type DesignController } from "@/design/controller.ts";
import { stopDesign } from "@/design/launcher.ts";
import { takePendingBrief } from "@/design/pending-brief.ts";
import {
  getBySession,
  getLinkExpiresAt,
  getUnreachableReason,
  isLinkExpired,
  list as listDesignSpawns,
  subscribe as subscribeDesign,
} from "@/design/spawn-registry.ts";
import { openBrowser } from "@/kernel/std/browser.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import type { TerminalColor } from "@/terminal-runtime/text/style-model.js";
import {
  type FooterPanelSpec,
  labelColumnWidth,
  panelDividerLine,
  renderFooterPanel,
  renderPanelRowLine,
} from "@/ui/chrome/string-view-panel.ts";
import { loginPickPanelLines, logoutConfirmPanelLines } from "@/ui/panels/design/account-views.ts";
import {
  type Action,
  type AuthSnapshot,
  type Busy,
  busyLabel,
  deviceAuthLines,
  errText,
  formatCountdown,
  LOGIN_PROVIDERS,
  narrowProps,
  readAuth,
  resolveController,
  resolveSessionId,
  type View,
} from "@/ui/panels/design/data.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";
import { Color } from "@/ui/theme/theme.ts";

const CONTENT_PAD = 2;
const COUNTDOWN_MS = 1000;

const ACTION_LABEL: Record<Action, string> = {
  login: "Sign in",
  start: "Start design session",
  open: "Open in browser",
  stop: "Stop session",
  logout: "Sign out",
};

const STATUS_LABEL = { account: "Account", session: "Session" } as const;
const DIVIDER_VALUE_ROOM = 14;

/**
 * Otherside Design overlay on the string model. Manages backend sign-in, design
 * session start/stop, and the pairing link (spawn-registry). Slash-open carries no
 * props — session id comes from the active task session / spawn registry; start/stop
 * reuse `createDesignController` / `stopDesign` when runtime deps are available
 * (optional opener props: session, controller, broker, agent). Never prints auth
 * tokens or other secrets beyond the pairing URL and device user-code the React
 * panel already showed.
 */
class DesignPanel implements StringViewPanel {
  private ctx: StringViewContext | undefined;
  private unsubDesign: (() => void) | undefined;
  private unsubDeviceAuth: (() => void) | undefined;
  private countdownTimer: ReturnType<typeof setInterval> | undefined;
  private cancelled = false;

  private readonly sessionId: string;
  private readonly brief: string;
  private readonly controller: DesignController | null;

  private view: View = "main";
  private busy: Busy = null;
  private error: string | null = null;
  private auth: AuthSnapshot = readAuth();
  private selected = 0;
  private providerIdx = 0;
  private deviceAuth: DeviceAuthPending | null = getPendingDeviceAuth();
  private now = Date.now();

  constructor(
    private readonly close: () => void,
    props?: unknown,
  ) {
    const p = narrowProps(props);
    this.sessionId = resolveSessionId(p);
    this.brief = this.sessionId.length > 0 ? takePendingBrief(this.sessionId) : "";
    this.controller = resolveController(p);
  }

  mount(ctx: StringViewContext): void {
    this.ctx = ctx;
    this.cancelled = false;
    this.unsubDesign = subscribeDesign(() => {
      this.clampSelection();
      this.syncCountdown();
      this.ctx?.requestRender();
    });
    this.unsubDeviceAuth = subscribeDeviceAuth(() => {
      this.deviceAuth = getPendingDeviceAuth();
      this.ctx?.requestRender();
    });
    this.deviceAuth = getPendingDeviceAuth();
    this.syncCountdown();
    ctx.requestRender();
  }

  unmount(): void {
    this.cancelled = true;
    this.unsubDesign?.();
    this.unsubDesign = undefined;
    this.unsubDeviceAuth?.();
    this.unsubDeviceAuth = undefined;
    this.clearCountdown();
    this.ctx = undefined;
  }

  render(width: number): string[] {
    if (this.view === "loginPick") {
      return loginPickPanelLines(
        {
          providerIdx: this.providerIdx,
          busy: this.busy,
          deviceAuth: this.deviceAuth,
          error: this.error,
        },
        width,
      );
    }
    if (this.view === "logoutConfirm") return logoutConfirmPanelLines(this.busy, width);
    return this.renderMain(width);
  }

  handleKey(key: KeyEventData): void {
    if (key.name === "escape" || key.name === "left") {
      this.handleBack();
      return;
    }

    if (this.view === "logoutConfirm") {
      if (key.name === "return" && this.busy === null) this.runLogout();
      return;
    }

    if (this.view === "loginPick") {
      this.handleLoginPickKey(key);
      return;
    }

    this.handleMainKey(key);
  }

  private handleBack(): void {
    if (this.view !== "main") {
      this.view = "main";
      this.error = null;
      this.ctx?.requestRender();
      return;
    }
    this.close();
  }

  private handleMainKey(key: KeyEventData): void {
    const actions = this.mainActions();
    if (key.name === "up") {
      if (actions.length === 0) return;
      this.selected = (this.selected - 1 + actions.length) % actions.length;
      this.ctx?.requestRender();
      return;
    }
    if (key.name === "down") {
      if (actions.length === 0) return;
      this.selected = (this.selected + 1) % actions.length;
      this.ctx?.requestRender();
      return;
    }
    if (key.name === "return") {
      if (this.busy !== null) return;
      const action = actions[this.selectedIdx(actions)];
      if (action) this.activate(action);
    }
  }

  private handleLoginPickKey(key: KeyEventData): void {
    if (key.name === "up") {
      this.providerIdx = (this.providerIdx - 1 + LOGIN_PROVIDERS.length) % LOGIN_PROVIDERS.length;
      this.ctx?.requestRender();
      return;
    }
    if (key.name === "down") {
      this.providerIdx = (this.providerIdx + 1) % LOGIN_PROVIDERS.length;
      this.ctx?.requestRender();
      return;
    }
    if (key.name === "return") {
      if (this.busy !== null) return;
      const provider = LOGIN_PROVIDERS[this.providerIdx];
      if (provider) this.runLogin(provider.id);
    }
  }

  private activate(action: Action): void {
    if (action === "login") {
      this.providerIdx = 0;
      this.error = null;
      this.view = "loginPick";
      this.ctx?.requestRender();
      return;
    }
    if (action === "start") {
      this.runStart();
      return;
    }
    if (action === "open") {
      const url = this.spawnSnapshot().url;
      if (url.length > 0) void openBrowser(url);
      return;
    }
    if (action === "stop") {
      this.runStop();
      return;
    }
    this.view = "logoutConfirm";
    this.error = null;
    this.ctx?.requestRender();
  }

  private runLogin(provider: OAuthProvider): void {
    this.busy = "login";
    this.error = null;
    this.ctx?.requestRender();
    void oauthLogin(provider)
      .then(() => {
        if (this.cancelled) return;
        this.auth = readAuth();
        this.view = "main";
        this.selected = 0;
        this.busy = null;
        this.ctx?.requestRender();
      })
      .catch((err: unknown) => {
        if (this.cancelled) return;
        this.error = errText(err);
        this.busy = null;
        this.ctx?.requestRender();
      });
  }

  private runStart(): void {
    const controller = this.controller;
    if (!controller) {
      this.error =
        "Design start is not wired — pass session + controller (or session/broker/agent) via overlay props.";
      this.ctx?.requestRender();
      return;
    }
    this.busy = "start";
    this.error = null;
    this.ctx?.requestRender();
    void controller
      .start(this.brief)
      .catch((err: unknown) => {
        if (this.cancelled) return;
        this.error = errText(err);
      })
      .finally(() => {
        if (this.cancelled) return;
        this.busy = null;
        this.clampSelection();
        this.syncCountdown();
        this.ctx?.requestRender();
      });
  }

  private runStop(): void {
    this.busy = "stop";
    this.error = null;
    this.ctx?.requestRender();
    const stop = this.controller
      ? this.controller.stop()
      : this.sessionId.length > 0
        ? stopDesign(this.sessionId).then(() => {})
        : Promise.resolve();
    void stop
      .catch((err: unknown) => {
        if (this.cancelled) return;
        this.error = errText(err);
      })
      .finally(() => {
        if (this.cancelled) return;
        this.busy = null;
        this.clampSelection();
        this.syncCountdown();
        this.ctx?.requestRender();
      });
  }

  private runLogout(): void {
    this.busy = "stop";
    this.error = null;
    this.ctx?.requestRender();
    const stop = this.controller
      ? this.controller.stop()
      : this.sessionId.length > 0
        ? stopDesign(this.sessionId).then(() => {})
        : Promise.resolve();
    void stop
      .catch(() => {})
      .then(() => signOutRemote())
      .catch(() => {})
      .finally(() => {
        if (this.cancelled) return;
        this.auth = readAuth();
        this.view = "main";
        this.selected = 0;
        this.busy = null;
        this.clampSelection();
        this.ctx?.requestRender();
      });
  }

  private mainActions(): Action[] {
    const hasSession = this.spawnSnapshot().url.length > 0;
    if (!this.auth.signedIn) return ["login"];
    if (hasSession) return ["open", "stop", "logout"];
    return ["start", "logout"];
  }

  private selectedIdx(actions: Action[]): number {
    return this.selected < actions.length ? this.selected : 0;
  }

  private clampSelection(): void {
    const actions = this.mainActions();
    if (this.selected >= actions.length) this.selected = 0;
  }

  private spawnSnapshot(): {
    url: string;
    attached: boolean;
    expiresAt: string | null;
    linkExpired: boolean;
    unreachable: string | null;
  } {
    const sessionId = this.sessionId;
    if (sessionId.length === 0) {
      const any = listDesignSpawns()[0];
      if (!any) {
        return {
          url: "",
          attached: false,
          expiresAt: null,
          linkExpired: false,
          unreachable: null,
        };
      }
      return {
        url: any.url,
        attached: any.attached,
        expiresAt: getLinkExpiresAt(any.id),
        linkExpired: isLinkExpired(any.id),
        unreachable: getUnreachableReason(any.id),
      };
    }
    const spawn = getBySession(sessionId);
    return {
      url: spawn?.url ?? "",
      attached: spawn?.attached ?? false,
      expiresAt: spawn ? getLinkExpiresAt(spawn.id) : null,
      linkExpired: spawn ? isLinkExpired(spawn.id) : false,
      unreachable: spawn ? getUnreachableReason(spawn.id) : null,
    };
  }

  private syncCountdown(): void {
    const snap = this.spawnSnapshot();
    const needs =
      snap.url.length > 0 && !snap.attached && !snap.linkExpired && snap.expiresAt !== null;
    if (needs && this.countdownTimer === undefined) {
      this.countdownTimer = setInterval(() => {
        this.now = Date.now();
        this.ctx?.requestRender();
      }, COUNTDOWN_MS);
    } else if (!needs) {
      this.clearCountdown();
    }
  }

  private clearCountdown(): void {
    if (this.countdownTimer !== undefined) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = undefined;
    }
  }

  private renderMain(width: number): string[] {
    const contentWidth = Math.max(1, width - CONTENT_PAD * 2);
    const snap = this.spawnSnapshot();
    const hasSession = snap.url.length > 0;
    const actions = this.mainActions();
    const selected = this.selectedIdx(actions);
    const rowWidth = labelColumnWidth([
      STATUS_LABEL.account,
      STATUS_LABEL.session,
      ...actions.map((action) => ACTION_LABEL[action]),
    ]);
    const body: string[] = [];

    body.push(
      renderPanelRowLine(
        { label: STATUS_LABEL.account, value: this.auth.label, muted: true },
        contentWidth,
        rowWidth,
      ),
    );
    body.push(...this.sessionStatusLines(snap, contentWidth, rowWidth));

    if (!hasSession && this.brief.length > 0) {
      body.push("");
      body.push(renderTextWithStyles("Pending brief", { color: Color.muted }));
      body.push(
        renderTextWithStyles(truncateEllipsis(this.brief, contentWidth), { color: Color.text }),
      );
    }

    body.push("");
    body.push(panelDividerLine(Math.min(contentWidth, rowWidth + DIVIDER_VALUE_ROOM)));
    body.push("");

    for (let index = 0; index < actions.length; index++) {
      const action = actions[index]!;
      body.push(
        renderPanelRowLine(
          { label: ACTION_LABEL[action], selected: index === selected },
          contentWidth,
          rowWidth,
        ),
      );
    }

    if (this.busy !== null) {
      body.push("");
      body.push(renderTextWithStyles(busyLabel(this.busy), { color: Color.muted, dim: true }));
    }
    if (this.deviceAuth !== null) {
      body.push(...deviceAuthLines(this.deviceAuth, contentWidth));
    }
    if (this.error) {
      body.push("");
      body.push(renderTextWithStyles(this.error, { color: Color.error }));
    }

    const spec: FooterPanelSpec = {
      command: "/design",
      title: "Otherside Design",
      footerHints: [
        ["↑↓", "navigate"],
        ["Enter", "select"],
        ["Esc", "close"],
      ],
      body,
      flushTop: true,
    };
    return renderFooterPanel(spec, width);
  }

  private sessionStatusLines(
    snap: {
      url: string;
      attached: boolean;
      expiresAt: string | null;
      linkExpired: boolean;
      unreachable: string | null;
    },
    contentWidth: number,
    rowWidth: number,
  ): string[] {
    const lines: string[] = [];
    if (snap.url.length === 0) {
      lines.push(
        renderPanelRowLine(
          { label: STATUS_LABEL.session, value: "none", muted: true },
          contentWidth,
          rowWidth,
        ),
      );
      return lines;
    }

    const isUnreachable = snap.attached && snap.unreachable !== null;
    let statusValue: string;
    let statusColor: TerminalColor;
    if (isUnreachable) {
      statusValue = "session unreachable — web may have lost pairing";
      statusColor = Color.warning;
    } else if (snap.attached) {
      statusValue = "attached";
      statusColor = Color.success;
    } else {
      statusValue = "waiting for browser";
      statusColor = Color.warning;
    }

    lines.push(
      renderPanelRowLine(
        { label: STATUS_LABEL.session, value: statusValue, valueColor: statusColor, muted: true },
        contentWidth,
        rowWidth,
      ),
    );
    lines.push("");
    lines.push(renderTextWithStyles("URL", { color: Color.muted }));
    lines.push(
      renderTextWithStyles(truncateEllipsis(snap.url, contentWidth), { color: Color.panelAccent }),
    );

    if (!snap.attached && snap.linkExpired) {
      lines.push(
        renderTextWithStyles("link expired — restart the session", { color: Color.warning }),
      );
    } else if (!snap.attached && snap.expiresAt !== null) {
      const remaining = Date.parse(snap.expiresAt) - this.now;
      lines.push(
        renderTextWithStyles(`link expires in ${formatCountdown(remaining)}`, {
          color: Color.muted,
        }),
      );
    }
    return lines;
  }
}

export function createDesignPanel(close: () => void, props?: unknown): StringViewPanel {
  return new DesignPanel(close, props);
}
