import { relative } from "node:path";
import { useEffect, useMemo, useRef, useState } from "react";
import { fireNotificationHook } from "@/engine/queue/emit.ts";
import { getDestructiveCommandWarning } from "@/engine/tools/index.ts";
import { userFacingToolName } from "@/engine/tools/tool-label.ts";
import { Box, Text } from "@/ink";
import {
  answer,
  type PendingPermission,
  type PermissionResult,
  PermissionResults,
  type PermissionSource,
} from "@/kernel/channels/permission.ts";
import type { NotificationCtx } from "@/kernel/hooks/events.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import { readPermissionQueueSlice, useAppSelect } from "@/store/index.ts";
import { FooterPanel } from "@/ui/chrome/panel.tsx";
import { usePanelNavigation } from "@/ui/hooks/use-panel-navigation.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";
import { Markdown } from "@/ui/transcript/markdown/index.tsx";

/** Reference idle threshold (`DEFAULT_INTERACTION_THRESHOLD_MS` = 6s). */
export const PERMISSION_PROMPT_IDLE_MS = 6000;

export function permissionPromptNotificationMessage(
  pending: Pick<PendingPermission, "toolName">,
): string {
  if (pending.toolName === "ExitPlanMode") {
    return "Otherside needs your approval for the plan";
  }
  const toolName = userFacingToolName(pending.toolName);
  if (!toolName || toolName.trim() === "") {
    return "Otherside needs your attention";
  }
  return `Otherside needs your permission to use ${toolName}`;
}

/** Arm an idle-permission Notification hook that can be reset by user interaction. */
export function armPermissionPromptNotification(
  pending: Pick<PendingPermission, "toolName">,
  fire: (ctx: NotificationCtx) => void = fireNotificationHook,
  timeoutMs: number = PERMISSION_PROMPT_IDLE_MS,
): { cancel: () => void; markInteraction: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  let notified = false;

  const arm = (): void => {
    if (cancelled || notified) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (cancelled) return;
      notified = true;
      fire({
        hook_event_name: "Notification",
        message: permissionPromptNotificationMessage(pending),
        notification_type: "permission_prompt",
      });
    }, timeoutMs);
  };

  arm();
  return {
    cancel: () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    markInteraction: arm,
  };
}

type OptionKind =
  | "allow"
  | "allow_session"
  | "allow_session_tool"
  | "allow_session_edits"
  | "allow_always"
  | "deny"
  | "plan_bypass"
  | "plan_accept_edits"
  | "plan_default"
  | "plan_feedback";

interface OptionRow {
  key: string;
  label: string;
  kind: OptionKind;
}

// A bypass-latched session can return directly to yolo. Otherwise the first
// option presents the reference's auto-mode wording while mapping to the
// accept-edits equivalent. Manual approval always switches to default.
export function planOptionsFor(bypassAvailable: boolean): OptionRow[] {
  return [
    bypassAvailable
      ? { key: "1", label: "Yes, and bypass permissions", kind: "plan_bypass" }
      : { key: "1", label: "Yes, and use auto mode", kind: "plan_accept_edits" },
    { key: "2", label: "Yes, manually approve edits", kind: "plan_default" },
    { key: "3", label: "Tell Otherside what to change", kind: "plan_feedback" },
  ];
}

// Feedback typed in amend mode rides whichever decision the user confirms —
// the channel carries it; resolution decides how it reaches the model.
function withFeedback(result: PermissionResult, feedback?: string): PermissionResult {
  const trimmed = feedback?.trim();
  return trimmed && trimmed.length > 0 ? { ...result, feedback: trimmed } : result;
}

function resultFor(
  kind: OptionKind,
  rule: string | null,
  toolName: string,
  feedback?: string,
  editDirectory?: string | null,
  suggestions?: PendingPermission["suggestions"],
): PermissionResult {
  if (kind === "allow") return PermissionResults.allow(feedback);
  if (kind === "deny") return PermissionResults.deny(feedback);
  if (kind === "allow_session" && rule)
    return withFeedback(PermissionResults.allowSession(rule, suggestions), feedback);
  if (kind === "allow_session_tool" && toolName)
    return withFeedback(PermissionResults.allowSession(toolName), feedback);
  if (kind === "allow_session_edits")
    return withFeedback(PermissionResults.allowSessionEdits(editDirectory), feedback);
  if (kind === "allow_always" && rule)
    return withFeedback(PermissionResults.allowAlways(rule), feedback);
  if (kind === "allow_always") return PermissionResults.allow(feedback);
  if (kind === "plan_bypass") return PermissionResults.setMode("yolo");
  if (kind === "plan_accept_edits") return PermissionResults.setMode("accept-edits");
  if (kind === "plan_default") return PermissionResults.setMode("default");
  return PermissionResults.planFeedback(feedback ?? "");
}

// Suggested rules arrive as `Bash(git reset *)`; older session grants may use
// the `Bash:content` form. Extract the inner pattern from either.
function bashRuleContentOf(rule: string): string {
  const openIdx = rule.indexOf("(");
  const closeIdx = rule.lastIndexOf(")");
  if (openIdx >= 0 && closeIdx > openIdx) return rule.slice(openIdx + 1, closeIdx).trim();
  const colonIdx = rule.indexOf(":");
  return colonIdx >= 0 ? rule.slice(colonIdx + 1).trim() : "";
}

export function PermissionOverlay(): React.JSX.Element | null {
  const pending = useAppSelect((s) => readPermissionQueueSlice(s.engine)?.[0] ?? null);
  const [cursor, setCursor] = useState(0);
  const [feedbackDraft, setFeedbackDraft] = useState("");
  const [amendMode, setAmendMode] = useState(false);
  const [amendDraft, setAmendDraft] = useState("");
  const [prefixDraft, setPrefixDraft] = useState<string | null>(null);
  const permissionNotificationRef = useRef<ReturnType<
    typeof armPermissionPromptNotification
  > | null>(null);

  useEffect(() => {
    setCursor(0);
    setFeedbackDraft("");
    setAmendMode(false);
    setAmendDraft("");
    setPrefixDraft(null);
  }, [pending?.id]);

  // Fire only after a full idle window. Any interaction with the prompt
  // re-arms the timer; deciding or unmounting cancels it.
  useEffect(() => {
    if (!pending) return;
    const notification = armPermissionPromptNotification(pending);
    permissionNotificationRef.current = notification;
    return () => {
      notification.cancel();
      if (permissionNotificationRef.current === notification) {
        permissionNotificationRef.current = null;
      }
    };
  }, [pending?.id, pending?.toolName]);

  const isPlan = pending?.toolName === "ExitPlanMode";
  const isDesign = pending?.source?.name === "design";
  // The Bash "don't ask again" rule prefix is editable while its row is
  // focused; an emptied draft falls back to the suggested rule on submit.
  const bashPrefixEditable =
    !isPlan && !isDesign && pending?.toolName === "Bash" && pending?.rule !== null;
  const bashRuleContent =
    bashPrefixEditable && pending?.rule ? bashRuleContentOf(pending.rule) : null;
  const prefixValue = prefixDraft ?? bashRuleContent ?? "";
  const submitRule =
    bashPrefixEditable && prefixDraft !== null && prefixDraft.trim().length > 0
      ? `Bash(${prefixDraft.trim()})`
      : (pending?.rule ?? null);
  const genericOptions = buildGenericOptions(
    pending?.rule ?? null,
    isDesign,
    pending?.toolName ?? "",
    pending?.readOnly ?? false,
  );
  const options = isPlan ? planOptionsFor(pending?.bypassAvailable ?? false) : genericOptions;
  const planFeedbackFocused = isPlan && options[cursor]?.kind === "plan_feedback";
  // The prefix row is an input whenever focused — amend mode only re-targets
  // typing on the Yes/No rows, never on the rule row itself.
  const prefixFocused = bashPrefixEditable && options[cursor]?.kind === "allow_always";

  function ruleForKind(kind: OptionKind): string | null {
    return kind === "allow_always" ? submitRule : (pending?.rule ?? null);
  }

  function dismiss(): void {
    if (!pending) return;
    if (amendMode) {
      setAmendMode(false);
      setAmendDraft("");
      return;
    }
    if (planFeedbackFocused) {
      setCursor(0);
      setFeedbackDraft("");
      return;
    }
    if (isPlan) {
      answer(pending.id, PermissionResults.planFeedback(""));
    } else {
      answer(pending.id, PermissionResults.deny());
    }
  }

  function activate(): void {
    if (!pending) return;
    if (planFeedbackFocused) {
      answer(pending.id, PermissionResults.planFeedback(feedbackDraft));
      return;
    }
    const choice = options[cursor];
    if (choice) {
      answer(
        pending.id,
        resultFor(
          choice.kind,
          ruleForKind(choice.kind),
          pending.toolName,
          amendDraft,
          pending.editDirectory,
          pending.suggestions,
        ),
      );
    }
  }

  function handleKey(input: string, key: { ctrl?: boolean; meta?: boolean }): boolean {
    if (!pending) return false;
    if (prefixFocused) {
      // While the editable prefix row is focused, printable input edits the
      // rule instead of quick-selecting — arrows + Enter still navigate/confirm.
      if (input && !key.ctrl && !key.meta) {
        setPrefixDraft((d) => (d ?? bashRuleContent ?? "") + input);
        return true;
      }
      return false;
    }
    if (amendMode) {
      if (input && !key.ctrl && !key.meta) {
        setAmendDraft((d) => d + input);
        return true;
      }
      return false;
    }
    if (planFeedbackFocused) {
      if (input && !key.ctrl && !key.meta) {
        setFeedbackDraft((d) => d + input);
        return true;
      }
      return false;
    }
    const direct = options.find((o) => o.key === input);
    if (!direct) return false;
    if (direct.kind === "plan_feedback") {
      const nextIdx = options.findIndex((o) => o.kind === "plan_feedback");
      setCursor(nextIdx >= 0 ? nextIdx : cursor);
      return true;
    }
    answer(
      pending.id,
      resultFor(
        direct.kind,
        ruleForKind(direct.kind),
        pending.toolName,
        amendDraft,
        pending.editDirectory,
        pending.suggestions,
      ),
    );
    return true;
  }

  usePanelNavigation({
    isActive: !!pending,
    layer: "permission",
    onClose: dismiss,
    onActivate: activate,
    rows: { count: options.length, selected: cursor, onChange: setCursor },
    onKey: (input, key) => {
      permissionNotificationRef.current?.markInteraction();
      if (key.tab && !isPlan && !isDesign) {
        setAmendMode((m) => !m);
        return true;
      }
      if (prefixFocused && (key.backspace || key.delete)) {
        setPrefixDraft((d) => (d ?? bashRuleContent ?? "").slice(0, -1));
        return true;
      }
      if (amendMode && (key.backspace || key.delete)) {
        setAmendDraft((d) => d.slice(0, -1));
        return true;
      }
      if (planFeedbackFocused && (key.backspace || key.delete)) {
        setFeedbackDraft((d) => d.slice(0, -1));
        return true;
      }
      return handleKey(input, key);
    },
  });

  if (!pending) return null;
  if (isPlan)
    return (
      <PlanPanel
        pending={pending}
        cursor={cursor}
        options={options}
        feedbackDraft={feedbackDraft}
        feedbackFocused={planFeedbackFocused}
      />
    );
  return (
    <GenericPanel
      pending={pending}
      cursor={cursor}
      options={options}
      amendMode={amendMode}
      amendDraft={amendDraft}
      prefix={bashPrefixEditable ? { value: prefixValue, focused: prefixFocused } : null}
    />
  );
}

function ruleDisplay(rule: string): string {
  const colonIdx = rule.indexOf(":");
  if (colonIdx < 0) return rule;
  const tool = rule.slice(0, colonIdx);
  const content = rule.slice(colonIdx + 1).trim();
  if (content.length === 0) return tool;
  const compact = content.length > 48 ? `${content.slice(0, 48)}…` : content;
  return `${tool}(${compact})`;
}

export function buildGenericOptions(
  rule: string | null,
  isDesign = false,
  toolName = "",
  readOnly = false,
): OptionRow[] {
  if (isDesign) {
    const opts: OptionRow[] = [{ key: "1", label: "Allow once (this turn)", kind: "allow" }];
    if (rule) {
      opts.push({
        key: "2",
        label: "Allow for this design session",
        kind: "allow_session",
      });
      if (readOnly) {
        opts.push({
          key: String(opts.length + 1),
          label: `Allow all ${userFacingToolName(toolName)} for this design session`,
          kind: "allow_session_tool",
        });
      }
      opts.push({
        key: String(opts.length + 1),
        label: `Always allow (persist for ${ruleDisplay(rule)})`,
        kind: "allow_always",
      });
      opts.push({ key: String(opts.length + 1), label: "Deny", kind: "deny" });
    } else {
      opts.push({ key: "2", label: "Deny", kind: "deny" });
    }
    return opts;
  }

  const opts: OptionRow[] = [{ key: "1", label: "Yes", kind: "allow" }];
  if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(toolName)) {
    opts.push({
      key: "2",
      label: "Yes, allow all edits during this session",
      kind: "allow_session_edits",
    });
    opts.push({ key: "3", label: "No", kind: "deny" });
    return opts;
  }
  if (readOnly && rule) {
    opts.push({
      key: String(opts.length + 1),
      label: "Yes, during this session",
      kind: "allow_session",
    });
  }
  if (rule) {
    opts.push({
      key: String(opts.length + 1),
      label: `Yes, and don't ask again for ${ruleDisplay(rule)} in this project`,
      kind: "allow_always",
    });
  }
  opts.push({ key: String(opts.length + 1), label: "No", kind: "deny" });
  return opts;
}

interface ToolPresentation {
  title: string;
  question: string;
  body: React.ReactNode;
  warning: string | null;
}

function inputRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function inputString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value : "";
}

function displayPath(file: string): string {
  if (file.length === 0) return file;
  try {
    const rel = relative(process.cwd(), file);
    // A path that escapes the cwd relativizes to a "../"-heavy string; show the
    // original in that case rather than a confusing climb.
    return rel.length > 0 && !rel.startsWith("..") ? rel : file;
  } catch {
    return file;
  }
}

// Per-tool title, question, body, and (Bash only) destructive warning — the
// generic "Tool use" panel gains the shape of the specific tool being confirmed.
function toolPresentation(pending: PendingPermission): ToolPresentation {
  const input = inputRecord(pending.input);
  const tool = pending.toolName;
  const display = userFacingToolName(tool);
  const signature = (
    <Text color={Color.text}>
      {display}
      {pending.argsPreview ? `(${pending.argsPreview})` : ""}
    </Text>
  );

  switch (tool) {
    case "Bash": {
      const command = inputString(input, "command");
      const description = inputString(input, "description");
      return {
        title: "Bash command",
        question: "Do you want to proceed?",
        warning: command.length > 0 ? getDestructiveCommandWarning(command) : null,
        body: (
          <Box flexDirection="column">
            <Text color={Color.text}>{command.length > 0 ? command : signature}</Text>
            {description.length > 0 ? <Text color={Color.muted}>{description}</Text> : null}
          </Box>
        ),
      };
    }
    case "Edit":
    case "MultiEdit": {
      const file = displayPath(inputString(input, "file_path"));
      return {
        title: "Edit file",
        question:
          file.length > 0 ? `Do you want to make this edit to ${file}?` : "Do you want to proceed?",
        warning: null,
        body: file.length > 0 ? <Text color={Color.text}>{file}</Text> : signature,
      };
    }
    case "Write": {
      const file = displayPath(inputString(input, "file_path"));
      return {
        title: "Write file",
        question: file.length > 0 ? `Do you want to write ${file}?` : "Do you want to proceed?",
        warning: null,
        body: file.length > 0 ? <Text color={Color.text}>{file}</Text> : signature,
      };
    }
    case "Read": {
      const file = displayPath(inputString(input, "file_path"));
      return {
        title: "Read file",
        question: "Do you want to proceed?",
        warning: null,
        body: file.length > 0 ? <Text color={Color.text}>{file}</Text> : signature,
      };
    }
    case "WebFetch": {
      const url = inputString(input, "url");
      const prompt = inputString(input, "prompt");
      return {
        title: "Fetch",
        question: "Do you want to allow Otherside to fetch this content?",
        warning: null,
        body: (
          <Box flexDirection="column">
            <Text color={Color.text}>{url.length > 0 ? url : signature}</Text>
            {prompt.length > 0 ? <Text color={Color.muted}>{prompt}</Text> : null}
          </Box>
        ),
      };
    }
    default:
      return {
        title: "Tool use",
        question: "Do you want to proceed?",
        warning: null,
        body: signature,
      };
  }
}

function subagentAttribution(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? `from the ${truncateEllipsis(trimmed, 24)} agent` : "from a subagent";
}

// The origin badge rides the title line (dim `· ` + attribution), matching the
// per-tool title layout rather than a separate body row.
function PermissionTitle({
  title,
  source,
}: {
  title: string;
  source: PermissionSource | undefined;
}): React.JSX.Element {
  const attribution = source ? subagentAttribution(source.name) : null;
  return (
    <Box flexDirection="row" gap={1}>
      <Text bold color={Color.primaryGlow}>
        {title}
      </Text>
      {attribution !== null && (
        <Text>
          <Text dim>{"· "}</Text>
          {attribution}
        </Text>
      )}
    </Box>
  );
}

const PREFIX_PLACEHOLDER = "command prefix (e.g., npm run *)";

interface PrefixEdit {
  value: string;
  focused: boolean;
}

function amendPlaceholderFor(kind: OptionKind | undefined): string {
  return kind === "deny"
    ? "and tell Otherside what to do differently"
    : "and tell Otherside what to do next";
}

function GenericPanel({
  pending,
  cursor,
  options,
  amendMode,
  amendDraft,
  prefix,
}: {
  pending: PendingPermission;
  cursor: number;
  options: OptionRow[];
  amendMode: boolean;
  amendDraft: string;
  prefix: PrefixEdit | null;
}): React.JSX.Element {
  const display = userFacingToolName(pending.toolName);
  const quickRange = options.length === 2 ? "1-2" : `1-${options.length}`;
  const isDesign = pending.source?.name === "design";
  const presentation = useMemo(() => toolPresentation(pending), [pending]);
  const title = isDesign
    ? `Allow ${display} for this design session?`
    : ((<PermissionTitle title={presentation.title} source={pending.source} />) as React.ReactNode);
  const footerHints: [string, string][] = amendMode
    ? [
        ["type", "feedback"],
        ["Enter", "confirm"],
        ["Esc", "back"],
        ["↑↓", "select"],
      ]
    : [
        ["↑↓", "select"],
        ["Enter", "confirm"],
        ["Esc", "cancel"],
        [quickRange, "quick"],
        ...(isDesign ? [] : ([["Tab", "amend"]] as [string, string][])),
      ];
  return (
    <FooterPanel title={title} accent={Color.primaryGlow} footerHints={footerHints}>
      <Box flexDirection="column" marginBottom={1}>
        {isDesign ? (
          <Text color={Color.text}>
            {display}
            {pending.argsPreview ? `(${pending.argsPreview})` : ""}
          </Text>
        ) : (
          presentation.body
        )}
      </Box>
      {!isDesign && presentation.warning !== null && (
        <Box marginBottom={1}>
          <Text color={Color.warning}>
            {Glyph.warning} {presentation.warning}
          </Text>
        </Box>
      )}
      {!isDesign && (
        <Box marginBottom={1}>
          <Text color={Color.text}>{presentation.question}</Text>
        </Box>
      )}
      <Box flexDirection="column">
        {options.map((opt, i) => {
          const selected = i === cursor;
          const rowColor = selected ? Color.primaryGlow : Color.muted;
          if (opt.kind === "allow_always" && prefix !== null) {
            return (
              <Box key={opt.kind}>
                <Text color={rowColor}>
                  {selected ? Glyph.chevron : "  "}
                  {opt.key}. Yes, and don't ask again for:{" "}
                </Text>
                {prefix.value.length > 0 ? (
                  <Text color={selected ? Color.text : Color.muted}>{prefix.value}</Text>
                ) : (
                  <Text color={Color.muted}>{PREFIX_PLACEHOLDER}</Text>
                )}
                {prefix.focused && <Text color={Color.muted}>{Glyph.blockThreeEighths}</Text>}
              </Box>
            );
          }
          // Amend mode turns the focused Yes/No row into an inline feedback input; the typed text rides the row itself.
          const amendHere = amendMode && selected && (opt.kind === "allow" || opt.kind === "deny");
          if (amendHere) {
            return (
              <Box key={opt.kind}>
                <Text color={rowColor}>
                  {Glyph.chevron}
                  {opt.key}. {opt.label},{" "}
                </Text>
                {amendDraft.length > 0 ? (
                  <Text color={Color.text}>{amendDraft}</Text>
                ) : (
                  <Text color={Color.muted}>{amendPlaceholderFor(opt.kind)}</Text>
                )}
                <Text color={Color.muted}>{Glyph.blockThreeEighths}</Text>
              </Box>
            );
          }
          return (
            <Box key={opt.kind}>
              <Text color={rowColor}>
                {selected ? Glyph.chevron : "  "}
                {opt.key}. {opt.label}
              </Text>
            </Box>
          );
        })}
      </Box>
    </FooterPanel>
  );
}

function PlanPanel({
  pending,
  cursor,
  options,
  feedbackDraft,
  feedbackFocused,
}: {
  pending: PendingPermission;
  cursor: number;
  options: OptionRow[];
  feedbackDraft: string;
  feedbackFocused: boolean;
}): React.JSX.Element {
  const planText = extractPlan(pending.input);
  return (
    <FooterPanel
      title="Ready to code?"
      accent={Color.modePlan}
      footerHints={planFooterHints(feedbackFocused)}
    >
      <Box marginBottom={1}>
        <Text color={Color.muted}>Here is the plan:</Text>
      </Box>
      {!!planText && (
        <Box
          flexDirection="column"
          marginBottom={1}
          borderStyle="single"
          borderColor={Color.muted}
          paddingX={1}
        >
          <Markdown source={planText} />
        </Box>
      )}
      <Box marginBottom={1}>
        <Text color={Color.text}>
          Otherside has written up a plan and is ready to execute. Would you like to proceed?
        </Text>
      </Box>
      <Box flexDirection="column">
        {options.map((opt, i) => {
          const selected = i === cursor;
          const isFeedback = opt.kind === "plan_feedback";
          return (
            <Box key={opt.kind} flexDirection="column">
              <Box>
                <Text color={selected ? Color.modePlan : Color.muted}>
                  {selected ? Glyph.chevron : "  "}
                  {opt.key}. {opt.label}
                </Text>
              </Box>
              {selected && isFeedback && (
                <Box paddingLeft={3}>
                  <Text color={Color.muted}>{Glyph.chevron}</Text>
                  <Text color={Color.text}>{feedbackDraft.length > 0 ? feedbackDraft : ""}</Text>
                  <Text color={Color.muted}>
                    {feedbackDraft.length === 0 ? "Tell agent what to change" : ""}
                    {Glyph.blockThreeEighths}
                  </Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
    </FooterPanel>
  );
}

function planFooterHints(feedbackFocused: boolean): [string, string][] {
  if (feedbackFocused) {
    return [
      ["type", "feedback"],
      ["Enter", "submit"],
      ["Esc", "clear"],
      ["↑↓", "change option"],
    ];
  }
  return [
    ["↑↓", "select"],
    ["Enter", "confirm"],
    ["Esc", "cancel"],
    ["1-3", "quick"],
  ];
}

function extractPlan(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const v = (input as Record<string, unknown>).plan;
  return typeof v === "string" && v.length > 0 ? v : null;
}
