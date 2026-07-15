import { useEffect, useMemo, useRef, useState } from "react";
import { publish } from "@/engine/background/tasks/bus.ts";
import { Box, type Color as InkColor, type Key, TerminalLink, Text } from "@/ink";
import {
  approveProjectMcpServer,
  disableMcpServer,
  enableMcpServer,
  rejectProjectMcpServer,
} from "@/kernel/mcp/config.ts";
import { dropClient, startOAuthFlow } from "@/kernel/mcp/index.ts";
import { errorMessage } from "@/kernel/std/errno.ts";
import { capitalize } from "@/kernel/std/text/text.ts";
import { FooterPanel } from "@/ui/chrome/panel.tsx";
import { usePanelNavigation } from "@/ui/hooks/use-panel-navigation.ts";
import {
  formatCount,
  groupServerRows,
  isRemote,
  loadMcpRows,
  type McpGroup,
  type McpMenuOption,
  type McpServerRow,
  resolveInspection,
  serverMenuOptions,
  statusColor,
  wrapIndex,
} from "@/ui/panels/mcp/data";
import { ServerDetailView, ToolDetailView, ToolsView } from "@/ui/panels/mcp/detail-views";
import { useOverlayClose } from "@/ui/panels/use-overlay-close";
import { Color, Glyph } from "@/ui/theme/theme.ts";

export interface McpOverlayProps {
  onClose?: () => void;
}

type View = "list" | "server" | "tools" | "tool" | "auth";

type AuthStatus = "running" | "ok" | "fail";

interface AuthState {
  serverName: string;
  url: string;
  status: AuthStatus;
  message: string;
  pasted: string;
}

interface McpOverlayState {
  loading: boolean;
  error: string | null;
  rows: McpServerRow[];
}

const EMPTY_STATE: McpOverlayState = {
  loading: true,
  error: null,
  rows: [],
};

function McpServerList({
  state,
  groups,
  rows,
  serverIndex,
}: {
  state: McpOverlayState;
  groups: McpGroup[];
  rows: McpServerRow[];
  serverIndex: number;
}): React.JSX.Element {
  if (state.loading) return <Text color={Color.muted}>Checking MCP server health…</Text>;
  if (state.error) return <Text color={Color.error}>{state.error}</Text>;
  if (rows.length === 0) return <Text color={Color.muted}>No MCP servers configured</Text>;
  return (
    <>
      {groups.map((group) => (
        <Box key={group.key} flexDirection="column" marginBottom={1}>
          <Box paddingLeft={2}>
            <Text color={Color.textStrong} bold>
              {group.label}
            </Text>
            {!!group.path && <Text color={Color.muted}> ({group.path})</Text>}
          </Box>
          {group.rows.map((row) => {
            const index = rows.findIndex((candidate) => candidate.name === row.name);
            return <McpServerListRow key={row.name} row={row} selected={index === serverIndex} />;
          })}
        </Box>
      ))}
    </>
  );
}

export function McpOverlay({ onClose }: McpOverlayProps = {}): React.JSX.Element {
  const close = useOverlayClose(onClose);
  const [state, setState] = useState<McpOverlayState>(EMPTY_STATE);
  const [reloadKey, setReloadKey] = useState(0);
  const [view, setView] = useState<View>("list");
  const [serverIndex, setServerIndex] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [toolIndex, setToolIndex] = useState(0);
  const [detailToolIndex, setDetailToolIndex] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [auth, setAuth] = useState<AuthState | null>(null);
  const authAbortRef = useRef<AbortController | null>(null);
  const authFlowRef = useRef<{ submitCode: (input: string) => void } | null>(null);
  const authSeqRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const currentReloadKey = reloadKey;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    void loadMcpRows()
      .then((rows) => {
        if (currentReloadKey !== reloadKey) return;
        if (cancelled) return;
        setState({ loading: false, error: null, rows });
        setServerIndex((idx) => Math.min(Math.max(0, rows.length - 1), idx));
      })
      .catch((error) => {
        if (currentReloadKey !== reloadKey) return;
        if (cancelled) return;
        setState({
          loading: false,
          error: errorMessage(error),
          rows: [],
        });
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const rows = state.rows;
  const selectedServer = rows[serverIndex];
  const serverTools = selectedServer?.inspection.tools ?? [];
  const selectedTool = serverTools[detailToolIndex] ?? serverTools[toolIndex];
  const menuOptions = useMemo(() => serverMenuOptions(selectedServer), [selectedServer]);
  const groups = useMemo(() => groupServerRows(rows), [rows]);

  useEffect(() => {
    setMenuIndex((idx) => Math.min(Math.max(0, menuOptions.length - 1), idx));
  }, [menuOptions.length]);

  useEffect(() => {
    setToolIndex((idx) => Math.min(Math.max(0, serverTools.length - 1), idx));
    setDetailToolIndex((idx) => Math.min(Math.max(0, serverTools.length - 1), idx));
  }, [serverTools.length]);

  function cancelAuth(): void {
    authSeqRef.current += 1;
    authAbortRef.current?.abort();
    authAbortRef.current = null;
    authFlowRef.current = null;
    setAuth(null);
    setView("list");
  }

  function handleAuthInput(input: string, key: Key): void {
    if (!auth) return;
    if (auth.status !== "running") {
      if (key.return || key.leftArrow) cancelAuth();
      return;
    }
    if (key.leftArrow) {
      cancelAuth();
      return;
    }
    if (key.return) {
      const code = auth.pasted.trim();
      if (code.length === 0) return;
      authFlowRef.current?.submitCode(code);
      setAuth({ ...auth, pasted: "", message: `Verifying code for ${auth.serverName}…` });
      return;
    }
    if (key.backspace || key.delete) {
      setAuth({ ...auth, pasted: auth.pasted.slice(0, -1) });
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setAuth({ ...auth, pasted: auth.pasted + input });
    }
  }

  usePanelNavigation({
    onClose: close,
    skipEsc: true,
    onKey: (input, key) => {
      if (busy) return false;
      if (view === "auth") {
        handleAuthInput(input, key);
        return true;
      }
      if (state.loading || rows.length === 0) return false;
      if (view === "list") {
        if (key.upArrow) {
          setServerIndex((idx) => wrapIndex(idx - 1, rows.length));
          return true;
        }
        if (key.downArrow) {
          setServerIndex((idx) => wrapIndex(idx + 1, rows.length));
          return true;
        }
        if (key.return) {
          setMenuIndex(0);
          setView("server");
          return true;
        }
        return false;
      }
      if (view === "server") {
        if (key.upArrow) {
          setMenuIndex((idx) => wrapIndex(idx - 1, menuOptions.length));
          return true;
        }
        if (key.downArrow) {
          setMenuIndex((idx) => wrapIndex(idx + 1, menuOptions.length));
          return true;
        }
        if (key.return) {
          const option = menuOptions[menuIndex];
          if (selectedServer && option) void runServerAction(selectedServer, option);
          return true;
        }
        return false;
      }
      if (view === "tools") {
        if (key.upArrow) {
          setToolIndex((idx) => wrapIndex(idx - 1, serverTools.length));
          return true;
        }
        if (key.downArrow) {
          setToolIndex((idx) => wrapIndex(idx + 1, serverTools.length));
          return true;
        }
        if (key.return && serverTools[toolIndex]) {
          setDetailToolIndex(toolIndex);
          setView("tool");
          return true;
        }
      }
      return false;
    },
  });

  async function beginAuth(serverName: string, baseUrl: string, scope?: string): Promise<void> {
    const seq = ++authSeqRef.current;
    const controller = new AbortController();
    authAbortRef.current = controller;
    authFlowRef.current = null;
    setAuth({
      serverName,
      url: "",
      status: "running",
      message: "Starting authorization…",
      pasted: "",
    });
    setView("auth");
    try {
      const flow = await startOAuthFlow({
        serverName,
        baseUrl,
        abortSignal: controller.signal,
        ...(scope ? { scope } : {}),
      });
      if (authSeqRef.current !== seq) return;
      authFlowRef.current = { submitCode: flow.submitCode };
      setAuth({
        serverName,
        url: flow.authUrl,
        status: "running",
        message: "Browser opened — waiting for authorization…",
        pasted: "",
      });
      void flow.done.then((outcome) => {
        if (authSeqRef.current !== seq) return;
        if (outcome.kind === "saved") {
          setAuth({
            serverName,
            url: flow.authUrl,
            status: "ok",
            message: `Authorized ${serverName}.`,
            pasted: "",
          });
          publish("success", `MCP "${serverName}" authorized`);
          setReloadKey((key) => key + 1);
          return;
        }
        setAuth({
          serverName,
          url: flow.authUrl,
          status: "fail",
          message: outcome.reason,
          pasted: "",
        });
        publish("error", `MCP "${serverName}" auth failed: ${outcome.reason}`);
      });
    } catch (e) {
      if (authSeqRef.current !== seq) return;
      const message = e instanceof Error ? e.message : String(e);
      setAuth({ serverName, url: "", status: "fail", message, pasted: "" });
      publish("error", `MCP "${serverName}" auth error: ${message}`);
    }
  }

  async function runServerAction(server: McpServerRow, option: McpMenuOption): Promise<void> {
    if (option.id === "trust" || option.id === "trustAll" || option.id === "reject") {
      const approved = option.id !== "reject";
      setBusy(`${approved ? "Approving" : "Rejecting"} ${server.name}`);
      if (approved) {
        await approveProjectMcpServer(process.cwd(), server.name, option.id === "trustAll");
      } else {
        await rejectProjectMcpServer(process.cwd(), server.name);
      }
      publish(
        "success",
        approved ? `MCP "${server.name}" approved` : `MCP "${server.name}" rejected`,
      );
      setView("list");
      setMenuIndex(0);
      setBusy(null);
      setReloadKey((key) => key + 1);
      return;
    }
    if (option.id === "tools") {
      setToolIndex(0);
      setDetailToolIndex(0);
      setView("tools");
      return;
    }
    if (option.id === "authenticate") {
      if (!isRemote(server.config)) return;
      await beginAuth(server.name, server.config.url, server.config.oauthScopes);
      return;
    }
    if (option.id === "reconnect") {
      setBusy(`Reconnecting to ${server.name}`);
      await dropClient(server.name, server.config);
      const inspection = await resolveInspection(server.name, server.config, server.enabled, false);
      setState((prev) => ({
        ...prev,
        rows: prev.rows.map((row) => (row.name === server.name ? { ...row, inspection } : row)),
      }));
      setBusy(null);
      return;
    }
    setBusy(`${server.enabled ? "Disabling" : "Enabling"} ${server.name}`);
    await dropClient(server.name, server.config);
    await (server.enabled
      ? disableMcpServer(process.cwd(), server.name)
      : enableMcpServer(process.cwd(), server.name));
    setView("list");
    setMenuIndex(0);
    setBusy(null);
    setReloadKey((key) => key + 1);
  }

  if (view === "server" && selectedServer) {
    return (
      <ServerDetailView
        server={selectedServer}
        options={menuOptions}
        selected={menuIndex}
        busy={busy}
        onCancel={() => setView("list")}
      />
    );
  }

  if (view === "tools" && selectedServer) {
    return (
      <ToolsView server={selectedServer} selected={toolIndex} onCancel={() => setView("server")} />
    );
  }

  if (view === "tool" && selectedServer && selectedTool) {
    return (
      <ToolDetailView
        server={selectedServer}
        tool={selectedTool}
        onCancel={() => setView("tools")}
      />
    );
  }

  if (view === "auth" && auth) {
    return <AuthView auth={auth} onCancel={cancelAuth} />;
  }

  return (
    <FooterPanel
      command="/mcp"
      flushTop
      onCancel={close}
      footerHints={[
        ["↑↓", "navigate"],
        ["Enter", "confirm"],
        ["Esc", "cancel"],
      ]}
    >
      <Box flexDirection="column">
        <Text color={Color.text} bold>
          Manage MCP servers
        </Text>
        <Text color={Color.muted}>{formatCount(rows.length, "server")}</Text>
        <Box flexDirection="column" marginTop={1}>
          <McpServerList state={state} groups={groups} rows={rows} serverIndex={serverIndex} />
        </Box>
        {!state.loading && rows.some((row) => row.inspection.status === "failed") && (
          <Box marginTop={1}>
            <Text color={Color.muted}>※ Run otherside --debug to see error logs</Text>
          </Box>
        )}
      </Box>
    </FooterPanel>
  );
}

function AuthView({
  auth,
  onCancel,
}: {
  auth: AuthState;
  onCancel?: () => void;
}): React.JSX.Element {
  const footerHints: [string, string][] =
    auth.status === "running"
      ? [
          ["Enter", "submit pasted code"],
          ["Esc", "cancel"],
        ]
      : [
          ["Enter", "back"],
          ["Esc", "back"],
        ];
  return (
    <FooterPanel command="/mcp" flushTop onCancel={onCancel} footerHints={footerHints}>
      <Box flexDirection="column">
        <Text color={Color.textStrong} bold>
          Authenticate {capitalize(auth.serverName)}
        </Text>
        <Text color={Color.muted}>{auth.serverName}</Text>
        {auth.status === "running" ? (
          <>
            {auth.url.length > 0 && (
              <>
                <Box marginTop={1}>
                  <Text color={Color.muted}>If the browser didn't open, visit:</Text>
                </Box>
                <TerminalLink url={auth.url} />
                <Box marginTop={1}>
                  <Text color={Color.muted}>Or paste the URL/code from the redirect page:</Text>
                </Box>
                <Box>
                  <Text color={Color.muted}>{Glyph.chevron}</Text>
                  <Text color={Color.text}>{`${auth.pasted}${Glyph.blockHalf}`}</Text>
                </Box>
              </>
            )}
            <Box marginTop={1}>
              <Text color={authStatusColor(auth.status)}>{auth.message}</Text>
            </Box>
          </>
        ) : (
          <Box marginTop={1}>
            <Text color={authStatusColor(auth.status)}>{auth.message}</Text>
          </Box>
        )}
      </Box>
    </FooterPanel>
  );
}

function authStatusColor(status: AuthStatus): InkColor {
  if (status === "ok") return Color.success;
  if (status === "fail") return Color.error;
  return Color.highlight;
}

function McpServerListRow({
  row,
  selected,
}: {
  row: McpServerRow;
  selected: boolean;
}): React.JSX.Element {
  return (
    <Box>
      <Text color={selected ? Color.highlight : Color.muted}>
        {selected ? Glyph.chevron : "  "}
      </Text>
      <Text color={selected ? Color.highlight : Color.text}>{row.name}</Text>
      <Text color={Color.muted}> · </Text>
      <Text color={Color.muted}>{row.config.type}</Text>
      <Text color={Color.muted}> · </Text>
      <Text color={statusColor(row.inspection.status)}>{row.inspection.statusText}</Text>
    </Box>
  );
}
