import { currentUserEmail, currentUserId, loadAuth } from "@/backend/shared/auth.ts";
import type { DeviceAuthPending, OAuthProvider } from "@/backend/shared/oauth.ts";
import { OTHERSIDE_VERSION } from "@/boot/version.ts";
import { createDesignController, type DesignController } from "@/design/controller.ts";
import { getBySession, list as listDesignSpawns } from "@/design/spawn-registry.ts";
import { getActiveSessionId } from "@/engine/background/tasks/output-files.ts";
import type { Agent } from "@/engine/queue/index.ts";
import type { Session } from "@/engine/session/index.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import { sessionFinalizersRef } from "@/store/session-lifecycle/index.ts";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { Color } from "@/ui/theme/theme.ts";

export type View = "main" | "loginPick" | "logoutConfirm";
export type Busy = null | "login" | "start" | "stop";
export type Action = "login" | "start" | "open" | "stop" | "logout";

export interface AuthSnapshot {
  signedIn: boolean;
  label: string;
}

interface ProviderChoice {
  id: OAuthProvider;
  label: string;
}

export interface DesignPanelProps {
  session?: Session;
  controller?: DesignController;
  broker?: Broker;
  agent?: Agent;
  version?: string;
}

export const LOGIN_PROVIDERS: ProviderChoice[] = [
  { id: "google", label: "Continue with Google" },
  { id: "apple", label: "Continue with Apple" },
];

export function deviceAuthLines(pending: DeviceAuthPending, contentWidth: number): string[] {
  return [
    "",
    renderTextWithStyles("Approve this terminal in the browser", { color: Color.warning }),
    renderTextWithStyles("Code ", { color: Color.muted }) +
      renderTextWithStyles(pending.userCode, { color: Color.text, bold: true }),
    renderTextWithStyles(truncateEllipsis(pending.verificationUri, contentWidth), {
      color: Color.panelAccent,
    }),
  ];
}

export function readAuth(): AuthSnapshot {
  if (!loadAuth()) return { signedIn: false, label: "Not signed in" };
  const email = currentUserEmail();
  const id = currentUserId();
  const label = email ?? (id ? `${id.slice(0, 8)}…` : "Signed in");
  return { signedIn: true, label };
}

export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function busyLabel(busy: Exclude<Busy, null>): string {
  if (busy === "login") return "Opening browser for sign-in…";
  if (busy === "start") return "Starting design session…";
  return "Stopping session…";
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function resolveSessionId(props: DesignPanelProps): string {
  if (props.session?.id) return props.session.id;
  const active = getActiveSessionId();
  if (active) return active;
  const spawn = listDesignSpawns()[0];
  return spawn?.sessionId ?? "";
}

export function resolveController(props: DesignPanelProps): DesignController | null {
  if (props.controller) return props.controller;
  if (props.session && props.broker && props.agent) {
    return createDesignController({
      broker: props.broker,
      session: props.session,
      agent: props.agent,
      version: props.version ?? OTHERSIDE_VERSION,
      onFinalize: (handler) => {
        sessionFinalizersRef.current.push(handler);
      },
    });
  }
  // Existing spawn carries the live runtime handles (restart after attach).
  const spawn =
    (props.session ? getBySession(props.session.id) : undefined) ?? listDesignSpawns()[0];
  if (spawn) {
    return createDesignController({
      broker: spawn.broker,
      session: spawn.session,
      agent: spawn.agent,
      version: spawn.version || OTHERSIDE_VERSION,
      onFinalize: (handler) => {
        sessionFinalizersRef.current.push(handler);
      },
    });
  }
  return null;
}

export function narrowProps(props: unknown): DesignPanelProps {
  if (typeof props !== "object" || props === null) return {};
  const raw = props as Record<string, unknown>;
  const out: DesignPanelProps = {};

  if (raw.session !== undefined && typeof raw.session === "object" && raw.session !== null) {
    const session = raw.session as Session;
    if (typeof session.id === "string") out.session = session;
  }

  if (
    raw.controller !== undefined &&
    typeof raw.controller === "object" &&
    raw.controller !== null &&
    typeof (raw.controller as DesignController).start === "function" &&
    typeof (raw.controller as DesignController).stop === "function"
  ) {
    out.controller = raw.controller as DesignController;
  }

  if (
    raw.broker !== undefined &&
    typeof raw.broker === "object" &&
    raw.broker !== null &&
    typeof (raw.broker as Broker).read === "function"
  ) {
    out.broker = raw.broker as Broker;
  }

  if (raw.agent !== undefined && typeof raw.agent === "object" && raw.agent !== null) {
    out.agent = raw.agent as Agent;
  }

  if (typeof raw.version === "string") out.version = raw.version;

  return out;
}
