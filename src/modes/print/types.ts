import type { ModelPricing } from "@/engine/contract/pricing.ts";
import type { PermissionMode } from "@/kernel/std/types/request.ts";

export interface PrintRuntime {
  sessionId: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  verbose: boolean;
  contextWindow: number;
  pricing: ModelPricing | null;
  maxTurns: number | null;
  toolNames: string[];
  slashCommands: string[];
  agentNames: string[];
  skillNames: string[];
  mcpServers: string[];
  version: string;
}

export type PrintOutputFormat = "text" | "json" | "stream-json";

export type McpStatus = { name: string; status: "connected" | "failed" | "needs-auth" | "pending" };

export type InstalledSessionResources = {
  toolNames: string[];
  mcpStatuses: McpStatus[];
  agentNames: string[];
  close(): Promise<void>;
};

export type StructuredOutputState = {
  schema: Record<string, unknown>;
  validate: (input: unknown) => { kind: "valid" } | { kind: "mismatch"; error: string };
  consumed: boolean;
  value: unknown;
  retries: number;
  lastError: string | null;
  lastInput: unknown;
};
