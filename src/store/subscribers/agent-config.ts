import type { Agent } from "@/engine/queue/index.ts";
import { descriptorFor } from "@/kernel/config/registry.ts";
import { resolveConfig } from "@/kernel/config/resolver.ts";
import { onSettingsChanged } from "@/kernel/config/settings-watch.ts";

interface ConfigurableAgent {
  readonly deps: Pick<Agent["deps"], "config"> & {
    session: Pick<Agent["deps"]["session"], "cwd">;
  };
  updateConfig: Agent["updateConfig"];
}

export function startAgentConfigSubscriber(agent: ConfigurableAgent): () => void {
  return onSettingsChanged((change) => {
    // An accepted change in another scope must not import a refused language edit.
    if (!descriptorFor("language")?.scopes.includes(change.scope)) return;
    const { language } = resolveConfig(agent.deps.session.cwd);
    const current = agent.deps.config;
    if (language === current.language) return;

    const next = { ...current };
    if (language === undefined) delete next.language;
    else next.language = language;
    agent.updateConfig(next);
  });
}
