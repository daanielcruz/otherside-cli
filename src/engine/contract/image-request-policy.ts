import type { ProviderId, ProviderModelRoute } from "@/kernel/std/types/provider-ids.ts";

export interface ImageRequestPolicy {
  readonly maxEdge: number;
  readonly maxRawBytes: number;
  readonly maxPixels: number;
}

export interface ImageRequestPolicyOptions {
  /** Total image blocks in the outbound request (direct + tool_result nested). */
  readonly imageCount?: number;
}

/**
 * Opt-in count-dependent dimension clamp. Only providers that declare this
 * (Anthropic many-image API rule) ever tighten maxEdge from request image count.
 */
interface ManyImageDimensionCap {
  /** Requests with more than this many images use maxEdge below. */
  readonly threshold: number;
  readonly maxEdge: number;
}

interface ProviderImageRequestPolicy {
  readonly default: ImageRequestPolicy;
  readonly models?: Readonly<Record<string, ImageRequestPolicy>>;
  /** Present only when the provider enforces a many-image dimension rule. */
  readonly manyImageDimensionCap?: ManyImageDimensionCap;
}

/**
 * Anthropic vision many-image rule (platform.claude.com vision docs): more than
 * 20 images in one request → neither dimension may exceed 2000 px. The API
 * rejection body names this as "many-image requests" with the pixel limit.
 */
export const ANTHROPIC_MANY_IMAGE_THRESHOLD = 20;
export const ANTHROPIC_MANY_IMAGE_MAX_EDGE = 2000;

const CONSERVATIVE_IMAGE_REQUEST_POLICY: ImageRequestPolicy = {
  maxEdge: 1568,
  maxRawBytes: 512_000,
  maxPixels: 2_458_624,
};

const IMAGE_REQUEST_POLICIES: Readonly<Partial<Record<ProviderId, ProviderImageRequestPolicy>>> = {
  anthropic: {
    default: CONSERVATIVE_IMAGE_REQUEST_POLICY,
    models: {
      "claude-opus-4-8": {
        maxEdge: 2048,
        maxRawBytes: 786_432,
        maxPixels: 4_194_304,
      },
    },
    manyImageDimensionCap: {
      threshold: ANTHROPIC_MANY_IMAGE_THRESHOLD,
      maxEdge: ANTHROPIC_MANY_IMAGE_MAX_EDGE,
    },
  },
  antigravity: {
    default: {
      maxEdge: 2000,
      maxRawBytes: 786_432,
      maxPixels: 4_000_000,
    },
  },
  codex: {
    default: {
      maxEdge: 2048,
      maxRawBytes: 786_432,
      maxPixels: 2_560_000,
    },
  },
  kimi: {
    default: {
      maxEdge: 2000,
      maxRawBytes: 512_000,
      maxPixels: 4_000_000,
    },
  },
  xai: {
    default: {
      maxEdge: 2000,
      maxRawBytes: 786_432,
      maxPixels: 2_400_000,
    },
  },
};

export function imageRequestPolicyFor(
  route: ProviderModelRoute,
  options: ImageRequestPolicyOptions = {},
): ImageRequestPolicy {
  const providerPolicy = IMAGE_REQUEST_POLICIES[route.provider];
  const base =
    providerPolicy?.models?.[route.model] ??
    providerPolicy?.default ??
    CONSERVATIVE_IMAGE_REQUEST_POLICY;
  return applyManyImageDimensionCap(
    base,
    providerPolicy?.manyImageDimensionCap,
    options.imageCount ?? 0,
  );
}

function applyManyImageDimensionCap(
  policy: ImageRequestPolicy,
  cap: ManyImageDimensionCap | undefined,
  imageCount: number,
): ImageRequestPolicy {
  if (!cap || imageCount <= cap.threshold || policy.maxEdge <= cap.maxEdge) {
    return policy;
  }
  return { ...policy, maxEdge: cap.maxEdge };
}
