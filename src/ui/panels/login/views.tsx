import { Box, TerminalLink, Text } from "@/ink";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { CredentialsBundle } from "@/kernel/storage/credentials.ts";
import { FooterPanelRow } from "@/ui/chrome/panel.tsx";
import {
  API_KEY_HOST_LABELS,
  buildProviderRows,
  formatContextWindow,
  formatOutputTokenLimit,
  inputDisplay,
  maskKey,
  OPENAI_CUSTOM_URL_PLACEHOLDER,
  oauthStatusColor,
  type Phase,
} from "@/ui/panels/login/flow";
import { ProviderTosWarning } from "@/ui/panels/provider-tos-warning";
import { Color, Glyph } from "@/ui/theme/theme.ts";

export function ProviderList({
  cursor,
  bundle,
  configured,
}: {
  cursor: number;
  bundle: CredentialsBundle | null;
  configured: boolean;
}): React.JSX.Element {
  const rows = buildProviderRows(bundle);
  const hasAny =
    bundle !== null &&
    Object.values(bundle as Record<string, unknown>).some((value) => value !== undefined);
  return (
    <Box flexDirection="column">
      <Text color={Color.muted}>Choose a provider to authenticate.</Text>
      {!hasAny && configured && (
        <Box marginTop={1}>
          <Text color={Color.warning}>⚠ At least one provider is required to continue.</Text>
        </Box>
      )}
      <Box flexDirection="column" marginTop={1}>
        {rows.length === 0 ? (
          <Text color={Color.muted}>No providers available.</Text>
        ) : (
          rows.map((row, i) => (
            <FooterPanelRow
              key={row.id}
              label={row.label}
              selected={i === cursor}
              width={42}
              {...(row.signedIn
                ? { value: `· ${Glyph.checkThin}`, valueColor: Color.success }
                : {})}
            />
          ))
        )}
      </Box>
    </Box>
  );
}
export function OAuthPhase({
  phase,
}: {
  phase: Extract<Phase, { kind: "oauth" }>;
}): React.JSX.Element {
  const color = oauthStatusColor(phase.status);
  return (
    <Box flexDirection="column">
      <ProviderTosWarning provider={phase.provider.id as ProviderId} />
      <Text color={Color.muted}>{phase.provider.label}</Text>
      {phase.status === "running" ? (
        <>
          {phase.url.length > 0 && (
            <>
              <Box marginTop={1}>
                <Text color={Color.muted}>If browser didn't open, visit:</Text>
              </Box>
              <TerminalLink url={phase.url} />
            </>
          )}
          {phase.supportsPaste && (
            <>
              <Box marginTop={1}>
                <Text color={Color.muted}>Or paste the URL/code from the redirect page:</Text>
              </Box>
              <Box>
                <Text color={Color.muted}>{Glyph.chevron}</Text>
                <Text color={Color.text}>{`${phase.pasted}${Glyph.blockHalf}`}</Text>
              </Box>
            </>
          )}
          <Box marginTop={1}>
            <Text color={color}>{phase.message}</Text>
          </Box>
        </>
      ) : (
        <Box marginTop={1}>
          <Text color={color}>{phase.message}</Text>
        </Box>
      )}
    </Box>
  );
}

export function VerifyPhase({
  phase,
}: {
  phase: Extract<Phase, { kind: "verify" }>;
}): React.JSX.Element {
  const color = phase.status === "fail" ? Color.error : Color.highlight;
  return (
    <Box flexDirection="column">
      <Text color={Color.muted}>{phase.provider.label}</Text>
      <Box marginTop={1}>
        <Text color={Color.text}>{phase.description}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={Color.muted}>Verify your account in the browser, then return here:</Text>
      </Box>
      <TerminalLink url={phase.url} />
      <Box marginTop={1}>
        <Text color={color}>{phase.message}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={Color.muted}>Enter verified · a another account · Esc cancel</Text>
      </Box>
    </Box>
  );
}
export function ApiKeyForm({
  phase,
}: {
  phase: Extract<Phase, { kind: "api_key" }>;
}): React.JSX.Element {
  const host = API_KEY_HOST_LABELS[phase.provider];
  return (
    <Box flexDirection="column">
      <Text color={Color.muted}>Paste your {host} API key.</Text>
      <Box flexDirection="column" marginTop={1}>
        <FooterPanelRow
          label="API key"
          value={`${maskKey(phase.apiKey)}${phase.status === "input" ? Glyph.blockHalf : ""}`}
          selected={phase.status === "input"}
          width={14}
        />
      </Box>
      {phase.status === "fail" && <Text color={Color.error}>{phase.message}</Text>}
      {phase.status === "saving" && <Text color={Color.highlight}>saving…</Text>}
    </Box>
  );
}

export function CustomForm({
  phase,
}: {
  phase: Extract<Phase, { kind: "custom" }>;
}): React.JSX.Element {
  if (phase.step === "credentials") {
    return (
      <Box flexDirection="column">
        <Text color={Color.muted}>Enter the OpenAI-compatible base URL and optional API key.</Text>
        <Box flexDirection="column" marginTop={1}>
          <FooterPanelRow
            label="Base URL"
            value={inputDisplay(phase.url, OPENAI_CUSTOM_URL_PLACEHOLDER, phase.field === 0)}
            valueColor={phase.url.length === 0 ? Color.muted : undefined}
            selected={phase.field === 0}
            width={14}
          />
          <FooterPanelRow
            label="API key (optional)"
            value={`${maskKey(phase.apiKey)}${phase.field === 1 ? Glyph.blockHalf : ""}`}
            selected={phase.field === 1}
            width={20}
          />
        </Box>
        {phase.status === "fail" && <Text color={Color.error}>{phase.message}</Text>}
        {phase.status === "discovering" && <Text color={Color.highlight}>{phase.message}</Text>}
      </Box>
    );
  }

  if (phase.step === "model") {
    return (
      <Box flexDirection="column">
        <Text color={phase.failedDiscovery ? Color.error : Color.muted}>{phase.message}</Text>
        <Box flexDirection="column" marginTop={1}>
          {phase.manual ? (
            <FooterPanelRow
              label="Model"
              value={`${phase.model}${Glyph.blockHalf}`}
              selected
              width={14}
            />
          ) : (
            <>
              {phase.models.map((model, index) => (
                <FooterPanelRow
                  key={model.id}
                  label={model.id}
                  value={formatContextWindow(model.contextWindow)}
                  selected={phase.cursor === index}
                  active={phase.model === model.id}
                  width={62}
                />
              ))}
              <Box marginTop={1}>
                <FooterPanelRow
                  label="Enter model manually"
                  selected={phase.cursor >= phase.models.length}
                  width={42}
                />
              </Box>
            </>
          )}
        </Box>
      </Box>
    );
  }

  if (phase.step === "context") {
    return (
      <Box flexDirection="column">
        <Text color={phase.status === "fail" ? Color.error : Color.muted}>{phase.message}</Text>
        <Box flexDirection="column" marginTop={1}>
          <FooterPanelRow label="Model" value={phase.model} width={18} />
          <FooterPanelRow
            label="Context window"
            value={`${phase.contextWindow}${Glyph.blockHalf}`}
            selected
            width={18}
          />
        </Box>
      </Box>
    );
  }

  if (phase.step === "output") {
    return (
      <Box flexDirection="column">
        <Text color={phase.status === "fail" ? Color.error : Color.muted}>{phase.message}</Text>
        <Box flexDirection="column" marginTop={1}>
          <FooterPanelRow label="Model" value={phase.model} width={18} />
          <FooterPanelRow
            label="Max output"
            value={`${phase.outputTokenLimit}${Glyph.blockHalf}`}
            selected
            width={18}
          />
        </Box>
      </Box>
    );
  }

  if (phase.step === "test_failed") {
    return (
      <Box flexDirection="column">
        <Text color={Color.error}>{phase.message}</Text>
        <Box flexDirection="column" marginTop={1}>
          <FooterPanelRow label="Save anyway" selected={phase.cursor === 0} width={22} />
          <FooterPanelRow label="Review settings" selected={phase.cursor === 1} width={22} />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color={phase.step === "success" ? Color.success : Color.highlight}>
        {phase.message}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <FooterPanelRow label="Base URL" value={phase.url} width={14} />
        <FooterPanelRow label="Model" value={phase.model} width={14} />
        <FooterPanelRow
          label="Context"
          value={formatContextWindow(Number(phase.contextWindow))}
          width={14}
        />
        <FooterPanelRow
          label="Max output"
          value={formatOutputTokenLimit(Number(phase.outputTokenLimit))}
          width={14}
        />
      </Box>
    </Box>
  );
}
