import type { BindingTable, ContextBindings } from "@/ui/keys/types.ts";

/**
 * What every key does today, read off the surfaces that own them.
 *
 * A context maps a normalized chord to one action. Several chords may reach the
 * same action — that is an alias, not a conflict — but one chord never carries
 * two actions in one context; when a surface does two things with one press,
 * the second belongs to whichever context sits further out on the stack.
 *
 * Keys are already normalized as written: modifiers lowercase and alphabetical,
 * named keys lowercase, typed characters verbatim.
 */

/** Reachable wherever nothing inner claims the key first. */
const APP: ContextBindings = {
  "ctrl+c": "app:interrupt",
  escape: "app:interrupt",
  "ctrl+z": "app:suspend",
  "shift+tab": "app:cyclePermissionMode",
  "ctrl+t": "app:toggleTaskList",
  "ctrl+o": "app:toggleTranscript",
  "ctrl+l": "app:redraw",
};

/**
 * Pushed only while a turn runs, and pushed INNERMOST.
 *
 * `ctrl+b` backgrounds the running tool, and the prompt binds the same chord to a
 * caret move — the live behaviour is that backgrounding wins, but only while there
 * is something to background. A stack alone cannot say "outer wins when running",
 * so the state IS a context: present while the turn is, absent otherwise, and the
 * ordinary innermost-first rule then gives the right answer both times.
 */
const TURN: ContextBindings = {
  "ctrl+b": "app:backgroundTool",
};

/**
 * The prompt buffer.
 *
 * Dismissing the footer notice is deliberately NOT an action here, and not an
 * action at all. The notice clears on backspace or delete while that same press
 * keeps its editing job, and one chord in one context resolves to exactly one
 * action — so the dismissal stays a side effect of the edit. Naming it would put
 * an id in the vocabulary that nothing could ever bind.
 *
 * `escape` appears here and in six other contexts, each correct in isolation. Its
 * real precedence is the ladder in `string-view-prompt.ts`, which runs before a
 * lookup would: the editor mode has to see Escape before the clear arms, and the
 * clear has to arm before the draft is discarded. The table cannot express an
 * order that depends on what is armed, so it does not try — these entries say what
 * Escape means in a context, never which context gets it.
 */
const PROMPT: ContextBindings = {
  return: "prompt:submit",
  enter: "prompt:newline",
  "shift+return": "prompt:newline",
  "meta+return": "prompt:newline",
  "ctrl+c": "prompt:clear",
  escape: "prompt:armClear",
  "ctrl+_": "prompt:undo",
  "ctrl+s": "prompt:stash",
  "ctrl+g": "prompt:externalEditor",
  "ctrl+x ctrl+e": "prompt:externalEditor",
  "ctrl+v": "prompt:pasteImage",
  "ctrl+r": "prompt:openHistorySearch",
  "ctrl+p": "prompt:historyPrevious",
  "ctrl+n": "prompt:historyNext",
  up: "prompt:historyPrevious",
  down: "prompt:historyNext",
  "meta+p": "prompt:openModelPicker",
  "meta+w": "prompt:toggleKeyword",
};

/** Readline editing, shared by the prompt and every panel text field. */
const EDIT: ContextBindings = {
  backspace: "edit:deletePreviousChar",
  "ctrl+h": "edit:deletePreviousChar",
  "ctrl+d": "edit:deleteNextChar",
  "meta+d": "edit:deleteNextWord",
  "ctrl+w": "edit:killPreviousWord",
  "ctrl+backspace": "edit:killPreviousWord",
  "meta+backspace": "edit:killPreviousWord",
  "ctrl+u": "edit:killToLineStart",
  "ctrl+k": "edit:killToLineEnd",
  "meta+delete": "edit:killToLineEnd",
  "ctrl+y": "edit:yank",
  "meta+y": "edit:yankPop",
  "ctrl+a": "edit:moveLineStart",
  "ctrl+e": "edit:moveLineEnd",
  "ctrl+b": "edit:movePreviousChar",
  "ctrl+f": "edit:moveNextChar",
};

const HISTORY_SEARCH: ContextBindings = {
  "ctrl+r": "historySearch:next",
  return: "historySearch:accept",
  "ctrl+c": "historySearch:cancel",
  escape: "historySearch:abandon",
  tab: "historySearch:abandon",
  backspace: "historySearch:deletePrevious",
  "ctrl+h": "historySearch:deletePrevious",
};

const AUTOCOMPLETE: ContextBindings = {
  tab: "autocomplete:complete",
  return: "autocomplete:accept",
  escape: "autocomplete:dismiss",
};

/** The running-agents strip, reachable from an empty prompt. */
const STRIP: ContextBindings = {
  down: "strip:next",
  up: "strip:previous",
  return: "strip:open",
  x: "strip:stopOrClose",
  escape: "strip:blur",
};

/** The list vocabulary. Digit jumps are resolved by the resolver, not listed. */
const SELECT: ContextBindings = {
  down: "select:next",
  j: "select:next",
  "ctrl+n": "select:next",
  up: "select:previous",
  k: "select:previous",
  "ctrl+p": "select:previous",
  pagedown: "select:pageDown",
  pageup: "select:pageUp",
  home: "select:first",
  end: "select:last",
};

const SEARCH: ContextBindings = {
  "/": "search:focus",
  escape: "search:clearOrExit",
  return: "search:toList",
  down: "search:toList",
  up: "search:toHeader",
  left: "search:caretPrevious",
  right: "search:caretNext",
  home: "search:caretStart",
  "ctrl+a": "search:caretStart",
  end: "search:caretEnd",
  "ctrl+e": "search:caretEnd",
  backspace: "search:deletePrevious",
  delete: "search:deleteNext",
};

const TABS: ContextBindings = {
  tab: "tabs:next",
  right: "tabs:next",
  "shift+tab": "tabs:previous",
  left: "tabs:previous",
};

/** What a panel does regardless of what it lists. */
/**
 * What every panel answers to beyond its list. `back` and `forward` are the two
 * halves of moving between levels — a panel with only one level acts on neither,
 * and one that has levels decides for itself whether a press pops or closes.
 */
const PANEL: ContextBindings = {
  escape: "panel:close",
  left: "panel:back",
  right: "panel:forward",
  return: "panel:confirm",
  // The decoder tells the two Enter keys apart; a panel takes the row on either.
  enter: "panel:confirm",
  space: "panel:toggle",
};

const TRANSCRIPT: ContextBindings = {
  up: "transcript:scrollUp",
  k: "transcript:scrollUp",
  down: "transcript:scrollDown",
  j: "transcript:scrollDown",
  "ctrl+u": "transcript:halfPageUp",
  "ctrl+d": "transcript:halfPageDown",
  "ctrl+b": "transcript:pageUp",
  b: "transcript:pageUp",
  "ctrl+f": "transcript:pageDown",
  space: "transcript:pageDown",
  home: "transcript:top",
  g: "transcript:top",
  end: "transcript:bottom",
  G: "transcript:bottom",
  "/": "transcript:openSearch",
  n: "transcript:nextMatch",
  N: "transcript:previousMatch",
  "ctrl+e": "transcript:toggleAll",
  escape: "transcript:exit",
  q: "transcript:exit",
  "ctrl+c": "transcript:exit",
};

/** The query line the transcript reader opens with `/`. */
const TRANSCRIPT_SEARCH: ContextBindings = {
  escape: "search:clearOrExit",
  return: "search:toList",
  enter: "search:toList",
  backspace: "search:deletePrevious",
  delete: "search:deletePrevious",
};

const ASK: ContextBindings = {
  tab: "ask:nextQuestion",
  right: "ask:nextQuestion",
  "shift+tab": "ask:previousQuestion",
  left: "ask:previousQuestion",
  space: "ask:toggleOption",
};

const CONFIRM: ContextBindings = {
  e: "confirm:toggleExplanation",
};

const DIFF: ContextBindings = {
  r: "diff:refresh",
  q: "panel:close",
  pageup: "diff:pageUp",
  pagedown: "diff:pageDown",
  home: "diff:top",
  end: "diff:bottom",
};

const WORKFLOWS: ContextBindings = {
  x: "workflow:stop",
  p: "workflow:pause",
  s: "workflow:save",
  r: "workflow:restart",
  q: "panel:close",
};

const BACKGROUND_TASKS: ContextBindings = {
  f: "task:foreground",
  x: "task:stop",
};

const PLUGINS: ContextBindings = { f: "plugin:favorite" };
const SKILLS: ContextBindings = { t: "skill:toggle" };
const REMOTE: ContextBindings = {
  r: "remote:refresh",
  R: "remote:refresh",
  u: "remote:unpair",
  U: "remote:unpair",
};
const USAGE: ContextBindings = { r: "usage:refresh" };
const ERROR_REPORT: ContextBindings = { d: "error:toggleDetail", D: "error:toggleDetail" };
/**
 * A row whose value cycles rather than opens. The arrows step it, which is why
 * this context has to claim them before `panel` reads them as levels — a config
 * row has no level to move between.
 */
const CONFIG: ContextBindings = {
  d: "config:reset",
  left: "config:stepValue",
  right: "config:stepValue",
};

export const DEFAULT_BINDINGS: BindingTable = {
  app: APP,
  turn: TURN,
  prompt: PROMPT,
  edit: EDIT,
  historySearch: HISTORY_SEARCH,
  autocomplete: AUTOCOMPLETE,
  strip: STRIP,
  transcript: TRANSCRIPT,
  transcriptSearch: TRANSCRIPT_SEARCH,
  select: SELECT,
  search: SEARCH,
  tabs: TABS,
  panel: PANEL,
  ask: ASK,
  confirm: CONFIRM,
  diff: DIFF,
  workflows: WORKFLOWS,
  backgroundTasks: BACKGROUND_TASKS,
  plugins: PLUGINS,
  skills: SKILLS,
  remote: REMOTE,
  usage: USAGE,
  errorReport: ERROR_REPORT,
  config: CONFIG,
};

/** Digits 1-9 jump to that visible row and take it, in any list context. */
export const ROW_JUMP_DIGITS = "123456789";
