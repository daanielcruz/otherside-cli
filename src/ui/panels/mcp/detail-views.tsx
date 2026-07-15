import { Box, type Color as InkColor, Text } from "@/ink";
import { type McpToolInfo, wireToolName } from "@/kernel/mcp/index.ts";
import { capitalize } from "@/kernel/std/text/text.ts";
import { FooterPanel, FooterPanelRow } from "@/ui/chrome/panel.tsx";
import {
  capabilities,
  formatCount,
  type McpMenuOption,
  type McpServerRow,
  TOOL_PAGE_SIZE,
  toolMarker,
  toolWindowStart,
} from "@/ui/panels/mcp/data";
import {
  annotationLabels,
  annotationText,
  schemaProperties,
  toolDisplayName,
} from "@/ui/panels/mcp/tool-format";
import { Color, Glyph } from "@/ui/theme/theme.ts";

export function ServerDetailView({
  server,
  options,
  selected,
  busy,
  onCancel,
}: {
  server: McpServerRow;
  options: McpMenuOption[];
  selected: number;
  busy: string | null;
  onCancel?: () => void;
}): React.JSX.Element {
  return (
    <FooterPanel
      command="/mcp"
      flushTop
      onCancel={onCancel}
      footerHints={[
        ["↑↓", "navigate"],
        ["Enter", "select"],
        ["Esc", "back"],
      ]}
    >
      <Box flexDirection="column">
        <Text color={Color.text} bold>
          {capitalize(server.name)} MCP Server
        </Text>
        {busy ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color={Color.text}>{busy}</Text>
            <Text color={Color.muted}>Restarting MCP server process</Text>
          </Box>
        ) : (
          <>
            <Box flexDirection="column" marginTop={1}>
              <InfoLine label="Status" value={server.inspection.statusText} />
              <InfoLine label="Transport" value={server.config.type} muted />
              {server.config.type === "stdio" ? (
                <>
                  <InfoLine label="Command" value={server.config.command} muted />
                  {server.config.args.length > 0 && (
                    <InfoLine label="Args" value={server.config.args.join(" ")} muted />
                  )}
                </>
              ) : (
                <InfoLine label="URL" value={server.config.url} muted />
              )}
              <InfoLine label="Config location" value={server.source?.path ?? "dynamic"} muted />
              {server.inspection.status === "connected" && (
                <InfoLine label="Capabilities" value={capabilities(server)} />
              )}
              {server.inspection.status === "connected" && server.inspection.tools.length > 0 && (
                <InfoLine
                  label="Tools"
                  value={formatCount(server.inspection.tools.length, "tool")}
                  muted
                />
              )}
              {server.inspection.status === "failed" && !!server.inspection.error && (
                <Box marginTop={1}>
                  <Text color={Color.error}>{server.inspection.error}</Text>
                </Box>
              )}
            </Box>
            <Box flexDirection="column" marginTop={1}>
              {options.map((option, index) => (
                <FooterPanelRow
                  key={option.id}
                  label={`${index + 1}. ${option.label}`}
                  selected={index === selected}
                  width={24}
                />
              ))}
            </Box>
          </>
        )}
      </Box>
    </FooterPanel>
  );
}

export function ToolsView({
  server,
  selected,
  onCancel,
}: {
  server: McpServerRow;
  selected: number;
  onCancel?: () => void;
}): React.JSX.Element {
  const tools = server.inspection.tools;
  const start = toolWindowStart(selected, tools.length);
  const visible = tools.slice(start, start + TOOL_PAGE_SIZE);
  return (
    <FooterPanel
      command="/mcp"
      flushTop
      onCancel={onCancel}
      footerHints={[
        ["↑↓", "navigate"],
        ["Enter", "select"],
        ["Esc", "back"],
      ]}
    >
      <Box flexDirection="column">
        <Text color={Color.text} bold>
          Tools for {server.name}
        </Text>
        <Text color={Color.muted}>{formatCount(tools.length, "tool")}</Text>
        <Box flexDirection="column" marginTop={1}>
          {tools.length === 0 ? (
            <Text color={Color.muted}>No tools available</Text>
          ) : (
            visible.map((tool, offset) => {
              const index = start + offset;
              const marker = toolMarker(index, selected, start, tools.length);
              const labels = annotationText(tool);
              return (
                <Box key={tool.name}>
                  <Text color={index === selected ? Color.highlight : Color.muted}>{marker} </Text>
                  <Text color={Color.text}>{`${index + 1}.`.padEnd(4)}</Text>
                  <Text color={index === selected ? Color.highlight : Color.text}>
                    {toolDisplayName(tool).padEnd(24)}
                  </Text>
                  {!!labels && (
                    <Text color={tool.destructiveHint ? Color.error : Color.muted}>{labels}</Text>
                  )}
                </Box>
              );
            })
          )}
        </Box>
      </Box>
    </FooterPanel>
  );
}

export function annotationColor(label: string): InkColor {
  if (label === "destructive") return Color.error;
  if (label === "read-only") return Color.success;
  return Color.muted;
}

export function ToolDetailView({
  server,
  tool,
  onCancel,
}: {
  server: McpServerRow;
  tool: McpToolInfo;
  onCancel?: () => void;
}): React.JSX.Element {
  const annotations = annotationLabels(tool);
  const params = schemaProperties(tool.inputSchema);
  return (
    <FooterPanel command="/mcp" flushTop onCancel={onCancel} footerHints={[["Esc", "go back"]]}>
      <Box flexDirection="column">
        <Box>
          <Text color={Color.text} bold>
            {toolDisplayName(tool)}
          </Text>
          {annotations.map((label) => (
            <Text key={label} color={annotationColor(label)}>
              {" "}
              [{label}]
            </Text>
          ))}
        </Box>
        <Text color={Color.muted}>{server.name}</Text>
        <Box flexDirection="column" marginTop={1}>
          <InfoLine label="Tool name" value={tool.name} muted />
          <InfoLine label="Full name" value={wireToolName(server.name, tool.name)} muted />
          {tool.description.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text color={Color.text} bold>
                Description:
              </Text>
              <Text color={Color.text}>{tool.description}</Text>
            </Box>
          )}
          {params.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text color={Color.text} bold>
                Parameters:
              </Text>
              <Box flexDirection="column" marginLeft={2}>
                {params.map((param) => (
                  <Text key={param.name} color={Color.text}>
                    {`${Glyph.bulletFilled} `}
                    {param.name}
                    {param.required && <Text color={Color.muted}> (required)</Text>}:{" "}
                    <Text color={Color.muted}>{param.type}</Text>
                    {!!param.description && <Text color={Color.muted}> - {param.description}</Text>}
                  </Text>
                ))}
              </Box>
            </Box>
          )}
        </Box>
      </Box>
    </FooterPanel>
  );
}

export function InfoLine({
  label,
  value,
  muted = false,
}: {
  label: string;
  value: string;
  muted?: boolean;
}): React.JSX.Element {
  return (
    <Box>
      <Text color={Color.text} bold>
        {`${label}:`.padEnd(17)}
      </Text>
      <Text color={muted ? Color.muted : Color.text}>{value}</Text>
    </Box>
  );
}
