import { useMemo, useState } from "react";
import {
  buildMergedPhases,
  buildWorkflowHeader,
  computeWorkflowAgentCounts,
} from "@/engine/background/workflows/runtime/progress/merge.ts";
import { Box, Text } from "@/ink";
import { computeListWindow } from "@/kernel/std/list-window.ts";
import { clamp } from "@/kernel/std/math.ts";
import { stringWidth } from "@/kernel/std/text/string-width.ts";
import { usePanelNavigation } from "@/ui/hooks/use-panel-navigation.ts";
import { Color } from "@/ui/theme/theme.ts";
import type { DetailLevel, WorkflowDetailItem } from "../types";
import {
  AGENT_LABEL_FLOOR,
  AGENT_LABEL_PAD,
  AGENT_LEFT_MAX,
  AGENT_LEFT_MIN,
  AGENT_RIGHT_MIN,
  ARROW_DOWN,
  ARROW_UP,
  CARD_NARROW_FLOOR,
  CONTENT_FLOOR,
  CONTENT_MARGIN,
  INNER_INSET,
  MAX_HEIGHT_WIDE,
  MIN_HEIGHT_TIGHT,
  MIN_HEIGHT_WIDE,
  NOW_BUCKET_MS,
  PHASE_COL_FLOOR,
  PHASE_COL_POINTER,
  PHASE_INNER_INSET,
  PHASE_LEFT_MAX,
  PHASE_LEFT_MIN,
  PHASE_LIST_TAIL,
  PHASE_RIGHT_MIN,
  phaseColGlyph,
  ROWS_MARGIN,
  SPLIT_MIN_WIDTH,
  TIGHT_BODY_MARGIN,
  TIGHT_CARD_NARROW_MARGIN,
  TIGHT_CARD_WIDE_MARGIN,
  TIGHT_ROWS,
  WIDE_BODY_MARGIN,
  WIDE_CARD_NARROW_MARGIN,
  WIDE_CARD_WIDE_MARGIN,
} from "./constants.ts";
import { buildAgentDetailLines } from "./detail-lines.ts";
import { useWorkflowDetailLayout, useWorkflowElapsed } from "./hooks.ts";
import {
  AgentDetailSinglePane,
  AgentDetailSplitPane,
  AgentListSinglePane,
  PhaseAgentSplitPane,
} from "./panes.tsx";
import { PhaseRow, PhaseScrollIndicator, WorkflowHeader } from "./phase-components.tsx";
import { agentDisplayStatus, type Segment } from "./segments.tsx";

export type { WorkflowDetailItem } from "../types";

export function WorkflowDetailPanel(props: {
  item: WorkflowDetailItem;
  onBack: () => void;
  onStop?: () => void;
  onPause?: () => void;
  onSave?: () => void;
  onSkip?: (agentId: string) => void;
  onRetry?: (agentId: string) => void;
  onResume?: () => void;
}): React.JSX.Element {
  const { item, onBack, onStop, onPause, onSave, onSkip, onRetry, onResume } = props;
  const { availableRows, width, rows } = useWorkflowDetailLayout();
  const contentWidth = Math.max(CONTENT_FLOOR, width - CONTENT_MARGIN);
  const elapsedMs = useWorkflowElapsed({ item });
  const phases = useMemo(
    () => buildMergedPhases({ workflowProgress: item.workflowProgress, phases: item.phases }),
    [item.workflowProgress, item.phases],
  );
  const counts = useMemo(
    () => computeWorkflowAgentCounts({ phases, declaredAgentCount: item.agentCount }),
    [phases, item.agentCount],
  );
  const { name, subtext, stats } = buildWorkflowHeader({
    name: item.name,
    description: item.description,
    status: item.status,
    counts,
    elapsedMs,
  });

  const [phaseCursor, setPhaseCursor] = useState(0);
  const [agentCursor, setAgentCursor] = useState(0);
  const [level, setLevel] = useState<DetailLevel>("phases");
  const [cardScroll, setCardScroll] = useState(0);
  const [expandedPrompts, setExpandedPrompts] = useState<Set<string>>(() => new Set());

  const clampedPhase = Math.min(phaseCursor, Math.max(0, phases.length - 1));
  const selectedPhase = phases[clampedPhase];
  const clampedAgent = selectedPhase
    ? Math.min(agentCursor, Math.max(0, selectedPhase.agents.length - 1))
    : 0;
  const hasScript = item.script.length > 0;
  const hasPhases = phases.length > 0;
  const workflowActive = item.status === "running";

  const cursoredAgent =
    level !== "phases" && selectedPhase ? selectedPhase.agents[clampedAgent] : undefined;
  const cursoredStatus = cursoredAgent
    ? agentDisplayStatus({ agent: cursoredAgent, workflowActive })
    : undefined;
  const promptExpanded = cursoredAgent ? expandedPrompts.has(cursoredAgent.label) : false;

  const innerWidth = contentWidth - INNER_INSET;
  const agentLabelColWidth = selectedPhase
    ? Math.max(
        AGENT_LABEL_FLOOR,
        ...selectedPhase.agents.map((agent) => AGENT_LABEL_PAD + stringWidth(agent.label)),
      )
    : AGENT_LABEL_FLOOR;
  const agentLeftWidth = Math.max(
    AGENT_LEFT_MIN,
    Math.min(AGENT_LEFT_MAX, agentLabelColWidth, innerWidth - AGENT_LEFT_MAX),
  );
  const agentRightWidth = innerWidth - agentLeftWidth;
  const splitAgentDetail =
    level === "agent" &&
    phases.length > 0 &&
    width >= SPLIT_MIN_WIDTH &&
    agentRightWidth >= AGENT_RIGHT_MIN;
  const detailWidth = splitAgentDetail ? agentRightWidth : contentWidth;

  function resetCard(): void {
    setCardScroll(0);
  }
  function toggleCurrentPrompt(): void {
    if (!cursoredAgent) return;
    const label = cursoredAgent.label;
    setExpandedPrompts((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
    setCardScroll(0);
  }
  function movePhase(delta: number): void {
    setPhaseCursor((prev) =>
      clamp(clamp(prev, 0, phases.length - 1) + delta, 0, phases.length - 1),
    );
    setAgentCursor(0);
    resetCard();
  }
  function moveAgent(delta: number): void {
    if (!selectedPhase) return;
    setAgentCursor((prev) => clamp(prev + delta, 0, selectedPhase.agents.length - 1));
    resetCard();
  }
  function moveCard(delta: number): void {
    setCardScroll((prev) => Math.max(0, prev + delta));
  }
  function moveCursor(delta: number): void {
    if (level === "phases") {
      movePhase(delta);
      return;
    }
    moveAgent(delta);
  }
  function goBack(): void {
    if (level === "agent") {
      setLevel("agents");
      return;
    }
    if (level === "agents") {
      setLevel("phases");
      return;
    }
    onBack();
  }
  function enterAgents(): void {
    if (selectedPhase && selectedPhase.agents.length > 0) {
      setAgentCursor(0);
      setLevel("agents");
    }
  }
  function enterAgentDetail(): void {
    if (!cursoredAgent) return;
    resetCard();
    setLevel("agent");
  }

  const nowMs =
    cursoredStatus === "running" ? Math.floor(Date.now() / NOW_BUCKET_MS) * NOW_BUCKET_MS : 0;
  const detail = useMemo(
    () =>
      level === "agent" && cursoredAgent && cursoredStatus
        ? buildAgentDetailLines({
            agent: cursoredAgent,
            status: cursoredStatus,
            width: detailWidth,
            nowMs,
            promptExpanded,
          })
        : { lines: [] as Segment[][], promptExpandable: false },
    [level, cursoredAgent, cursoredStatus, detailWidth, nowMs, promptExpanded],
  );

  const tight = availableRows < TIGHT_ROWS;
  const bodyRows = availableRows - (tight ? TIGHT_BODY_MARGIN : WIDE_BODY_MARGIN);
  const phaseListViewport = Math.max(1, bodyRows - PHASE_LIST_TAIL);
  const phasesOverflow = phases.length > phaseListViewport;
  const phaseRowsShown = phasesOverflow ? Math.max(1, phaseListViewport - 1) : phases.length;
  const listTailViewport = Math.max(1, bodyRows - phaseRowsShown - (phasesOverflow ? 1 : 0));
  const phaseWin = computeListWindow({
    cursor: clampedPhase,
    total: phases.length,
    size: phaseRowsShown,
    anchor: "center",
  });

  const phaseColWidth = Math.max(
    PHASE_COL_FLOOR,
    ...phases.map((phase, index) => {
      const glyph = phaseColGlyph({ status: phase.status, index });
      const counts2 = phase.totalCount > 0 ? `${phase.doneCount}/${phase.totalCount}` : "";
      return (
        PHASE_COL_POINTER +
        stringWidth(glyph) +
        1 +
        stringWidth(phase.title) +
        (counts2 ? 1 + stringWidth(counts2) : 0)
      );
    }),
  );
  const phaseLeftWidth = Math.max(
    PHASE_LEFT_MIN,
    Math.min(PHASE_LEFT_MAX, phaseColWidth, innerWidth - PHASE_INNER_INSET),
  );
  const phaseRightWidth = innerWidth - phaseLeftWidth;
  const splitPhases =
    level !== "agent" &&
    hasPhases &&
    width >= SPLIT_MIN_WIDTH &&
    phaseRightWidth >= PHASE_RIGHT_MIN;

  const cardViewportWide = Math.max(
    1,
    availableRows - (tight ? TIGHT_CARD_WIDE_MARGIN : WIDE_CARD_WIDE_MARGIN),
  );
  const cardViewportNarrow = Math.max(
    CARD_NARROW_FLOOR,
    availableRows - (tight ? TIGHT_CARD_NARROW_MARGIN : WIDE_CARD_NARROW_MARGIN),
  );
  const cardViewport = splitAgentDetail ? cardViewportWide : cardViewportNarrow;
  const maxCardScroll = Math.max(0, detail.lines.length - cardViewport);
  if (cardScroll > maxCardScroll) setCardScroll(maxCardScroll);

  const canStopWorkflow = workflowActive && !!onStop && level === "phases";
  const canPauseAtPhase = workflowActive && !!onPause && level === "phases";
  const canPauseAnywhere = workflowActive && !!onPause;
  // Both controls abort the active attempt with a different reason. The
  // bridge consumes user-retry by starting a fresh attempt; once an agent is
  // terminal its controller has already been removed.
  const canControlAgent =
    workflowActive &&
    level === "agent" &&
    cursoredAgent?.agentId !== undefined &&
    cursoredStatus === "running";
  const canRetryAgent = canControlAgent && !!onRetry;
  const canSkipAgent = canControlAgent && !!onSkip;
  const canResumePaused = item.status === "paused" && !!onResume;

  const hints: string[] = [];
  if (level === "agent") {
    hints.push(`${ARROW_UP}${ARROW_DOWN} agent`);
    if (detail.lines.length > cardViewport) hints.push("j/k scroll");
    if (detail.promptExpandable) hints.push("p prompt");
    if (canRetryAgent) hints.push("r retry");
    if (canSkipAgent) hints.push("s skip");
  } else if (hasPhases) {
    hints.push(`${ARROW_UP}${ARROW_DOWN} select`);
  }
  if (canStopWorkflow) hints.push("x stop workflow");
  if (canPauseAtPhase) hints.push("p pause");
  if (canPauseAnywhere && !canPauseAtPhase) hints.push("space pause");
  if (canResumePaused) hints.push("space resume");
  hints.push("esc back");
  if (hasScript && onSave && !canSkipAgent) hints.push("s save");
  const inputGuide = hints.join(" · ");

  usePanelNavigation({
    onClose: goBack,
    onKey: (input, key) => {
      if (key.ctrl || key.meta) return false;
      if (key.downArrow) {
        moveCursor(1);
        return true;
      }
      if (key.upArrow) {
        moveCursor(-1);
        return true;
      }
      if (input === "j") {
        if (level === "agent") moveCard(1);
        else moveCursor(1);
        return true;
      }
      if (input === "k") {
        if (level === "agent") moveCard(-1);
        else moveCursor(-1);
        return true;
      }
      if (key.return || key.rightArrow) {
        if (level === "agent" && detail.promptExpandable) {
          toggleCurrentPrompt();
          return true;
        }
        if (level === "phases") enterAgents();
        else if (level === "agents") enterAgentDetail();
        return true;
      }
      if (key.leftArrow) {
        goBack();
        return true;
      }
      if (input === " " && canPauseAnywhere) {
        onPause?.();
        return true;
      }
      if (input === " " && canResumePaused) {
        onResume?.();
        return true;
      }
      if (input === "x" && canStopWorkflow) {
        onStop?.();
        return true;
      }
      if (input === "p" && level === "agent" && detail.promptExpandable) {
        toggleCurrentPrompt();
        return true;
      }
      if (input === "p" && canPauseAtPhase) {
        onPause?.();
        return true;
      }
      if (input === "r" && canRetryAgent && cursoredAgent?.agentId !== undefined) {
        onRetry?.(cursoredAgent.agentId);
        return true;
      }
      if (input === "s" && canSkipAgent && cursoredAgent?.agentId !== undefined) {
        onSkip?.(cursoredAgent.agentId);
        return true;
      }
      if (input === "s" && hasScript && onSave) {
        onSave();
        return true;
      }
      return false;
    },
  });

  let body: React.JSX.Element;
  if (!hasPhases) {
    body = (
      <>
        <Text color={Color.muted}>No agents yet.</Text>
        <Box flexGrow={1} />
      </>
    );
  } else if (level === "agent" && cursoredAgent && selectedPhase) {
    body = (
      <>
        <WorkflowHeader name={name} subtext={subtext} stats={stats} width={width} />
        {!tight && <Box height={1} />}
        {splitAgentDetail ? (
          <AgentDetailSplitPane
            phase={selectedPhase}
            clampedAgent={clampedAgent}
            agentLabel={cursoredAgent.label}
            detailLines={detail.lines}
            cardScroll={cardScroll}
            leftWidth={agentLeftWidth}
            rightWidth={agentRightWidth}
            viewport={cardViewportWide}
            workflowActive={workflowActive}
          />
        ) : (
          <AgentDetailSinglePane
            agentLabel={cursoredAgent.label}
            position={`${clampedAgent + 1}/${selectedPhase.agents.length}`}
            detailLines={detail.lines}
            cardScroll={cardScroll}
            contentWidth={contentWidth}
            viewport={cardViewportNarrow}
          />
        )}
        <Box flexGrow={1} />
      </>
    );
  } else if (splitPhases && selectedPhase) {
    body = (
      <>
        <WorkflowHeader name={name} subtext={subtext} stats={stats} width={width} />
        {!tight && <Box height={1} />}
        <PhaseAgentSplitPane
          phases={phases}
          selectedPhase={selectedPhase}
          clampedPhase={clampedPhase}
          clampedAgent={clampedAgent}
          level={level === "phases" ? "phases" : "agents"}
          leftWidth={phaseLeftWidth}
          rightWidth={phaseRightWidth}
          viewport={cardViewportWide}
          workflowActive={workflowActive}
        />
        <Box flexGrow={1} />
      </>
    );
  } else {
    body = (
      <>
        <WorkflowHeader name={name} subtext={subtext} stats={stats} width={width} />
        {!tight && <Box height={1} />}
        {phases.slice(phaseWin.from, phaseWin.to).map((phase, i) => {
          const idx = phaseWin.from + i;
          return (
            <PhaseRow
              key={`${idx}-${phase.title}`}
              index={idx + 1}
              title={phase.title}
              done={phase.doneCount}
              total={phase.totalCount}
              status={phase.status}
              selected={idx === clampedPhase}
            />
          );
        })}
        {phasesOverflow && <PhaseScrollIndicator win={phaseWin} total={phases.length} />}
        <Box flexGrow={1} />
        {!!selectedPhase && (
          <AgentListSinglePane
            phase={selectedPhase}
            selectedAgent={clampedAgent}
            level={level === "phases" ? "phases" : "agents"}
            contentWidth={contentWidth}
            viewport={listTailViewport}
            tight={tight}
            workflowActive={workflowActive}
          />
        )}
      </>
    );
  }

  return (
    <Box
      flexDirection="column"
      width={width}
      minHeight={Math.max(
        tight ? MIN_HEIGHT_TIGHT : MIN_HEIGHT_WIDE,
        Math.min(availableRows - 1, rows - ROWS_MARGIN),
      )}
      maxHeight={Math.max(tight ? MIN_HEIGHT_TIGHT : MAX_HEIGHT_WIDE, availableRows - 1)}
      overflowY="hidden"
    >
      {body}
      <Text dim italic wrap="truncate-end">
        {" "}
        {inputGuide}
      </Text>
    </Box>
  );
}
