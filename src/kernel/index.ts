export { getActivePasteStore, setActivePasteStore } from "./std/paste/registry.ts";
export { installProcessSignalHandlers, shutdown } from "./std/proc/process-shutdown.ts";
export { AsyncStream } from "./std/stream/async.ts";
export type { PasteStore } from "./std/types/paste.ts";
export {
  clearFileHistoryForSession,
  type FileSnapshot,
  fileRestoreDiffStatsForTurn,
  fileSnapshotStatsForTurn,
  type RestoreDiffStats,
  restoreFilesForRewind,
  setActiveRewindTurn,
  snapshotBeforeFileMutation,
} from "./storage/file-history.ts";
