import { getProviderConfig } from "@/engine/contract/registry.ts";
import { Box, Text } from "@/ink";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import { Color } from "@/ui/theme/theme.ts";

export function ProviderTosWarning({
  provider,
}: {
  provider: ProviderId;
}): React.JSX.Element | null {
  if (provider !== "antigravity") return null;
  const label = getProviderConfig(provider)?.provider.label ?? provider;
  const message = `Using ${label} in third-party tools may violate Google's ToS. Please use at your own risk.`;
  return (
    <Box marginBottom={1}>
      <Text color={Color.warning} bold>
        ⚠ {message}
      </Text>
    </Box>
  );
}
