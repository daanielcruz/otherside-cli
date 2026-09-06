import { get as getBackgroundTask } from "@/engine/background/tasks/background.ts";
import type { EffortLevel } from "@/kernel/std/types/effort.ts";
import { modelRoute } from "@/kernel/std/types/provider-ids.ts";
import { appStore } from "@/store/app-store/index.ts";
import { displayNameFor, displayRouteModelName } from "@/ui/transcript/tool-render/args.ts";

/** Longest name the placeholder spells out before it elides the tail. */
const PLACEHOLDER_NAME_LIMIT = 20;

/** Who a typed message reaches while an agent's document is open. */
export interface AgentAddressee {
  /**
   * What is running — agent type, model and effort. The spawn description already
   * has a home on the agents panel row and must not displace the identity here.
   */
  readonly identity: string;
  /** What an empty prompt stands in with, so the addressee is named either way. */
  readonly placeholder: string;
}

/** The open agent document's addressee, or null while the conversation is the main one. */
export function openAgentAddressee(): AgentAddressee | null {
  const id = appStore.getState().view.viewingAgentId;
  if (id === null) return null;
  const task = getBackgroundTask(id);
  if (task === undefined) return null;

  const route =
    task.provider !== undefined && task.model !== undefined
      ? modelRoute(task.provider, task.model)
      : null;
  const identity = [
    agentTypeName(task.agentId, task.agentName),
    route === null ? "" : `- ${displayRouteModelName(route)}`,
    task.effort === undefined ? "" : effortLabel(task.effort),
  ]
    .filter((part) => part.length > 0)
    .join(" ");
  return { identity, placeholder: placeholderFor(task.agentName) };
}

/** The type's display name, falling back to the instance name when it carries no type. */
function agentTypeName(agentId: string | undefined, agentName: string): string {
  if (agentId === undefined || agentId.length === 0) return agentName;
  const label = displayNameFor("Agent", { subagent_type: agentId });
  return label.length === 0 ? agentName : label;
}

function effortLabel(effort: EffortLevel): string {
  if (effort === "xhigh") return "xHigh";
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

function placeholderFor(agentName: string): string {
  const name =
    agentName.length > PLACEHOLDER_NAME_LIMIT
      ? `${agentName.slice(0, PLACEHOLDER_NAME_LIMIT - 3)}...`
      : agentName;
  return `Message @${name}…`;
}
