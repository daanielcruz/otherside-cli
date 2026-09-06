import { startDesign, stopDesign } from "@/design/launcher.ts";
import type { Agent } from "@/engine/queue/index.ts";
import type { Session } from "@/engine/session/index.ts";
import type { Broker } from "@/store/app-store/broker.ts";

export interface DesignControllerDeps {
  broker: Broker;
  session: Session;
  agent: Agent;
  version: string;
  onFinalize: (handler: () => void | Promise<void>) => void;
}

export interface DesignController {
  start: (brief: string) => Promise<void>;
  stop: () => Promise<void>;
}

export function createDesignController(deps: DesignControllerDeps): DesignController {
  return {
    async start(brief: string): Promise<void> {
      const handle = await startDesign({
        broker: deps.broker,
        session: deps.session,
        agent: deps.agent,
        cwd: deps.session.cwd,
        version: deps.version,
        initialPrompt: brief || undefined,
      });
      deps.onFinalize(() => handle.stop());
    },
    async stop(): Promise<void> {
      await stopDesign(deps.session.id);
    },
  };
}
