import type {
  ComposedHarness,
  LayerContext,
  SystemTextBlock,
} from "@/harness/composer/injections.ts";
import { HARNESS_MANIFEST, type LayerDescriptor } from "@/harness/composer/manifest.ts";
import { stripSystemReminderWrapper } from "@/harness/composer/reminder-wrapper.ts";
import { applyTokens } from "@/harness/composer/tokens.ts";

export function defaultStack(): LayerDescriptor[] {
  return [...HARNESS_MANIFEST];
}

export function compose(layers: readonly LayerDescriptor[], ctx: LayerContext): ComposedHarness {
  const rendered: { name: string; body: string }[] = [];
  const systemBlocks: SystemTextBlock[] = [];
  const userPrepend: SystemTextBlock[] = [];
  const midSystemBlocks: SystemTextBlock[] = [];
  for (const layer of layers) {
    if (layer.when && !layer.when(ctx)) continue;
    const body =
      layer.render !== undefined
        ? layer.render(ctx)
        : layer.tokens !== undefined
          ? applyTokens(layer.prompt, layer.tokens(ctx))
          : layer.prompt;
    if (body === null || body.length === 0) continue;
    rendered.push({ name: layer.name, body });
    const phase = layer.phase ?? "static";
    const bundleKey = layer.bundleKey ?? layer.name;
    const block: SystemTextBlock = { text: body, phase, bundleKey };
    if (layer.kind === "system") systemBlocks.push(block);
    else if (layer.kind === "mid-system") {
      // Promotion lifts the reminder out of the user turn; the unwrap set
      // additionally drops the reminder envelope from the promoted content.
      if (ctx.promoteMidSystem) {
        midSystemBlocks.push(
          ctx.supportsMidSystem
            ? { ...block, text: stripSystemReminderWrapper(block.text) }
            : block,
        );
      } else userPrepend.push({ ...block, standalone: true });
    } else userPrepend.push(block);
  }
  return {
    layers: rendered,
    combined: rendered.map((l) => l.body).join("\n\n"),
    systemBlocks,
    userPrepend,
    midSystemBlocks,
    midSystemPromotion: ctx.promoteMidSystem
      ? ctx.supportsMidSystem
        ? "unwrapped"
        : "wrapped"
      : "off",
  };
}
