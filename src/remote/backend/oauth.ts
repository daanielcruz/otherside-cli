import { spawn } from "node:child_process";
import { oauthSuccessResponse } from "@/kernel/std/oauth-success-page.ts";
import { CortexApiError, cortexFetch } from "@/remote/_infra/cortex.ts";
import {
  decodeTokenResponse,
  type RemoteAuth,
  saveAuth,
  type TokenResponse,
} from "@/remote/backend/auth.ts";

export type OAuthProvider = "google" | "apple";

const LOGIN_TIMEOUT_MS = 180_000;
const POLL_MS = 2_500;

export interface DeviceAuthPending {
  userCode: string;
  verificationUri: string;
}

// Ink swallows stderr, so the pending device code is published here for the
// design overlay (or any UI) to render while the poll loop waits for approval.
let pendingDeviceAuth: DeviceAuthPending | null = null;
const deviceAuthListeners = new Set<() => void>();

function setPendingDeviceAuth(next: DeviceAuthPending | null): void {
  pendingDeviceAuth = next;
  for (const listener of deviceAuthListeners) listener();
}

export function getPendingDeviceAuth(): DeviceAuthPending | null {
  return pendingDeviceAuth;
}

export function subscribeDeviceAuth(listener: () => void): () => void {
  deviceAuthListeners.add(listener);
  return () => {
    deviceAuthListeners.delete(listener);
  };
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* ignore */
  }
}

/**
 * Device-code login against cortex. Phone/app approves via POST /v1/auth/device/approve
 * after user visits verification_uri_complete (or enters user_code).
 */
export async function oauthLogin(_provider: OAuthProvider = "google"): Promise<RemoteAuth> {
  const start = await cortexFetch<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval?: number;
  }>("/v1/auth/device/code", { method: "POST", body: {} });

  const intervalMs = Math.max(POLL_MS, (start.interval ?? 2) * 1000);
  const deadline = Date.now() + Math.min(LOGIN_TIMEOUT_MS, (start.expires_in ?? 900) * 1000);

  setPendingDeviceAuth({
    userCode: start.user_code,
    verificationUri: start.verification_uri_complete || start.verification_uri,
  });
  openBrowser(start.verification_uri_complete || start.verification_uri);

  try {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, intervalMs));
      try {
        const tokens = await cortexFetch<TokenResponse>("/v1/auth/device/token", {
          method: "POST",
          body: { device_code: start.device_code },
        });
        const auth = decodeTokenResponse(tokens);
        saveAuth(auth);
        // best-effort success page not available without loopback — CLI message is enough
        void oauthSuccessResponse("device");
        return auth;
      } catch (err) {
        if (err instanceof CortexApiError) {
          // pending until approved
          if (
            err.code === "unauthorized" &&
            (err.message.includes("authorization_pending") || err.message.includes("pending"))
          ) {
            continue;
          }
          if (err.message.includes("authorization_pending")) continue;
        }
        // keep polling on soft failures
        if (err instanceof CortexApiError && err.httpStatus === 401) continue;
        if (err instanceof CortexApiError && err.httpStatus >= 500) continue;
        throw err instanceof Error ? err : new Error(String(err));
      }
    }
    throw new Error("oauth login timed out");
  } finally {
    setPendingDeviceAuth(null);
  }
}
