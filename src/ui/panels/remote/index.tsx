import { useEffect, useRef, useState } from "react";
import {
  beginPair,
  ensureDevice,
  isAutoEnable,
  isRemoteEnabled,
  listPeers,
  type PairHandle,
  type PairResult,
  type Peer,
  removePeer,
  resetRemoteIdentity,
  setAutoEnable,
  setRemoteEnabled,
  syncPeersWithBackend,
} from "@/backend/index.ts";
import { type OAuthProvider, oauthLogin } from "@/backend/shared/oauth.ts";
import { Box, type Color as InkColor, Text, useStdout } from "@/ink";
import { readRemoteInvalidationEpoch, useAppSelect } from "@/store/index.ts";
import { FooterPanel, FooterPanelRow, PanelDivider } from "@/ui/chrome/panel.tsx";
import { usePanelNavigation } from "@/ui/hooks/use-panel-navigation.ts";
import {
  type AuthSnapshot,
  LOGIN_PROVIDERS,
  LoginPick,
  readAuth,
  usePendingDeviceAuth,
} from "@/ui/panels/_shared/backend-account.tsx";
import { useOverlayDispatch } from "@/ui/panels/context";
import { useOverlayClose } from "@/ui/panels/use-overlay-close";
import { Color } from "@/ui/theme/theme.ts";

export interface RemoteOverlayProps {
  onClose?: () => void;
}

type Sub =
  | { kind: "login" }
  | { kind: "loginPick" }
  | { kind: "list" }
  | { kind: "unpair"; peer: Peer }
  | { kind: "pair" };

type PairPhase = "awaiting" | "confirmed" | "failed";

interface RemoteSnapshot {
  enabled: boolean;
  autoEnable: boolean;
  deviceName: string;
  peers: Peer[];
}

interface SettingRow {
  id: "session" | "autoEnable";
  label: string;
  value: string;
  disabled: boolean;
}

const ROW_WIDTH = 26;

function readSnapshot(): RemoteSnapshot {
  const peers = listPeers();
  const enabled = isRemoteEnabled() && peers.length > 0;
  return {
    enabled,
    autoEnable: isAutoEnable(),
    deviceName: ensureDevice().name,
    peers,
  };
}

function settingRows(snapshot: RemoteSnapshot): SettingRow[] {
  const hasPeers = snapshot.peers.length > 0;
  return [
    {
      id: "session",
      label: "Remote Session active",
      value: snapshot.enabled ? "on" : "off",
      disabled: !hasPeers,
    },
    {
      id: "autoEnable",
      label: "Always active on startup",
      value: snapshot.autoEnable ? "on" : "off",
      disabled: false,
    },
  ];
}

export function RemoteOverlay({ onClose }: RemoteOverlayProps = {}): React.JSX.Element {
  const { invalidatePrevFrame } = useOverlayDispatch();
  const close = useOverlayClose(onClose);
  const invalidatePrevFrameRef = useRef(invalidatePrevFrame);
  invalidatePrevFrameRef.current = invalidatePrevFrame;
  const syncStatus = useAppSelect((s) => s.view.remoteSyncStatus);
  const invalidationEpoch = useAppSelect((s) => readRemoteInvalidationEpoch(s.engine));
  const initialSnapshot = readSnapshot();
  const [snapshot, setSnapshot] = useState<RemoteSnapshot>(initialSnapshot);
  const [auth, setAuth] = useState<AuthSnapshot>(readAuth);
  const [sub, setSub] = useState<Sub>(() => {
    if (!readAuth().signedIn) return { kind: "login" };
    return initialSnapshot.peers.length === 0 ? { kind: "pair" } : { kind: "list" };
  });
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [providerIdx, setProviderIdx] = useState(0);
  const deviceAuth = usePendingDeviceAuth();
  const invalidationMounted = useRef(false);

  useEffect(() => {
    if (!invalidationMounted.current) {
      invalidationMounted.current = true;
      return;
    }
    const next = readSnapshot();
    setSnapshot(next);
    setAuth(readAuth());
    if (!readAuth().signedIn) {
      setSub({ kind: "login" });
    } else if (next.peers.length === 0) {
      setSub({ kind: "pair" });
    }
  }, [invalidationEpoch]);

  const [settingIdx, setSettingIdx] = useState(0);
  const [pair, setPair] = useState<PairHandle | null>(null);
  const [pairPhase, setPairPhase] = useState<PairPhase>("awaiting");
  const [pairResult, setPairResult] = useState<PairResult | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const [pairEpoch, setPairEpoch] = useState(0);
  const [unpairError, setUnpairError] = useState<string | null>(null);

  const settings = settingRows(snapshot);

  useEffect(() => {
    if (!readAuth().signedIn) return;
    void syncPeersWithBackend().then(() => {
      const fresh = readSnapshot();
      if (fresh.peers.length === 0) {
        setRemoteEnabled(false);
        setSub({ kind: "pair" });
      }
      setSnapshot(fresh);
    });
  }, []);

  useEffect(() => {
    if (sub.kind !== "pair") return;
    let cancelled = false;
    let activeHandle: PairHandle | null = null;
    setPair(null);
    setPairPhase("awaiting");
    setPairResult(null);
    setPairError(null);
    beginPair(ensureDevice())
      .then((handle) => {
        if (cancelled) {
          handle.cancel();
          return;
        }
        activeHandle = handle;
        setPair(handle);
        handle.awaiting
          .then((result) => {
            if (cancelled) return;
            invalidatePrevFrameRef.current?.();
            setRemoteEnabled(true);
            setPairResult(result);
            setPairPhase("confirmed");
            setSnapshot(readSnapshot());
          })
          .catch((err) => {
            if (cancelled) return;
            setPairError(err instanceof Error ? err.message : String(err));
            setPairPhase("failed");
          });
      })
      .catch((err) => {
        if (cancelled) return;
        setPairError(err instanceof Error ? err.message : String(err));
        setPairPhase("failed");
      });
    return () => {
      cancelled = true;
      activeHandle?.cancel();
    };
  }, [sub.kind, pairEpoch]);

  function runLogin(provider: OAuthProvider): void {
    setLoginBusy(true);
    setLoginError(null);
    oauthLogin(provider)
      .then(() => {
        setAuth(readAuth());
        const fresh = readSnapshot();
        setSnapshot(fresh);
        setSub(fresh.peers.length === 0 ? { kind: "pair" } : { kind: "list" });
        void syncPeersWithBackend().then(() => setSnapshot(readSnapshot()));
      })
      .catch((err) => setLoginError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoginBusy(false));
  }

  function backToList(): void {
    invalidatePrevFrameRef.current?.();
    setSub({ kind: "list" });
    setSnapshot(readSnapshot());
  }

  function confirmUnpair(peer: Peer): void {
    removePeer(peer.deviceId)
      .then(() => {
        resetRemoteIdentity();
        close();
      })
      .catch((err) => {
        setUnpairError(err instanceof Error ? err.message : String(err));
      });
  }

  function toggleSetting(rowId: SettingRow["id"]): void {
    if (rowId === "session") {
      const next = !snapshot.enabled;
      if (next && snapshot.peers.length === 0) return;
      setRemoteEnabled(next);
      setSnapshot(readSnapshot());
      return;
    }
    setAutoEnable(!snapshot.autoEnable);
    setSnapshot(readSnapshot());
  }

  const handleCancel = (): void => {
    if (sub.kind === "loginPick") {
      setSub({ kind: "login" });
      setLoginError(null);
      return;
    }
    if (sub.kind === "login" || sub.kind === "list" || snapshot.peers.length === 0) {
      close();
    } else {
      backToList();
    }
  };

  usePanelNavigation({
    onClose: close,
    skipEsc: true,
    onBack: () => {
      if (sub.kind === "loginPick") {
        setSub({ kind: "login" });
        setLoginError(null);
        return true;
      }
      if (sub.kind === "login" || sub.kind === "list" || snapshot.peers.length === 0) {
        close();
        return true;
      }
      backToList();
      return true;
    },
    rows:
      sub.kind === "list"
        ? {
            count: settings.length,
            selected: settingIdx,
            onChange: setSettingIdx,
          }
        : sub.kind === "loginPick"
          ? {
              count: LOGIN_PROVIDERS.length,
              selected: providerIdx,
              onChange: setProviderIdx,
            }
          : undefined,
    onActivate: () => {
      if (sub.kind === "login") {
        if (!loginBusy) {
          setProviderIdx(0);
          setLoginError(null);
          setSub({ kind: "loginPick" });
        }
        return;
      }
      if (sub.kind === "loginPick") {
        if (loginBusy) return;
        const provider = LOGIN_PROVIDERS[providerIdx];
        if (provider) runLogin(provider.id);
        return;
      }
      if (sub.kind !== "list") return;
      if (settingIdx === 0) {
        toggleSetting("session");
      } else if (settingIdx === 1) {
        toggleSetting("autoEnable");
      }
    },
    onKey: (input, key) => {
      if (sub.kind === "unpair") {
        if (key.return) confirmUnpair(sub.peer);
        return true;
      }
      if (sub.kind === "pair") {
        if (input === "r" || input === "R") {
          invalidatePrevFrameRef.current?.();
          setPairEpoch((epoch) => epoch + 1);
        }
        return true;
      }
      if (sub.kind === "list" && (input === "u" || input === "U")) {
        const peer = snapshot.peers[0];
        if (peer) {
          invalidatePrevFrameRef.current?.();
          setUnpairError(null);
          setSub({ kind: "unpair", peer });
        }
        return true;
      }
      return false;
    },
  });

  if (sub.kind === "login") {
    return (
      <FooterPanel
        command="/remote"
        title="Remote Session"
        accent={Color.primaryGlow}
        footerHints={[
          ["Enter", "select"],
          ["Esc", "close"],
        ]}
        onCancel={handleCancel}
      >
        <Box flexDirection="column">
          <Box flexDirection="column" marginBottom={1}>
            <FooterPanelRow label="Account" value={auth.label} width={ROW_WIDTH} muted />
          </Box>
          <PanelDivider width={ROW_WIDTH + 12} />
          <Box flexDirection="column" marginTop={1}>
            <FooterPanelRow label="Sign in" selected width={ROW_WIDTH} />
          </Box>
          <Box marginTop={1}>
            <Text color={Color.muted}>Sign in first, then pair your mobile device.</Text>
          </Box>
        </Box>
      </FooterPanel>
    );
  }

  if (sub.kind === "loginPick") {
    return (
      <FooterPanel
        command="/remote"
        title="Sign in"
        accent={Color.primaryGlow}
        footerHints={[
          ["↑↓", "navigate"],
          ["Enter", "choose"],
          ["Esc/←", "back"],
        ]}
        onCancel={handleCancel}
      >
        <LoginPick
          description="Sign in to the otherside backend to link your mobile device."
          selected={providerIdx}
          busy={loginBusy}
          error={loginError}
          deviceAuth={deviceAuth}
          rowWidth={ROW_WIDTH}
        />
      </FooterPanel>
    );
  }

  if (sub.kind === "pair") {
    const pairHints: [string, string][] = [
      ["r", "new code"],
      snapshot.peers.length === 0 ? ["Esc/←", "close"] : ["Esc/←", "back"],
    ];
    return (
      <FooterPanel
        command="/remote"
        title="Pair a device"
        accent={Color.primaryGlow}
        footerHints={pairHints}
        onCancel={handleCancel}
      >
        <PairPane phase={pairPhase} handle={pair} result={pairResult} error={pairError} />
      </FooterPanel>
    );
  }

  if (sub.kind === "unpair") {
    return (
      <FooterPanel
        command="/remote"
        title="Unpair device"
        accent={Color.primaryGlow}
        footerHints={[
          ["Enter", "confirm"],
          ["Esc/←", "cancel"],
        ]}
        onCancel={handleCancel}
      >
        <UnpairPane peer={sub.peer} error={unpairError} />
      </FooterPanel>
    );
  }

  const syncLabel =
    syncStatus === "active"
      ? "active"
      : syncStatus === "connecting"
        ? "connecting..."
        : "disconnected";
  const syncColor =
    syncStatus === "active"
      ? Color.success
      : syncStatus === "connecting"
        ? Color.warning
        : Color.muted;

  return (
    <FooterPanel
      command="/remote"
      title="Remote Session"
      accent={Color.primaryGlow}
      footerHints={footerHints(snapshot)}
      onCancel={handleCancel}
    >
      <Box flexDirection="column">
        <Box flexDirection="column" marginBottom={1}>
          <FooterPanelRow label="Account" value={auth.label} width={ROW_WIDTH} muted />
          <FooterPanelRow label="CLI device" value={snapshot.deviceName} width={ROW_WIDTH} muted />
          {snapshot.peers.map((peer) => (
            <FooterPanelRow
              key={peer.deviceId}
              label="Paired device"
              value={peer.label}
              width={ROW_WIDTH}
              muted
            />
          ))}
          <FooterPanelRow
            label="Connection status"
            value={syncLabel}
            valueColor={syncColor}
            width={ROW_WIDTH}
            muted
          />
        </Box>

        <PanelDivider width={ROW_WIDTH + 12} />

        <Box flexDirection="column" marginTop={1}>
          {settings.map((row, idx) => (
            <FooterPanelRow
              key={row.id}
              label={row.label}
              value={row.value}
              selected={idx === settingIdx}
              width={ROW_WIDTH}
              valueColor={settingValueColor(row)}
            />
          ))}
        </Box>
      </Box>
    </FooterPanel>
  );
}

function footerHints(snapshot: RemoteSnapshot): [string, string][] {
  const hints: [string, string][] = [
    ["↑↓", "navigate"],
    ["Enter", "toggle"],
  ];
  if (snapshot.peers.length > 0) {
    hints.push(["u", "unpair"]);
  }
  hints.push(["Esc/←", "close"]);
  return hints;
}

function settingValueColor(row: SettingRow): InkColor | undefined {
  if (row.disabled) return Color.muted;
  return row.value === "on" ? Color.success : Color.muted;
}

function UnpairPane({ peer, error }: { peer: Peer; error: string | null }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={Color.text}>Unpair </Text>
        <Text color={Color.text} bold>
          {peer.label}
        </Text>
        <Text color={Color.text}>?</Text>
      </Box>
      {error && (
        <Box marginTop={1}>
          <Text color={Color.error}>{error}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={Color.muted}>Enter to confirm · Esc to cancel</Text>
      </Box>
    </Box>
  );
}

const QR_MIN_ROWS = 38;

function PairPane({
  phase,
  handle,
  result,
  error,
}: {
  phase: PairPhase;
  handle: PairHandle | null;
  result: PairResult | null;
  error: string | null;
}): React.JSX.Element {
  const { stdout } = useStdout();
  const rows = stdout.rows ?? 0;
  const showQr = rows >= QR_MIN_ROWS;
  if (phase === "confirmed") {
    return (
      <Box flexDirection="column">
        <Text color={Color.success} bold>
          Paired
        </Text>
        <Text color={Color.text}>Linked with {result?.peerDeviceId ?? "your device"}.</Text>
        <Text color={Color.muted}>Remote is now enabled.</Text>
      </Box>
    );
  }
  if (phase === "failed") {
    const timedOut = !!error && error.includes("timed out");
    return (
      <Box flexDirection="column">
        <Text color={timedOut ? Color.warning : Color.error} bold>
          {timedOut ? "Pairing code expired" : "Pairing failed"}
        </Text>
        <Text color={timedOut ? Color.muted : Color.error}>
          {timedOut ? "No device scanned it within 3 minutes." : (error ?? "unknown error")}
        </Text>
        <Box marginTop={1}>
          <Text color={Color.primaryGlow}>Press r to generate a new code.</Text>
        </Box>
      </Box>
    );
  }
  if (!handle) {
    return <Text color={Color.muted}>Preparing pairing code…</Text>;
  }
  return (
    <Box flexDirection="column">
      <Text color={Color.muted}>
        Scan with the otherside app (Settings → Linked devices → Pair new device)
      </Text>
      {showQr ? (
        <Box marginTop={1}>
          <Text>{handle.qr}</Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          <Text color={Color.muted}>Terminal too small for QR ({rows} rows). Resize or set</Text>
          <Text color={Color.muted}>
            OTHERSIDE_REMOTE_DEBUG_PAYLOAD=1 to paste payload manually.
          </Text>
        </Box>
      )}
      {process.env.OTHERSIDE_REMOTE_DEBUG_PAYLOAD === "1" && (
        <Box marginTop={1} flexDirection="column">
          <Text color={Color.muted}>Paste this pairing payload in the app's debug field:</Text>
          <Text color={Color.text}>{handle.payload}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={Color.primaryGlow}>Awaiting scan…</Text>
      </Box>
      <Box>
        <Text color={Color.muted}>Code expires after 3 min · press r for a new one</Text>
      </Box>
    </Box>
  );
}
