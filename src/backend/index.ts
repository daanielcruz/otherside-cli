export { beginPair, type PairHandle, type PairResult } from "@/backend/app/pair.ts";
export {
  type ConfirmPairingInput,
  type ConfirmPairingResult,
  confirmPairing,
  type UnpairInput,
  type UnpairResult,
  unpair,
} from "@/backend/app/pairing-api.ts";
export {
  listPeers,
  loadPeer,
  type Peer,
  removePeer,
  retireRemotePairings,
  savePeer,
  signOutRemote,
  syncPeersWithBackend,
  touchPeer,
} from "@/backend/app/peers.ts";
export {
  initRemoteSession,
  isAutoEnable,
  isRemoteEnabled,
  type RemoteStateSource,
  removeLegacyRemoteSessionState,
  setAutoEnable,
  setRemoteEnabled,
  subscribeRemoteState,
  sweepLegacyRemoteSessionState,
} from "@/backend/app/session/state.ts";
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
} from "@/backend/app/session/sync.ts";
export {
  type RegisterEnvironmentInput,
  type RegisterEnvironmentResult,
  RemoteApiError,
  registerEnvironment,
  type SessionKeyEntry,
  type ShareSessionKeyInput,
  type ShareSessionKeyResult,
  shareSessionKey,
} from "@/backend/shared/api.ts";
export {
  isExpired,
  loadAuth,
  loadFreshAuth,
  type RemoteAuth,
  refreshAuth,
  saveAuth,
} from "@/backend/shared/auth.ts";
export {
  type Device,
  dropCurrentDevice,
  ensureDevice,
  loadDevice,
} from "@/backend/shared/device.ts";
export {
  authPath,
  devicePath,
  ensurePeersDir,
  ensureRemoteHome,
  peerPath,
  peersDir,
  pendingEventsPath,
  remoteHome,
} from "@/backend/shared/paths.ts";
