import { makeGoogleRecoverableError } from "@/engine/providers/_shared/google-fallback.ts";
import { ProviderHttpError } from "@/kernel/std/types/error-meta.ts";

export const recoverableError = makeGoogleRecoverableError({
  providerId: "antigravity",
  rateLimitErrorCtor: ProviderHttpError,
  httpErrorCtor: ProviderHttpError,
});
