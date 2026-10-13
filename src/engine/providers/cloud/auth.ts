import { createAnthropicOAuth } from "../anthropic/_infra/oauth.ts";

export type { AnthropicLoginHandle as CloudLoginHandle } from "../anthropic/_infra/oauth.ts";

export const {
  Auth,
  beginLogin,
  login,
  loginManual,
  currentTokens,
  forceRefreshTokens,
  authorizationHeader,
} = createAnthropicOAuth("anthropic-cloud");
