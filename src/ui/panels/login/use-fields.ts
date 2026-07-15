import { digitFilter, useTextField } from "@/ui/hooks/use-text-field.ts";
import type { Phase } from "@/ui/panels/login/flow";

type LoginTextField = ReturnType<typeof useTextField>;

export interface LoginFields {
  oauthPasteField: LoginTextField;
  apiKeyField: LoginTextField;
  customUrlField: LoginTextField;
  customApiKeyField: LoginTextField;
  manualModelField: LoginTextField;
  contextWindowField: LoginTextField;
  outputLimitField: LoginTextField;
}

export function useLoginFields(phase: Phase, setPhase: (p: Phase) => void): LoginFields {
  const oauthPasteField = useTextField({
    value: phase.kind === "oauth" ? phase.pasted : "",
    onChange: (pasted) => {
      if (phase.kind === "oauth") setPhase({ ...phase, pasted });
    },
  });
  const apiKeyField = useTextField({
    value: phase.kind === "api_key" ? phase.apiKey : "",
    onChange: (apiKey) => {
      if (phase.kind === "api_key") setPhase({ ...phase, apiKey });
    },
  });
  const customUrlField = useTextField({
    value: phase.kind === "custom" && phase.step === "credentials" ? phase.url : "",
    onChange: (url) => {
      if (phase.kind === "custom" && phase.step === "credentials") {
        setPhase({ ...phase, url, status: "input", message: "" });
      }
    },
  });
  const customApiKeyField = useTextField({
    value: phase.kind === "custom" && phase.step === "credentials" ? phase.apiKey : "",
    onChange: (apiKey) => {
      if (phase.kind === "custom" && phase.step === "credentials") {
        setPhase({ ...phase, apiKey, status: "input", message: "" });
      }
    },
  });
  const manualModelField = useTextField({
    value: phase.kind === "custom" && phase.step === "model" && phase.manual ? phase.model : "",
    onChange: (model) => {
      if (phase.kind === "custom" && phase.step === "model" && phase.manual) {
        setPhase({ ...phase, model, message: "" });
      }
    },
  });
  const contextWindowField = useTextField({
    value: phase.kind === "custom" && phase.step === "context" ? phase.contextWindow : "",
    filter: digitFilter,
    onChange: (contextWindow) => {
      if (phase.kind === "custom" && phase.step === "context") {
        setPhase({ ...phase, contextWindow, status: "input", message: "" });
      }
    },
  });
  const outputLimitField = useTextField({
    value: phase.kind === "custom" && phase.step === "output" ? phase.outputTokenLimit : "",
    filter: digitFilter,
    onChange: (outputTokenLimit) => {
      if (phase.kind === "custom" && phase.step === "output") {
        setPhase({ ...phase, outputTokenLimit, status: "input", message: "" });
      }
    },
  });

  return {
    oauthPasteField,
    apiKeyField,
    customUrlField,
    customApiKeyField,
    manualModelField,
    contextWindowField,
    outputLimitField,
  };
}
