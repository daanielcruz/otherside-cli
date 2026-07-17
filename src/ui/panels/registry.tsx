import type { DesignController } from "@/design/controller.ts";
import { getProviderConfig } from "@/engine/contract/registry.ts";
import type { CodexUsage } from "@/engine/providers/codex/usage.ts";
import { isInterruptionMessage } from "@/engine/queue/runtime/interruption-text.ts";
import type { Session } from "@/engine/session/index.ts";
import type { UsageByProvider } from "@/engine/session/usage/provider.ts";
import type { UserConfig } from "@/kernel/config/config.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import {
  OVERLAY_NAMES,
  type Overlay,
  type OverlayName,
  type OverlayOpenStack,
} from "@/store/overlay-stack/index.ts";
import type { RewindMode } from "@/ui/app.tsx";
import type { TranscriptEntry } from "@/ui/transcript/types";
import { AgentsOverlay } from "./agents";
import { BackgroundTasksOverlay } from "./background-tasks";
import { BashesOverlay } from "./bashes";
import { ConfigOverlay, type TabId as ConfigTabId } from "./config";
import { DesignOverlay } from "./design";
import { DiffOverlay } from "./diff";
import { EffortOverlay } from "./effort";
import { UltracodeEffortOverlay } from "./effort/ultracode";
import { HelpOverlay } from "./help";
import { HooksOverlay } from "./hooks";
import { LoginOverlay } from "./login";
import { LogoutOverlay } from "./logout";
import { McpOverlay } from "./mcp";
import { ModelOverlay } from "./model";
import { OrchestrationOverlay } from "./orchestration";
import { PermissionsOverlay } from "./permission/rules";
import { PluginsOverlay } from "./plugins";
import { RemoteOverlay } from "./remote";
import { ResumeOverlay } from "./resume";
import { RewindOverlay, type RewindUserTurn } from "./rewind";
import { SkillsOverlay } from "./skills";
import { ThemeOverlay } from "./theme";
import { type UsageInitialTab, UsageOverlay } from "./usage";
import { WorkflowsOverlay } from "./workflows";

export type { Overlay, OverlayName, OverlayOpenStack };
export { OVERLAY_NAMES };

export interface OverlayRegistryProps {
  broker: Broker;
  session: Session;
  designController: DesignController;
  config: UserConfig;
  onConfigChange?: ((config: UserConfig) => void) | undefined;
  version: string;
  onClose: () => void;
  onOpenModel: () => void;
  onOpenLogin?:
    | ((provider?: import("@/kernel/config/provider-ids.ts").ProviderId) => void)
    | undefined;
  loginInitialProvider?: import("@/kernel/config/provider-ids.ts").ProviderId | undefined;
  tasks?: import("@/engine/background/tasks/background.ts").BackgroundTask[];
  usageByProvider?: UsageByProvider | undefined;
  offlineUsageByProvider?: UsageByProvider | undefined;
  codexUsage?: CodexUsage | null | undefined;
  onCodexUsage?: ((usage: CodexUsage | null) => void) | undefined;
  configInitialTab?: ConfigTabId | undefined;
  transcript?: readonly TranscriptEntry[];
  transcriptFull?: readonly TranscriptEntry[];
  onRewind?: (id: string, mode?: RewindMode) => void;
  onResumeSession?: (id: string) => void | Promise<void>;
  isTurnRunning?: () => boolean;
  workflowDetailTargetId?: string | null | undefined;
  onWorkflowDetailOpenChange?: ((open: boolean) => void) | undefined;
}

type OverlayRenderer = (props: OverlayRegistryProps) => React.JSX.Element;

const OVERLAY_RENDERERS: Record<OverlayName, OverlayRenderer> = {
  help: () => <HelpOverlay />,
  model: ({ broker, config, onClose, onConfigChange, onOpenLogin, isTurnRunning }) => (
    <ModelOverlay
      broker={broker}
      config={config}
      onClose={onClose}
      onConfigChange={onConfigChange}
      onOpenLogin={onOpenLogin}
      isTurnRunning={isTurnRunning}
    />
  ),
  effort: ({ broker, config, onClose, isTurnRunning }) => (
    <EffortOverlay
      broker={broker}
      config={config}
      onClose={onClose}
      isTurnRunning={isTurnRunning}
    />
  ),
  agents: ({ broker, onClose }) => (
    <AgentsOverlay
      onClose={onClose}
      providerShortKey={
        getProviderConfig(broker.read().provider)?.provider.shortKey ?? broker.read().provider
      }
    />
  ),
  tasks: ({ onClose, tasks }) => (
    <BackgroundTasksOverlay
      onClose={onClose}
      tasks={(tasks ?? []).filter((t) => t.isBackgrounded && t.status === "running")}
    />
  ),
  bashes: ({ onClose }) => <BashesOverlay onClose={onClose} />,
  config: ({
    broker,
    config,
    version,
    onClose,
    onOpenModel,
    configInitialTab,
    onConfigChange,
    isTurnRunning,
  }) => (
    <ConfigOverlay
      broker={broker}
      config={config}
      version={version}
      onClose={onClose}
      onOpenModel={onOpenModel}
      initialTab={configInitialTab}
      onConfigChange={onConfigChange}
      isTurnRunning={isTurnRunning}
    />
  ),
  permissions: ({ broker, onClose }) => <PermissionsOverlay broker={broker} onClose={onClose} />,
  hooks: ({ config, onClose, session }) => (
    <HooksOverlay config={config} sessionId={session.id} onClose={onClose} />
  ),
  diff: ({ onClose }) => <DiffOverlay onClose={onClose} />,
  skills: ({ onClose }) => <SkillsOverlay onClose={onClose} />,
  status: usagePanel("status", "general"),
  usage: usagePanel("usage", "current"),
  stats: usagePanel("stats", "current"),
  mcp: ({ onClose }) => <McpOverlay onClose={onClose} />,
  plugins: ({ onClose }) => <PluginsOverlay onClose={onClose} />,
  orchestration: ({ config, session, onClose, onConfigChange }) => (
    <OrchestrationOverlay
      config={config}
      cwd={session.cwd}
      onClose={onClose}
      onConfigChange={onConfigChange}
    />
  ),
  login: ({ broker, config, onClose, onConfigChange, loginInitialProvider }) => (
    <LoginOverlay
      broker={broker}
      config={config}
      onClose={onClose}
      onConfigChange={onConfigChange}
      initialProvider={loginInitialProvider}
    />
  ),
  logout: ({ broker, onClose }) => <LogoutOverlay broker={broker} onClose={onClose} />,
  rewind: ({ onClose, session, transcript, transcriptFull, onRewind }) => {
    const transcriptEntries = transcriptFull ?? transcript ?? [];
    const transcriptUserEntries = transcriptEntries.filter(
      (entry) =>
        entry.kind === "user" &&
        !isSlashCommandText(entry.text) &&
        !isInterruptionMessage(entry.text),
    );
    const recordUserMessages = session.records.filter(
      (rec) => rec.type === "user_message" && !isInterruptionMessage(rec.content),
    );
    const pairCount = Math.min(transcriptUserEntries.length, recordUserMessages.length);
    const userTurns: RewindUserTurn[] = [];
    for (let i = 0; i < pairCount; i += 1) {
      const entry = transcriptUserEntries[i];
      const rec = recordUserMessages[i];
      if (!entry || entry.kind !== "user" || !rec) continue;
      userTurns.push({ id: entry.id, ts: rec.ts, text: entry.text });
    }
    return (
      <RewindOverlay
        sessionId={session.id}
        userTurns={userTurns}
        onClose={onClose}
        {...(onRewind ? { onRewind } : {})}
      />
    );
  },
  resume: ({ onClose, onResumeSession }) => (
    <ResumeOverlay onClose={onClose} {...(onResumeSession ? { onResumeSession } : {})} />
  ),
  theme: ({ config, onClose, onConfigChange }) => (
    <ThemeOverlay config={config} onClose={onClose} onConfigChange={onConfigChange} />
  ),
  remote: ({ onClose }) => <RemoteOverlay onClose={onClose} />,
  design: ({ session, onClose, designController }) => (
    <DesignOverlay session={session} controller={designController} onClose={onClose} />
  ),
  workflows: ({ session, onClose, workflowDetailTargetId, onWorkflowDetailOpenChange }) => (
    <WorkflowsOverlay
      sessionId={session.id}
      cwd={session.cwd}
      onClose={onClose}
      {...(onWorkflowDetailOpenChange ? { onDetailOpenChange: onWorkflowDetailOpenChange } : {})}
      {...(workflowDetailTargetId ? { initialDetailItemId: workflowDetailTargetId } : {})}
    />
  ),
  "ultracode-effort": ({ broker, config, onConfigChange, onClose }) => (
    <UltracodeEffortOverlay
      broker={broker}
      config={config}
      onConfigChange={onConfigChange}
      onClose={onClose}
    />
  ),
};

function usagePanel(
  command: "status" | "usage" | "stats",
  initialTab: UsageInitialTab,
): OverlayRenderer {
  return ({
    broker,
    session,
    version,
    onClose,
    tasks,
    usageByProvider,
    offlineUsageByProvider,
    codexUsage,
    onCodexUsage,
    config,
    onConfigChange,
    isTurnRunning,
  }) => (
    <UsageOverlay
      broker={broker}
      onClose={onClose}
      initialTab={initialTab}
      command={`/${command}`}
      session={session}
      version={version}
      usageByProvider={usageByProvider}
      offlineUsageByProvider={offlineUsageByProvider}
      codexUsage={codexUsage}
      onCodexUsage={onCodexUsage}
      backgroundTaskCount={(tasks ?? []).filter((task) => task.isBackgrounded).length}
      config={config}
      onConfigChange={onConfigChange}
      isTurnRunning={isTurnRunning}
    />
  );
}

function isSlashCommandText(text: string): boolean {
  return text.trimStart().startsWith("/");
}

export function isOverlayName(name: string): name is OverlayName {
  return (OVERLAY_NAMES as readonly string[]).includes(name);
}

export function renderOverlay(
  overlay: Overlay,
  props: OverlayRegistryProps,
): React.JSX.Element | null {
  if (overlay === null) return null;
  return OVERLAY_RENDERERS[overlay](props);
}
