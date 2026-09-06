import { callCortex } from "@/backend/shared/api.ts";

export interface ConfirmPairingInput {
  cli_device_id: string;
  app_device_id: string;
  pair_session_id: string;
  app_pub: string;
  confirm_token: string;
  cli_device_label?: string;
  cli_fingerprint?: string;
}

export interface ConfirmPairingResult {
  cli_device_id?: string;
  app_device_id?: string;
  pairing?: { device_a: string; device_b: string };
  created?: boolean;
  verified_at?: string;
}

export function confirmPairing(input: ConfirmPairingInput): Promise<ConfirmPairingResult> {
  return callCortex<ConfirmPairingResult>("/v1/pairings/confirm", input);
}

export interface UnpairInput {
  cli_device_id: string;
  app_device_id?: string;
}

export interface UnpairResult {
  removed?: boolean;
  revoked?: boolean;
}

export function unpair(input: UnpairInput): Promise<UnpairResult> {
  return callCortex<UnpairResult>("/v1/pairings/unpair", input);
}
