const WORKFLOW_PREVIEW_MAX_CHARS = 400;
const AGENT_LABEL_MAX_WORDS = 6;
const AGENT_LABEL_MAX_CHARS = 48;

function safeJsonPreview(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function truncateWorkflowPreview(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const raw = typeof value === "string" ? value : safeJsonPreview(value);
  const text = raw.trim();
  if (text.length === 0) return undefined;
  return text.length > WORKFLOW_PREVIEW_MAX_CHARS
    ? `${text.slice(0, WORKFLOW_PREVIEW_MAX_CHARS)}…`
    : text;
}

export function deriveAgentLabel(prompt: string, phase: string | undefined, index: number): string {
  const firstLine = prompt
    .split("\n")
    .map((line) => line.replace(/^[\s#>*`-]+/, "").trim())
    .find((line) => line.length > 0);
  if (firstLine !== undefined && firstLine.length > 0) {
    const snippet = firstLine.split(/\s+/).slice(0, AGENT_LABEL_MAX_WORDS).join(" ");
    return snippet.length > AGENT_LABEL_MAX_CHARS
      ? `${snippet.slice(0, AGENT_LABEL_MAX_CHARS - 1)}…`
      : snippet;
  }
  if (phase !== undefined && phase.length > 0) return `${phase} ${index}`;
  return `agent:${index}`;
}
