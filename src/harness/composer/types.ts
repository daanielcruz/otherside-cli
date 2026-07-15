import type { HarnessLayer, LayerContext } from "@/harness/composer/injections.ts";

export type LayerKind = "system" | "user" | "mid-system";

export interface CategorizedLayer extends HarnessLayer {
  kind: LayerKind;
  cache?: "1h" | "5m" | "global-1h";
  // Static (default) lives in the long-lived global cache bucket;
  // dynamic content (cwd-derived, env-derived, per-turn injections) is split
  // into a separate bucket so static prefix stays cacheable across requests.
  // Only consumed for kind: 'system' layers by the Anthropic provider.
  phase?: "static" | "dynamic";
  // Optional override for the bundle taxonomy header (# ${bundleKey}) used by
  // the Anthropic prependUserContext-style envelope. Defaults to `name`.
  bundleKey?: string;
}

export type { LayerContext };
