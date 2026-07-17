import { fetchModelsForConfig, testConfig } from "@/engine/providers/openai/models.ts";
import { fastModeForProvider, type UserConfig, updateConfig } from "@/kernel/config/config.ts";
import { loadFor, saveFor } from "@/kernel/storage/credentials.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import {
  contextWindowText,
  normalizeContextWindowInput,
  normalizeOutputTokenLimitInput,
  openAiCustomCredentialsPhase,
  type Phase,
  registerOpenAiCustomModel,
} from "@/ui/panels/login/flow";

export interface OpenAiCustomActions {
  beginOpenAiCustomConfig: () => void;
  discoverOpenAiModels: (current: Extract<Phase, { kind: "custom"; step: "credentials" }>) => void;
  startOpenAiTest: (current: Extract<Phase, { kind: "custom" }>, model: string) => void;
  saveOpenAiCustomConfig: (
    url: string,
    apiKey: string,
    model: string,
    contextWindow: number,
    outputTokenLimit: number | undefined,
    successMessage: string,
  ) => void;
}

export function createOpenAiCustomActions(deps: {
  setPhase: (p: Phase) => void;
  close: () => void;
  broker: Broker | undefined;
  config: UserConfig | undefined;
  onConfigChange: ((config: UserConfig) => void) | undefined;
}): OpenAiCustomActions {
  const { setPhase, close, broker, config, onConfigChange } = deps;

  const beginOpenAiCustomConfig = (): void => {
    setPhase(openAiCustomCredentialsPhase(null));
    void loadFor("openai").then((stored) => {
      setPhase(openAiCustomCredentialsPhase(stored ?? null));
    });
  };

  const discoverOpenAiModels = (
    current: Extract<Phase, { kind: "custom"; step: "credentials" }>,
  ) => {
    const url = current.url.trim();
    const apiKey = current.apiKey.trim();
    if (url.length === 0) {
      setPhase({ ...current, status: "fail", message: "base URL is required" });
      return;
    }
    setPhase({
      ...current,
      status: "discovering",
      message: "fetching models…",
    });
    void fetchModelsForConfig(url, apiKey).then((result) => {
      if (result.ok && result.models.length > 0) {
        setPhase({
          kind: "custom",
          step: "model",
          url,
          apiKey,
          model: result.models[0]?.id ?? "",
          contextWindow: contextWindowText(result.models[0]?.contextWindow, current.contextWindow),
          outputTokenLimit: current.outputTokenLimit,
          models: result.models,
          cursor: 0,
          manual: false,
          failedDiscovery: false,
          message: `Found ${result.models.length} model${result.models.length === 1 ? "" : "s"}.`,
        });
        return;
      }
      setPhase({
        kind: "custom",
        step: "model",
        url,
        apiKey,
        model: "",
        contextWindow: current.contextWindow,
        outputTokenLimit: current.outputTokenLimit,
        models: [],
        cursor: 0,
        manual: true,
        failedDiscovery: true,
        message: `Could not fetch models from ${result.url}: ${result.error ?? "unknown error"}. Type a model id manually.`,
      });
    });
  };

  const startOpenAiTest = (current: Extract<Phase, { kind: "custom" }>, model: string) => {
    const trimmedModel = model.trim();
    const contextWindow =
      "contextWindow" in current ? normalizeContextWindowInput(current.contextWindow) : null;
    const outputTokenLimit =
      "outputTokenLimit" in current
        ? normalizeOutputTokenLimitInput(current.outputTokenLimit)
        : null;
    if (trimmedModel.length === 0) {
      if (current.step === "model") {
        setPhase({ ...current, message: "model id is required" });
      }
      return;
    }
    if (contextWindow === null) {
      if (current.step === "context") {
        setPhase({
          ...current,
          status: "fail",
          message: "context window is required",
        });
      }
      return;
    }
    setPhase({
      kind: "custom",
      step: "testing",
      url: current.url,
      apiKey: current.apiKey,
      model: trimmedModel,
      contextWindow: String(contextWindow),
      outputTokenLimit: outputTokenLimit ? String(outputTokenLimit) : "",
      message: "testing configuration…",
    });
    void testConfig(current.url, current.apiKey, trimmedModel, outputTokenLimit ?? undefined).then(
      (result) => {
        if (result.ok) {
          saveOpenAiCustomConfig(
            current.url,
            current.apiKey,
            trimmedModel,
            contextWindow,
            outputTokenLimit ?? undefined,
            "configured successfully",
          );
          return;
        }
        setPhase({
          kind: "custom",
          step: "test_failed",
          url: current.url,
          apiKey: current.apiKey,
          model: trimmedModel,
          contextWindow: String(contextWindow),
          outputTokenLimit: outputTokenLimit ? String(outputTokenLimit) : "",
          cursor: 0,
          message: `Test request failed: ${result.error ?? "unknown error"}`,
        });
      },
    );
  };

  const saveOpenAiCustomConfig = (
    url: string,
    apiKey: string,
    model: string,
    contextWindow: number,
    outputTokenLimit: number | undefined,
    successMessage: string,
  ) => {
    setPhase({
      kind: "custom",
      step: "saving",
      url,
      apiKey,
      model,
      contextWindow: String(contextWindow),
      outputTokenLimit: outputTokenLimit ? String(outputTokenLimit) : "",
      message: "saving…",
    });
    void saveFor("openai", {
      apiKey,
      baseUrl: url,
      model,
      contextWindow,
      ...(outputTokenLimit ? { outputTokenLimit } : {}),
    })
      .then(() => {
        registerOpenAiCustomModel(model, contextWindow);
        if (config) {
          const next = {
            ...config,
            defaultProvider: "openai" as const,
            defaultModel: model,
          };
          broker?.dispatch({
            kind: "set_provider",
            provider: "openai",
            model,
            fastMode: fastModeForProvider(config, "openai"),
          });
          onConfigChange?.(next);
          void updateConfig((current) => {
            current.defaultProvider = "openai";
            current.defaultModel = model;
          });
        }
        setPhase({
          kind: "custom",
          step: "success",
          url,
          apiKey,
          model,
          contextWindow: String(contextWindow),
          outputTokenLimit: outputTokenLimit ? String(outputTokenLimit) : "",
          message: successMessage,
        });
        setTimeout(() => close(), 700);
      })
      .catch((err) => {
        setPhase({
          kind: "custom",
          step: "test_failed",
          url,
          apiKey,
          model,
          contextWindow: String(contextWindow),
          outputTokenLimit: outputTokenLimit ? String(outputTokenLimit) : "",
          cursor: 1,
          message: err instanceof Error ? err.message : String(err),
        });
      });
  };

  return {
    beginOpenAiCustomConfig,
    discoverOpenAiModels,
    startOpenAiTest,
    saveOpenAiCustomConfig,
  };
}
