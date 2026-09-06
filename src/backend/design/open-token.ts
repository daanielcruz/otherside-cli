import { callCortex } from "@/backend/shared/api.ts";

export interface MintDesignOpenTokenInput {
  session_id: string;
  cli_environment_id: string;
}

export interface MintDesignOpenTokenResult {
  token: string;
  expires_at: string;
  session_id: string;
}

export function mintDesignOpenToken(
  input: MintDesignOpenTokenInput,
): Promise<MintDesignOpenTokenResult> {
  return callCortex<MintDesignOpenTokenResult>("/v1/design/open-tokens", input);
}
