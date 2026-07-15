import { useEffect, useState } from "react";
import { Box, type Color as InkColor, Text } from "@/ink";
import { configPath } from "@/kernel/config/config.ts";
import type { PermissionRule } from "@/kernel/permissions/index.ts";
import { READ_ONLY_PERMISSION_SOURCES } from "@/kernel/permissions/index.ts";
import { loadRules, saveRules } from "@/kernel/permissions/persist.ts";
import { permissionRuleValueToString } from "@/kernel/permissions/types.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import { FooterPanel, FooterPanelRow } from "@/ui/chrome/panel.tsx";
import { usePanelNavigation } from "@/ui/hooks/use-panel-navigation.ts";
import { useOverlayState } from "@/ui/panels/context";
import { useOverlayClose } from "@/ui/panels/use-overlay-close";
import { Color } from "@/ui/theme/theme.ts";

export interface PermissionsOverlayProps {
  broker?: Broker;
  onClose?: () => void;
}

function ruleKey(rule: PermissionRule): string {
  return `${rule.source}|${rule.ruleBehavior}|${permissionRuleValueToString(rule.ruleValue)}`;
}

function behaviorColor(behavior: PermissionRule["ruleBehavior"]): InkColor | undefined {
  if (behavior === "deny") return Color.error;
  if (behavior === "ask") return Color.warning;
  return undefined;
}

function renderRulesList(
  rules: PermissionRule[] | null,
  idx: number,
): React.JSX.Element | React.JSX.Element[] {
  if (rules === null) return <Text color={Color.muted}>loading rules</Text>;
  if (rules.length === 0) return <Text color={Color.muted}>no persisted rules</Text>;
  return rules.map((rule, i) => (
    <FooterPanelRow
      key={ruleKey(rule)}
      label={`${rule.ruleBehavior} ${permissionRuleValueToString(rule.ruleValue)}`}
      value={rule.source}
      selected={i === idx}
      active={rule.ruleBehavior === "allow"}
      valueColor={behaviorColor(rule.ruleBehavior)}
      width={34}
    />
  ));
}

export function PermissionsOverlay({
  broker,
  onClose,
}: PermissionsOverlayProps = {}): React.JSX.Element {
  const overlayState = useOverlayState();
  const activeBroker = broker ?? overlayState.broker;
  const close = useOverlayClose(onClose);
  const cwd = overlayState.session.cwd;
  const state = activeBroker.read();
  const [rules, setRules] = useState<PermissionRule[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [feedback, setFeedback] = useState<string | null>(null);

  const refresh = (): void => {
    setRules(null);
    void loadRules(cwd).then((loaded) => {
      setRules(loaded);
      setIdx(0);
      setFeedback(null);
    });
  };

  useEffect(() => {
    setRules(null);
    void loadRules(cwd).then((loaded) => {
      setRules(loaded);
      setIdx(0);
      setFeedback(null);
    });
  }, [cwd]);

  const loaded = rules ?? [];

  usePanelNavigation({
    onClose: close,
    rows: { count: loaded.length, selected: idx, onChange: setIdx },
    onKey: (input) => {
      if (input === "q") {
        close();
        return true;
      }
      if (input === "r") {
        refresh();
        return true;
      }
      if (input === "x") {
        const selected = loaded[idx];
        if (!selected) return true;
        if (READ_ONLY_PERMISSION_SOURCES.has(selected.source)) {
          setFeedback(`${selected.source} rules cannot be removed here`);
          return true;
        }
        const key = ruleKey(selected);
        const next = loaded.filter((rule) => ruleKey(rule) !== key);
        setRules(next);
        setIdx((i) => Math.min(i, Math.max(0, next.length - 1)));
        void saveRules(next, cwd).then(() =>
          setFeedback(`removed ${permissionRuleValueToString(selected.ruleValue)}`),
        );
        return true;
      }
      return false;
    },
  });

  return (
    <FooterPanel
      command="/permissions"
      title="Permissions"
      onCancel={close}
      footerHints={[
        ["↑↓", "navigate"],
        ["x", "delete rule"],
        ["r", "reload"],
        ["Esc", "close"],
      ]}
    >
      <FooterPanelRow label="Session-scoped mode" value={state.permissionMode} width={28} />
      <FooterPanelRow label="Rules file" value={configPath()} muted width={28} />
      <Box marginTop={1} flexDirection="column">
        {renderRulesList(rules, idx)}
      </Box>
      {!!feedback && (
        <Box marginTop={1}>
          <Text color={Color.muted}>{feedback}</Text>
        </Box>
      )}
    </FooterPanel>
  );
}
