/**
 * Dependency-safe semantic facade for the top-right status region.
 * No React / terminal-runtime imports — safe from store subscribers and engine-adjacent code.
 */
import { pluralize } from "@/kernel/std/text/pluralize.ts";
import { dispatch } from "@/store/app-store/index.ts";
import type {
  EphemeralNoticeInput,
  PersistentNoticeInput,
} from "@/store/app-store/slices/right-region.ts";
import {
  CLIPBOARD_IMAGE_COOLDOWN_MS,
  CLIPBOARD_IMAGE_MS,
  DEFAULT_EPHEMERAL_MS,
  ORCHESTRATION_NOTICE_MS,
  PLUGIN_NOTICE_MS,
  VOICE_ERROR_MS,
} from "@/store/app-store/slices/right-region.ts";

export type {
  EphemeralNoticeInput,
  NoticePriority,
  NoticeTone,
  PersistentNoticeInput,
  PersistentNoticeLane,
} from "@/store/app-store/slices/right-region.ts";
export {
  CLIPBOARD_COPY_NATIVE_MS,
  CLIPBOARD_COPY_TMUX_MS,
  CLIPBOARD_COPY_WARNING_MS,
  CLIPBOARD_IMAGE_COOLDOWN_MS,
  CLIPBOARD_IMAGE_MS,
  DEFAULT_EPHEMERAL_MS,
  GOAL_REFRESH_MS,
  ORCHESTRATION_NOTICE_MS,
  PLUGIN_NOTICE_MS,
  VOICE_ERROR_MS,
} from "@/store/app-store/slices/right-region.ts";

/** Stable notice keys — producers and invalidation lists share these. */
export const RightNoticeKey = {
  quota: "quota-warning",
  orchestration: "orchestration-notice",
  clipboardImage: "clipboard-image-hint",
  clipboardCopy: "clipboard-copy",
  plugin: "plugin-notice",
  voiceError: "voice-error",
  voiceRecording: "voice-recording",
  voiceProcessing: "voice-processing",
  context: "context-warning",
  autoCompact: "auto-compact",
  mcpFailure: "mcp-failure",
  goal: "goal",
  remote: "remote-session",
  design: "design-session",
  remoteDesign: "remote-design-session",
  keyBindings: "key-bindings",
} as const;

export function submitEphemeral(notice: EphemeralNoticeInput, now: number = Date.now()): void {
  dispatch({ type: "rightRegion/submitEphemeral", notice, now });
}

export function removeNotice(key: string, now: number = Date.now()): void {
  dispatch({ type: "rightRegion/removeNotice", key, now });
}

export function upsertPersistent(notice: PersistentNoticeInput, now: number = Date.now()): void {
  dispatch({ type: "rightRegion/upsertPersistent", notice, now });
}

export function removePersistent(key: string): void {
  dispatch({ type: "rightRegion/removePersistent", key });
}

export function setTokenCounter(text: string | null): void {
  dispatch({ type: "rightRegion/setCounter", text });
}

export function setRegionPaused(paused: boolean, now: number = Date.now()): void {
  dispatch({ type: "rightRegion/setPaused", paused, now });
}

export function expireCurrentNotice(now: number = Date.now()): void {
  dispatch({ type: "rightRegion/expireCurrent", now });
}

export function tickRegionRefresh(now: number = Date.now()): void {
  dispatch({ type: "rightRegion/tickRefresh", now });
}

/** Full slice reset — tests and session teardown. */
export function resetRightRegion(): void {
  dispatch({ type: "rightRegion/reset" });
}

// ── Semantic helpers for common producers ──────────────────────────────────

export function submitQuotaWarning(message: string, severity: "warning" | "error"): void {
  submitEphemeral({
    key: RightNoticeKey.quota,
    text: message,
    tone: severity === "error" ? "error" : "warning",
    priority: "high",
    durationMs: DEFAULT_EPHEMERAL_MS,
    fold: true,
    restartOnFold: true,
  });
}

export function clearQuotaWarning(): void {
  removeNotice(RightNoticeKey.quota);
}

// Folding lets a rapid mode change replace a still-visible notice with the
// latest text and a fresh window instead of being dropped as a duplicate key.
export function submitOrchestrationNotice(text: string): void {
  submitEphemeral({
    key: RightNoticeKey.orchestration,
    text,
    tone: "warning",
    priority: "immediate",
    durationMs: ORCHESTRATION_NOTICE_MS,
    fold: true,
    restartOnFold: true,
  });
}

// The hint rides the mode row, where it shares the side with the goal, so a paste
// notice never costs the chrome a row of its own.
export function submitClipboardImageHint(text: string): void {
  submitEphemeral({
    key: RightNoticeKey.clipboardImage,
    text,
    lane: "statusbar",
    tone: "muted",
    priority: "immediate",
    durationMs: CLIPBOARD_IMAGE_MS,
    cooldownMs: CLIPBOARD_IMAGE_COOLDOWN_MS,
    dim: true,
  });
}

export function submitPluginNotice(text: string): void {
  submitEphemeral({
    key: RightNoticeKey.plugin,
    text,
    tone: "muted",
    priority: "low",
    durationMs: PLUGIN_NOTICE_MS,
  });
}

// Boot-time companion to the transcript rows: servers that would not connect
// also surface here once, on the queue's default window, then dismiss.
export function submitMcpFailuresNotice(failedCount: number): void {
  if (failedCount <= 0) return;
  submitEphemeral({
    key: RightNoticeKey.mcpFailure,
    text: `${failedCount} MCP ${pluralize(failedCount, "server", "servers")} failed`,
    dimSuffix: " · /mcp",
    tone: "error",
    priority: "high",
    durationMs: DEFAULT_EPHEMERAL_MS,
  });
}

export function submitVoiceError(message: string): void {
  submitEphemeral({
    key: RightNoticeKey.voiceError,
    text: message,
    tone: "error",
    priority: "immediate",
    durationMs: VOICE_ERROR_MS,
  });
}

export function setVoicePhase(phase: "idle" | "warmup" | "recording" | "processing"): void {
  const now = Date.now();
  removeNotice(RightNoticeKey.voiceRecording, now);
  removeNotice(RightNoticeKey.voiceProcessing, now);
  if (phase === "recording") {
    submitEphemeral({
      key: RightNoticeKey.voiceRecording,
      text: "listening…",
      tone: "muted",
      priority: "immediate",
      durationMs: null,
    });
    return;
  }
  if (phase === "processing") {
    submitEphemeral({
      key: RightNoticeKey.voiceProcessing,
      text: "Voice: processing…",
      tone: "muted",
      priority: "immediate",
      durationMs: null,
    });
  }
}
