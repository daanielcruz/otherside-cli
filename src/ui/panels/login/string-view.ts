import type { ValidationIntent } from "@/engine/contract/login.ts";
import { loadConfigSync, type UserConfig } from "@/kernel/config/config.ts";
import { isProviderId, type ProviderId } from "@/kernel/std/types/provider-ids.ts";
import { type CredentialsBundle, loadAll } from "@/kernel/storage/credentials.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import type { Key } from "@/terminal-runtime";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { typedText } from "@/ui/chrome/key-input.ts";
import { panelKey } from "@/ui/chrome/panel-keys.ts";
import { FALLBACK_TERMINAL_ROWS } from "@/ui/chrome/string-view-panel.ts";
import { applyTextFieldKey, digitFilter } from "@/ui/hooks/text-field.ts";
import { writeTextToClipboard } from "@/ui/input/paste/clipboard.ts";
import { createOpenAiCustomActions, type OpenAiCustomActions } from "@/ui/panels/login/actions.ts";
import {
  handleLoginApiKeyKey,
  handleLoginOAuthKey,
  handleLoginVerificationKey,
  startLoginFlow,
} from "@/ui/panels/login/authentication.ts";
import {
  buildProviderRows,
  type FlowHandle,
  openAiCustomCredentialsPhase,
  type Phase,
  type ProviderRow,
} from "@/ui/panels/login/flow.ts";
import { renderLoginFlow } from "@/ui/panels/login/flow-view.ts";
import { renderLoginList } from "@/ui/panels/login/list.ts";
import { handleOpenAiCustomKey } from "@/ui/panels/login/openai-custom-flow.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";

/**
 * Opener payload for the login overlay. Slash-open may pass nothing; model/switch
 * flows may seed `initialProvider`. `broker` + config hooks are the route-switch
 * refs the app root supplies so provider activation updates session state.
 */
export interface LoginPanelProps {
  initialProvider?: ProviderId;
  broker?: Broker;
  config?: UserConfig;
  onConfigChange?: (config: UserConfig) => void;
}

/**
 * Sign-in overlay on the string model. Provider list → OAuth / device-code / API key /
 * OpenAI-custom flows, driven by the same modules the React panel used (`flow`,
 * `actions`, credentials). Escape backs out or closes when at least one credential
 * exists; never prints secrets (API keys masked).
 */
class LoginPanel implements StringViewPanel {
  private ctx: StringViewContext | undefined;
  private phase: Phase;
  private cursor = 0;
  private bundle: CredentialsBundle | null = null;
  private readonly flowRef: { current: FlowHandle | null } = { current: null };
  private readonly validationResolveRef: {
    current: ((intent: ValidationIntent) => void) | null;
  } = { current: null };
  private readonly initialProvider: ProviderId | undefined;
  private readonly broker: Broker | undefined;
  private config: UserConfig | undefined;
  private readonly onConfigChange: ((config: UserConfig) => void) | undefined;
  private readonly actions: OpenAiCustomActions;
  private cancelled = false;
  private autoStarted = false;

  constructor(
    private readonly close: () => void,
    props?: LoginPanelProps,
  ) {
    const p = narrowProps(props);
    this.initialProvider = p.initialProvider;
    this.broker = p.broker;
    this.config = p.config ?? loadConfigSync();
    this.onConfigChange = p.onConfigChange;
    this.phase =
      this.initialProvider === "openai" ? openAiCustomCredentialsPhase(null) : { kind: "list" };
    this.actions = createOpenAiCustomActions({
      setPhase: (next) => this.setPhase(next),
      close: () => this.close(),
      broker: this.broker,
      config: this.config,
      onConfigChange: (next) => {
        this.config = next;
        this.onConfigChange?.(next);
      },
    });
  }

  mount(ctx: StringViewContext): void {
    this.ctx = ctx;
    this.cancelled = false;
    void this.reloadBundle();
    this.maybeAutoStart();
    ctx.requestRender();
  }

  unmount(): void {
    this.cancelled = true;
    this.flowRef.current = null;
    this.validationResolveRef.current?.("cancel");
    this.validationResolveRef.current = null;
    this.ctx = undefined;
  }

  render(width: number): string[] {
    if (this.phase.kind === "list") return this.renderList(width);
    return renderLoginFlow(this.phase, width);
  }

  handleKey(key: KeyEventData): void {
    if (key.name === "escape") {
      this.handleCancel();
      return;
    }
    if (this.phase.kind === "list") {
      this.handleListKey(key);
      return;
    }
    if (this.phase.kind === "verify") {
      handleLoginVerificationKey(this.phase, key, this.authenticationDeps());
      return;
    }
    if (this.phase.kind === "oauth") {
      if (isCopyKey(key) && this.phase.url.length > 0) {
        this.copyOAuthUrl(this.phase.url);
        return;
      }
      handleLoginOAuthKey(this.phase, key, this.authenticationDeps());
      return;
    }
    if (this.phase.kind === "api_key") {
      handleLoginApiKeyKey(this.phase, key, this.authenticationDeps());
      return;
    }
    if (key.name === "left") {
      if (this.initialProvider === "openai") this.tryClose();
      else this.setPhase({ kind: "list" });
      return;
    }
    handleOpenAiCustomKey(this.phase, key, {
      actions: this.actions,
      setPhase: (next) => this.setPhase(next),
      applyText: (field, textKey) => this.applyText(field, textKey),
    });
  }

  private setPhase(next: Phase): void {
    if (this.cancelled) return;
    const prevKind = this.phase.kind;
    this.phase = next;
    if (next.kind === "list" && prevKind !== "list") {
      void this.reloadBundle();
    }
    this.ctx?.requestRender();
  }

  private copyOAuthUrl(url: string): void {
    void writeTextToClipboard(url).then((copied) => {
      if (!copied || this.cancelled || this.phase.kind !== "oauth" || this.phase.url !== url)
        return;
      this.setPhase({ ...this.phase, urlCopied: true });
      setTimeout(() => this.clearCopiedOAuthUrl(url), 2_000);
    });
  }

  private clearCopiedOAuthUrl(url: string): void {
    if (this.cancelled || this.phase.kind !== "oauth" || this.phase.url !== url) return;
    this.setPhase({ ...this.phase, urlCopied: false });
  }

  private async reloadBundle(): Promise<void> {
    try {
      const bundle = await loadAll();
      if (this.cancelled) return;
      this.bundle = bundle;
      this.ctx?.requestRender();
    } catch {
      // keep prior bundle; list still usable without signed-in markers
    }
  }

  private maybeAutoStart(): void {
    if (!this.initialProvider || this.autoStarted) return;
    this.autoStarted = true;
    if (this.initialProvider === "openai") {
      this.actions.beginOpenAiCustomConfig();
      return;
    }
    const row = buildProviderRows(null).find((r) => r.id === this.initialProvider);
    if (!row) return;
    startLoginFlow(row, this.authenticationDeps());
  }

  private rows(): ProviderRow[] {
    return buildProviderRows(this.bundle);
  }

  private hasAnyCredential(): boolean {
    if (this.bundle === null) return false;
    return Object.values(this.bundle as Record<string, unknown>).some(
      (value) => value !== undefined,
    );
  }

  private tryClose(): void {
    if (this.hasAnyCredential()) this.close();
  }

  private handleCancel(): void {
    if (this.phase.kind === "list") {
      this.tryClose();
      return;
    }
    if (this.phase.kind === "verify") {
      this.validationResolveRef.current?.("cancel");
      return;
    }
    if (this.phase.kind === "oauth") {
      this.flowRef.current = null;
      if (this.phase.status === "ok") this.close();
      else if (this.phase.status === "running") this.setPhase({ kind: "list" });
      else this.tryClose();
      return;
    }
    if (this.phase.kind === "api_key") {
      this.setPhase({ kind: "list" });
      return;
    }
    if (this.initialProvider === "openai") this.tryClose();
    else this.setPhase({ kind: "list" });
  }

  private authenticationDeps() {
    return {
      actions: this.actions,
      broker: this.broker,
      getConfig: () => this.config,
      setConfig: (next: UserConfig) => {
        this.config = next;
        this.onConfigChange?.(next);
      },
      isCancelled: () => this.cancelled,
      setPhase: (next: Phase) => this.setPhase(next),
      close: () => this.close(),
      tryClose: () => this.tryClose(),
      flowRef: this.flowRef,
      validationResolveRef: this.validationResolveRef,
      applyText: (field: "oauth-paste" | "api-key", textKey: KeyEventData) =>
        this.applyText(field, textKey),
    };
  }

  private handleListKey(key: KeyEventData): void {
    const rows = this.rows();
    if (key.name === "left") {
      this.tryClose();
      return;
    }
    if (key.name === "up") {
      if (rows.length === 0) return;
      this.cursor = (this.cursor - 1 + rows.length) % rows.length;
      this.ctx?.requestRender();
      return;
    }
    if (key.name === "down") {
      if (rows.length === 0) return;
      this.cursor = (this.cursor + 1) % rows.length;
      this.ctx?.requestRender();
      return;
    }
    if (panelKey(key) === "confirm") {
      const row = rows[this.cursor];
      if (row) startLoginFlow(row, this.authenticationDeps());
    }
  }

  private applyText(
    field:
      | "oauth-paste"
      | "api-key"
      | "custom-url"
      | "custom-api-key"
      | "manual-model"
      | "context-window"
      | "output-limit",
    key: KeyEventData,
  ): void {
    const filter = field === "context-window" || field === "output-limit" ? digitFilter : undefined;
    const current = this.readField(field);
    const { consumed, next } = applyTextFieldKey(current, typedText(key), toTextKey(key), {
      filter,
    });
    if (!consumed || next === current) return;
    this.writeField(field, next);
  }

  private readField(
    field:
      | "oauth-paste"
      | "api-key"
      | "custom-url"
      | "custom-api-key"
      | "manual-model"
      | "context-window"
      | "output-limit",
  ): string {
    const phase = this.phase;
    if (field === "oauth-paste" && phase.kind === "oauth") return phase.pasted;
    if (field === "api-key" && phase.kind === "api_key") return phase.apiKey;
    if (phase.kind !== "custom") return "";
    if (field === "custom-url" && phase.step === "credentials") return phase.url;
    if (field === "custom-api-key" && phase.step === "credentials") return phase.apiKey;
    if (field === "manual-model" && phase.step === "model" && phase.manual) return phase.model;
    if (field === "context-window" && phase.step === "context") return phase.contextWindow;
    if (field === "output-limit" && phase.step === "output") return phase.outputTokenLimit;
    return "";
  }

  private writeField(
    field:
      | "oauth-paste"
      | "api-key"
      | "custom-url"
      | "custom-api-key"
      | "manual-model"
      | "context-window"
      | "output-limit",
    value: string,
  ): void {
    const phase = this.phase;
    if (field === "oauth-paste" && phase.kind === "oauth") {
      this.setPhase({ ...phase, pasted: value });
      return;
    }
    if (field === "api-key" && phase.kind === "api_key") {
      this.setPhase({ ...phase, apiKey: value });
      return;
    }
    if (phase.kind !== "custom") return;
    if (field === "custom-url" && phase.step === "credentials") {
      this.setPhase({ ...phase, url: value, status: "input", message: "" });
      return;
    }
    if (field === "custom-api-key" && phase.step === "credentials") {
      this.setPhase({ ...phase, apiKey: value, status: "input", message: "" });
      return;
    }
    if (field === "manual-model" && phase.step === "model" && phase.manual) {
      this.setPhase({ ...phase, model: value, message: "" });
      return;
    }
    if (field === "context-window" && phase.step === "context") {
      this.setPhase({ ...phase, contextWindow: value, status: "input", message: "" });
      return;
    }
    if (field === "output-limit" && phase.step === "output") {
      this.setPhase({ ...phase, outputTokenLimit: value, status: "input", message: "" });
    }
  }

  private renderList(width: number): string[] {
    const rows = this.rows();
    if (this.cursor >= rows.length) this.cursor = Math.max(0, rows.length - 1);
    return renderLoginList({
      width,
      rows,
      cursor: this.cursor,
      phase: this.phase,
      config: this.config,
      hasAnyCredential: this.hasAnyCredential(),
      terminalRows: this.ctx?.terminalRows?.() ?? FALLBACK_TERMINAL_ROWS,
    });
  }
}

function isCopyKey(key: KeyEventData): boolean {
  return !key.ctrl && !key.meta && (key.sequence === "c" || key.sequence === "C");
}

function toTextKey(key: KeyEventData): Key {
  return {
    upArrow: key.name === "up",
    downArrow: key.name === "down",
    leftArrow: key.name === "left",
    rightArrow: key.name === "right",
    pageDown: key.name === "pagedown",
    pageUp: key.name === "pageup",
    wheelUp: false,
    wheelDown: false,
    home: key.name === "home",
    end: key.name === "end",
    return: key.name === "return",
    escape: key.name === "escape",
    ctrl: key.ctrl,
    shift: key.shift,
    fn: key.fn,
    tab: key.name === "tab",
    backspace: key.name === "backspace",
    delete: key.name === "delete",
    meta: key.meta || key.option,
    super: key.super,
  };
}

function narrowProps(props: LoginPanelProps | unknown): LoginPanelProps {
  // Accept bare provider id string or a full opener object.
  if (isProviderId(props)) return { initialProvider: props };
  if (typeof props !== "object" || props === null) return {};
  const raw = props as Record<string, unknown>;
  let initialProvider: ProviderId | undefined;
  if (isProviderId(raw.initialProvider)) initialProvider = raw.initialProvider;
  else if (isProviderId(raw.provider)) initialProvider = raw.provider;

  const broker =
    raw.broker !== undefined &&
    typeof raw.broker === "object" &&
    raw.broker !== null &&
    typeof (raw.broker as Broker).dispatch === "function"
      ? (raw.broker as Broker)
      : undefined;

  const config =
    raw.config !== undefined && typeof raw.config === "object" && raw.config !== null
      ? (raw.config as UserConfig)
      : undefined;

  const onConfigChange =
    typeof raw.onConfigChange === "function"
      ? (raw.onConfigChange as (config: UserConfig) => void)
      : undefined;

  return {
    ...(initialProvider !== undefined ? { initialProvider } : {}),
    ...(broker !== undefined ? { broker } : {}),
    ...(config !== undefined ? { config } : {}),
    ...(onConfigChange !== undefined ? { onConfigChange } : {}),
  };
}

export function createLoginPanel(close: () => void, props?: LoginPanelProps): StringViewPanel {
  return new LoginPanel(close, props);
}
