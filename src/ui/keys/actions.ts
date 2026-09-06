/**
 * Every action a key can perform, named for what our surfaces actually do.
 *
 * An id reads `namespace:verb`. The namespace is the vocabulary the action
 * belongs to, not the panel that happens to host it — `select:next` is the same
 * fact whether a plugin list or a workflow list answers it, which is exactly why
 * a table can replace the switch each panel keeps today.
 */

/** The generic vocabularies, shared by every surface that adopts them. */
const SHARED_ACTIONS = [
  // The list vocabulary every panel list answers to.
  "select:next",
  "select:previous",
  "select:pageDown",
  "select:pageUp",
  "select:first",
  "select:last",
  "select:jumpToRow",
  // The search box a panel opens over its list.
  "search:focus",
  "search:clearOrExit",
  "search:toList",
  "search:toHeader",
  "search:caretPrevious",
  "search:caretNext",
  "search:caretStart",
  "search:caretEnd",
  "search:deletePrevious",
  "search:deleteNext",
  // The tab header above a panel body.
  "tabs:next",
  "tabs:previous",
  // What every panel does regardless of what it lists.
  "panel:close",
  "panel:back",
  "panel:forward",
  "panel:confirm",
  "panel:toggle",
] as const;

/** Session-wide actions, reachable from the prompt and most panels. */
const APP_ACTIONS = [
  "app:interrupt",
  "app:suspend",
  "app:backgroundTool",
  "app:cyclePermissionMode",
  "app:toggleTaskList",
  "app:toggleTranscript",
  "app:redraw",
] as const;

/** The prompt buffer: what it submits, opens, and remembers. */
const PROMPT_ACTIONS = [
  "prompt:submit",
  "prompt:newline",
  "prompt:clear",
  "prompt:armClear",
  "prompt:undo",
  "prompt:stash",
  "prompt:externalEditor",
  "prompt:pasteImage",
  "prompt:openHistorySearch",
  "prompt:historyPrevious",
  "prompt:historyNext",
  "prompt:exitBashMode",
  "prompt:openModelPicker",
  "prompt:toggleKeyword",
] as const;

/** Readline editing inside any text field, prompt or panel. */
const EDIT_ACTIONS = [
  "edit:deletePreviousChar",
  "edit:deleteNextChar",
  "edit:deleteNextWord",
  "edit:killPreviousWord",
  "edit:killToLineStart",
  "edit:killToLineEnd",
  "edit:yank",
  "edit:yankPop",
  "edit:moveLineStart",
  "edit:moveLineEnd",
  "edit:movePreviousChar",
  "edit:moveNextChar",
] as const;

/** The reverse-incremental history search opened from the prompt. */
const HISTORY_SEARCH_ACTIONS = [
  "historySearch:next",
  "historySearch:accept",
  "historySearch:cancel",
  "historySearch:abandon",
  "historySearch:deletePrevious",
] as const;

/** The slash-command and mention menus that open over the prompt. */
const AUTOCOMPLETE_ACTIONS = [
  "autocomplete:complete",
  "autocomplete:accept",
  "autocomplete:dismiss",
] as const;

/** The running-agents strip below the prompt. */
const STRIP_ACTIONS = [
  "strip:next",
  "strip:previous",
  "strip:open",
  "strip:stopOrClose",
  "strip:blur",
] as const;

/** The full-screen reader over already-rendered transcript rows. */
const TRANSCRIPT_ACTIONS = [
  "transcript:scrollUp",
  "transcript:scrollDown",
  "transcript:halfPageUp",
  "transcript:halfPageDown",
  "transcript:pageUp",
  "transcript:pageDown",
  "transcript:top",
  "transcript:bottom",
  "transcript:openSearch",
  "transcript:nextMatch",
  "transcript:previousMatch",
  "transcript:toggleAll",
  "transcript:exit",
] as const;

/** The question dialog and the permission prompt. */
const DIALOG_ACTIONS = [
  "ask:nextQuestion",
  "ask:previousQuestion",
  "ask:toggleOption",
  "ask:selectByNumber",
  "confirm:toggleExplanation",
] as const;

/** Actions a single panel owns, because only that panel can perform them. */
const PANEL_ACTIONS = [
  "diff:refresh",
  "diff:pageUp",
  "diff:pageDown",
  "diff:top",
  "diff:bottom",
  "workflow:stop",
  "workflow:pause",
  "workflow:save",
  "workflow:restart",
  "task:foreground",
  "task:stop",
  "plugin:favorite",
  "skill:toggle",
  "remote:refresh",
  "remote:unpair",
  "usage:refresh",
  "error:toggleDetail",
  "config:reset",
  "config:stepValue",
] as const;

const KEY_ACTIONS = [
  ...SHARED_ACTIONS,
  ...APP_ACTIONS,
  ...PROMPT_ACTIONS,
  ...EDIT_ACTIONS,
  ...HISTORY_SEARCH_ACTIONS,
  ...AUTOCOMPLETE_ACTIONS,
  ...STRIP_ACTIONS,
  ...TRANSCRIPT_ACTIONS,
  ...DIALOG_ACTIONS,
  ...PANEL_ACTIONS,
] as const;

export type KeyAction = (typeof KEY_ACTIONS)[number];

const KEY_ACTION_SET: ReadonlySet<string> = new Set(KEY_ACTIONS);

export function isKeyAction(value: string): value is KeyAction {
  return KEY_ACTION_SET.has(value);
}

/**
 * Where a key is being pressed. Contexts stack innermost-first, so a search box
 * open over a list answers before the list does, and the list answers before the
 * session-wide keys.
 *
 * A surface earns a context only when it binds something the shared vocabularies
 * do not already cover; a panel that just lists and dismisses composes `select`
 * and `panel` instead of naming itself here.
 */
const KEY_CONTEXTS = [
  "app",
  "turn",
  "prompt",
  "edit",
  "historySearch",
  "autocomplete",
  "strip",
  "transcript",
  "transcriptSearch",
  "select",
  "search",
  "tabs",
  "panel",
  "ask",
  "confirm",
  "diff",
  "workflows",
  "backgroundTasks",
  "plugins",
  "skills",
  "remote",
  "usage",
  "errorReport",
  "config",
] as const;

export type KeyContext = (typeof KEY_CONTEXTS)[number];

const KEY_CONTEXT_SET: ReadonlySet<string> = new Set(KEY_CONTEXTS);

export function isKeyContext(value: string): value is KeyContext {
  return KEY_CONTEXT_SET.has(value);
}
