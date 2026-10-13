import {
  type AuthUnavailableReason,
  authUnavailableReason,
  loadAuth,
  loadFreshAuth,
  type RemoteAuth,
} from "@/backend/shared/auth.ts";

export const DESIGN_RELAY_SIGNED_OUT = "sign-in expired — run /remote pair to reconnect";

export interface RelayAuthGate {
  /** Whether this cycle may talk to the backend; a false cycle is skipped, never retried with a stale token. */
  ready(): Promise<boolean>;
}

export interface RelayAuthGateDeps {
  onSignedOut: (reason: string) => void;
  onRestored: () => void;
}

export interface RelayAuthSource {
  loadAuth(): RemoteAuth | null;
  loadFreshAuth(): Promise<RemoteAuth | null>;
  authUnavailableReason(): AuthUnavailableReason;
}

const sharedAuthSource: RelayAuthSource = { loadAuth, loadFreshAuth, authUnavailableReason };

export function createRelayAuthGate(
  deps: RelayAuthGateDeps,
  auth: RelayAuthSource = sharedAuthSource,
): RelayAuthGate {
  let rejectedAccessToken: string | null = null;

  return {
    async ready() {
      if (rejectedAccessToken !== null) {
        // A rejected refresh token stays rejected: wait for a new sign-in to land
        // on disk instead of asking the backend again every cycle.
        const stored = auth.loadAuth();
        if (!stored || stored.accessToken === rejectedAccessToken) return false;
      }
      const fresh = await auth.loadFreshAuth();
      if (fresh) {
        if (rejectedAccessToken !== null) {
          rejectedAccessToken = null;
          deps.onRestored();
        }
        return true;
      }
      if (rejectedAccessToken === null && auth.authUnavailableReason() !== "refresh_pending") {
        rejectedAccessToken = auth.loadAuth()?.accessToken ?? "";
        deps.onSignedOut(DESIGN_RELAY_SIGNED_OUT);
      }
      return false;
    },
  };
}
