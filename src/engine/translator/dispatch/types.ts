export type Api = "anthropic-messages" | "openai-completions" | "codex-responses";

export interface ApiCompatBase {
  readonly api: Api;
}

export type ThinkingFormat =
  | "anthropic-base64"
  | "deepseek-string"
  | "kimi-signature"
  | "openai-reasoning"
  | "google-thought-signature";

export type WebSearchKind = "anthropic-server" | "openai-tool" | "none";

export interface AnthropicMessagesCompat extends ApiCompatBase {
  api: "anthropic-messages";
  thinkingFormat: ThinkingFormat;
  supportsContextManagement: boolean;
  supportsInterleavedThinking: boolean;
  betaHeaders: readonly string[];
  oauthBearer: boolean;
  webSearchKind: WebSearchKind;
  requiresToolResultName: boolean;
}

export interface OpenAICompletionsCompat extends ApiCompatBase {
  api: "openai-completions";
  endpointKind: "chat_completions" | "simple_chat";
  supportsStore: boolean;
}

export interface CodexResponsesCompat extends ApiCompatBase {
  api: "codex-responses";
  transport: "http" | "ws";
  supportsStore: boolean;
  supportsReasoningSummary: boolean;
}

export type ApiCompat = AnthropicMessagesCompat | OpenAICompletionsCompat | CodexResponsesCompat;

export type ApiCompatFor<A extends Api> = Extract<ApiCompat, { api: A }>;
