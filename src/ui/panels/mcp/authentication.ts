import { startOAuthFlow } from "@/kernel/mcp/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import { isInsertable } from "@/ui/chrome/key-input.ts";
import { publishPanelTranscriptLine } from "@/ui/panels/transcript-feedback.ts";

export type McpAuthStatus = "running" | "ok" | "fail";

export interface McpAuthState {
  serverName: string;
  url: string;
  status: McpAuthStatus;
  message: string;
  pasted: string;
  urlCopied?: boolean;
}

export function handleMcpAuthKey(input: {
  key: KeyEventData;
  auth: McpAuthState | null;
  submit: ((input: string) => void) | null;
  setAuth: (auth: McpAuthState) => void;
  cancel: () => void;
}): void {
  const { key, auth, submit, setAuth, cancel } = input;
  if (!auth) return;

  if (auth.status !== "running") {
    if (key.name === "return" || key.name === "left") cancel();
    return;
  }

  if (key.name === "left") {
    cancel();
    return;
  }
  if (key.name === "return") {
    const code = auth.pasted.trim();
    if (code.length === 0) return;
    submit?.(code);
    setAuth({
      ...auth,
      pasted: "",
      message: `Verifying code for ${auth.serverName}…`,
    });
    return;
  }
  if (key.name === "backspace" || key.name === "delete") {
    setAuth({ ...auth, pasted: auth.pasted.slice(0, -1) });
    return;
  }
  const sequence = key.sequence;
  if (!key.ctrl && !key.meta && sequence !== undefined && isInsertable(sequence)) {
    setAuth({ ...auth, pasted: auth.pasted + sequence });
  }
}

export async function startMcpAuthentication(input: {
  serverName: string;
  baseUrl: string;
  scope: string | undefined;
  controller: AbortController;
  sequence: number;
  isCurrent: (sequence: number) => boolean;
  setSubmit: (submit: ((input: string) => void) | null) => void;
  setAuth: (auth: McpAuthState) => void;
  requestRender: () => void;
  reload: () => void;
}): Promise<void> {
  const {
    serverName,
    baseUrl,
    scope,
    controller,
    sequence,
    isCurrent,
    setSubmit,
    setAuth,
    requestRender,
    reload,
  } = input;
  try {
    const flow = await startOAuthFlow({
      serverName,
      baseUrl,
      abortSignal: controller.signal,
      ...(scope ? { scope } : {}),
    });
    if (!isCurrent(sequence)) return;
    setSubmit(flow.submitCode);
    setAuth({
      serverName,
      url: flow.authUrl,
      status: "running",
      message: "Browser opened — waiting for authorization…",
      pasted: "",
    });
    requestRender();

    void flow.done.then((outcome) => {
      if (!isCurrent(sequence)) return;
      if (outcome.kind === "saved") {
        setAuth({
          serverName,
          url: flow.authUrl,
          status: "ok",
          message: `Authorized ${serverName}.`,
          pasted: "",
        });
        publishPanelTranscriptLine("/mcp", `MCP "${serverName}" authorized`);
        reload();
        requestRender();
        return;
      }
      setAuth({
        serverName,
        url: flow.authUrl,
        status: "fail",
        message: outcome.reason,
        pasted: "",
      });
      publishPanelTranscriptLine(
        "/mcp",
        `MCP "${serverName}" auth failed: ${outcome.reason}`,
        true,
      );
      requestRender();
    });
  } catch (error) {
    if (!isCurrent(sequence)) return;
    const message = error instanceof Error ? error.message : String(error);
    setAuth({ serverName, url: "", status: "fail", message, pasted: "" });
    publishPanelTranscriptLine("/mcp", `MCP "${serverName}" auth error: ${message}`, true);
    requestRender();
  }
}
