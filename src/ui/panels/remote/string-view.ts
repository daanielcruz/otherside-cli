import {
  beginPair,
  ensureDevice,
  getRemoteSyncStatus,
  type PairHandle,
  type PairResult,
  type Peer,
  removePeer,
  retireRemotePairings,
  setAutoEnable,
  setRemoteEnabled,
  signOutRemote,
  subscribeRemoteInvalidated,
  subscribeRemoteState,
  subscribeRemoteSyncStatus,
  syncPeersWithBackend,
} from "@/backend/index.ts";
import {
  type DeviceAuthPending,
  getPendingDeviceAuth,
  type OAuthProvider,
  oauthLogin,
  subscribeDeviceAuth,
} from "@/backend/shared/oauth.ts";
import type { RemoteSyncStatus } from "@/kernel/std/types/remote-sync-status.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { panelKey, panelLeaves } from "@/ui/chrome/panel-keys.ts";
import {
  FALLBACK_TERMINAL_ROWS,
  type FooterPanelSpec,
  labelColumnWidth,
  panelDividerLine,
  renderFooterPanel,
  renderPanelRowLine,
} from "@/ui/chrome/string-view-panel.ts";
import {
  type ActionRow,
  type AuthSnapshot,
  actionRows,
  actionValueColor,
  connectionLabel,
  LOGIN_PROVIDERS,
  mainFooterHints,
  type PairPhase,
  type RemoteAction,
  type RemoteSnapshot,
  readAuth,
  readSnapshot,
  type Sub,
} from "@/ui/panels/remote/data.ts";
import { loginPickPanelLines } from "@/ui/panels/remote/login-view.ts";
import { pairBodyLines } from "@/ui/panels/remote/pair-view.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";
import { Color } from "@/ui/theme/theme.ts";

const COMMAND = "/remote";
const STATUS_LABEL = {
  account: "Account",
  device: "CLI device",
  peer: "Paired device",
  connection: "Connection status",
} as const;
const CONTENT_PAD = 2;
const QR_MIN_ROWS = 38;

/**
 * Remote Session overlay on the string model. Device-approved pairing (QR / code),
 * optional legacy sign-in, session toggles, paired-device list, and unpair — driven
 * by the same `@/backend` pairing/session modules the React panel used.
 * Subscribes to remote state, sync status, invalidation, and device-auth pending;
 * never prints tokens or pairing secrets beyond the QR / optional debug payload.
 */
class RemotePanel implements StringViewPanel {
  private ctx: StringViewContext | undefined;
  private unsubs: Array<() => void> = [];
  private cancelled = false;

  private snapshot: RemoteSnapshot = readSnapshot();
  private auth: AuthSnapshot = readAuth();
  private syncStatus: RemoteSyncStatus = getRemoteSyncStatus();
  private sub: Sub = { kind: "main" };
  private selected = 0;

  private providerIdx = 0;
  private loginBusy = false;
  private loginError: string | null = null;
  private deviceAuth: DeviceAuthPending | null = getPendingDeviceAuth();

  private pairHandle: PairHandle | null = null;
  private pairPhase: PairPhase = "awaiting";
  private pairResult: PairResult | null = null;
  private pairError: string | null = null;
  private pairGen = 0;

  private unpairError: string | null = null;

  constructor(
    private readonly close: () => void,
    _props?: unknown,
  ) {}

  mount(ctx: StringViewContext): void {
    this.ctx = ctx;
    this.cancelled = false;
    this.refreshAll();

    this.unsubs.push(
      subscribeRemoteState(() => {
        this.refreshSnapshot();
        this.ctx?.requestRender();
      }),
      subscribeRemoteSyncStatus((status) => {
        this.syncStatus = status;
        this.ctx?.requestRender();
      }),
      subscribeRemoteInvalidated(() => {
        this.refreshAll();
        const signedOutSubIsAvailable =
          this.sub.kind === "main" || this.sub.kind === "loginPick" || this.sub.kind === "pair";
        if (!this.auth.signedIn && !signedOutSubIsAvailable) {
          this.backToMain();
        } else {
          this.ctx?.requestRender();
        }
      }),
      subscribeDeviceAuth(() => {
        this.deviceAuth = getPendingDeviceAuth();
        this.ctx?.requestRender();
      }),
    );

    if (this.auth.signedIn) {
      void syncPeersWithBackend()
        .then(() => {
          if (this.cancelled) return;
          const fresh = readSnapshot();
          if (fresh.peers.length === 0) setRemoteEnabled(false);
          this.snapshot = readSnapshot();
          this.ctx?.requestRender();
        })
        .catch(() => {
          // keep local peers if backend sync fails
        });
    }

    ctx.requestRender();
  }

  unmount(): void {
    this.cancelled = true;
    this.cancelPairing();
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.ctx = undefined;
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - CONTENT_PAD * 2);
    if (this.sub.kind === "loginPick") {
      return loginPickPanelLines(
        {
          providerIdx: this.providerIdx,
          busy: this.loginBusy,
          deviceAuth: this.deviceAuth,
          error: this.loginError,
        },
        width,
        contentWidth,
      );
    }
    if (this.sub.kind === "logoutConfirm") return this.renderLogoutConfirm(width);
    if (this.sub.kind === "pair") return this.renderPair(width, contentWidth);
    if (this.sub.kind === "unpair") return this.renderUnpair(width);
    return this.renderMain(width, contentWidth);
  }

  handleKey(key: KeyEventData): void {
    // The cancel handler owns what a level means: it backs out of a sub-view when
    // there is one and closes the panel when there is not.
    if (panelLeaves(key)) {
      this.handleCancel();
      return;
    }

    if (this.sub.kind === "loginPick") {
      this.handleLoginPickKey(key);
      return;
    }
    if (this.sub.kind === "logoutConfirm") {
      if (panelKey(key) === "confirm") this.runLogout();
      return;
    }
    if (this.sub.kind === "unpair") {
      if (panelKey(key) === "confirm") this.confirmUnpair(this.sub.peer);
      return;
    }
    if (this.sub.kind === "pair") {
      if (key.sequence === "r" || key.sequence === "R") this.startPairing();
      return;
    }

    this.handleMainKey(key);
  }

  private handleMainKey(key: KeyEventData): void {
    const actions = actionRows(this.auth, this.snapshot);
    if (actions.length === 0) return;

    if (key.name === "up") {
      this.selected = (this.selected - 1 + actions.length) % actions.length;
      this.ctx?.requestRender();
      return;
    }
    if (key.name === "down") {
      this.selected = (this.selected + 1) % actions.length;
      this.ctx?.requestRender();
      return;
    }
    if (panelKey(key) === "confirm") {
      const action = actions[this.selectedIdx(actions)];
      if (action) this.activate(action.id);
      return;
    }
    if (key.sequence === "u" || key.sequence === "U") {
      const peer = this.snapshot.peers[0];
      if (peer) {
        this.unpairError = null;
        this.sub = { kind: "unpair", peer };
        this.ctx?.requestRender();
      }
    }
  }

  private handleLoginPickKey(key: KeyEventData): void {
    if (this.loginBusy) return;
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
    if (panelKey(key) === "confirm") {
      const provider = LOGIN_PROVIDERS[this.providerIdx];
      if (provider) this.runLogin(provider.id);
    }
  }

  private handleCancel(): void {
    if (this.sub.kind === "main") {
      this.close();
      return;
    }
    if (this.sub.kind === "loginPick") this.loginError = null;
    if (this.sub.kind === "unpair") this.unpairError = null;
    if (this.sub.kind === "pair") this.cancelPairing();
    this.backToMain();
  }

  private backToMain(): void {
    this.sub = { kind: "main" };
    this.refreshAll();
    this.ctx?.requestRender();
  }

  private refreshAll(): void {
    this.auth = readAuth();
    this.snapshot = readSnapshot();
    this.syncStatus = getRemoteSyncStatus();
    this.clampSelected();
  }

  private refreshSnapshot(): void {
    this.snapshot = readSnapshot();
    this.clampSelected();
  }

  private clampSelected(): void {
    const n = actionRows(this.auth, this.snapshot).length;
    if (n === 0) {
      this.selected = 0;
      return;
    }
    if (this.selected >= n) this.selected = 0;
  }

  private selectedIdx(actions: ActionRow[]): number {
    return this.selected < actions.length ? this.selected : 0;
  }

  private activate(action: RemoteAction): void {
    if (action === "login") {
      this.providerIdx = 0;
      this.loginError = null;
      this.sub = { kind: "loginPick" };
      this.ctx?.requestRender();
      return;
    }
    if (action === "pair") {
      this.sub = { kind: "pair" };
      this.startPairing();
      this.ctx?.requestRender();
      return;
    }
    if (action === "logout") {
      this.sub = { kind: "logoutConfirm" };
      this.ctx?.requestRender();
      return;
    }
    this.toggleSetting(action);
  }

  private toggleSetting(action: "session" | "autoEnable"): void {
    if (action === "session") {
      setRemoteEnabled(!this.snapshot.enabled);
    } else {
      setAutoEnable(!this.snapshot.autoEnable);
    }
    this.refreshSnapshot();
    this.ctx?.requestRender();
  }

  private runLogin(provider: OAuthProvider): void {
    this.loginBusy = true;
    this.loginError = null;
    this.ctx?.requestRender();
    void oauthLogin(provider)
      .then(() => {
        if (this.cancelled) return;
        this.auth = readAuth();
        this.snapshot = readSnapshot();
        this.selected = 0;
        this.loginBusy = false;
        this.sub = { kind: "main" };
        this.ctx?.requestRender();
        void syncPeersWithBackend()
          .then(() => {
            if (this.cancelled) return;
            this.snapshot = readSnapshot();
            this.ctx?.requestRender();
          })
          .catch(() => {});
      })
      .catch((err: unknown) => {
        if (this.cancelled) return;
        this.loginBusy = false;
        this.loginError = err instanceof Error ? err.message : String(err);
        this.ctx?.requestRender();
      });
  }

  private runLogout(): void {
    void signOutRemote().finally(() => {
      if (this.cancelled) return;
      this.auth = readAuth();
      this.snapshot = readSnapshot();
      this.selected = 0;
      this.sub = { kind: "main" };
      this.ctx?.requestRender();
    });
  }

  private confirmUnpair(peer: Peer): void {
    void removePeer(peer.deviceId)
      .then(() => {
        if (this.cancelled) return;
        retireRemotePairings();
        this.refreshAll();
        this.selected = 0;
        this.sub = { kind: "main" };
        this.ctx?.requestRender();
      })
      .catch((err: unknown) => {
        if (this.cancelled) return;
        this.unpairError = err instanceof Error ? err.message : String(err);
        this.ctx?.requestRender();
      });
  }

  private startPairing(): void {
    this.cancelPairing();
    const gen = ++this.pairGen;
    this.pairPhase = "awaiting";
    this.pairResult = null;
    this.pairError = null;
    this.pairHandle = null;
    this.ctx?.requestRender();

    void beginPair(ensureDevice())
      .then((handle) => {
        if (this.cancelled || gen !== this.pairGen || this.sub.kind !== "pair") {
          handle.cancel();
          return;
        }
        this.pairHandle = handle;
        this.ctx?.requestRender();
        void handle.awaiting
          .then((result) => {
            if (this.cancelled || gen !== this.pairGen) return;
            setRemoteEnabled(true);
            this.pairResult = result;
            this.pairPhase = "confirmed";
            this.refreshSnapshot();
            this.ctx?.requestRender();
          })
          .catch((err: unknown) => {
            if (this.cancelled || gen !== this.pairGen) return;
            this.pairError = err instanceof Error ? err.message : String(err);
            this.pairPhase = "failed";
            this.ctx?.requestRender();
          });
      })
      .catch((err: unknown) => {
        if (this.cancelled || gen !== this.pairGen) return;
        this.pairError = err instanceof Error ? err.message : String(err);
        this.pairPhase = "failed";
        this.ctx?.requestRender();
      });
  }

  private cancelPairing(): void {
    this.pairHandle?.cancel();
    this.pairHandle = null;
    this.pairGen += 1;
  }

  private renderMain(width: number, contentWidth: number): string[] {
    const actions = actionRows(this.auth, this.snapshot);
    const selectedIdx = this.selectedIdx(actions);
    const connection = connectionLabel(this.snapshot.peers, this.syncStatus);
    const rowWidth = labelColumnWidth([
      STATUS_LABEL.account,
      STATUS_LABEL.device,
      ...(this.snapshot.peers.length > 0 ? [STATUS_LABEL.peer] : []),
      STATUS_LABEL.connection,
      ...actions.map((action) => action.label),
    ]);
    const body: string[] = [];

    body.push(
      renderPanelRowLine(
        { label: STATUS_LABEL.account, value: this.auth.label, muted: true },
        contentWidth,
        rowWidth,
      ),
    );
    body.push(
      renderPanelRowLine(
        { label: STATUS_LABEL.device, value: this.snapshot.deviceName, muted: true },
        contentWidth,
        rowWidth,
      ),
    );
    for (const peer of this.snapshot.peers) {
      body.push(
        renderPanelRowLine(
          { label: STATUS_LABEL.peer, value: peer.label, muted: true },
          contentWidth,
          rowWidth,
        ),
      );
    }
    body.push(
      renderPanelRowLine(
        {
          label: STATUS_LABEL.connection,
          value: connection.label,
          valueColor: connection.color,
          muted: true,
        },
        contentWidth,
        rowWidth,
      ),
    );

    body.push("");
    body.push(panelDividerLine(contentWidth));
    body.push("");

    for (let idx = 0; idx < actions.length; idx++) {
      const action = actions[idx]!;
      const valueColor = actionValueColor(action.value);
      body.push(
        renderPanelRowLine(
          {
            label: action.label,
            ...(action.value !== undefined ? { value: action.value } : {}),
            selected: idx === selectedIdx,
            ...(valueColor !== undefined ? { valueColor } : {}),
          },
          contentWidth,
          rowWidth,
        ),
      );
    }

    const spec: FooterPanelSpec = {
      command: COMMAND,
      title: "Remote Session",
      footerHints: mainFooterHints(this.snapshot),
      body,
    };
    return renderFooterPanel(spec, width);
  }

  private renderLogoutConfirm(width: number): string[] {
    const body = [
      renderTextWithStyles("Sign out of Remote Session?", { color: Color.text }),
      "",
      renderTextWithStyles("This signs out every CLI session on this machine.", {
        color: Color.warning,
      }),
      renderTextWithStyles("Linked mobile devices are unpaired.", { color: Color.warning }),
      "",
      renderTextWithStyles("Enter to confirm · Esc to cancel", { color: Color.muted }),
    ];
    const spec: FooterPanelSpec = {
      command: COMMAND,
      title: "Sign out",
      footerHints: [
        ["Enter", "confirm"],
        ["Esc/←", "cancel"],
      ],
      body,
    };
    return renderFooterPanel(spec, width);
  }

  private renderUnpair(width: number): string[] {
    const peer = this.sub.kind === "unpair" ? this.sub.peer : null;
    const body: string[] = [
      renderTextWithStyles("Unpair ", { color: Color.text }) +
        renderTextWithStyles(peer?.label ?? "device", { color: Color.text, bold: true }) +
        renderTextWithStyles("?", { color: Color.text }),
    ];
    if (this.unpairError) {
      body.push("");
      body.push(renderTextWithStyles(this.unpairError, { color: Color.error }));
    }
    body.push("");
    body.push(renderTextWithStyles("Enter to confirm · Esc to cancel", { color: Color.muted }));

    const spec: FooterPanelSpec = {
      command: COMMAND,
      title: "Unpair device",
      footerHints: [
        ["Enter", "confirm"],
        ["Esc/←", "cancel"],
      ],
      body,
    };
    return renderFooterPanel(spec, width);
  }

  private renderPair(width: number, _contentWidth: number): string[] {
    const body = pairBodyLines(
      {
        phase: this.pairPhase,
        result: this.pairResult,
        error: this.pairError,
        handle: this.pairHandle,
      },
      this.ctx?.terminalRows?.() ?? FALLBACK_TERMINAL_ROWS,
    );
    const spec: FooterPanelSpec = {
      command: COMMAND,
      title: "Pair a device",
      footerHints: [
        ["r", "new code"],
        ["Esc/←", "back"],
      ],
      body,
    };
    return renderFooterPanel(spec, width);
  }
}

export function createRemotePanel(close: () => void, props?: unknown): StringViewPanel {
  return new RemotePanel(close, props);
}
