import type {
  DesignSnapshot,
  JsonRpcNotification,
  JsonRpcResponse,
  RpcContext,
} from "@/design/types.ts";
import type { Agent } from "@/engine/queue/index.ts";
import type { Session } from "@/engine/session/index.ts";
import type { Broker } from "@/store/app-store/broker.ts";

export interface BuildRpcContextArgs {
  broker: Broker;
  session: Session;
  agent: Agent;
  cwd: string;
  codebaseRoot: string | null;
  sessionId: string;
  spawnId: string;
  designId: string;
  snapshots: Map<string, DesignSnapshot>;
  port: number;
  version: string;
  authorizedMethods: () => string[];
  send: (frame: JsonRpcResponse) => void;
  emit: (frame: JsonRpcNotification) => void;
}

export function buildRpcContext(args: BuildRpcContextArgs): RpcContext {
  return {
    broker: args.broker,
    session: args.session,
    agent: args.agent,
    cwd: args.cwd,
    codebaseRoot: args.codebaseRoot,
    sessionId: args.sessionId,
    spawnId: args.spawnId,
    designId: args.designId,
    activeDesignId: args.designId,
    snapshots: args.snapshots,
    port: args.port,
    version: args.version,
    send: args.send,
    emit: args.emit,
    authorizedMethods: args.authorizedMethods,
  };
}
