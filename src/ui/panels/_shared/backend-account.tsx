// Shared sign-in surface for panels that talk to the otherside backend
// (/remote and /design): account snapshot, provider list, provider pick view,
// and the device-code approval notice.

import { useSyncExternalStore } from "react";
import { currentUserEmail, currentUserId, loadAuth } from "@/backend/shared/auth.ts";
import {
  type DeviceAuthPending,
  getPendingDeviceAuth,
  type OAuthProvider,
  subscribeDeviceAuth,
} from "@/backend/shared/oauth.ts";
import { Box, TerminalLink, Text } from "@/ink";
import { FooterPanelRow } from "@/ui/chrome/panel.tsx";
import { Color } from "@/ui/theme/theme.ts";

export interface AuthSnapshot {
  signedIn: boolean;
  label: string;
}

export interface ProviderChoice {
  id: OAuthProvider;
  label: string;
}

export const LOGIN_PROVIDERS: ProviderChoice[] = [
  { id: "google", label: "Continue with Google" },
  { id: "apple", label: "Continue with Apple" },
];

export function readAuth(): AuthSnapshot {
  if (!loadAuth()) return { signedIn: false, label: "Not signed in" };
  const email = currentUserEmail();
  const id = currentUserId();
  const label = email ?? (id ? `${id.slice(0, 8)}…` : "Signed in");
  return { signedIn: true, label };
}

export function usePendingDeviceAuth(): DeviceAuthPending | null {
  return useSyncExternalStore(subscribeDeviceAuth, getPendingDeviceAuth, getPendingDeviceAuth);
}

export function DeviceAuthNotice({ pending }: { pending: DeviceAuthPending }): React.JSX.Element {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text color={Color.warning}>Approve this terminal in the browser</Text>
      <Box>
        <Text color={Color.muted}>Code </Text>
        <Text color={Color.text} bold>
          {pending.userCode}
        </Text>
      </Box>
      <TerminalLink url={pending.verificationUri} />
    </Box>
  );
}

export function LoginPick({
  description,
  selected,
  busy,
  error,
  deviceAuth,
  rowWidth,
}: {
  description: string;
  selected: number;
  busy: boolean;
  error: string | null;
  deviceAuth: DeviceAuthPending | null;
  rowWidth: number;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text color={Color.muted}>{description}</Text>
      <Box flexDirection="column" marginTop={1}>
        {LOGIN_PROVIDERS.map((provider, idx) => (
          <FooterPanelRow
            key={provider.id}
            label={provider.label}
            selected={idx === selected}
            width={rowWidth}
          />
        ))}
      </Box>
      {busy && (
        <Box marginTop={1}>
          <Text color={Color.muted} dim>
            Opening browser… complete the sign-in, then return here.
          </Text>
        </Box>
      )}
      {deviceAuth !== null && <DeviceAuthNotice pending={deviceAuth} />}
      {!!error && (
        <Box marginTop={1}>
          <Text color={Color.error}>{error}</Text>
        </Box>
      )}
    </Box>
  );
}
