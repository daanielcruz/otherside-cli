export {
  authPath,
  devicePath,
  ensurePeersDir,
  ensureRemoteHome,
  peerPath,
  peersDir,
  pendingEventsPath,
  remoteHome,
} from "@/remote/_infra/paths.ts";
export {
  type ConfirmPairingInput,
  type ConfirmPairingResult,
  confirmPairing,
  type RegisterEnvironmentInput,
  type RegisterEnvironmentResult,
  RemoteApiError,
  registerEnvironment,
  type SessionKeyEntry,
  type ShareSessionKeyInput,
  type ShareSessionKeyResult,
  shareSessionKey,
  type UnpairInput,
  type UnpairResult,
  unpair,
} from "@/remote/backend/api.ts";
export {
  clearAuth,
  isExpired,
  loadAuth,
  loadFreshAuth,
  type RemoteAuth,
  refreshAuth,
  saveAuth,
} from "@/remote/backend/auth.ts";
export { beginPair, type PairHandle, type PairResult } from "@/remote/backend/pair.ts";
export {
  type Device,
  dropCurrentDevice,
  ensureDevice,
  loadDevice,
} from "@/remote/devices/device.ts";
export {
  listPeers,
  loadPeer,
  type Peer,
  removePeer,
  resetRemoteIdentity,
  savePeer,
  syncPeersWithBackend,
  touchPeer,
} from "@/remote/devices/peers.ts";
export { bootRemote } from "@/remote/session/boot.ts";
export {
  initRemoteSession,
  isAutoEnable,
  isRemoteEnabled,
  setAutoEnable,
  setRemoteEnabled,
  subscribeRemoteState,
} from "@/remote/session/state.ts";
export {
  emitEnvBroadcast,
  emitPushEvent,
  emitQueuedInputDrained,
  getActiveSyncSessionId,
  getRemoteSyncStatus,
  isRemoteSyncSuspended,
  resumeRemoteSync,
  type SyncHandle,
  setSessionStatus,
  startSync,
  subscribeRemoteInvalidated,
  subscribeRemoteSyncStatus,
} from "@/remote/session/sync.ts";
