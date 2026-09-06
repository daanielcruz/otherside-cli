import type { OverlayName } from "@/store/overlay-stack/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { StringComponent } from "@/terminal-runtime/string-view/component.js";
import type { BtwPanelProps } from "@/ui/panels/btw/string-view.ts";
import type { LoginPanelProps } from "@/ui/panels/login/string-view.ts";
import type { LogoutPanelProps } from "@/ui/panels/logout/string-view.ts";
import type { PluginsOverlayProps } from "@/ui/panels/plugins/types.ts";
import type { ResumePanelProps } from "@/ui/panels/resume/string-view.ts";
import type { RewindPanelProps } from "@/ui/panels/rewind/string-view.ts";

/**
 * A string-view footer panel: a renderable that also owns keyboard input while it
 * holds focus. Concrete panels read their data from the engine/stores directly and
 * request a render on change, mirroring the transcript and chrome components.
 */
export interface StringViewPanel extends StringComponent {
  handleKey(key: KeyEventData): void;
  /**
   * True while the panel wants the whole frame. The conversation above and the
   * prompt below yield to it, and both come back when it stops asking. A panel
   * that leaves this out keeps the footer tenancy every list panel wants.
   */
  fullscreen?(): boolean;
}

/**
 * Open-time payload per overlay name. Only overlays that accept opener props appear
 * here; every field is supplied by the app root (or nested openers) via
 * `overlayStack.open(name, props)`. Slash-open with no payload leaves props undefined
 * and each panel must tolerate that (disabled / fallback path, never crash).
 *
 * Integrator checklist (values wired outside this package):
 * - login → `broker`, `config`, `onConfigChange`, optional `initialProvider`
 * - logout → optional `broker` (else active session provider)
 * - resume → `onResumeSession` from `createResumeSession` (session-ops)
 * - rewind → `onRewind` from `createRewindToTranscriptId` (session-ops), optional turns
 * - plugins → optional `commandResult`
 * - btw → `forkAnswer` + `abortPending` from the dispatch's side-question controller
 */
export type OverlayProps = {
  login: LoginPanelProps;
  logout: LogoutPanelProps;
  resume: ResumePanelProps;
  rewind: RewindPanelProps;
  plugins: PluginsOverlayProps;
  btw: BtwPanelProps;
};

/** Props accepted when opening overlay `N` (unknown when `N` has no OverlayProps entry). */
export type OverlayOpenProps<N extends OverlayName> = N extends keyof OverlayProps
  ? OverlayProps[N]
  : unknown;

/**
 * Builds a panel for overlay `N`. Second arg is the opener payload when `N` is in
 * OverlayProps; omitted on plain slash-open.
 */
export type StringViewPanelFactory<N extends OverlayName = OverlayName> = (
  close: () => void,
  props?: OverlayOpenProps<N>,
) => StringViewPanel;
