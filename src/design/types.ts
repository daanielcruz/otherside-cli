import type { Agent } from "@/engine/queue/index.ts";
import type { Session } from "@/engine/session/index.ts";
import type { ToolHandler } from "@/engine/tools/contract.ts";
import type { Broker } from "@/store/app-store/broker.ts";

export type JsonRpcId = number | string | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export type StreamEvent = "start" | "end";
export type DesignStatus = "idle" | "awaiting" | "streaming" | "completed" | "error";

export interface DesignSnapshotMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  source?: "left" | "device";
  status?: "streaming" | "done" | "error";
  /** Which user-turn produced this message (0-based count of user messages). */
  turnIndex?: number;
  /**
   * Set on an assistant message that is one text segment of a turn — prose the
   * model emitted before a tool call, split out so it keeps its place relative
   * to the cards. Marks the message as CLI-authored (the client never echoes it)
   * so a later turn's rebuild re-attaches it instead of dropping it.
   */
  segment?: number;
}

export interface DesignSnapshotFile {
  path: string;
  content?: string;
  status: "generated" | "modified" | "unchanged";
  language: string;
  kind?: string;
  displayName?: string;
  typeLabel?: string;
  updatedAt?: string;
}

export interface DesignSnapshotArtifact {
  artifactId: string;
  kind: "os-html";
  content: string;
  metadata?: Record<string, unknown>;
}

// A tool-call card, persisted so the timeline survives a web reload. Mirrors the
// `$/tool` notification shape so the web rebuilds cards through its existing path.
// `preview` holds the tool INPUT (needed by update_todos to render its checklist);
// it is omitted for the HTML-authoring tools whose inputs are large and redundant
// with the persisted artifacts. `createdAt` is the tool's start time — the web
// timeline sorts by it so rehydrated tools interleave with messages instead of
// collapsing to the top (messages carry their own `createdAt`, tools did not).
// The structured fields (`toolUseId`, `input`, `output`, `isError`, `turnIndex`)
// exist so prior turns can be replayed to the fork as real tool_use/tool_result
// blocks. They are all optional so snapshots written before they existed still
// load; `input`/`output` are snapshot-only (never sent on the `$/tool` wire) and
// truncated, so a truncated `input` may fail JSON.parse and replay as `{}`.
export interface PersistedToolCard {
  id: string;
  name: string;
  phase: "running" | "done" | "error";
  /**
   * Which agent dispatched this tool: the main design fork or the background
   * verifier fork. Optional so snapshots written before lanes existed still
   * load; absent means "main".
   */
  lane?: "main" | "verifier";
  preview?: unknown;
  createdAt?: string;
  /** The fork's toolCallId — replayed as the tool_use/tool_result block id. */
  toolUseId?: string;
  /** JSON.stringify of the tool input, truncated to 2000 chars. */
  input?: string;
  /** Tool result content, truncated to 2000 chars. */
  output?: string;
  isError?: boolean;
  /** Which user-turn dispatched this tool (0-based count of user messages). */
  turnIndex?: number;
}

export interface DesignSnapshot {
  designId: string;
  title?: string;
  /**
   * True when `title` was auto-generated (LLM title pass) rather than set by a
   * user rename — the web renders auto titles with a distinct treatment.
   */
  titleIsAuto?: boolean;
  messages: DesignSnapshotMessage[];
  files: DesignSnapshotFile[];
  artifacts: DesignSnapshotArtifact[];
  tools?: PersistedToolCard[];
  viewState: {
    activeFileTab: string | null;
    openFiles: string[];
    activeChatId: string | null;
  };
  designSystem: {
    designSystemId: string;
    isDefault: boolean;
  };
  provider?: string;
  model?: string;
  effort?: string | null;
  status: DesignStatus;
  updatedAt: string;
}

export interface RpcEmitter {
  emit(notification: JsonRpcNotification): void;
}

export interface RpcContext {
  broker: Broker;
  session: Session;
  agent: Agent;
  cwd: string;
  codebaseRoot: string | null;
  sessionId: string;
  spawnId: string;
  designId: string;
  activeDesignId: string | null;
  snapshots: Map<string, DesignSnapshot>;
  port: number;
  version: string;
  send: (frame: JsonRpcResponse) => void;
  emit: (notification: JsonRpcNotification) => void;
  authorizedMethods: () => string[];
}

export type RpcMethod = (params: unknown, ctx: RpcContext, id: JsonRpcId) => Promise<void> | void;

export interface DesignCapability {
  name: string;
  rpcMethod?: { method: string; handler: RpcMethod };
  tool?: ToolHandler;
}

export interface DesignSpawn {
  id: string;
  sessionId: string;
  sessionHash: string;
  cwd: string;
  session: Session;
  agent: Agent;
  designId: string;
  snapshots: Map<string, DesignSnapshot>;
  url: string;
  version: string;
  startedAt: number;
  attached: boolean;
  broker: Broker;
  stop: () => Promise<void>;
}

export interface DesignSpawnHandle {
  spawnId: string;
  sessionHash: string;
  designId: string;
  url: string;
  stop: () => Promise<void>;
}

export function slug(path: string): string {
  return path
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function stableArtifactId(designId: string, path: string): string {
  return `${designId}:${slug(path)}`;
}
