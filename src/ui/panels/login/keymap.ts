import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { ValidationIntent } from "@/engine/contract/login.ts";
import { getProviderConfig } from "@/engine/contract/registry.ts";
import type { Key } from "@/ink";
import { fastModeForProvider, type UserConfig, updateConfig } from "@/kernel/config/config.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import type { OpenAiCustomActions } from "./actions";
import {
  apiKeyProviderFor,
  contextMessage,
  contextWindowText,
  type FlowHandle,
  normalizeContextWindowInput,
  normalizeOutputTokenLimitInput,
  outputTokenLimitText,
  type Phase,
  type ProviderRow,
  persistApiKeyCredential,
  startOAuthPkce,
  startOAuthRedirect,
} from "./flow";
import type { LoginFields } from "./use-fields";

export interface KeymapContext {
  phase: Phase;
  setPhase: (p: Phase) => void;
  cursor: number;
  setCursor: Dispatch<SetStateAction<number>>;
  rows: ProviderRow[];
  close: () => void;
  tryClose: () => void;
  initialProvider: ProviderId | undefined;
  flowRef: MutableRefObject<FlowHandle | null>;
  validationResolveRef: MutableRefObject<((i: ValidationIntent) => void) | null>;
  fields: LoginFields;
  actions: OpenAiCustomActions;
  broker: Broker | undefined;
  config: UserConfig | undefined;
  onConfigChange: ((c: UserConfig) => void) | undefined;
}

export function handleLoginCancel(ctx: KeymapContext): void {
  if (ctx.phase.kind === "list") {
    ctx.tryClose();
    return;
  }
  if (ctx.phase.kind === "verify") {
    ctx.validationResolveRef.current?.("cancel");
    return;
  }
  if (ctx.phase.kind === "oauth") {
    ctx.flowRef.current = null;
    if (ctx.phase.status === "ok") {
      ctx.close();
    } else if (ctx.phase.status === "running") {
      ctx.setPhase({ kind: "list" });
    } else {
      ctx.tryClose();
    }
    return;
  }
  if (ctx.phase.kind === "api_key") {
    ctx.setPhase({ kind: "list" });
    return;
  }
  if (ctx.phase.kind === "custom") {
    if (ctx.initialProvider === "openai") ctx.tryClose();
    else ctx.setPhase({ kind: "list" });
  }
}

export function activateProvider(ctx: KeymapContext): void {
  const row = ctx.rows[ctx.cursor];
  if (!row) return;
  const flow = getProviderConfig(row.id)?.beginLogin;
  if (!flow) return;
  if (flow.kind === "api_key") {
    const provider = apiKeyProviderFor(row.id);
    if (!provider) return;
    ctx.setPhase({
      kind: "api_key",
      provider,
      apiKey: "",
      status: "input",
      message: "",
    });
    return;
  }
  if (flow.kind === "openai_custom") {
    ctx.actions.beginOpenAiCustomConfig();
    return;
  }
  if (flow.kind === "oauth_pkce") {
    startOAuthPkce({
      provider: row,
      begin: flow.begin,
      finalizeLogin: flow.finalizeLogin,
      setPhase: ctx.setPhase,
      flowRef: ctx.flowRef,
      validationResolveRef: ctx.validationResolveRef,
      broker: ctx.broker,
      config: ctx.config,
      onConfigChange: ctx.onConfigChange,
    });
    return;
  }
  startOAuthRedirect(row, flow.login, ctx.setPhase, ctx.broker, ctx.config, ctx.onConfigChange);
}

export function handlePanelKey(ctx: KeymapContext, input: string, key: Key): boolean {
  if (ctx.phase.kind === "list") {
    if (key.leftArrow) {
      ctx.tryClose();
      return true;
    }
    if (key.upArrow) {
      ctx.setCursor((c) => (c - 1 + ctx.rows.length) % ctx.rows.length);
      return true;
    }
    if (key.downArrow) {
      ctx.setCursor((c) => (c + 1) % ctx.rows.length);
      return true;
    }
    if (key.return) {
      const row = ctx.rows[ctx.cursor];
      if (!row) return true;
      const flow = getProviderConfig(row.id)?.beginLogin;
      if (!flow) return true;
      if (flow.kind === "api_key") {
        const provider = apiKeyProviderFor(row.id);
        if (!provider) return true;
        ctx.setPhase({
          kind: "api_key",
          provider,
          apiKey: "",
          status: "input",
          message: "",
        });
        return true;
      }
      if (flow.kind === "openai_custom") {
        ctx.actions.beginOpenAiCustomConfig();
        return true;
      }
      if (flow.kind === "oauth_pkce") {
        startOAuthPkce({
          provider: row,
          begin: flow.begin,
          finalizeLogin: flow.finalizeLogin,
          setPhase: ctx.setPhase,
          flowRef: ctx.flowRef,
          validationResolveRef: ctx.validationResolveRef,
          broker: ctx.broker,
          config: ctx.config,
          onConfigChange: ctx.onConfigChange,
        });
        return true;
      }
      startOAuthRedirect(row, flow.login, ctx.setPhase, ctx.broker, ctx.config, ctx.onConfigChange);
    }
    return true;
  }

  if (ctx.phase.kind === "verify") {
    if (key.return) {
      ctx.setPhase({ ...ctx.phase, status: "checking", message: "checking…" });
      ctx.validationResolveRef.current?.("verify");
      return true;
    }
    if (input === "a" || input === "A") {
      ctx.validationResolveRef.current?.("change_auth");
      return true;
    }
    if (key.leftArrow) {
      ctx.validationResolveRef.current?.("cancel");
      return true;
    }
    return true;
  }

  if (ctx.phase.kind === "oauth") {
    if (ctx.phase.status === "ok") {
      if (key.return || key.leftArrow) {
        ctx.flowRef.current = null;
        ctx.close();
      }
      return true;
    }
    if (key.leftArrow) {
      ctx.flowRef.current = null;
      if (ctx.phase.status === "running") ctx.setPhase({ kind: "list" });
      else ctx.tryClose();
      return true;
    }
    if (ctx.phase.status !== "running") return true;
    if (key.return) {
      const trimmed = ctx.phase.pasted.trim();
      if (trimmed.length === 0) return true;
      if (!ctx.phase.supportsPaste) return true;
      ctx.setPhase({
        ...ctx.phase,
        pasted: "",
        message: `verifying code for ${ctx.phase.provider.label}…`,
        supportsPaste: false,
      });
      ctx.flowRef.current?.submitCode?.(trimmed);
      return true;
    }
    if (!ctx.phase.supportsPaste) return true;
    return ctx.fields.oauthPasteField.handleKey(input, key);
  }

  if (ctx.phase.kind === "api_key") {
    if (key.leftArrow) {
      ctx.setPhase({ kind: "list" });
      return true;
    }
    if (key.return) {
      if (ctx.phase.apiKey.trim().length === 0) return true;
      const apiKey = ctx.phase.apiKey.trim();
      const provider = ctx.phase.provider;
      ctx.setPhase({ ...ctx.phase, status: "saving", message: "" });

      const persist = persistApiKeyCredential(provider, apiKey);

      void persist
        .then(async () => {
          const rawDefault = getProviderConfig(provider)?.defaultModelId;
          const model = typeof rawDefault === "function" ? rawDefault() : (rawDefault ?? "");
          ctx.broker?.dispatch({
            kind: "set_provider",
            provider,
            model,
            ...(ctx.config ? { fastMode: fastModeForProvider(ctx.config, provider) } : {}),
          });
          if (ctx.config) {
            const next = {
              ...ctx.config,
              defaultProvider: provider,
              defaultModel: model,
            };
            await updateConfig((current) => {
              current.defaultProvider = provider;
              current.defaultModel = model;
            });
            ctx.onConfigChange?.(next);
          }
          ctx.close();
        })
        .catch((err) => {
          ctx.setPhase({
            kind: "api_key",
            provider,
            apiKey,
            status: "fail",
            message: err instanceof Error ? err.message : String(err),
          });
        });
      return true;
    }
    if (ctx.phase.status !== "input") return true;
    return ctx.fields.apiKeyField.handleKey(input, key);
  }

  if (ctx.phase.kind === "custom") {
    if (key.leftArrow) {
      if (ctx.initialProvider === "openai") ctx.tryClose();
      else ctx.setPhase({ kind: "list" });
      return true;
    }

    if (ctx.phase.step === "credentials") {
      if (ctx.phase.status === "discovering") return true;
      if (key.tab || key.downArrow) {
        ctx.setPhase({
          ...ctx.phase,
          field: ((ctx.phase.field + 1) % 2) as 0 | 1,
          status: "input",
        });
        return true;
      }
      if (key.upArrow) {
        ctx.setPhase({
          ...ctx.phase,
          field: ((ctx.phase.field + 1) % 2) as 0 | 1,
          status: "input",
        });
        return true;
      }
      if (key.return) {
        if (ctx.phase.field === 0)
          ctx.setPhase({ ...ctx.phase, field: 1, status: "input", message: "" });
        else ctx.actions.discoverOpenAiModels(ctx.phase);
        return true;
      }
      return ctx.phase.field === 0
        ? ctx.fields.customUrlField.handleKey(input, key)
        : ctx.fields.customApiKeyField.handleKey(input, key);
    }

    if (ctx.phase.step === "model") {
      if (ctx.phase.manual) {
        if (key.tab && ctx.phase.models.length > 0) {
          ctx.setPhase({
            ...ctx.phase,
            manual: false,
            cursor: 0,
            model: ctx.phase.models[0]?.id ?? "",
            contextWindow: contextWindowText(
              ctx.phase.models[0]?.contextWindow,
              ctx.phase.contextWindow,
            ),
            outputTokenLimit: ctx.phase.outputTokenLimit,
          });
          return true;
        }
        if (key.return) {
          if (ctx.phase.model.trim().length === 0) {
            ctx.setPhase({ ...ctx.phase, message: "model id is required" });
            return true;
          }
          ctx.setPhase({
            kind: "custom",
            step: "context",
            url: ctx.phase.url,
            apiKey: ctx.phase.apiKey,
            model: ctx.phase.model.trim(),
            contextWindow: ctx.phase.contextWindow,
            outputTokenLimit: ctx.phase.outputTokenLimit,
            status: "input",
            message: contextMessage(ctx.phase.contextWindow),
          });
          return true;
        }
        return ctx.fields.manualModelField.handleKey(input, key);
      }
      const actionCount = ctx.phase.models.length + 1;
      if (key.upArrow) {
        const cursor = (ctx.phase.cursor - 1 + actionCount) % actionCount;
        const selected = ctx.phase.models[cursor];
        ctx.setPhase({
          ...ctx.phase,
          cursor,
          model: selected?.id ?? ctx.phase.model,
          contextWindow: contextWindowText(selected?.contextWindow, ctx.phase.contextWindow),
          outputTokenLimit: ctx.phase.outputTokenLimit,
        });
        return true;
      }
      if (key.downArrow || key.tab) {
        const cursor = (ctx.phase.cursor + 1) % actionCount;
        const selected = ctx.phase.models[cursor];
        ctx.setPhase({
          ...ctx.phase,
          cursor,
          model: selected?.id ?? ctx.phase.model,
          contextWindow: contextWindowText(selected?.contextWindow, ctx.phase.contextWindow),
          outputTokenLimit: ctx.phase.outputTokenLimit,
        });
        return true;
      }
      if (input.toLowerCase() === "m") {
        ctx.setPhase({ ...ctx.phase, manual: true, model: "" });
        return true;
      }
      if (key.return) {
        if (ctx.phase.cursor >= ctx.phase.models.length) {
          ctx.setPhase({ ...ctx.phase, manual: true, model: "" });
          return true;
        }
        const selected = ctx.phase.models[ctx.phase.cursor];
        const model = selected?.id ?? ctx.phase.model;
        ctx.setPhase({
          kind: "custom",
          step: "context",
          url: ctx.phase.url,
          apiKey: ctx.phase.apiKey,
          model,
          contextWindow: contextWindowText(selected?.contextWindow, ctx.phase.contextWindow),
          outputTokenLimit: ctx.phase.outputTokenLimit,
          status: "input",
          message: contextMessage(
            contextWindowText(selected?.contextWindow, ctx.phase.contextWindow),
          ),
        });
      }
      return true;
    }

    if (ctx.phase.step === "context") {
      if (key.return) {
        ctx.setPhase({
          kind: "custom",
          step: "output",
          url: ctx.phase.url,
          apiKey: ctx.phase.apiKey,
          model: ctx.phase.model,
          contextWindow: ctx.phase.contextWindow,
          outputTokenLimit: outputTokenLimitText(
            ctx.phase.outputTokenLimit,
            ctx.phase.contextWindow,
          ),
          status: "input",
          message: "Type max output tokens. 8192 is a good default for gpt-oss-120b.",
        });
        return true;
      }
      return ctx.fields.contextWindowField.handleKey(input, key);
    }

    if (ctx.phase.step === "output") {
      if (key.return) {
        const limit = normalizeOutputTokenLimitInput(ctx.phase.outputTokenLimit);
        if (limit === null) {
          ctx.setPhase({
            ...ctx.phase,
            status: "fail",
            message: "output token limit is required",
          });
          return true;
        }
        ctx.actions.startOpenAiTest(
          { ...ctx.phase, outputTokenLimit: String(limit) },
          ctx.phase.model,
        );
        return true;
      }
      return ctx.fields.outputLimitField.handleKey(input, key);
    }

    if (ctx.phase.step === "test_failed") {
      if (key.upArrow || key.downArrow || key.tab) {
        ctx.setPhase({ ...ctx.phase, cursor: ctx.phase.cursor === 0 ? 1 : 0 });
        return true;
      }
      if (key.return) {
        if (ctx.phase.cursor === 0) {
          ctx.actions.saveOpenAiCustomConfig(
            ctx.phase.url,
            ctx.phase.apiKey,
            ctx.phase.model,
            normalizeContextWindowInput(ctx.phase.contextWindow) ?? 200_000,
            normalizeOutputTokenLimitInput(ctx.phase.outputTokenLimit) ?? undefined,
            "saved despite failed test",
          );
        } else {
          ctx.setPhase({
            kind: "custom",
            step: "credentials",
            field: 0,
            url: ctx.phase.url,
            apiKey: ctx.phase.apiKey,
            model: ctx.phase.model,
            contextWindow: ctx.phase.contextWindow,
            outputTokenLimit: ctx.phase.outputTokenLimit,
            status: "input",
            message: "",
          });
        }
        return true;
      }
    }
  }
  return false;
}
