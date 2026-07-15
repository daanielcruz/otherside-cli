import { makeApiKeyAuth } from "@/engine/providers/_shared/oauth/api-key.ts";
import { ENV_VAR_CANONICAL, ENV_VAR_VENDOR } from "./fingerprint.ts";

const helpers = makeApiKeyAuth({
  providerId: "deepseek",
  label: "deepseek",
  envCanonical: ENV_VAR_CANONICAL,
  envVendor: ENV_VAR_VENDOR,
});

export const currentApiKey = helpers.currentApiKey;
export const loginWithKey = helpers.loginWithKey;
export const Auth = helpers.Auth;
