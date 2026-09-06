import {
  ensureDevice,
  isAutoEnable,
  isRemoteEnabled,
  listPeers,
  type Peer,
} from "@/backend/index.ts";
import {
  currentAuthScope,
  currentUserEmail,
  currentUserId,
  loadAuth,
} from "@/backend/shared/auth.ts";
import type { OAuthProvider } from "@/backend/shared/oauth.ts";
import type { RemoteSyncStatus } from "@/kernel/std/types/remote-sync-status.ts";
import { Color } from "@/ui/theme/theme.ts";

export type RemoteAction = "login" | "pair" | "session" | "autoEnable" | "logout";

export type Sub =
  | { kind: "main" }
  | { kind: "loginPick" }
  | { kind: "logoutConfirm" }
  | { kind: "unpair"; peer: Peer }
  | { kind: "pair" };

export type PairPhase = "awaiting" | "confirmed" | "failed";

export interface AuthSnapshot {
  signedIn: boolean;
  label: string;
}

export interface RemoteSnapshot {
  enabled: boolean;
  autoEnable: boolean;
  deviceName: string;
  peers: Peer[];
}

export interface ActionRow {
  id: RemoteAction;
  label: string;
  value?: string;
}

interface ProviderChoice {
  id: OAuthProvider;
  label: string;
}

export const LOGIN_PROVIDERS: ProviderChoice[] = [
  { id: "google", label: "Continue with Google" },
  { id: "apple", label: "Continue with Apple" },
];

const ACTION_LABEL: Record<RemoteAction, string> = {
  login: "Sign in",
  pair: "Pair a device",
  session: "Remote Session active",
  autoEnable: "Always active on startup",
  logout: "Sign out",
};

/**
 * Action ids shown on the main Remote Session surface, ordered for the credential /
 * paired state. Exported for unit tests that pin the matrix.
 */
export function remoteMainActions(signedIn: boolean, hasPeers: boolean): RemoteAction[] {
  if (!signedIn) return ["pair", "login"];
  if (!hasPeers) return ["pair", "logout"];
  return ["session", "autoEnable", "pair", "logout"];
}

export function readAuth(): AuthSnapshot {
  if (!loadAuth()) return { signedIn: false, label: "Not paired" };
  if (currentAuthScope() === "device") return { signedIn: true, label: "Device approved" };
  const email = currentUserEmail();
  const id = currentUserId();
  const label = email ?? (id ? `${id.slice(0, 8)}…` : "Signed in");
  return { signedIn: true, label };
}

export function readSnapshot(): RemoteSnapshot {
  const peers = listPeers();
  const enabled = isRemoteEnabled() && peers.length > 0;
  return {
    enabled,
    autoEnable: isAutoEnable(),
    deviceName: ensureDevice().name,
    peers,
  };
}

export function actionRows(auth: AuthSnapshot, snapshot: RemoteSnapshot): ActionRow[] {
  return remoteMainActions(auth.signedIn, snapshot.peers.length > 0).map((action) => {
    if (action === "session") {
      return { id: action, label: ACTION_LABEL[action], value: snapshot.enabled ? "on" : "off" };
    }
    if (action === "autoEnable") {
      return {
        id: action,
        label: ACTION_LABEL[action],
        value: snapshot.autoEnable ? "on" : "off",
      };
    }
    return { id: action, label: ACTION_LABEL[action] };
  });
}

export function actionValueColor(
  value: string | undefined,
): typeof Color.success | typeof Color.muted | undefined {
  if (value === undefined) return undefined;
  return value === "on" ? Color.success : Color.muted;
}

export function connectionLabel(
  peers: Peer[],
  syncStatus: RemoteSyncStatus,
): { label: string; color: typeof Color.success | typeof Color.warning | typeof Color.muted } {
  if (peers.length > 0 && syncStatus === "active") {
    return { label: "active", color: Color.success };
  }
  if (peers.length > 0 && syncStatus === "connecting") {
    return { label: "connecting...", color: Color.warning };
  }
  if (peers.length > 0) {
    return { label: "disconnected", color: Color.muted };
  }
  return { label: "not paired", color: Color.muted };
}

export function mainFooterHints(snapshot: RemoteSnapshot): [string, string][] {
  const hints: [string, string][] = [
    ["↑↓", "navigate"],
    ["Enter", "select"],
  ];
  if (snapshot.peers.length > 0) hints.push(["u", "unpair"]);
  hints.push(["Esc/←", "close"]);
  return hints;
}
