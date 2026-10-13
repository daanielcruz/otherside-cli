import { createAnthropicOAuth } from "./_infra/oauth.ts";

export type { AnthropicLoginHandle } from "./_infra/oauth.ts";

export const {
  Auth,
  beginLogin,
  login,
  loginManual,
  currentTokens,
  forceRefreshTokens,
  authorizationHeader,
} = createAnthropicOAuth("anthropic");
