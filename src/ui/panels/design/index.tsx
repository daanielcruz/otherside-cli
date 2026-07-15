import { useEffect, useState, useSyncExternalStore } from "react";
import type { DesignController } from "@/design/controller.ts";
import { takePendingBrief } from "@/design/pending-brief.ts";
import {
  getBySession,
  getLinkExpiresAt,
  getUnreachableReason,
  isLinkExpired,
  subscribe as subscribeDesign,
} from "@/design/spawn-registry.ts";
import type { Session } from "@/engine/session/index.ts";
import { Box, type Color as InkColor, TerminalLink, Text, useRepeatingClock } from "@/ink";
import { openBrowser } from "@/kernel/std/browser.ts";
import { currentUserEmail, currentUserId } from "@/remote/backend/auth.ts";
import {
  type DeviceAuthPending,
  getPendingDeviceAuth,
  type OAuthProvider,
  oauthLogin,
  subscribeDeviceAuth,
} from "@/remote/backend/oauth.ts";
import { clearAuth, loadAuth } from "@/remote/index.ts";
import { FooterPanel, FooterPanelRow } from "@/ui/chrome/panel.tsx";
import { type PanelRowsNav, usePanelNavigation } from "@/ui/hooks/use-panel-navigation.ts";
import { useOverlayClose } from "@/ui/panels/use-overlay-close";
import { Color, Glyph } from "@/ui/theme/theme.ts";

export interface DesignOverlayProps {
  session: Session;
  controller: DesignController;
  onClose?: () => void;
}

type View = "main" | "loginPick" | "logoutConfirm";
type Busy = null | "login" | "start" | "stop";
type Action = "login" | "start" | "open" | "stop" | "logout";

interface AuthSnapshot {
  signedIn: boolean;
  label: string;
}

interface ProviderChoice {
  id: OAuthProvider;
  label: string;
}

const PROVIDERS: ProviderChoice[] = [
  { id: "google", label: "Continue with Google" },
  { id: "apple", label: "Continue with Apple" },
];

const ACTION_LABEL: Record<Action, string> = {
  login: "Sign in",
  start: "Start design session",
  open: "Open in browser",
  stop: "Stop session",
  logout: "Sign out",
};

const ROW_WIDTH = 22;

function readAuth(): AuthSnapshot {
  if (!loadAuth()) return { signedIn: false, label: "Not signed in" };
  const email = currentUserEmail();
  const id = currentUserId();
  const label = email ?? (id ? `${id.slice(0, 8)}…` : "Signed in");
  return { signedIn: true, label };
}

function mainActions(signedIn: boolean, hasSession: boolean): Action[] {
  if (!signedIn) return ["login"];
  if (hasSession) return ["open", "stop", "logout"];
  return ["start", "logout"];
}

function readLinkExpiresAt(sessionId: string): string | null {
  const spawn = getBySession(sessionId);
  return spawn ? getLinkExpiresAt(spawn.id) : null;
}

function readLinkExpired(sessionId: string): boolean {
  const spawn = getBySession(sessionId);
  return spawn ? isLinkExpired(spawn.id) : false;
}

function readUnreachable(sessionId: string): string | null {
  const spawn = getBySession(sessionId);
  return spawn ? getUnreachableReason(spawn.id) : null;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function busyLabel(busy: Exclude<Busy, null>): string {
  if (busy === "login") return "Opening browser for sign-in…";
  if (busy === "start") return "Starting design session…";
  return "Stopping session…";
}

export function DesignOverlay({
  session,
  controller,
  onClose,
}: DesignOverlayProps): React.JSX.Element {
  const close = useOverlayClose(onClose);
  const sessionId = session.id;

  const url = useSyncExternalStore(
    subscribeDesign,
    () => getBySession(sessionId)?.url ?? "",
    () => getBySession(sessionId)?.url ?? "",
  );
  const attached = useSyncExternalStore(
    subscribeDesign,
    () => getBySession(sessionId)?.attached ?? false,
    () => getBySession(sessionId)?.attached ?? false,
  );
  const expiresAt = useSyncExternalStore(
    subscribeDesign,
    () => readLinkExpiresAt(sessionId),
    () => readLinkExpiresAt(sessionId),
  );
  const linkExpired = useSyncExternalStore(
    subscribeDesign,
    () => readLinkExpired(sessionId),
    () => readLinkExpired(sessionId),
  );
  const unreachable = useSyncExternalStore(
    subscribeDesign,
    () => readUnreachable(sessionId),
    () => readUnreachable(sessionId),
  );
  const hasSession = url.length > 0;

  const deviceAuth = useSyncExternalStore(
    subscribeDeviceAuth,
    getPendingDeviceAuth,
    getPendingDeviceAuth,
  );

  const [brief] = useState(() => takePendingBrief(sessionId));
  const [auth, setAuth] = useState<AuthSnapshot>(readAuth);
  const [view, setView] = useState<View>("main");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [providerIdx, setProviderIdx] = useState(0);

  const actions = mainActions(auth.signedIn, hasSession);

  // The action list changes shape when a session starts/stops (3 items vs 2).
  // A stale cursor index would land on the wrong row (e.g. "Sign out" right
  // after "Stop session"), so reset it whenever the list length changes.
  useEffect(() => {
    setSelected(0);
  }, [actions.length]);
  // Clamp for the render between the list shrinking and the effect firing.
  const selectedIdx = selected < actions.length ? selected : 0;

  function runLogin(provider: OAuthProvider): void {
    setBusy("login");
    setError(null);
    oauthLogin(provider)
      .then(() => {
        setAuth(readAuth());
        setView("main");
        setSelected(0);
      })
      .catch((err) => setError(errText(err)))
      .finally(() => setBusy(null));
  }

  function runStart(): void {
    setBusy("start");
    setError(null);
    controller
      .start(brief)
      .catch((err) => setError(errText(err)))
      .finally(() => setBusy(null));
  }

  function runStop(): void {
    setBusy("stop");
    setError(null);
    controller
      .stop()
      .catch((err) => setError(errText(err)))
      .finally(() => setBusy(null));
  }

  function runLogout(): void {
    setBusy("stop");
    setError(null);
    controller
      .stop()
      .catch(() => {})
      .finally(() => {
        clearAuth();
        setAuth(readAuth());
        setView("main");
        setSelected(0);
        setBusy(null);
      });
  }

  function activate(action: Action): void {
    if (action === "login") {
      setProviderIdx(0);
      setError(null);
      setView("loginPick");
      return;
    }
    if (action === "start") {
      runStart();
      return;
    }
    if (action === "open") {
      if (url.length > 0) openBrowser(url);
      return;
    }
    if (action === "stop") {
      runStop();
      return;
    }
    setView("logoutConfirm");
  }

  function backToMain(): void {
    setView("main");
    setError(null);
  }

  let rows: PanelRowsNav | undefined;
  if (view === "loginPick") {
    rows = { count: PROVIDERS.length, selected: providerIdx, onChange: setProviderIdx };
  } else if (view === "main") {
    rows = { count: actions.length, selected: selectedIdx, onChange: setSelected };
  }

  usePanelNavigation({
    onClose: close,
    skipEsc: true,
    rows,
    onActivate: () => {
      if (busy !== null) return;
      if (view === "main") {
        const action = actions[selectedIdx];
        if (action) activate(action);
        return;
      }
      if (view === "loginPick") {
        const provider = PROVIDERS[providerIdx];
        if (provider) runLogin(provider.id);
        return;
      }
      runLogout();
    },
    onBack: () => {
      if (view !== "main") {
        backToMain();
        return true;
      }
      return false;
    },
  });

  if (view === "loginPick") {
    return (
      <FooterPanel
        command="/design"
        title="Sign in"
        accent={Color.primaryGlow}
        footerHints={[
          ["↑↓", "navigate"],
          ["Enter", "choose"],
          ["Esc/←", "back"],
        ]}
        onCancel={backToMain}
      >
        <LoginPick
          selected={providerIdx}
          busy={busy === "login"}
          error={error}
          deviceAuth={deviceAuth}
        />
      </FooterPanel>
    );
  }

  if (view === "logoutConfirm") {
    return (
      <FooterPanel
        command="/design"
        title="Sign out"
        accent={Color.primaryGlow}
        footerHints={[
          ["Enter", "confirm"],
          ["Esc/←", "cancel"],
        ]}
        onCancel={backToMain}
      >
        <LogoutConfirm />
      </FooterPanel>
    );
  }

  return (
    <FooterPanel
      command="/design"
      title="Otherside Design"
      accent={Color.primaryGlow}
      footerHints={[
        ["↑↓", "navigate"],
        ["Enter", "select"],
        ["Esc", "close"],
      ]}
      onCancel={close}
    >
      <MainView
        auth={auth}
        hasSession={hasSession}
        attached={attached}
        url={url}
        expiresAt={expiresAt}
        linkExpired={linkExpired}
        unreachable={unreachable}
        brief={brief}
        actions={actions}
        selected={selectedIdx}
        busy={busy}
        error={error}
        deviceAuth={deviceAuth}
      />
    </FooterPanel>
  );
}

function DeviceAuthNotice({ pending }: { pending: DeviceAuthPending }): React.JSX.Element {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text color={Color.warning}>Approve this terminal in the browser</Text>
      <Box>
        <Text color={Color.muted}>Code </Text>
        <Text color={Color.text} bold>
          {pending.userCode}
        </Text>
      </Box>
      <TerminalLink url={pending.verificationUri} />
    </Box>
  );
}

function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function LinkCountdown({ expiresAt }: { expiresAt: string }): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useRepeatingClock(() => setNow(Date.now()), 1000);
  const remaining = Date.parse(expiresAt) - now;
  return <Text color={Color.muted}>link expires in {formatCountdown(remaining)}</Text>;
}

function SessionStatus({
  hasSession,
  attached,
  url,
  expiresAt,
  linkExpired,
  unreachable,
}: {
  hasSession: boolean;
  attached: boolean;
  url: string;
  expiresAt: string | null;
  linkExpired: boolean;
  unreachable: string | null;
}): React.JSX.Element {
  if (!hasSession) {
    return <FooterPanelRow label="Session" value="none" width={ROW_WIDTH} muted />;
  }
  const isUnreachable = attached && unreachable !== null;
  let statusValue: string;
  let statusColor: InkColor;
  if (isUnreachable) {
    statusValue = "session unreachable — web may have lost pairing";
    statusColor = Color.warning;
  } else if (attached) {
    statusValue = "attached";
    statusColor = Color.success;
  } else {
    statusValue = "waiting for browser";
    statusColor = Color.warning;
  }
  return (
    <Box flexDirection="column">
      <FooterPanelRow
        label="Session"
        value={statusValue}
        valueColor={statusColor}
        width={ROW_WIDTH}
        muted
      />
      <Box marginTop={1} flexDirection="column">
        <Text color={Color.muted}>URL</Text>
        <TerminalLink url={url} />
        {!attached && linkExpired && (
          <Text color={Color.warning}>link expired — restart the session</Text>
        )}
        {!attached && !linkExpired && expiresAt !== null && <LinkCountdown expiresAt={expiresAt} />}
      </Box>
    </Box>
  );
}

function MainView({
  auth,
  hasSession,
  attached,
  url,
  expiresAt,
  linkExpired,
  unreachable,
  brief,
  actions,
  selected,
  busy,
  error,
  deviceAuth,
}: {
  auth: AuthSnapshot;
  hasSession: boolean;
  attached: boolean;
  url: string;
  expiresAt: string | null;
  linkExpired: boolean;
  unreachable: string | null;
  brief: string;
  actions: Action[];
  selected: number;
  busy: Busy;
  error: string | null;
  deviceAuth: DeviceAuthPending | null;
}): React.JSX.Element {
  const showBrief = !hasSession && brief.length > 0;
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginBottom={1}>
        <FooterPanelRow label="Account" value={auth.label} width={ROW_WIDTH} muted />
        <SessionStatus
          hasSession={hasSession}
          attached={attached}
          url={url}
          expiresAt={expiresAt}
          linkExpired={linkExpired}
          unreachable={unreachable}
        />
        {showBrief && (
          <Box marginTop={1} flexDirection="column">
            <Text color={Color.muted}>Pending brief</Text>
            <Text color={Color.text} wrap="truncate-end">
              {brief}
            </Text>
          </Box>
        )}
      </Box>

      <Text color={Color.border}>{Glyph.boxHLine.repeat(ROW_WIDTH + 14)}</Text>

      <Box flexDirection="column" marginTop={1}>
        {actions.map((action, idx) => (
          <FooterPanelRow
            key={action}
            label={ACTION_LABEL[action]}
            selected={idx === selected}
            width={ROW_WIDTH}
          />
        ))}
      </Box>

      {busy !== null && (
        <Box marginTop={1}>
          <Text color={Color.muted} dim>
            {busyLabel(busy)}
          </Text>
        </Box>
      )}
      {deviceAuth !== null && <DeviceAuthNotice pending={deviceAuth} />}
      {!!error && (
        <Box marginTop={1}>
          <Text color={Color.error}>{error}</Text>
        </Box>
      )}
    </Box>
  );
}

function LoginPick({
  selected,
  busy,
  error,
  deviceAuth,
}: {
  selected: number;
  busy: boolean;
  error: string | null;
  deviceAuth: DeviceAuthPending | null;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text color={Color.muted}>
        Sign in to the otherside backend to relay your design session.
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {PROVIDERS.map((provider, idx) => (
          <FooterPanelRow
            key={provider.id}
            label={provider.label}
            selected={idx === selected}
            width={ROW_WIDTH}
          />
        ))}
      </Box>
      {busy && (
        <Box marginTop={1}>
          <Text color={Color.muted} dim>
            Opening browser… complete the sign-in, then return here.
          </Text>
        </Box>
      )}
      {deviceAuth !== null && <DeviceAuthNotice pending={deviceAuth} />}
      {!!error && (
        <Box marginTop={1}>
          <Text color={Color.error}>{error}</Text>
        </Box>
      )}
    </Box>
  );
}

function LogoutConfirm(): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text color={Color.text}>Sign out of Otherside Design?</Text>
      <Box marginTop={1}>
        <Text color={Color.warning}>This also unpairs all linked mobile devices.</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={Color.muted}>Enter to confirm · Esc to cancel</Text>
      </Box>
    </Box>
  );
}
