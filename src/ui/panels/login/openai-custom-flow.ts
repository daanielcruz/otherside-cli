import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { OpenAiCustomActions } from "@/ui/panels/login/actions.ts";
import {
  contextMessage,
  contextWindowText,
  normalizeContextWindowInput,
  normalizeOutputTokenLimitInput,
  outputTokenLimitText,
  type Phase,
} from "@/ui/panels/login/flow.ts";

export interface OpenAiCustomFlowDeps {
  actions: OpenAiCustomActions;
  setPhase: (phase: Phase) => void;
  applyText: (
    field: "custom-url" | "custom-api-key" | "manual-model" | "context-window" | "output-limit",
    key: KeyEventData,
  ) => void;
}

export function handleOpenAiCustomKey(
  phase: Extract<Phase, { kind: "custom" }>,
  key: KeyEventData,
  deps: OpenAiCustomFlowDeps,
): void {
  if (phase.step === "credentials") {
    if (phase.status === "discovering") return;
    if (key.name === "tab" || key.name === "down") {
      deps.setPhase({
        ...phase,
        field: ((phase.field + 1) % 2) as 0 | 1,
        status: "input",
      });
      return;
    }
    if (key.name === "up") {
      deps.setPhase({
        ...phase,
        field: ((phase.field + 1) % 2) as 0 | 1,
        status: "input",
      });
      return;
    }
    if (key.name === "return") {
      if (phase.field === 0) {
        deps.setPhase({ ...phase, field: 1, status: "input", message: "" });
      } else {
        deps.actions.discoverOpenAiModels(phase);
      }
      return;
    }
    deps.applyText(phase.field === 0 ? "custom-url" : "custom-api-key", key);
    return;
  }

  if (phase.step === "model") {
    if (phase.manual) {
      if (key.name === "tab" && phase.models.length > 0) {
        deps.setPhase({
          ...phase,
          manual: false,
          cursor: 0,
          model: phase.models[0]?.id ?? "",
          contextWindow: contextWindowText(phase.models[0]?.contextWindow, phase.contextWindow),
        });
        return;
      }
      if (key.name === "return") {
        if (phase.model.trim().length === 0) {
          deps.setPhase({ ...phase, message: "model id is required" });
          return;
        }
        deps.setPhase({
          kind: "custom",
          step: "context",
          url: phase.url,
          apiKey: phase.apiKey,
          model: phase.model.trim(),
          contextWindow: phase.contextWindow,
          outputTokenLimit: phase.outputTokenLimit,
          status: "input",
          message: contextMessage(phase.contextWindow),
        });
        return;
      }
      deps.applyText("manual-model", key);
      return;
    }
    const actionCount = phase.models.length + 1;
    if (key.name === "up") {
      const cursor = (phase.cursor - 1 + actionCount) % actionCount;
      const selected = phase.models[cursor];
      deps.setPhase({
        ...phase,
        cursor,
        model: selected?.id ?? phase.model,
        contextWindow: contextWindowText(selected?.contextWindow, phase.contextWindow),
      });
      return;
    }
    if (key.name === "down" || key.name === "tab") {
      const cursor = (phase.cursor + 1) % actionCount;
      const selected = phase.models[cursor];
      deps.setPhase({
        ...phase,
        cursor,
        model: selected?.id ?? phase.model,
        contextWindow: contextWindowText(selected?.contextWindow, phase.contextWindow),
      });
      return;
    }
    if (key.sequence?.toLowerCase() === "m") {
      deps.setPhase({ ...phase, manual: true, model: "" });
      return;
    }
    if (key.name === "return") {
      if (phase.cursor >= phase.models.length) {
        deps.setPhase({ ...phase, manual: true, model: "" });
        return;
      }
      const selected = phase.models[phase.cursor];
      const model = selected?.id ?? phase.model;
      const contextWindow = contextWindowText(selected?.contextWindow, phase.contextWindow);
      deps.setPhase({
        kind: "custom",
        step: "context",
        url: phase.url,
        apiKey: phase.apiKey,
        model,
        contextWindow,
        outputTokenLimit: phase.outputTokenLimit,
        status: "input",
        message: contextMessage(contextWindow),
      });
    }
    return;
  }

  if (phase.step === "context") {
    if (key.name === "return") {
      deps.setPhase({
        kind: "custom",
        step: "output",
        url: phase.url,
        apiKey: phase.apiKey,
        model: phase.model,
        contextWindow: phase.contextWindow,
        outputTokenLimit: outputTokenLimitText(phase.outputTokenLimit, phase.contextWindow),
        status: "input",
        message: "Type max output tokens. 8192 is a good default for gpt-oss-120b.",
      });
      return;
    }
    deps.applyText("context-window", key);
    return;
  }

  if (phase.step === "output") {
    if (key.name === "return") {
      const limit = normalizeOutputTokenLimitInput(phase.outputTokenLimit);
      if (limit === null) {
        deps.setPhase({
          ...phase,
          status: "fail",
          message: "output token limit is required",
        });
        return;
      }
      deps.actions.startOpenAiTest({ ...phase, outputTokenLimit: String(limit) }, phase.model);
      return;
    }
    deps.applyText("output-limit", key);
    return;
  }

  if (phase.step === "test_failed") {
    if (key.name === "up" || key.name === "down" || key.name === "tab") {
      deps.setPhase({ ...phase, cursor: phase.cursor === 0 ? 1 : 0 });
      return;
    }
    if (key.name === "return") {
      if (phase.cursor === 0) {
        deps.actions.saveOpenAiCustomConfig(
          phase.url,
          phase.apiKey,
          phase.model,
          normalizeContextWindowInput(phase.contextWindow) ?? 200_000,
          normalizeOutputTokenLimitInput(phase.outputTokenLimit) ?? undefined,
          "saved despite failed test",
        );
      } else {
        deps.setPhase({
          kind: "custom",
          step: "credentials",
          field: 0,
          url: phase.url,
          apiKey: phase.apiKey,
          model: phase.model,
          contextWindow: phase.contextWindow,
          outputTokenLimit: phase.outputTokenLimit,
          status: "input",
          message: "",
        });
      }
    }
  }
}
