import { readFileSync } from "node:fs";

const CONFIG_ENV = "OTHERSIDE_DEVTOOLS_CONFIG";
const SECRET_NAME = /(API_?KEY|AUTH|CREDENTIAL|PASSWORD|SECRET|TOKEN)/i;
const ENV_NAME = /^(OTHERSIDE_|BASH_|TASK_|MAX_|ENABLE_|DISABLE_)[A-Z0-9_]+$/;

export type ProviderDevtoolId =
  | "anthropic"
  | "antigravity"
  | "codex"
  | "deepseek"
  | "glm"
  | "kimi"
  | "minimax"
  | "openai-custom"
  | "xai";

export type ProviderEndpointName =
  | "authorize"
  | "balance"
  | "base"
  | "countTokens"
  | "images"
  | "messages"
  | "models"
  | "profile"
  | "responses"
  | "responsesWs"
  | "search"
  | "token"
  | "usage"
  | "userinfo";

interface DevtoolsConfig {
  version: 1;
  environment: Record<string, string>;
  providers: Partial<Record<ProviderDevtoolId, Partial<Record<ProviderEndpointName, string>>>>;
}

let loadedPath: string | undefined;
let loadedConfig: DevtoolsConfig | undefined;

export function initializeDevtools(): void {
  const config = currentConfig();
  for (const [name, value] of Object.entries(config.environment)) {
    process.env[name] = value;
  }
}

export function providerEndpoint(
  provider: ProviderDevtoolId,
  endpoint: ProviderEndpointName,
  fallback: string,
): string {
  return currentConfig().providers[provider]?.[endpoint] ?? fallback;
}

export function devtoolsConfigPath(): string | undefined {
  return process.env[CONFIG_ENV]?.trim() || undefined;
}

export function resetDevtoolsForTest(): void {
  loadedPath = undefined;
  loadedConfig = undefined;
}

function currentConfig(): DevtoolsConfig {
  const path = devtoolsConfigPath();
  if (!path) return emptyConfig();
  if (loadedConfig && loadedPath === path) return loadedConfig;
  const parsed = parseConfig(readFileSync(path, "utf8"));
  loadedPath = path;
  loadedConfig = parsed;
  return parsed;
}

function parseConfig(raw: string): DevtoolsConfig {
  const value: unknown = JSON.parse(raw);
  if (!isObject(value) || value.version !== 1) {
    throw new Error("devtools config must be an object with version 1");
  }
  const environment = parseEnvironment(value.environment);
  const providers = parseProviders(value.providers);
  return { version: 1, environment, providers };
}

function parseEnvironment(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isObject(value)) throw new Error("devtools environment must be an object");
  const environment: Record<string, string> = {};
  for (const [name, setting] of Object.entries(value)) {
    if (!ENV_NAME.test(name) || name === CONFIG_ENV || SECRET_NAME.test(name)) {
      throw new Error(`devtools environment override is not allowed: ${name}`);
    }
    if (typeof setting !== "string") {
      throw new Error(`devtools environment override must be a string: ${name}`);
    }
    environment[name] = setting;
  }
  return environment;
}

function parseProviders(value: unknown): DevtoolsConfig["providers"] {
  if (value === undefined) return {};
  if (!isObject(value)) throw new Error("devtools providers must be an object");
  const providers: DevtoolsConfig["providers"] = {};
  for (const [provider, rawEndpoints] of Object.entries(value)) {
    if (!isProvider(provider)) throw new Error(`unknown devtools provider: ${provider}`);
    if (!isObject(rawEndpoints)) {
      throw new Error(`devtools provider overrides must be an object: ${provider}`);
    }
    const endpoints: Partial<Record<ProviderEndpointName, string>> = {};
    for (const [endpoint, rawUrl] of Object.entries(rawEndpoints)) {
      if (!isEndpoint(endpoint)) {
        throw new Error(`unknown devtools endpoint: ${provider}.${endpoint}`);
      }
      if (typeof rawUrl !== "string") {
        throw new Error(`devtools endpoint must be a string: ${provider}.${endpoint}`);
      }
      const url = new URL(rawUrl);
      if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
        throw new Error(`unsupported devtools endpoint protocol: ${provider}.${endpoint}`);
      }
      endpoints[endpoint] = url.toString();
    }
    providers[provider] = endpoints;
  }
  return providers;
}

function emptyConfig(): DevtoolsConfig {
  return { version: 1, environment: {}, providers: {} };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProvider(value: string): value is ProviderDevtoolId {
  return [
    "anthropic",
    "antigravity",
    "codex",
    "deepseek",
    "glm",
    "kimi",
    "minimax",
    "openai-custom",
    "xai",
  ].includes(value);
}

function isEndpoint(value: string): value is ProviderEndpointName {
  return [
    "authorize",
    "balance",
    "base",
    "countTokens",
    "images",
    "messages",
    "models",
    "profile",
    "responses",
    "responsesWs",
    "search",
    "token",
    "usage",
    "userinfo",
  ].includes(value);
}
