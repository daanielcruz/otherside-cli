import { appendFileSync } from "node:fs";
import createReconciler from "react-reconciler";
import { DefaultEventPriority, NoEventPriority } from "react-reconciler/constants.js";
import { devtoolBoolean, devtoolPath } from "@/devtools/settings.ts";
import { getLayoutCounters } from "@/native-ts/yoga-layout/index.js";
import { LayoutVisibility } from "@/terminal-runtime/geometry/layout-element.js";
import applyStyles, {
  type Styles,
  type TerminalTextStyle,
} from "@/terminal-runtime/paint/style-model.js";
import {
  appendChild,
  applyNodeStyle,
  applyTextStyle,
  createTextElement,
  createTreeElement,
  detachLayoutNodes,
  type ElementNodeNames,
  insertChildBefore,
  invalidateLayout,
  type NodeAttributeValue,
  removeChild,
  setAccessibility,
  setNodeAttribute,
  type TreeElement,
  type TreeTextNode,
  updateTextContent,
} from "@/terminal-runtime/tree/elements.js";

type AnyObject = Record<string, unknown>;

const diff = (before: AnyObject, after: AnyObject): AnyObject | undefined => {
  if (before === after) {
    return;
  }

  if (!before) {
    return after;
  }

  const changed: AnyObject = {};
  let isChanged = false;

  for (const key of Object.keys(before)) {
    const isDeleted = after ? !Object.hasOwn(after, key) : true;

    if (isDeleted) {
      changed[key] = undefined;
      isChanged = true;
    }
  }

  if (after) {
    for (const key of Object.keys(after)) {
      if (after[key] !== before[key]) {
        changed[key] = after[key];
        isChanged = true;
      }
    }
  }

  return isChanged ? changed : undefined;
};

const cleanupYogaNode = (node: TreeElement | TreeTextNode): void => {
  const yogaNode = node.yogaNode;
  if (yogaNode) {
    yogaNode.unsetMeasureFunc();

    detachLayoutNodes(node);
    yogaNode.freeRecursive();
  }
};

type Props = Record<string, unknown>;

type HostContext = {
  isInsideText: boolean;
};

function applyProp(node: TreeElement, key: string, value: unknown): void {
  if (key === "children") return;

  if (key === "style") {
    applyNodeStyle(node, value as Styles);
    if (node.yogaNode) {
      applyStyles(node.yogaNode, value as Styles);
    }
    return;
  }

  if (key === "textStyles") {
    node.textStyles = value as TerminalTextStyle;
    return;
  }

  if (key === "accessibility") {
    setAccessibility(node, value);
    return;
  }

  setNodeAttribute(node, key, value as NodeAttributeValue);
}

type FiberLike = {
  elementType?: { displayName?: string; name?: string } | string | null;
  _debugOwner?: FiberLike | null;
  return?: FiberLike | null;
};

export function getOwnerChain(fiber: unknown): string[] {
  const chain: string[] = [];
  const seen = new Set<unknown>();
  let cur = fiber as FiberLike | null | undefined;
  for (let i = 0; cur && i < 50; i++) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const t = cur.elementType;
    const name =
      typeof t === "function"
        ? (t as { displayName?: string; name?: string }).displayName ||
          (t as { displayName?: string; name?: string }).name
        : typeof t === "string"
          ? undefined
          : t?.displayName || t?.name;
    if (name && name !== chain[chain.length - 1]) chain.push(name);
    cur = cur._debugOwner ?? cur.return;
  }
  return chain;
}

let performanceDebugMode: boolean | undefined;
export function isPerformanceDebugActive(): boolean {
  if (performanceDebugMode === undefined) {
    performanceDebugMode = devtoolBoolean("repaintDiagnostics");
  }
  return performanceDebugMode ?? false;
}

let currentUpdatePriority = DefaultEventPriority as number;

const COMMIT_LOG = devtoolPath("commitLog");
let _commits = 0;
let _lastLog = 0;
let _lastCommitAt = 0;
let _maxGapMs = 0;
let _createCount = 0;
let _prepareAt = 0;

let _lastYogaMs = 0;
let _lastCommitMs = 0;
let _commitStart = 0;
export function recordLayoutComputeTime(ms: number): void {
  _lastYogaMs = ms;
}
export function getLastLayoutComputeTime(): number {
  return _lastYogaMs;
}
export function markReconcileStart(): void {
  _commitStart = performance.now();
}
export function getLastReconcileTime(): number {
  return _lastCommitMs;
}
export function resetPerformanceMetrics(): void {
  _lastYogaMs = 0;
  _lastCommitMs = 0;
  _commitStart = 0;
}

const reconciler = createReconciler<
  ElementNodeNames,
  Props,
  TreeElement,
  TreeElement,
  TreeTextNode,
  TreeElement,
  unknown,
  unknown,
  TreeElement,
  HostContext,
  null,
  NodeJS.Timeout,
  -1,
  null
>({
  getRootHostContext: () => ({ isInsideText: false }),
  prepareForCommit: () => {
    if (COMMIT_LOG) _prepareAt = performance.now();
    return null;
  },
  preparePortalMount: () => null,
  clearContainer: () => false,
  resetAfterCommit(rootNode: TreeElement) {
    _lastCommitMs = _commitStart > 0 ? performance.now() - _commitStart : 0;
    _commitStart = 0;
    if (COMMIT_LOG) {
      const now = performance.now();
      _commits++;
      const gap = _lastCommitAt > 0 ? now - _lastCommitAt : 0;
      if (gap > _maxGapMs) _maxGapMs = gap;
      _lastCommitAt = now;
      const reconcileMs = _prepareAt > 0 ? now - _prepareAt : 0;
      if (gap > 30 || reconcileMs > 20 || _createCount > 50) {
        appendFileSync(
          COMMIT_LOG,
          `${now.toFixed(1)} gap=${gap.toFixed(1)}ms reconcile=${reconcileMs.toFixed(1)}ms creates=${_createCount}\n`,
        );
      }
      _createCount = 0;
      if (now - _lastLog > 1000) {
        appendFileSync(
          COMMIT_LOG,
          `${now.toFixed(1)} commits=${_commits}/s maxGap=${_maxGapMs.toFixed(1)}ms\n`,
        );
        _commits = 0;
        _maxGapMs = 0;
        _lastLog = now;
      }
    }
    const _t0 = COMMIT_LOG ? performance.now() : 0;
    if (typeof rootNode.onComputeLayout === "function") {
      rootNode.onComputeLayout();
    }
    if (COMMIT_LOG) {
      const layoutMs = performance.now() - _t0;
      if (layoutMs > 20) {
        const c = getLayoutCounters();

        appendFileSync(
          COMMIT_LOG,
          `${_t0.toFixed(1)} SLOW_YOGA ${layoutMs.toFixed(1)}ms visited=${c.visited} measured=${c.measured} hits=${c.cacheHits} live=${c.live}\n`,
        );
      }
    }

    if (process.env.NODE_ENV === "test") {
      if (rootNode.childNodes.length === 0 && rootNode.hasRenderedContent) {
        return;
      }
      if (rootNode.childNodes.length > 0) {
        rootNode.hasRenderedContent = true;
      }
      rootNode.onImmediateRender?.();
      return;
    }

    const _tr = COMMIT_LOG ? performance.now() : 0;
    rootNode.onRender?.();
    if (COMMIT_LOG) {
      const renderMs = performance.now() - _tr;
      if (renderMs > 10) {
        appendFileSync(COMMIT_LOG, `${_tr.toFixed(1)} SLOW_PAINT ${renderMs.toFixed(1)}ms\n`);
      }
    }
  },
  getChildHostContext(parentHostContext: HostContext, type: ElementNodeNames): HostContext {
    const previousIsInsideText = parentHostContext.isInsideText;
    const isInsideText = type === "ink-text" || type === "ink-virtual-text" || type === "ink-link";

    if (previousIsInsideText === isInsideText) {
      return parentHostContext;
    }

    return { isInsideText };
  },
  shouldSetTextContent: () => false,
  createInstance(
    originalType: ElementNodeNames,
    newProps: Props,
    _root: TreeElement,
    hostContext: HostContext,
    internalHandle?: unknown,
  ): TreeElement {
    if (hostContext.isInsideText && originalType === "ink-box") {
      throw new Error(`<Box> can't be nested inside <Text> component`);
    }

    const type =
      originalType === "ink-text" && hostContext.isInsideText ? "ink-virtual-text" : originalType;

    const node = createTreeElement(type);
    if (COMMIT_LOG) _createCount++;

    for (const [key, value] of Object.entries(newProps)) {
      applyProp(node, key, value);
    }

    if (isPerformanceDebugActive()) {
      node.debugOwnerChain = getOwnerChain(internalHandle);
    }

    return node;
  },
  createTextInstance(text: string, _root: TreeElement, hostContext: HostContext): TreeTextNode {
    if (!hostContext.isInsideText) {
      throw new Error(`Text string "${text}" must be rendered inside <Text> component`);
    }

    return createTextElement(text);
  },
  resetTextContent() {},
  hideTextInstance(node: TreeTextNode) {
    updateTextContent(node, "");
  },
  unhideTextInstance(node: TreeTextNode, text: string) {
    updateTextContent(node, text);
  },
  getPublicInstance: (instance: TreeElement | TreeTextNode): TreeElement => instance as TreeElement,
  hideInstance(node: TreeElement) {
    node.isHidden = true;
    node.yogaNode?.setDisplay(LayoutVisibility.None);
    invalidateLayout(node);
  },
  unhideInstance(node: TreeElement) {
    node.isHidden = false;
    node.yogaNode?.setDisplay(LayoutVisibility.Flex);
    invalidateLayout(node);
  },
  appendInitialChild: appendChild,
  appendChild: appendChild,
  insertBefore: insertChildBefore,
  finalizeInitialChildren(): boolean {
    return false;
  },
  commitMount() {},
  isPrimaryRenderer: true,
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1,
  getCurrentUpdatePriority: () => currentUpdatePriority,
  beforeActiveInstanceBlur() {},
  afterActiveInstanceBlur() {},
  detachDeletedInstance() {},
  getInstanceFromNode: () => null,
  prepareScopeUpdate() {},
  getInstanceFromScope: () => null,
  appendChildToContainer: appendChild,
  insertInContainerBefore: insertChildBefore,
  removeChildFromContainer(node: TreeElement, removeNode: TreeElement): void {
    removeChild(node, removeNode);
    cleanupYogaNode(removeNode);
  },

  commitUpdate(node: TreeElement, _type: ElementNodeNames, oldProps: Props, newProps: Props): void {
    const props = diff(oldProps, newProps);
    const style = diff(oldProps.style as Styles, newProps.style as Styles);

    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (key === "style") {
          applyNodeStyle(node, value as Styles);
          continue;
        }

        if (key === "textStyles") {
          applyTextStyle(node, value as TerminalTextStyle);
          continue;
        }

        if (key === "accessibility") {
          setAccessibility(node, value);
          continue;
        }

        setNodeAttribute(node, key, value as NodeAttributeValue);
      }
    }

    if (style && node.yogaNode) {
      applyStyles(node.yogaNode, style, newProps.style as Styles);
    }
  },
  commitTextUpdate(node: TreeTextNode, _oldText: string, newText: string): void {
    updateTextContent(node, newText);
  },
  removeChild(node: TreeElement, removeNode: TreeElement | TreeTextNode) {
    removeChild(node, removeNode);
    cleanupYogaNode(removeNode);
  },

  maySuspendCommit(): boolean {
    return false;
  },
  preloadInstance(): boolean {
    return true;
  },
  startSuspendingCommit(): void {},
  suspendInstance(): void {},
  waitForCommitToBeReady(): null {
    return null;
  },
  NotPendingTransition: null,
  HostTransitionContext: {
    $$typeof: Symbol.for("react.context"),
    _currentValue: null,
  } as never,
  setCurrentUpdatePriority(newPriority: number): void {
    currentUpdatePriority = newPriority;
  },
  resolveUpdatePriority(): number {
    return currentUpdatePriority === (NoEventPriority as number)
      ? (DefaultEventPriority as number)
      : currentUpdatePriority;
  },
  resetFormInstance(): void {},
  requestPostPaintCallback(): void {},
  shouldAttemptEagerTransition(): boolean {
    return false;
  },
  trackSchedulerEvent(): void {},
  resolveEventType: () => null,
  resolveEventTimeStamp: () => -1.1,
});

export default reconciler;
