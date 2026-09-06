import { type ProviderId, providerDisplayName } from "@/kernel/std/types/provider-ids.ts";
import { deleteFor, type ProviderSlug } from "@/kernel/storage/credentials.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { readStringViewBrokerState } from "@/ui/chrome/status/string-view-state.ts";
import { type FooterPanelSpec, renderFooterPanel } from "@/ui/chrome/string-view-panel.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";
import { Color } from "@/ui/theme/theme.ts";

type Phase = "running" | "done" | "error";

/** Opener payload — optional broker to pick which provider's credentials to clear. */
export interface LogoutPanelProps {
  broker?: Broker;
}

/**
 * Logout status overlay on the string model. On mount, clears credentials for the
 * active broker provider (`deleteFor`); shows progress, then a success line and
 * exits the process, or an error the user can dismiss with Esc/Enter.
 */
class LogoutPanel implements StringViewPanel {
  private ctx: StringViewContext | undefined;
  private phase: Phase = "running";
  private errorMsg: string | null = null;
  private cancelled = false;
  private exitTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly provider: ProviderSlug;

  constructor(
    private readonly close: () => void,
    props?: LogoutPanelProps,
  ) {
    this.provider = resolveProvider(props);
  }

  mount(ctx: StringViewContext): void {
    this.ctx = ctx;
    this.cancelled = false;
    void deleteFor(this.provider)
      .then(() => {
        if (this.cancelled) return;
        this.phase = "done";
        this.ctx?.requestRender();
        this.exitTimer = setTimeout(() => process.exit(0), 200);
      })
      .catch((err: unknown) => {
        if (this.cancelled) return;
        this.phase = "error";
        this.errorMsg = err instanceof Error ? err.message : String(err);
        this.ctx?.requestRender();
      });
    ctx.requestRender();
  }

  unmount(): void {
    this.cancelled = true;
    if (this.exitTimer !== undefined) clearTimeout(this.exitTimer);
    this.ctx = undefined;
  }

  render(width: number): string[] {
    const body = [this.statusLine()];
    const spec: FooterPanelSpec = {
      command: "/logout",
      body,
      footerHints: [["Esc", "close"]],
    };
    return renderFooterPanel(spec, width);
  }

  handleKey(key: KeyEventData): void {
    switch (key.name) {
      case "escape":
        this.close();
        return;
      case "return":
        if (this.phase !== "running") this.close();
        return;
      case "up":
      case "down":
        return;
    }
  }

  private statusLine(): string {
    if (this.phase === "error") {
      return renderTextWithStyles(`logout failed: ${this.errorMsg ?? "unknown error"}`, {
        color: Color.error,
      });
    }
    if (this.phase === "done") {
      return renderTextWithStyles(
        `Successfully logged out from your ${providerDisplayName(this.provider as ProviderId)} account.`,
        { color: Color.text },
      );
    }
    return renderTextWithStyles("Logging out…", { color: Color.muted });
  }
}

function resolveProvider(props?: LogoutPanelProps): ProviderSlug {
  const fromProps = props?.broker?.read().provider;
  if (typeof fromProps === "string") return fromProps as ProviderSlug;
  return readStringViewBrokerState().provider as ProviderSlug;
}

export function createLogoutPanel(close: () => void, props?: LogoutPanelProps): StringViewPanel {
  return new LogoutPanel(close, props);
}
