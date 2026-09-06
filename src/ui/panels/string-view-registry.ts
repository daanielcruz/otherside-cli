import { type OverlayName, overlayStore } from "@/store/overlay-stack/index.ts";
import { createAgentsPanel } from "@/ui/panels/agents/string-view.ts";
import { createBackgroundTasksPanel } from "@/ui/panels/background-tasks/string-view.ts";
import { createBashesPanel } from "@/ui/panels/bashes/string-view.ts";
import { createBtwPanel } from "@/ui/panels/btw/string-view.ts";
import { createConfigPanel } from "@/ui/panels/config/string-view.ts";
import { createDesignPanel } from "@/ui/panels/design/string-view.ts";
import { createDiffPanel } from "@/ui/panels/diff/string-view.ts";
import { createEffortPanel } from "@/ui/panels/effort/string-view.ts";
import { createErrorPanel } from "@/ui/panels/error/string-view.ts";
import { createHelpPanel } from "@/ui/panels/help/string-view.ts";
import { createHooksPanel } from "@/ui/panels/hooks/string-view.ts";
import { createLoginPanel } from "@/ui/panels/login/string-view.ts";
import { createLogoutPanel } from "@/ui/panels/logout/string-view.ts";
import { createMcpPanel } from "@/ui/panels/mcp/string-view.ts";
import { createModelPanel } from "@/ui/panels/model/string-view.ts";
import { createOrchestrationPanel } from "@/ui/panels/orchestration/string-view.ts";
import { createPermissionsPanel } from "@/ui/panels/permissions/string-view.ts";
import { createPluginsPanel } from "@/ui/panels/plugins/string-view.ts";
import { createQuotaPanel } from "@/ui/panels/quota/string-view.ts";
import { createRemotePanel } from "@/ui/panels/remote/string-view.ts";
import { createResumePanel } from "@/ui/panels/resume/string-view.ts";
import { createRewindPanel } from "@/ui/panels/rewind/string-view.ts";
import { createSkillsPanel } from "@/ui/panels/skills/string-view.ts";
import type {
  OverlayOpenProps,
  StringViewPanel,
  StringViewPanelFactory,
} from "@/ui/panels/string-view-types.ts";
import { createThemePanel } from "@/ui/panels/theme/string-view.ts";
import { createUltracodeEffortPanel } from "@/ui/panels/ultracode-effort/string-view.ts";
import {
  createStatsPanel,
  createStatusPanel,
  createUsagePanel,
} from "@/ui/panels/usage/string-view.ts";
import { createWorkflowsPanel } from "@/ui/panels/workflows/string-view.ts";

/**
 * Maps overlay names to their string-view panel factories. An overlay absent from the
 * map has no string-view surface yet, so the host renders nothing and leaves keys with
 * the prompt until it is ported. Factories receive optional open-time props from the
 * overlay stack entry (see OverlayProps).
 */
const REGISTRY: Partial<{ [K in OverlayName]: StringViewPanelFactory<K> }> = {
  theme: createThemePanel,
  skills: createSkillsPanel,
  bashes: createBashesPanel,
  help: createHelpPanel,
  hooks: createHooksPanel,
  effort: createEffortPanel,
  diff: createDiffPanel,
  tasks: createBackgroundTasksPanel,
  agents: createAgentsPanel,
  model: createModelPanel,
  config: createConfigPanel,
  error: createErrorPanel,
  quota: createQuotaPanel,
  usage: createUsagePanel,
  status: createStatusPanel,
  stats: createStatsPanel,
  mcp: createMcpPanel,
  workflows: createWorkflowsPanel,
  orchestration: createOrchestrationPanel,
  remote: createRemotePanel,
  rewind: createRewindPanel,
  design: createDesignPanel,
  permissions: createPermissionsPanel,
  plugins: createPluginsPanel,
  "ultracode-effort": createUltracodeEffortPanel,
  login: createLoginPanel,
  logout: createLogoutPanel,
  resume: createResumePanel,
  btw: createBtwPanel,
};

export function isPortedOverlay(name: string): name is OverlayName {
  return name in REGISTRY;
}

/**
 * Instantiate the string-view surface for `name`. `props` is the open-time payload
 * stored on the overlay entry (typed per OverlayProps when known).
 */
export function createStringViewPanel<N extends OverlayName>(
  name: N,
  close: () => void,
  props?: OverlayOpenProps<N>,
): StringViewPanel {
  const factory = REGISTRY[name] as StringViewPanelFactory<N> | undefined;
  if (factory === undefined) {
    throw new Error(`no string-view panel registered for overlay "${name}"`);
  }
  return factory(close, props);
}

/** The top overlay's name when it has a string-view surface, else undefined. */
export function topPortedOverlay(): OverlayName | undefined {
  const stack = overlayStore.getState().openStack;
  const top = stack[stack.length - 1];
  if (top === undefined) return undefined;
  return isPortedOverlay(top.name) ? top.name : undefined;
}

/** True while a ported panel owns the lower region, so the chrome footer yields. */
export function isPortedOverlayOpen(): boolean {
  return topPortedOverlay() !== undefined;
}
