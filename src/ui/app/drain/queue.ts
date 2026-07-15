import type { PendingChange } from "@/commands/index.ts";
import { getProviderConfig } from "@/engine/contract/registry.ts";
import { effortLevelsForModel, findModel } from "@/engine/model/catalog.ts";
import type { Agent } from "@/engine/queue/index.ts";
import { appendRecord, nowIso, type Session } from "@/engine/session/index.ts";
import { sessionMetaFromBrokerState } from "@/engine/session/state.ts";
import { type UserConfig, updateConfig } from "@/kernel/config/config.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import {
  getQueueMessages,
  overlayStack,
  type QueuedMessage,
  type QueuedPastedImage,
  queueActions,
} from "@/store/index.ts";
import { createPasteStore } from "@/store/paste-store/index.ts";
import { expandToContentBlocks } from "@/ui/input/paste/references.ts";
import { isUltracodeChoice } from "@/ui/panels/effort/ultracode";

export interface QueueHelpersDeps {
  pasteStoreRef: { current: ReturnType<typeof createPasteStore> };
  session: Session;
  agent: Agent;
  broker: Broker;
  compactTerminalRef: { current: boolean };
  runtimeConfigRef: { current: UserConfig };
}

export interface QueueHelpers {
  pushQueued: (text: string) => void;
  popAllQueued: () => string | null;
  applyPendingChange: (change: PendingChange) => void;
  enqueuePendingChange: (change: PendingChange, label: string, recallText?: string) => void;
}

export function formatQueuedActionLabel(change: PendingChange): string {
  switch (change.kind) {
    case "set_model": {
      const providerLabel = getProviderConfig(change.provider)?.provider.label ?? change.provider;
      const modelEntry = findModel(change.model, change.provider);
      const modelLabel = modelEntry?.displayName ?? change.model;
      return `At next turn Otherside will switch to ${providerLabel} - ${modelLabel}`;
    }
    case "set_effort":
      return `At next turn Otherside will set effort to ${change.effort}`;
    case "set_ultracode":
      return `At next turn Otherside will ${change.enabled ? "enable" : "disable"} ultracode`;
    case "set_fast_mode":
      return `At next turn Otherside will ${change.enabled ? "enable" : "disable"} fast mode`;
    case "set_goal":
      return `At next turn Otherside will set goal: ${change.condition}`;
  }
}

export function createQueueHelpers(deps: QueueHelpersDeps): QueueHelpers {
  const { pasteStoreRef, session, agent, broker, compactTerminalRef, runtimeConfigRef } = deps;

  const pushQueued = (text: string): void => {
    const expansion = expandToContentBlocks(text, pasteStoreRef.current);
    const expanded = expansion.text.length > 0 ? expansion.text : text;
    const pastedImages: QueuedPastedImage[] = [];
    const refRe = /\[Image #(\d+)\]/g;
    const seen = new Set<number>();
    let refMatch: RegExpExecArray | null = refRe.exec(text);
    while (refMatch !== null) {
      const id = Number(refMatch[1]);
      if (!seen.has(id)) {
        seen.add(id);
        const stored = pasteStoreRef.current.get(id);
        if (stored && stored.type === "image" && stored.mediaType) {
          pastedImages.push({
            id,
            data: stored.content,
            mediaType: stored.mediaType,
            ...(stored.sourcePath ? { localPath: stored.sourcePath } : {}),
          });
        }
      }
      refMatch = refRe.exec(text);
    }
    const msg: QueuedMessage = {
      id: `q_${Date.now()}_${getQueueMessages().length}`,
      text,
      expanded,
      blocks: expansion.blocks,
      ...(pastedImages.length > 0 ? { pastedImages } : {}),
    };
    queueActions.push(msg);
    session.append("queued_input", { text: expanded });
    void appendRecord(session, {
      type: "injection_queued",
      ts: nowIso(),
      text: expanded,
      source: "user",
    }).catch(() => {});
  };

  const popAllQueued = (): string | null => {
    const current = getQueueMessages();
    if (current.length === 0) return null;
    const joined = current.map((m) => m.recallText ?? m.text).join("\n");
    queueActions.clear();
    return joined;
  };

  const applyPendingChange = (change: PendingChange): void => {
    if (change.kind === "set_model") {
      compactTerminalRef.current = false;
      broker.dispatch({
        kind: "set_provider",
        provider: change.provider,
        model: change.model,
        ...(change.fastMode !== undefined ? { fastMode: change.fastMode } : {}),
      });
      if (change.persistDefault) {
        const provider = change.provider;
        const model = change.model;
        void updateConfig((cfg) => {
          cfg.defaultProvider = provider;
          cfg.defaultModel = model;
        });
      }
    } else if (change.kind === "set_effort") {
      broker.dispatch({ kind: "set_effort", effort: change.effort });
    } else if (change.kind === "set_ultracode") {
      const desired = runtimeConfigRef.current.ultracodeEffort ?? "high";
      const stateNow = broker.read();
      const choices = effortLevelsForModel(stateNow.model, stateNow.provider).filter(
        isUltracodeChoice,
      );
      if (change.enabled && choices.length > 0 && !choices.some((choice) => choice === desired)) {
        overlayStack.open("ultracode-effort");
      } else {
        broker.dispatch({
          kind: "set_ultracode",
          enabled: change.enabled,
          effort: desired,
        });
        void updateConfig((cfg) => {
          cfg.ultracode = change.enabled;
        });
      }
    } else if (change.kind === "set_fast_mode") {
      broker.dispatch({ kind: "set_fast_mode", enabled: change.enabled });
      const provider = broker.read().provider;
      void updateConfig((cfg) => {
        cfg.fastModeByProvider = {
          ...(cfg.fastModeByProvider ?? {}),
          [provider]: change.enabled,
        };
      });
    } else if (change.kind === "set_goal" && change.metaMessage) {
      agent.pushInjection(change.metaMessage);
    }
    // The boot meta snapshot is flushed with the first record; a change applied
    // before that flush must be reflected in it or the stale boot state wins.
    if (session.pendingMeta !== null && change.kind !== "set_goal") {
      session.pendingMeta = sessionMetaFromBrokerState(session, broker.read(), nowIso());
    }
  };

  const enqueuePendingChange = (
    change: PendingChange,
    label: string,
    recallText?: string,
  ): void => {
    const text = `[QUEUED] ${formatQueuedActionLabel(change)}`;
    const msg: QueuedMessage = {
      id: `qc_${Date.now()}_${getQueueMessages().length}`,
      text,
      expanded: "",
      pendingChange: change,
      ...(recallText !== undefined ? { recallText } : {}),
      changeFeedback: label,
    };
    queueActions.push(msg);
  };

  return {
    pushQueued,
    popAllQueued,
    applyPendingChange,
    enqueuePendingChange,
  };
}
