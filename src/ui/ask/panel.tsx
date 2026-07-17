import { useEffect, useRef, useState } from "react";
import { Box, type Color as InkColor, Text } from "@/ink";
import type { GroupAnswer, GroupQuestion } from "@/kernel/channels/ask.ts";
import { resolveGroup } from "@/kernel/channels/ask.ts";
import { FooterPanel } from "@/ui/chrome/panel.tsx";
import { usePanelNavigation } from "@/ui/hooks/use-panel-navigation.ts";
import { useOverlayClose } from "@/ui/panels/use-overlay-close";
import { Color, Glyph } from "@/ui/theme/theme.ts";
import { useAskQueueHead } from "./use-ask-queue.ts";

interface TabState {
  cursor: number;
  marked: Set<number>;
  draft: string;
  draftCursor: number;
}

function freshState(): TabState {
  return { cursor: 0, marked: new Set(), draft: "", draftCursor: 0 };
}

export interface AskQuestionOverlayProps {
  onClose?: () => void;
}

export function AskQuestionOverlay({
  onClose,
}: AskQuestionOverlayProps = {}): React.JSX.Element | null {
  const close = useOverlayClose(onClose);
  const group = useAskQueueHead();
  const [activeTab, setActiveTab] = useState(0);
  const [tabStates, setTabStates] = useState<TabState[]>([]);
  const [answers, setAnswers] = useState<Map<number, string>>(new Map());
  const [confirmTick, setConfirmTick] = useState(0);
  const confirmDraftRef = useRef<() => void>(() => {});

  useEffect(() => {
    setActiveTab(0);
    setTabStates(group ? group.questions.map(() => freshState()) : []);
    setAnswers(new Map());
  }, [group]);

  useEffect(() => {
    if (confirmTick === 0) return;
    confirmDraftRef.current();
  }, [confirmTick]);

  const questions = group?.questions ?? [];
  const questionCount = questions.length;
  const showSubmitTab = questionCount > 1 || questions.some((q) => q.multiSelect);
  const tabCount = questionCount + (showSubmitTab ? 1 : 0);
  const isSubmitTab = showSubmitTab && activeTab === questionCount;
  const activeQuestion = isSubmitTab ? null : questions[activeTab];
  const state = tabStates[activeTab] ?? freshState();

  const optionCount = activeQuestion?.options.length ?? 0;
  const allowFreeform = activeQuestion?.allowFreeform !== false;
  const allowChat = activeQuestion?.allowChat !== false;
  const freeformIndex = allowFreeform ? optionCount : -1;
  const chatIndex = allowChat ? optionCount + (allowFreeform ? 1 : 0) : -1;
  const rowCount = optionCount + (allowFreeform ? 1 : 0) + (allowChat ? 1 : 0);
  const isTyping = !isSubmitTab && freeformIndex >= 0 && state.cursor === freeformIndex;

  function patchState(patch: Partial<TabState>): void {
    setTabStates((prev) => {
      const next = [...prev];
      next[activeTab] = { ...(next[activeTab] ?? freshState()), ...patch };
      return next;
    });
  }

  function setCursor(cursor: number): void {
    patchState({ cursor });
  }

  function decline(): void {
    if (!group) return;
    resolveGroup(group.id, { declined: true, reason: "cancel" });
    close();
  }

  function chatAboutThis(): void {
    if (!group) return;
    resolveGroup(group.id, { declined: true, reason: "chat" });
    close();
  }

  function submitAll(collected: Map<number, string>): void {
    if (!group) return;
    const out: GroupAnswer[] = [];
    questions.forEach((q, i) => {
      const value = collected.get(i);
      if (value !== undefined && value.length > 0)
        out.push({ question: q.question, answer: value });
    });
    resolveGroup(group.id, { declined: false, answers: out });
    close();
  }

  function recordAnswer(value: string): void {
    const next = new Map(answers);
    next.set(activeTab, value);
    setAnswers(next);
    if (!showSubmitTab) {
      submitAll(next);
      return;
    }
    const nextUnanswered = questions.findIndex((_, i) => i !== activeTab && !next.has(i));
    setActiveTab(nextUnanswered === -1 ? questionCount : nextUnanswered);
  }

  confirmDraftRef.current = (): void => {
    const value = (tabStates[activeTab]?.draft ?? "").trim();
    if (value.length === 0) return;
    patchState({ draft: "", draftCursor: 0 });
    recordAnswer(value);
  };

  function answerFromMarked(question: GroupQuestion): string {
    const labels = question.options.filter((_, i) => state.marked.has(i)).map((o) => o.label);
    if (labels.length > 0) return labels.join(", ");
    const focused = question.options[state.cursor];
    return focused ? focused.label : "";
  }

  function confirmDraft(): void {
    setConfirmTick((tick) => tick + 1);
  }

  function activate(): void {
    if (!group) return;
    if (isSubmitTab) {
      submitAll(answers);
      return;
    }
    if (!activeQuestion) return;
    if (state.cursor === chatIndex) {
      chatAboutThis();
      return;
    }
    if (state.cursor === freeformIndex) {
      confirmDraft();
      return;
    }
    if (activeQuestion.multiSelect) {
      recordAnswer(answerFromMarked(activeQuestion));
      return;
    }
    const opt = activeQuestion.options[state.cursor];
    if (opt) recordAnswer(opt.label);
  }

  function toggleMarked(index: number): void {
    setTabStates((prev) => {
      const next = [...prev];
      const cur = next[activeTab] ?? freshState();
      const marked = new Set(cur.marked);
      if (marked.has(index)) marked.delete(index);
      else marked.add(index);
      next[activeTab] = { ...cur, marked };
      return next;
    });
  }

  function insertDraft(input: string): void {
    setTabStates((prev) => {
      const next = [...prev];
      const cur = next[activeTab] ?? freshState();
      const pos = Math.max(0, Math.min(cur.draftCursor, cur.draft.length));
      const draft = cur.draft.slice(0, pos) + input + cur.draft.slice(pos);
      next[activeTab] = { ...cur, draft, draftCursor: pos + input.length };
      return next;
    });
  }

  function editDraft(edit: (cur: TabState) => Partial<TabState>): void {
    setTabStates((prev) => {
      const next = [...prev];
      const cur = next[activeTab] ?? freshState();
      next[activeTab] = { ...cur, ...edit(cur) };
      return next;
    });
  }

  function handleKey(
    input: string,
    key: { ctrl?: boolean; meta?: boolean; return?: boolean },
  ): boolean {
    if (!group || isSubmitTab || !activeQuestion) return false;
    if (isTyping) {
      if (key.return) {
        confirmDraft();
        return true;
      }
      if (input && input !== "\r" && input !== "\n" && !key.ctrl && !key.meta) {
        insertDraft(input);
        return true;
      }
      return false;
    }
    if (activeQuestion.multiSelect && input === " " && state.cursor < optionCount) {
      toggleMarked(state.cursor);
      return true;
    }
    const num = Number.parseInt(input, 10);
    if (Number.isInteger(num) && num >= 1 && num <= optionCount) {
      if (activeQuestion.multiSelect) toggleMarked(num - 1);
      else {
        const opt = activeQuestion.options[num - 1];
        if (opt) recordAnswer(opt.label);
      }
      return true;
    }
    return false;
  }

  usePanelNavigation({
    isActive: !!group,
    layer: "ask",
    onClose: decline,
    onActivate: activate,
    tabs: tabCount > 1 ? { count: tabCount, active: activeTab, onChange: setActiveTab } : undefined,
    rows: isSubmitTab
      ? undefined
      : { count: rowCount, selected: state.cursor, onChange: setCursor },
    onKey: (input, key) => {
      if (isTyping) {
        if (key.return) {
          confirmDraft();
          return true;
        }
        if (key.tab) return true;
        if (key.leftArrow) {
          editDraft((cur) => ({ draftCursor: Math.max(0, cur.draftCursor - 1) }));
          return true;
        }
        if (key.rightArrow) {
          editDraft((cur) => ({ draftCursor: Math.min(cur.draft.length, cur.draftCursor + 1) }));
          return true;
        }
        if (key.home || (key.ctrl && input === "a")) {
          editDraft(() => ({ draftCursor: 0 }));
          return true;
        }
        if (key.end || (key.ctrl && input === "e")) {
          editDraft((cur) => ({ draftCursor: cur.draft.length }));
          return true;
        }
        if (key.backspace || (key.ctrl && input === "h")) {
          editDraft((cur) => {
            if (cur.draftCursor === 0) return {};
            const pos = cur.draftCursor;
            return {
              draft: cur.draft.slice(0, pos - 1) + cur.draft.slice(pos),
              draftCursor: pos - 1,
            };
          });
          return true;
        }
        if (key.delete) {
          editDraft((cur) => {
            if (cur.draftCursor >= cur.draft.length) return {};
            return {
              draft: cur.draft.slice(0, cur.draftCursor) + cur.draft.slice(cur.draftCursor + 1),
            };
          });
          return true;
        }
      }
      return handleKey(input, key);
    },
  });

  if (!group) return null;

  const title = isSubmitTab ? "Review answers" : (activeQuestion?.question ?? "Question");
  return (
    <FooterPanel
      accent={Color.primaryGlow}
      footerHints={askFooterHints({ isSubmitTab, multiTab: tabCount > 1 })}
    >
      {tabCount > 1 && (
        <TabBar
          questions={questions}
          answers={answers}
          activeTab={activeTab}
          showSubmitTab={showSubmitTab}
        />
      )}
      <Box marginBottom={1}>
        <Text color={Color.textStrong} bold>
          {title}
        </Text>
      </Box>
      {isSubmitTab && <SubmitView questions={questions} answers={answers} />}
      {!isSubmitTab && !!activeQuestion && (
        <QuestionView
          question={activeQuestion}
          state={state}
          freeformIndex={freeformIndex}
          chatIndex={chatIndex}
        />
      )}
    </FooterPanel>
  );
}

function TabBar({
  questions,
  answers,
  activeTab,
  showSubmitTab,
}: {
  questions: GroupQuestion[];
  answers: Map<number, string>;
  activeTab: number;
  showSubmitTab: boolean;
}): React.JSX.Element {
  const submitActive = activeTab === questions.length;
  return (
    <Box flexDirection="row" marginBottom={1}>
      <Text color={activeTab === 0 ? Color.muted : Color.text}>{"← "}</Text>
      {questions.map((q, i) => {
        const active = i === activeTab;
        const answered = answers.has(i);
        const label = q.header ?? `Q${i + 1}`;
        const marker = answered ? Glyph.ballotBoxX : Glyph.ballotBox;
        return (
          <Box key={`tab-${q.question}`}>
            <Text
              {...(active ? { backgroundColor: Color.steel } : {})}
              color={tabLabelColor({ active, answered })}
            >
              {` ${marker} ${label} `}
            </Text>
          </Box>
        );
      })}
      {showSubmitTab && (
        <Box>
          <Text
            {...(submitActive ? { backgroundColor: Color.steel } : {})}
            color={submitActive ? Color.textStrong : Color.muted}
          >
            {` ${Glyph.check} Submit `}
          </Text>
        </Box>
      )}
      <Text color={submitActive ? Color.muted : Color.text}>{" →"}</Text>
    </Box>
  );
}

function tabLabelColor({ active, answered }: { active: boolean; answered: boolean }): InkColor {
  if (active) return Color.textStrong;
  if (answered) return Color.success;
  return Color.muted;
}

function QuestionView({
  question,
  state,
  freeformIndex,
  chatIndex,
}: {
  question: GroupQuestion;
  state: TabState;
  freeformIndex: number;
  chatIndex: number;
}): React.JSX.Element {
  const focusedOption =
    state.cursor < question.options.length ? question.options[state.cursor] : null;
  const preview = focusedOption?.preview;
  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        {question.options.map((opt, i) => {
          const selected = i === state.cursor;
          const checked = question.multiSelect && state.marked.has(i);
          return (
            <Box key={`${question.question}-${opt.label}`} flexDirection="column">
              <Box>
                <Text color={selected ? Color.primaryGlow : Color.muted}>
                  {`${selected ? Glyph.chevron : "  "}${
                    question.multiSelect ? `[${checked ? "x" : " "}] ` : ""
                  }${i + 1}. `}
                </Text>
                <Text color={optionLabelColor({ checked, selected })} bold={selected}>
                  {opt.label}
                </Text>
              </Box>
              {opt.description.length > 0 && (
                <Box paddingLeft={5}>
                  <Text color={Color.muted}>{opt.description}</Text>
                </Box>
              )}
            </Box>
          );
        })}
        {freeformIndex >= 0 && (
          <FreeformRow
            index={freeformIndex}
            focused={state.cursor === freeformIndex}
            draft={state.draft}
            draftCursor={state.draftCursor}
            multiSelect={question.multiSelect}
          />
        )}
        {chatIndex >= 0 && (
          <>
            <Box
              marginTop={1}
              width="100%"
              borderStyle="single"
              borderTop
              borderBottom={false}
              borderLeft={false}
              borderRight={false}
              borderTopColor={Color.muted}
            />
            <Box>
              <Text color={state.cursor === chatIndex ? Color.primaryGlow : Color.muted}>
                {state.cursor === chatIndex ? Glyph.chevron : "  "}
                {chatIndex + 1}. Chat about this
              </Text>
            </Box>
          </>
        )}
      </Box>
      {!!preview && (
        <Box flexDirection="column" marginTop={1} paddingLeft={2}>
          <Text color={Color.muted}>{preview}</Text>
        </Box>
      )}
    </Box>
  );
}

function optionLabelColor({
  checked,
  selected,
}: {
  checked: boolean;
  selected: boolean;
}): InkColor {
  if (checked) return Color.success;
  if (selected) return Color.primaryGlow;
  return Color.text;
}

function FreeformRow({
  index,
  focused,
  draft,
  draftCursor,
  multiSelect,
}: {
  index: number;
  focused: boolean;
  draft: string;
  draftCursor: number;
  multiSelect: boolean;
}): React.JSX.Element {
  const placeholder = multiSelect ? "Type something" : "Type something.";
  return (
    <Box>
      <Text color={focused ? Color.primaryGlow : Color.muted}>
        {focused ? Glyph.chevron : "  "}
        {`${index + 1}. `}
      </Text>
      {!focused && <Text color={Color.muted}>{placeholder}</Text>}
      {focused &&
        (draft.length === 0 ? (
          <Text>
            <Text inverse>{placeholder.slice(0, 1)}</Text>
            <Text color={Color.muted}>{placeholder.slice(1)}</Text>
          </Text>
        ) : (
          <DraftWithCursor draft={draft} cursor={draftCursor} />
        ))}
    </Box>
  );
}

function DraftWithCursor({ draft, cursor }: { draft: string; cursor: number }): React.JSX.Element {
  const pos = Math.max(0, Math.min(cursor, draft.length));
  const cursorChar = draft[pos] ?? " ";
  return (
    <Text>
      <Text color={Color.text}>{draft.slice(0, pos)}</Text>
      <Text inverse>{cursorChar}</Text>
      <Text color={Color.text}>{draft.slice(pos + (pos < draft.length ? 1 : 0))}</Text>
    </Text>
  );
}

function SubmitView({
  questions,
  answers,
}: {
  questions: GroupQuestion[];
  answers: Map<number, string>;
}): React.JSX.Element {
  const allAnswered = questions.every((_, i) => answers.has(i));
  return (
    <Box flexDirection="column">
      {!allAnswered && (
        <Box marginBottom={1}>
          <Text color={Color.warning}>{Glyph.warning} You have not answered all questions</Text>
        </Box>
      )}
      {questions.map((q, i) => {
        const answer = answers.get(i);
        return (
          <Box key={`submit-${q.question}`} flexDirection="column" marginBottom={1}>
            <Text color={Color.text}>
              {Glyph.bullet} {q.question}
            </Text>
            <Box paddingLeft={2}>
              <Text color={answer ? Color.success : Color.muted}>
                {"→ "}
                {answer ?? "(unanswered)"}
              </Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

export interface AskHintInput {
  isSubmitTab: boolean;
  multiTab: boolean;
}

export function askFooterHints({ isSubmitTab, multiTab }: AskHintInput): [string, string][] {
  if (isSubmitTab) {
    return [
      ["←/→", "tabs"],
      ["Enter", "submit"],
      ["Esc", "cancel"],
    ];
  }
  const navHint: [string, string] = multiTab
    ? ["Tab/Arrow keys", "to navigate"]
    : ["↑/↓", "to navigate"];
  const hints: [string, string][] = [["Enter", "to select"], navHint];
  hints.push(["Esc", "to cancel"]);
  return hints;
}
