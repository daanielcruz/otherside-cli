import {
  Align,
  BoxSizing,
  Dimension,
  Direction,
  Display,
  Edge,
  Errata,
  ExperimentalFeature,
  FlexDirection,
  Gutter,
  Justify,
  MeasureMode,
  Overflow,
  PositionType,
  Unit,
  Wrap,
} from "./enums.js";

export {
  Align,
  BoxSizing,
  Dimension,
  Direction,
  Display,
  Edge,
  Errata,
  ExperimentalFeature,
  FlexDirection,
  Gutter,
  Justify,
  MeasureMode,
  Overflow,
  PositionType,
  Unit,
  Wrap,
};

export type Value = {
  unit: Unit;
  value: number;
};

const UNDEFINED_METRIC: Value = { unit: Unit.Undefined, value: NaN };
const AUTO_METRIC: Value = { unit: Unit.Auto, value: NaN };

function metricPoints(v: number): Value {
  return { unit: Unit.Point, value: v };
}
function metricPercent(v: number): Value {
  return { unit: Unit.Percent, value: v };
}

function resolveMetric(v: Value, ownerSize: number): number {
  switch (v.unit) {
    case Unit.Point:
      return v.value;
    case Unit.Percent:
      return Number.isNaN(ownerSize) ? NaN : (v.value * ownerSize) / 100;
    default:
      return NaN;
  }
}

function isMetricDefined(n: number): boolean {
  return !Number.isNaN(n);
}

function floatsEqual(a: number, b: number): boolean {
  return a === b || (a !== a && b !== b);
}

type Bounds = {
  left: number;
  top: number;
  width: number;
  height: number;

  border: [number, number, number, number];
  padding: [number, number, number, number];
  margin: [number, number, number, number];
};

type DisplayStyle = {
  direction: Direction;
  flexDirection: FlexDirection;
  justifyContent: Justify;
  alignItems: Align;
  alignSelf: Align;
  alignContent: Align;
  flexWrap: Wrap;
  overflow: Overflow;
  display: Display;
  positionType: PositionType;

  flexGrow: number;
  flexShrink: number;
  flexBasis: Value;

  margin: Value[];
  padding: Value[];
  border: Value[];
  position: Value[];

  gap: Value[];

  width: Value;
  height: Value;
  minWidth: Value;
  minHeight: Value;
  maxWidth: Value;
  maxHeight: Value;
};

function createDefaultStyle(): DisplayStyle {
  return {
    direction: Direction.Inherit,
    flexDirection: FlexDirection.Column,
    justifyContent: Justify.FlexStart,
    alignItems: Align.Stretch,
    alignSelf: Align.Auto,
    alignContent: Align.FlexStart,
    flexWrap: Wrap.NoWrap,
    overflow: Overflow.Visible,
    display: Display.Flex,
    positionType: PositionType.Relative,
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: AUTO_METRIC,
    margin: new Array(9).fill(UNDEFINED_METRIC),
    padding: new Array(9).fill(UNDEFINED_METRIC),
    border: new Array(9).fill(UNDEFINED_METRIC),
    position: new Array(9).fill(UNDEFINED_METRIC),
    gap: new Array(3).fill(UNDEFINED_METRIC),
    width: AUTO_METRIC,
    height: AUTO_METRIC,
    minWidth: UNDEFINED_METRIC,
    minHeight: UNDEFINED_METRIC,
    maxWidth: UNDEFINED_METRIC,
    maxHeight: UNDEFINED_METRIC,
  };
}

const BOUNDARY_LEFT = 0;
const BOUNDARY_TOP = 1;
const BOUNDARY_RIGHT = 2;
const BOUNDARY_BOTTOM = 3;

function resolveBoundary(
  edges: Value[],
  resolvePhysicalBoundary: number,
  ownerSize: number,

  allowAuto = false,
): number {
  let v = edges[resolvePhysicalBoundary]!;
  if (v.unit === Unit.Undefined) {
    if (resolvePhysicalBoundary === BOUNDARY_LEFT || resolvePhysicalBoundary === BOUNDARY_RIGHT) {
      v = edges[Edge.Horizontal]!;
    } else {
      v = edges[Edge.Vertical]!;
    }
  }
  if (v.unit === Unit.Undefined) {
    v = edges[Edge.All]!;
  }

  if (v.unit === Unit.Undefined) {
    if (resolvePhysicalBoundary === BOUNDARY_LEFT) v = edges[Edge.Start]!;
    if (resolvePhysicalBoundary === BOUNDARY_RIGHT) v = edges[Edge.End]!;
  }
  if (v.unit === Unit.Undefined) return 0;
  if (v.unit === Unit.Auto) return allowAuto ? NaN : 0;
  return resolveMetric(v, ownerSize);
}

function resolveBoundaryRaw(edges: Value[], resolvePhysicalBoundary: number): Value {
  let v = edges[resolvePhysicalBoundary]!;
  if (v.unit === Unit.Undefined) {
    if (resolvePhysicalBoundary === BOUNDARY_LEFT || resolvePhysicalBoundary === BOUNDARY_RIGHT) {
      v = edges[Edge.Horizontal]!;
    } else {
      v = edges[Edge.Vertical]!;
    }
  }
  if (v.unit === Unit.Undefined) v = edges[Edge.All]!;
  if (v.unit === Unit.Undefined) {
    if (resolvePhysicalBoundary === BOUNDARY_LEFT) v = edges[Edge.Start]!;
    if (resolvePhysicalBoundary === BOUNDARY_RIGHT) v = edges[Edge.End]!;
  }
  return v;
}

function isBoundaryAuto(edges: Value[], resolvePhysicalBoundary: number): boolean {
  return resolveBoundaryRaw(edges, resolvePhysicalBoundary).unit === Unit.Auto;
}

function hasAnyAutoBoundary(edges: Value[]): boolean {
  for (let i = 0; i < 9; i++) if (edges[i]!.unit === 3) return true;
  return false;
}
function hasAnyDefinedBoundary(edges: Value[]): boolean {
  for (let i = 0; i < 9; i++) if (edges[i]!.unit !== 0) return true;
  return false;
}

function resolveBoundaries4Into(
  edges: Value[],
  ownerSize: number,
  out: [number, number, number, number],
): void {
  const eH = edges[6]!;
  const eV = edges[7]!;
  const eA = edges[8]!;
  const eS = edges[4]!;
  const eE = edges[5]!;
  const pctDenom = Number.isNaN(ownerSize) ? NaN : ownerSize / 100;

  let v = edges[0]!;
  if (v.unit === 0) v = eH;
  if (v.unit === 0) v = eA;
  if (v.unit === 0) v = eS;
  out[0] = v.unit === 1 ? v.value : v.unit === 2 ? v.value * pctDenom : 0;

  v = edges[1]!;
  if (v.unit === 0) v = eV;
  if (v.unit === 0) v = eA;
  out[1] = v.unit === 1 ? v.value : v.unit === 2 ? v.value * pctDenom : 0;

  v = edges[2]!;
  if (v.unit === 0) v = eH;
  if (v.unit === 0) v = eA;
  if (v.unit === 0) v = eE;
  out[2] = v.unit === 1 ? v.value : v.unit === 2 ? v.value * pctDenom : 0;

  v = edges[3]!;
  if (v.unit === 0) v = eV;
  if (v.unit === 0) v = eA;
  out[3] = v.unit === 1 ? v.value : v.unit === 2 ? v.value * pctDenom : 0;
}

function isRowDirection(dir: FlexDirection): boolean {
  return dir === FlexDirection.Row || dir === FlexDirection.RowReverse;
}
function isReverseDirection(dir: FlexDirection): boolean {
  return dir === FlexDirection.RowReverse || dir === FlexDirection.ColumnReverse;
}
function getOrthoAxis(dir: FlexDirection): FlexDirection {
  return isRowDirection(dir) ? FlexDirection.Column : FlexDirection.Row;
}
function getOriginBoundary(dir: FlexDirection): number {
  switch (dir) {
    case FlexDirection.Row:
      return BOUNDARY_LEFT;
    case FlexDirection.RowReverse:
      return BOUNDARY_RIGHT;
    case FlexDirection.Column:
      return BOUNDARY_TOP;
    case FlexDirection.ColumnReverse:
      return BOUNDARY_BOTTOM;
  }
}
function getTerminalBoundary(dir: FlexDirection): number {
  switch (dir) {
    case FlexDirection.Row:
      return BOUNDARY_RIGHT;
    case FlexDirection.RowReverse:
      return BOUNDARY_LEFT;
    case FlexDirection.Column:
      return BOUNDARY_BOTTOM;
    case FlexDirection.ColumnReverse:
      return BOUNDARY_TOP;
  }
}

export type MeasureCallback = (
  width: number,
  widthMode: MeasureMode,
  height: number,
  heightMode: MeasureMode,
) => { width: number; height: number };

export type Size = { width: number; height: number };

export type LayoutConfig = {
  pointScaleFactor: number;
  errata: Errata;
  useWebDefaults: boolean;
  free(): void;
  isExperimentalFeatureEnabled(_: ExperimentalFeature): boolean;
  setExperimentalFeatureEnabled(_: ExperimentalFeature, __: boolean): void;
  setPointScaleFactor(factor: number): void;
  getErrata(): Errata;
  setErrata(errata: Errata): void;
  setUseWebDefaults(v: boolean): void;
};

function createLayoutConfig(): LayoutConfig {
  const config: LayoutConfig = {
    pointScaleFactor: 1,
    errata: Errata.None,
    useWebDefaults: false,
    free() {},
    isExperimentalFeatureEnabled() {
      return false;
    },
    setExperimentalFeatureEnabled() {},
    setPointScaleFactor(f) {
      config.pointScaleFactor = f;
    },
    getErrata() {
      return config.errata;
    },
    setErrata(e) {
      config.errata = e;
    },
    setUseWebDefaults(v) {
      config.useWebDefaults = v;
    },
  };
  return config;
}

export class Node {
  style: DisplayStyle;
  layout: Bounds;
  parent: Node | null;
  children: Node[];
  measureFunc: MeasureCallback | null;
  config: LayoutConfig;
  isDirty_: boolean;
  isReferenceBaseline_: boolean;

  _flexBasis = 0;
  _mainSize = 0;
  _crossSize = 0;
  _lineIndex = 0;

  _hasAutoMargin = false;
  _hasPosition = false;

  _hasPadding = false;
  _hasBorder = false;
  _hasMargin = false;

  _lW = NaN;
  _lH = NaN;
  _lWM: MeasureMode = 0;
  _lHM: MeasureMode = 0;
  _lOW = NaN;
  _lOH = NaN;
  _lFW = false;
  _lFH = false;

  _lOutW = NaN;
  _lOutH = NaN;
  _hasL = false;
  _mW = NaN;
  _mH = NaN;
  _mWM: MeasureMode = 0;
  _mHM: MeasureMode = 0;
  _mOW = NaN;
  _mOH = NaN;
  _mOutW = NaN;
  _mOutH = NaN;
  _hasM = false;

  _fbBasis = NaN;
  _fbOwnerW = NaN;
  _fbOwnerH = NaN;
  _fbAvailMain = NaN;
  _fbAvailCross = NaN;
  _fbCrossMode: MeasureMode = 0;

  _fbGen = -1;

  _cIn: Float64Array | null = null;
  _cOut: Float64Array | null = null;
  _cGen = -1;
  _cN = 0;
  _cWr = 0;

  constructor(config?: LayoutConfig) {
    this.style = createDefaultStyle();
    this.layout = {
      left: 0,
      top: 0,
      width: 0,
      height: 0,
      border: [0, 0, 0, 0],
      padding: [0, 0, 0, 0],
      margin: [0, 0, 0, 0],
    };
    this.parent = null;
    this.children = [];
    this.measureFunc = null;
    this.config = config ?? DEFAULT_LAYOUT_CONFIG;
    this.isDirty_ = true;
    this.isReferenceBaseline_ = false;
    _layoutLiveNodes++;
  }

  insertChild(child: Node, index: number): void {
    child.parent = this;
    this.children.splice(index, 0, child);
    this.invalidateLayout();
  }
  removeChild(child: Node): void {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parent = null;
      this.invalidateLayout();
    }
  }
  getChild(index: number): Node {
    return this.children[index]!;
  }
  getChildCount(): number {
    return this.children.length;
  }
  getParent(): Node | null {
    return this.parent;
  }

  free(): void {
    this.parent = null;
    this.children = [];
    this.measureFunc = null;
    this._cIn = null;
    this._cOut = null;
    _layoutLiveNodes--;
  }
  freeRecursive(): void {
    for (const c of this.children) c.freeRecursive();
    this.free();
  }
  reset(): void {
    this.style = createDefaultStyle();
    this.children = [];
    this.parent = null;
    this.measureFunc = null;
    this.isDirty_ = true;
    this._hasAutoMargin = false;
    this._hasPosition = false;
    this._hasPadding = false;
    this._hasBorder = false;
    this._hasMargin = false;
    this._hasL = false;
    this._hasM = false;
    this._cN = 0;
    this._cWr = 0;
    this._fbBasis = NaN;
  }

  invalidateLayout(): void {
    this.isDirty_ = true;
    if (this.parent && !this.parent.isDirty_) this.parent.invalidateLayout();
  }
  isDirty(): boolean {
    return this.isDirty_;
  }
  hasNewLayout(): boolean {
    return true;
  }
  markLayoutSeen(): void {}

  setMeasureFunc(fn: MeasureCallback | null): void {
    this.measureFunc = fn;
    this.invalidateLayout();
  }
  unsetMeasureFunc(): void {
    this.measureFunc = null;
    this.invalidateLayout();
  }

  getComputedLeft(): number {
    return this.layout.left;
  }
  getComputedTop(): number {
    return this.layout.top;
  }
  getComputedWidth(): number {
    return this.layout.width;
  }
  getComputedHeight(): number {
    return this.layout.height;
  }
  getComputedRight(): number {
    const p = this.parent;
    return p ? p.layout.width - this.layout.left - this.layout.width : 0;
  }
  getComputedBottom(): number {
    const p = this.parent;
    return p ? p.layout.height - this.layout.top - this.layout.height : 0;
  }
  getComputedLayout(): {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  } {
    return {
      left: this.layout.left,
      top: this.layout.top,
      right: this.getComputedRight(),
      bottom: this.getComputedBottom(),
      width: this.layout.width,
      height: this.layout.height,
    };
  }
  getComputedBorder(edge: Edge): number {
    return this.layout.border[resolvePhysicalBoundary(edge)]!;
  }
  getComputedPadding(edge: Edge): number {
    return this.layout.padding[resolvePhysicalBoundary(edge)]!;
  }
  getComputedMargin(edge: Edge): number {
    return this.layout.margin[resolvePhysicalBoundary(edge)]!;
  }

  setWidth(v: number | "auto" | string | undefined): void {
    this.style.width = parseDimensionInput(v);
    this.invalidateLayout();
  }
  setWidthPercent(v: number): void {
    this.style.width = metricPercent(v);
    this.invalidateLayout();
  }
  setWidthAuto(): void {
    this.style.width = AUTO_METRIC;
    this.invalidateLayout();
  }
  setHeight(v: number | "auto" | string | undefined): void {
    this.style.height = parseDimensionInput(v);
    this.invalidateLayout();
  }
  setHeightPercent(v: number): void {
    this.style.height = metricPercent(v);
    this.invalidateLayout();
  }
  setHeightAuto(): void {
    this.style.height = AUTO_METRIC;
    this.invalidateLayout();
  }
  setMinWidth(v: number | string | undefined): void {
    this.style.minWidth = parseDimensionInput(v);
    this.invalidateLayout();
  }
  setMinWidthPercent(v: number): void {
    this.style.minWidth = metricPercent(v);
    this.invalidateLayout();
  }
  setMinHeight(v: number | string | undefined): void {
    this.style.minHeight = parseDimensionInput(v);
    this.invalidateLayout();
  }
  setMinHeightPercent(v: number): void {
    this.style.minHeight = metricPercent(v);
    this.invalidateLayout();
  }
  setMaxWidth(v: number | string | undefined): void {
    this.style.maxWidth = parseDimensionInput(v);
    this.invalidateLayout();
  }
  setMaxWidthPercent(v: number): void {
    this.style.maxWidth = metricPercent(v);
    this.invalidateLayout();
  }
  setMaxHeight(v: number | string | undefined): void {
    this.style.maxHeight = parseDimensionInput(v);
    this.invalidateLayout();
  }
  setMaxHeightPercent(v: number): void {
    this.style.maxHeight = metricPercent(v);
    this.invalidateLayout();
  }

  setFlexDirection(dir: FlexDirection): void {
    this.style.flexDirection = dir;
    this.invalidateLayout();
  }
  setFlexGrow(v: number | undefined): void {
    this.style.flexGrow = v ?? 0;
    this.invalidateLayout();
  }
  setFlexShrink(v: number | undefined): void {
    this.style.flexShrink = v ?? 0;
    this.invalidateLayout();
  }
  setFlex(v: number | undefined): void {
    if (v === undefined || Number.isNaN(v)) {
      this.style.flexGrow = 0;
      this.style.flexShrink = 0;
    } else if (v > 0) {
      this.style.flexGrow = v;
      this.style.flexShrink = 1;
      this.style.flexBasis = metricPoints(0);
    } else if (v < 0) {
      this.style.flexGrow = 0;
      this.style.flexShrink = -v;
    } else {
      this.style.flexGrow = 0;
      this.style.flexShrink = 0;
    }
    this.invalidateLayout();
  }
  setFlexBasis(v: number | "auto" | string | undefined): void {
    this.style.flexBasis = parseDimensionInput(v);
    this.invalidateLayout();
  }
  setFlexBasisPercent(v: number): void {
    this.style.flexBasis = metricPercent(v);
    this.invalidateLayout();
  }
  setFlexBasisAuto(): void {
    this.style.flexBasis = AUTO_METRIC;
    this.invalidateLayout();
  }
  setFlexWrap(wrap: Wrap): void {
    this.style.flexWrap = wrap;
    this.invalidateLayout();
  }

  setAlignItems(a: Align): void {
    this.style.alignItems = a;
    this.invalidateLayout();
  }
  setAlignSelf(a: Align): void {
    this.style.alignSelf = a;
    this.invalidateLayout();
  }
  setAlignContent(a: Align): void {
    this.style.alignContent = a;
    this.invalidateLayout();
  }
  setJustifyContent(j: Justify): void {
    this.style.justifyContent = j;
    this.invalidateLayout();
  }

  setDisplay(d: Display): void {
    this.style.display = d;
    this.invalidateLayout();
  }
  getDisplay(): Display {
    return this.style.display;
  }
  setPositionType(t: PositionType): void {
    this.style.positionType = t;
    this.invalidateLayout();
  }
  setPosition(edge: Edge, v: number | string | undefined): void {
    this.style.position[edge] = parseDimensionInput(v);
    this._hasPosition = hasAnyDefinedBoundary(this.style.position);
    this.invalidateLayout();
  }
  setPositionPercent(edge: Edge, v: number): void {
    this.style.position[edge] = metricPercent(v);
    this._hasPosition = true;
    this.invalidateLayout();
  }
  setPositionAuto(edge: Edge): void {
    this.style.position[edge] = AUTO_METRIC;
    this._hasPosition = true;
    this.invalidateLayout();
  }
  setOverflow(o: Overflow): void {
    this.style.overflow = o;
    this.invalidateLayout();
  }
  setDirection(d: Direction): void {
    this.style.direction = d;
    this.invalidateLayout();
  }
  setBoxSizing(_: BoxSizing): void {}

  setMargin(edge: Edge, v: number | "auto" | string | undefined): void {
    const val = parseDimensionInput(v);
    this.style.margin[edge] = val;
    if (val.unit === Unit.Auto) this._hasAutoMargin = true;
    else this._hasAutoMargin = hasAnyAutoBoundary(this.style.margin);
    this._hasMargin = this._hasAutoMargin || hasAnyDefinedBoundary(this.style.margin);
    this.invalidateLayout();
  }
  setMarginPercent(edge: Edge, v: number): void {
    this.style.margin[edge] = metricPercent(v);
    this._hasAutoMargin = hasAnyAutoBoundary(this.style.margin);
    this._hasMargin = true;
    this.invalidateLayout();
  }
  setMarginAuto(edge: Edge): void {
    this.style.margin[edge] = AUTO_METRIC;
    this._hasAutoMargin = true;
    this._hasMargin = true;
    this.invalidateLayout();
  }
  setPadding(edge: Edge, v: number | string | undefined): void {
    this.style.padding[edge] = parseDimensionInput(v);
    this._hasPadding = hasAnyDefinedBoundary(this.style.padding);
    this.invalidateLayout();
  }
  setPaddingPercent(edge: Edge, v: number): void {
    this.style.padding[edge] = metricPercent(v);
    this._hasPadding = true;
    this.invalidateLayout();
  }
  setBorder(edge: Edge, v: number | undefined): void {
    this.style.border[edge] = v === undefined ? UNDEFINED_METRIC : metricPoints(v);
    this._hasBorder = hasAnyDefinedBoundary(this.style.border);
    this.invalidateLayout();
  }
  setGap(gutter: Gutter, v: number | string | undefined): void {
    this.style.gap[gutter] = parseDimensionInput(v);
    this.invalidateLayout();
  }
  setGapPercent(gutter: Gutter, v: number): void {
    this.style.gap[gutter] = metricPercent(v);
    this.invalidateLayout();
  }

  getFlexDirection(): FlexDirection {
    return this.style.flexDirection;
  }
  getJustifyContent(): Justify {
    return this.style.justifyContent;
  }
  getAlignItems(): Align {
    return this.style.alignItems;
  }
  getAlignSelf(): Align {
    return this.style.alignSelf;
  }
  getAlignContent(): Align {
    return this.style.alignContent;
  }
  getFlexGrow(): number {
    return this.style.flexGrow;
  }
  getFlexShrink(): number {
    return this.style.flexShrink;
  }
  getFlexBasis(): Value {
    return this.style.flexBasis;
  }
  getFlexWrap(): Wrap {
    return this.style.flexWrap;
  }
  getWidth(): Value {
    return this.style.width;
  }
  getHeight(): Value {
    return this.style.height;
  }
  getOverflow(): Overflow {
    return this.style.overflow;
  }
  getPositionType(): PositionType {
    return this.style.positionType;
  }
  getDirection(): Direction {
    return this.style.direction;
  }

  copyStyle(_: Node): void {}
  setDirtiedFunc(_: unknown): void {}
  unsetDirtiedFunc(): void {}
  setIsReferenceBaseline(v: boolean): void {
    this.isReferenceBaseline_ = v;
    this.invalidateLayout();
  }
  isReferenceBaseline(): boolean {
    return this.isReferenceBaseline_;
  }
  setAspectRatio(_: number | undefined): void {}
  getAspectRatio(): number {
    return NaN;
  }
  setAlwaysFormsContainingBlock(_: boolean): void {}

  calculateLayout(
    ownerWidth: number | undefined,
    ownerHeight: number | undefined,
    _direction?: Direction,
  ): void {
    _layoutNodesVisited = 0;
    _layoutMeasureCalls = 0;
    _layoutCacheHits = 0;
    _layoutGeneration++;
    const w = ownerWidth === undefined ? NaN : ownerWidth;
    const h = ownerHeight === undefined ? NaN : ownerHeight;
    computeLayout(
      this,
      w,
      h,
      isMetricDefined(w) ? MeasureMode.Exactly : MeasureMode.Undefined,
      isMetricDefined(h) ? MeasureMode.Exactly : MeasureMode.Undefined,
      w,
      h,
      true,
    );

    const mar = this.layout.margin;
    const posL = resolveMetric(
      resolveBoundaryRaw(this.style.position, BOUNDARY_LEFT),
      isMetricDefined(w) ? w : 0,
    );
    const posT = resolveMetric(
      resolveBoundaryRaw(this.style.position, BOUNDARY_TOP),
      isMetricDefined(w) ? w : 0,
    );
    this.layout.left = mar[BOUNDARY_LEFT] + (isMetricDefined(posL) ? posL : 0);
    this.layout.top = mar[BOUNDARY_TOP] + (isMetricDefined(posT) ? posT : 0);
    snapLayoutToGrid(this, this.config.pointScaleFactor, 0, 0);
  }
}

const DEFAULT_LAYOUT_CONFIG = createLayoutConfig();

const LAYOUT_CACHE_SLOTS = 4;
function writeLayoutCache(
  node: Node,
  aW: number,
  aH: number,
  wM: MeasureMode,
  hM: MeasureMode,
  oW: number,
  oH: number,
  fW: boolean,
  fH: boolean,
  wasDirty: boolean,
): void {
  if (!node._cIn) {
    node._cIn = new Float64Array(LAYOUT_CACHE_SLOTS * 8);
    node._cOut = new Float64Array(LAYOUT_CACHE_SLOTS * 2);
  }

  if (wasDirty && node._cGen !== _layoutGeneration) {
    node._cN = 0;
    node._cWr = 0;
  }

  const i = node._cWr++ % LAYOUT_CACHE_SLOTS;
  if (node._cN < LAYOUT_CACHE_SLOTS) node._cN = node._cWr;
  const o = i * 8;
  const cIn = node._cIn;
  cIn[o] = aW;
  cIn[o + 1] = aH;
  cIn[o + 2] = wM;
  cIn[o + 3] = hM;
  cIn[o + 4] = oW;
  cIn[o + 5] = oH;
  cIn[o + 6] = fW ? 1 : 0;
  cIn[o + 7] = fH ? 1 : 0;
  node._cOut![i * 2] = node.layout.width;
  node._cOut![i * 2 + 1] = node.layout.height;
  node._cGen = _layoutGeneration;
}

function commitCachedResults(node: Node, performLayout: boolean): void {
  if (performLayout) {
    node._lOutW = node.layout.width;
    node._lOutH = node.layout.height;
  } else {
    node._mOutW = node.layout.width;
    node._mOutH = node.layout.height;
  }
}

let _layoutGeneration = 0;
let _layoutNodesVisited = 0;
let _layoutMeasureCalls = 0;
let _layoutCacheHits = 0;
let _layoutLiveNodes = 0;
export function getLayoutCounters(): {
  visited: number;
  measured: number;
  cacheHits: number;
  live: number;
} {
  return {
    visited: _layoutNodesVisited,
    measured: _layoutMeasureCalls,
    cacheHits: _layoutCacheHits,
    live: _layoutLiveNodes,
  };
}

function computeLayout(
  node: Node,
  availableWidth: number,
  availableHeight: number,
  widthMode: MeasureMode,
  heightMode: MeasureMode,
  ownerWidth: number,
  ownerHeight: number,
  performLayout: boolean,

  forceWidth = false,
  forceHeight = false,
): void {
  _layoutNodesVisited++;
  const style = node.style;
  const layout = node.layout;

  const sameGen = node._cGen === _layoutGeneration && !performLayout;
  if (!node.isDirty_ || sameGen) {
    if (
      !node.isDirty_ &&
      node._hasL &&
      node._lWM === widthMode &&
      node._lHM === heightMode &&
      node._lFW === forceWidth &&
      node._lFH === forceHeight &&
      floatsEqual(node._lW, availableWidth) &&
      floatsEqual(node._lH, availableHeight) &&
      floatsEqual(node._lOW, ownerWidth) &&
      floatsEqual(node._lOH, ownerHeight)
    ) {
      _layoutCacheHits++;
      layout.width = node._lOutW;
      layout.height = node._lOutH;
      return;
    }

    if (node._cN > 0 && (sameGen || !node.isDirty_)) {
      const cIn = node._cIn!;
      for (let i = 0; i < node._cN; i++) {
        const o = i * 8;
        if (
          cIn[o + 2] === widthMode &&
          cIn[o + 3] === heightMode &&
          cIn[o + 6] === (forceWidth ? 1 : 0) &&
          cIn[o + 7] === (forceHeight ? 1 : 0) &&
          floatsEqual(cIn[o]!, availableWidth) &&
          floatsEqual(cIn[o + 1]!, availableHeight) &&
          floatsEqual(cIn[o + 4]!, ownerWidth) &&
          floatsEqual(cIn[o + 5]!, ownerHeight)
        ) {
          layout.width = node._cOut![i * 2]!;
          layout.height = node._cOut![i * 2 + 1]!;
          _layoutCacheHits++;
          return;
        }
      }
    }
    if (
      !node.isDirty_ &&
      !performLayout &&
      node._hasM &&
      node._mWM === widthMode &&
      node._mHM === heightMode &&
      floatsEqual(node._mW, availableWidth) &&
      floatsEqual(node._mH, availableHeight) &&
      floatsEqual(node._mOW, ownerWidth) &&
      floatsEqual(node._mOH, ownerHeight)
    ) {
      layout.width = node._mOutW;
      layout.height = node._mOutH;
      _layoutCacheHits++;
      return;
    }
  }

  const wasDirty = node.isDirty_;
  if (performLayout) {
    node._lW = availableWidth;
    node._lH = availableHeight;
    node._lWM = widthMode;
    node._lHM = heightMode;
    node._lOW = ownerWidth;
    node._lOH = ownerHeight;
    node._lFW = forceWidth;
    node._lFH = forceHeight;
    node._hasL = true;
    node.isDirty_ = false;

    if (wasDirty) node._hasM = false;
  } else {
    node._mW = availableWidth;
    node._mH = availableHeight;
    node._mWM = widthMode;
    node._mHM = heightMode;
    node._mOW = ownerWidth;
    node._mOH = ownerHeight;
    node._hasM = true;

    if (wasDirty) node._hasL = false;
  }

  const pad = layout.padding;
  const bor = layout.border;
  const mar = layout.margin;
  if (node._hasPadding) resolveBoundaries4Into(style.padding, ownerWidth, pad);
  else pad[0] = pad[1] = pad[2] = pad[3] = 0;
  if (node._hasBorder) resolveBoundaries4Into(style.border, ownerWidth, bor);
  else bor[0] = bor[1] = bor[2] = bor[3] = 0;
  if (node._hasMargin) resolveBoundaries4Into(style.margin, ownerWidth, mar);
  else mar[0] = mar[1] = mar[2] = mar[3] = 0;

  const paddingBorderWidth = pad[0] + pad[2] + bor[0] + bor[2];
  const paddingBorderHeight = pad[1] + pad[3] + bor[1] + bor[3];

  const styleWidth = forceWidth ? NaN : resolveMetric(style.width, ownerWidth);
  const styleHeight = forceHeight ? NaN : resolveMetric(style.height, ownerHeight);

  let width = availableWidth;
  let height = availableHeight;
  let wMode = widthMode;
  let hMode = heightMode;
  if (isMetricDefined(styleWidth)) {
    width = styleWidth;
    wMode = MeasureMode.Exactly;
  }
  if (isMetricDefined(styleHeight)) {
    height = styleHeight;
    hMode = MeasureMode.Exactly;
  }

  width = constrainDimension(style, true, width, ownerWidth, ownerHeight);
  height = constrainDimension(style, false, height, ownerWidth, ownerHeight);

  if (node.measureFunc && node.children.length === 0) {
    const innerW = wMode === MeasureMode.Undefined ? NaN : Math.max(0, width - paddingBorderWidth);
    const innerH =
      hMode === MeasureMode.Undefined ? NaN : Math.max(0, height - paddingBorderHeight);
    _layoutMeasureCalls++;
    const measured = node.measureFunc(innerW, wMode, innerH, hMode);
    node.layout.width =
      wMode === MeasureMode.Exactly
        ? width
        : constrainDimension(
            style,
            true,
            (measured.width ?? 0) + paddingBorderWidth,
            ownerWidth,
            ownerHeight,
          );
    node.layout.height =
      hMode === MeasureMode.Exactly
        ? height
        : constrainDimension(
            style,
            false,
            (measured.height ?? 0) + paddingBorderHeight,
            ownerWidth,
            ownerHeight,
          );
    commitCachedResults(node, performLayout);

    writeLayoutCache(
      node,
      availableWidth,
      availableHeight,
      widthMode,
      heightMode,
      ownerWidth,
      ownerHeight,
      forceWidth,
      forceHeight,
      wasDirty,
    );
    return;
  }

  if (node.children.length === 0) {
    node.layout.width =
      wMode === MeasureMode.Exactly
        ? width
        : constrainDimension(style, true, paddingBorderWidth, ownerWidth, ownerHeight);
    node.layout.height =
      hMode === MeasureMode.Exactly
        ? height
        : constrainDimension(style, false, paddingBorderHeight, ownerWidth, ownerHeight);
    commitCachedResults(node, performLayout);

    writeLayoutCache(
      node,
      availableWidth,
      availableHeight,
      widthMode,
      heightMode,
      ownerWidth,
      ownerHeight,
      forceWidth,
      forceHeight,
      wasDirty,
    );
    return;
  }

  const mainAxis = style.flexDirection;
  const crossAx = getOrthoAxis(mainAxis);
  const isMainRow = isRowDirection(mainAxis);

  const mainSize = isMainRow ? width : height;
  const crossSize = isMainRow ? height : width;
  const mainMode = isMainRow ? wMode : hMode;
  const crossMode = isMainRow ? hMode : wMode;
  const mainPadBorder = isMainRow ? paddingBorderWidth : paddingBorderHeight;
  const crossPadBorder = isMainRow ? paddingBorderHeight : paddingBorderWidth;

  const innerMainSize = isMetricDefined(mainSize) ? Math.max(0, mainSize - mainPadBorder) : NaN;
  const innerCrossSize = isMetricDefined(crossSize) ? Math.max(0, crossSize - crossPadBorder) : NaN;

  const gapMain = resolveSpacing(style, isMainRow ? Gutter.Column : Gutter.Row, innerMainSize);

  const flowChildren: Node[] = [];
  const absChildren: Node[] = [];
  segregateChildren(node, flowChildren, absChildren);

  const ownerW = isMetricDefined(width) ? width : NaN;
  const ownerH = isMetricDefined(height) ? height : NaN;
  const isWrap = style.flexWrap !== Wrap.NoWrap;
  const gapCross = resolveSpacing(style, isMainRow ? Gutter.Row : Gutter.Column, innerCrossSize);

  for (const c of flowChildren) {
    c._flexBasis = calculateFlexBasis(
      c,
      mainAxis,
      innerMainSize,
      innerCrossSize,
      crossMode,
      ownerW,
      ownerH,
    );
  }
  const lines: Node[][] = [];
  if (!isWrap || !isMetricDefined(innerMainSize) || flowChildren.length === 0) {
    for (const c of flowChildren) c._lineIndex = 0;
    lines.push(flowChildren);
  } else {
    let lineStart = 0;
    let lineLen = 0;
    for (let i = 0; i < flowChildren.length; i++) {
      const c = flowChildren[i]!;
      const hypo = constrainDimension(c.style, isMainRow, c._flexBasis, ownerW, ownerH);
      const outer = Math.max(0, hypo) + getChildMarginAlongAxis(c, mainAxis, ownerW);
      const withGap = i > lineStart ? gapMain : 0;
      if (i > lineStart && lineLen + withGap + outer > innerMainSize) {
        lines.push(flowChildren.slice(lineStart, i));
        lineStart = i;
        lineLen = outer;
      } else {
        lineLen += withGap + outer;
      }
      c._lineIndex = lines.length;
    }
    lines.push(flowChildren.slice(lineStart));
  }
  const lineCount = lines.length;
  const isBaseline = isBaselineAligned(node, flowChildren);

  const lineConsumedMain: number[] = new Array(lineCount);
  const lineCrossSizes: number[] = new Array(lineCount);

  const lineMaxAscent: number[] = isBaseline ? new Array(lineCount).fill(0) : [];
  let maxLineMain = 0;
  let totalLinesCross = 0;
  for (let li = 0; li < lineCount; li++) {
    const line = lines[li]!;
    const lineGap = line.length > 1 ? gapMain * (line.length - 1) : 0;
    let lineBasis = lineGap;
    for (const c of line) {
      lineBasis += c._flexBasis + getChildMarginAlongAxis(c, mainAxis, ownerW);
    }

    let availMain = innerMainSize;
    if (!isMetricDefined(availMain)) {
      const mainOwner = isMainRow ? ownerWidth : ownerHeight;
      const minM = resolveMetric(isMainRow ? style.minWidth : style.minHeight, mainOwner);
      const maxM = resolveMetric(isMainRow ? style.maxWidth : style.maxHeight, mainOwner);
      if (isMetricDefined(maxM) && lineBasis > maxM - mainPadBorder) {
        availMain = Math.max(0, maxM - mainPadBorder);
      } else if (isMetricDefined(minM) && lineBasis < minM - mainPadBorder) {
        availMain = Math.max(0, minM - mainPadBorder);
      }
    }
    distributeFlexSpace(line, availMain, lineBasis, isMainRow, ownerW, ownerH);

    let lineCross = 0;
    for (const c of line) {
      const cStyle = c.style;
      const childAlign = cStyle.alignSelf === Align.Auto ? style.alignItems : cStyle.alignSelf;
      const cMarginCross = getChildMarginAlongAxis(c, crossAx, ownerW);
      let childCrossSize = NaN;
      let childCrossMode: MeasureMode = MeasureMode.Undefined;
      const resolvedCrossStyle = resolveMetric(
        isMainRow ? cStyle.height : cStyle.width,
        isMainRow ? ownerH : ownerW,
      );
      const crossLeadE = isMainRow ? BOUNDARY_TOP : BOUNDARY_LEFT;
      const crossTrailE = isMainRow ? BOUNDARY_BOTTOM : BOUNDARY_RIGHT;
      const hasCrossAutoMargin =
        c._hasAutoMargin &&
        (isBoundaryAuto(cStyle.margin, crossLeadE) || isBoundaryAuto(cStyle.margin, crossTrailE));

      if (isMetricDefined(resolvedCrossStyle)) {
        childCrossSize = resolvedCrossStyle;
        childCrossMode = MeasureMode.Exactly;
      } else if (
        childAlign === Align.Stretch &&
        !hasCrossAutoMargin &&
        !isWrap &&
        isMetricDefined(innerCrossSize) &&
        crossMode === MeasureMode.Exactly
      ) {
        childCrossSize = Math.max(0, innerCrossSize - cMarginCross);
        childCrossMode = MeasureMode.Exactly;
      } else if (!isWrap && isMetricDefined(innerCrossSize)) {
        childCrossSize = Math.max(0, innerCrossSize - cMarginCross);
        childCrossMode = MeasureMode.AtMost;
      }
      const cw = isMainRow ? c._mainSize : childCrossSize;
      const ch = isMainRow ? childCrossSize : c._mainSize;
      computeLayout(
        c,
        cw,
        ch,
        isMainRow ? MeasureMode.Exactly : childCrossMode,
        isMainRow ? childCrossMode : MeasureMode.Exactly,
        ownerW,
        ownerH,
        performLayout,
        isMainRow,
        !isMainRow,
      );
      c._crossSize = isMainRow ? c.layout.height : c.layout.width;
      lineCross = Math.max(lineCross, c._crossSize + cMarginCross);
    }

    if (isBaseline) {
      let maxAscent = 0;
      let maxDescent = 0;
      for (const c of line) {
        if (resolveChildAlignment(node, c) !== Align.Baseline) continue;
        const mTop = resolveBoundary(c.style.margin, BOUNDARY_TOP, ownerW);
        const mBot = resolveBoundary(c.style.margin, BOUNDARY_BOTTOM, ownerW);
        const ascent = computeBaseline(c) + mTop;
        const descent = c.layout.height + mTop + mBot - ascent;
        if (ascent > maxAscent) maxAscent = ascent;
        if (descent > maxDescent) maxDescent = descent;
      }
      lineMaxAscent[li] = maxAscent;
      if (maxAscent + maxDescent > lineCross) {
        lineCross = maxAscent + maxDescent;
      }
    }

    const mainLead = getOriginBoundary(mainAxis);
    const mainTrail = getTerminalBoundary(mainAxis);
    let consumed = lineGap;
    for (const c of line) {
      const cm = c.layout.margin;
      consumed += c._mainSize + cm[mainLead]! + cm[mainTrail]!;
    }
    lineConsumedMain[li] = consumed;
    lineCrossSizes[li] = lineCross;
    maxLineMain = Math.max(maxLineMain, consumed);
    totalLinesCross += lineCross;
  }
  const totalCrossGap = lineCount > 1 ? gapCross * (lineCount - 1) : 0;
  totalLinesCross += totalCrossGap;

  const isScroll = style.overflow === Overflow.Scroll;
  const contentMain = maxLineMain + mainPadBorder;
  const finalMainSize =
    mainMode === MeasureMode.Exactly
      ? mainSize
      : mainMode === MeasureMode.AtMost && isScroll
        ? Math.max(Math.min(mainSize, contentMain), mainPadBorder)
        : isWrap && lineCount > 1 && mainMode === MeasureMode.AtMost
          ? mainSize
          : contentMain;
  const contentCross = totalLinesCross + crossPadBorder;
  const finalCrossSize =
    crossMode === MeasureMode.Exactly
      ? crossSize
      : crossMode === MeasureMode.AtMost && isScroll
        ? Math.max(Math.min(crossSize, contentCross), crossPadBorder)
        : contentCross;
  node.layout.width = constrainDimension(
    style,
    true,
    isMainRow ? finalMainSize : finalCrossSize,
    ownerWidth,
    ownerHeight,
  );
  node.layout.height = constrainDimension(
    style,
    false,
    isMainRow ? finalCrossSize : finalMainSize,
    ownerWidth,
    ownerHeight,
  );
  commitCachedResults(node, performLayout);

  writeLayoutCache(
    node,
    availableWidth,
    availableHeight,
    widthMode,
    heightMode,
    ownerWidth,
    ownerHeight,
    forceWidth,
    forceHeight,
    wasDirty,
  );

  if (!performLayout) return;

  const actualInnerMain = (isMainRow ? node.layout.width : node.layout.height) - mainPadBorder;
  const actualInnerCross = (isMainRow ? node.layout.height : node.layout.width) - crossPadBorder;
  const mainLeadEdgePhys = getOriginBoundary(mainAxis);
  const mainTrailEdgePhys = getTerminalBoundary(mainAxis);
  const crossLeadEdgePhys = isMainRow ? BOUNDARY_TOP : BOUNDARY_LEFT;
  const crossTrailEdgePhys = isMainRow ? BOUNDARY_BOTTOM : BOUNDARY_RIGHT;
  const reversed = isReverseDirection(mainAxis);
  const mainContainerSize = isMainRow ? node.layout.width : node.layout.height;
  const crossLead = pad[crossLeadEdgePhys]! + bor[crossLeadEdgePhys]!;

  let lineCrossOffset = crossLead;
  let betweenLines = gapCross;
  const freeCross = actualInnerCross - totalLinesCross;
  if (lineCount === 1 && !isWrap && !isBaseline) {
    lineCrossSizes[0] = actualInnerCross;
  } else {
    const remCross = Math.max(0, freeCross);
    switch (style.alignContent) {
      case Align.FlexStart:
        break;
      case Align.Center:
        lineCrossOffset += freeCross / 2;
        break;
      case Align.FlexEnd:
        lineCrossOffset += freeCross;
        break;
      case Align.Stretch:
        if (lineCount > 0 && remCross > 0) {
          const add = remCross / lineCount;
          for (let i = 0; i < lineCount; i++) lineCrossSizes[i]! += add;
        }
        break;
      case Align.SpaceBetween:
        if (lineCount > 1) betweenLines += remCross / (lineCount - 1);
        break;
      case Align.SpaceAround:
        if (lineCount > 0) {
          betweenLines += remCross / lineCount;
          lineCrossOffset += remCross / lineCount / 2;
        }
        break;
      case Align.SpaceEvenly:
        if (lineCount > 0) {
          betweenLines += remCross / (lineCount + 1);
          lineCrossOffset += remCross / (lineCount + 1);
        }
        break;
      default:
        break;
    }
  }

  const wrapReverse = style.flexWrap === Wrap.WrapReverse;
  const crossContainerSize = isMainRow ? node.layout.height : node.layout.width;
  let lineCrossPos = lineCrossOffset;
  for (let li = 0; li < lineCount; li++) {
    const line = lines[li]!;
    const lineCross = lineCrossSizes[li]!;
    const consumedMain = lineConsumedMain[li]!;
    const n = line.length;

    if (isWrap || crossMode !== MeasureMode.Exactly) {
      for (const c of line) {
        const cStyle = c.style;
        const childAlign = cStyle.alignSelf === Align.Auto ? style.alignItems : cStyle.alignSelf;
        const crossStyleDef = isMetricDefined(
          resolveMetric(isMainRow ? cStyle.height : cStyle.width, isMainRow ? ownerH : ownerW),
        );
        const hasCrossAutoMargin =
          c._hasAutoMargin &&
          (isBoundaryAuto(cStyle.margin, crossLeadEdgePhys) ||
            isBoundaryAuto(cStyle.margin, crossTrailEdgePhys));
        if (childAlign === Align.Stretch && !crossStyleDef && !hasCrossAutoMargin) {
          const cMarginCross = getChildMarginAlongAxis(c, crossAx, ownerW);
          const target = Math.max(0, lineCross - cMarginCross);
          if (c._crossSize !== target) {
            const cw = isMainRow ? c._mainSize : target;
            const ch = isMainRow ? target : c._mainSize;
            computeLayout(
              c,
              cw,
              ch,
              MeasureMode.Exactly,
              MeasureMode.Exactly,
              ownerW,
              ownerH,
              performLayout,
              isMainRow,
              !isMainRow,
            );
            c._crossSize = target;
          }
        }
      }
    }

    let mainOffset = pad[mainLeadEdgePhys]! + bor[mainLeadEdgePhys]!;
    let betweenMain = gapMain;
    let numAutoMarginsMain = 0;
    for (const c of line) {
      if (!c._hasAutoMargin) continue;
      if (isBoundaryAuto(c.style.margin, mainLeadEdgePhys)) numAutoMarginsMain++;
      if (isBoundaryAuto(c.style.margin, mainTrailEdgePhys)) numAutoMarginsMain++;
    }
    const freeMain = actualInnerMain - consumedMain;
    const remainingMain = Math.max(0, freeMain);
    const autoMarginMainSize =
      numAutoMarginsMain > 0 && remainingMain > 0 ? remainingMain / numAutoMarginsMain : 0;
    if (numAutoMarginsMain === 0) {
      switch (style.justifyContent) {
        case Justify.FlexStart:
          break;
        case Justify.Center:
          mainOffset += freeMain / 2;
          break;
        case Justify.FlexEnd:
          mainOffset += freeMain;
          break;
        case Justify.SpaceBetween:
          if (n > 1) betweenMain += remainingMain / (n - 1);
          break;
        case Justify.SpaceAround:
          if (n > 0) {
            betweenMain += remainingMain / n;
            mainOffset += remainingMain / n / 2;
          }
          break;
        case Justify.SpaceEvenly:
          if (n > 0) {
            betweenMain += remainingMain / (n + 1);
            mainOffset += remainingMain / (n + 1);
          }
          break;
      }
    }

    const effectiveLineCrossPos = wrapReverse
      ? crossContainerSize - lineCrossPos - lineCross
      : lineCrossPos;

    let pos = mainOffset;
    for (const c of line) {
      const cMargin = c.style.margin;

      const cLayoutMargin = c.layout.margin;
      let autoMainLead = false;
      let autoMainTrail = false;
      let autoCrossLead = false;
      let autoCrossTrail = false;
      let mMainLead: number;
      let mMainTrail: number;
      let mCrossLead: number;
      let mCrossTrail: number;
      if (c._hasAutoMargin) {
        autoMainLead = isBoundaryAuto(cMargin, mainLeadEdgePhys);
        autoMainTrail = isBoundaryAuto(cMargin, mainTrailEdgePhys);
        autoCrossLead = isBoundaryAuto(cMargin, crossLeadEdgePhys);
        autoCrossTrail = isBoundaryAuto(cMargin, crossTrailEdgePhys);
        mMainLead = autoMainLead ? autoMarginMainSize : cLayoutMargin[mainLeadEdgePhys]!;
        mMainTrail = autoMainTrail ? autoMarginMainSize : cLayoutMargin[mainTrailEdgePhys]!;
        mCrossLead = autoCrossLead ? 0 : cLayoutMargin[crossLeadEdgePhys]!;
        mCrossTrail = autoCrossTrail ? 0 : cLayoutMargin[crossTrailEdgePhys]!;
      } else {
        mMainLead = cLayoutMargin[mainLeadEdgePhys]!;
        mMainTrail = cLayoutMargin[mainTrailEdgePhys]!;
        mCrossLead = cLayoutMargin[crossLeadEdgePhys]!;
        mCrossTrail = cLayoutMargin[crossTrailEdgePhys]!;
      }

      const mainPos = reversed
        ? mainContainerSize - (pos + mMainLead) - c._mainSize
        : pos + mMainLead;

      const childAlign = c.style.alignSelf === Align.Auto ? style.alignItems : c.style.alignSelf;
      let crossPos = effectiveLineCrossPos + mCrossLead;
      const crossFree = lineCross - c._crossSize - mCrossLead - mCrossTrail;
      if (autoCrossLead && autoCrossTrail) {
        crossPos += Math.max(0, crossFree) / 2;
      } else if (autoCrossLead) {
        crossPos += Math.max(0, crossFree);
      } else if (autoCrossTrail) {
      } else {
        switch (childAlign) {
          case Align.FlexStart:
          case Align.Stretch:
            if (wrapReverse) crossPos += crossFree;
            break;
          case Align.Center:
            crossPos += crossFree / 2;
            break;
          case Align.FlexEnd:
            if (!wrapReverse) crossPos += crossFree;
            break;
          case Align.Baseline:
            if (isBaseline) {
              crossPos = effectiveLineCrossPos + lineMaxAscent[li]! - computeBaseline(c);
            }
            break;
          default:
            break;
        }
      }

      let relX = 0;
      let relY = 0;
      if (c._hasPosition) {
        const relLeft = resolveMetric(resolveBoundaryRaw(c.style.position, BOUNDARY_LEFT), ownerW);
        const relRight = resolveMetric(
          resolveBoundaryRaw(c.style.position, BOUNDARY_RIGHT),
          ownerW,
        );
        const relTop = resolveMetric(resolveBoundaryRaw(c.style.position, BOUNDARY_TOP), ownerW);
        const relBottom = resolveMetric(
          resolveBoundaryRaw(c.style.position, BOUNDARY_BOTTOM),
          ownerW,
        );
        relX = isMetricDefined(relLeft) ? relLeft : isMetricDefined(relRight) ? -relRight : 0;
        relY = isMetricDefined(relTop) ? relTop : isMetricDefined(relBottom) ? -relBottom : 0;
      }

      if (isMainRow) {
        c.layout.left = mainPos + relX;
        c.layout.top = crossPos + relY;
      } else {
        c.layout.left = crossPos + relX;
        c.layout.top = mainPos + relY;
      }
      pos += c._mainSize + mMainLead + mMainTrail + betweenMain;
    }
    lineCrossPos += lineCross + betweenLines;
  }

  for (const c of absChildren) {
    layoutAbsolutionChild(node, c, node.layout.width, node.layout.height, pad, bor);
  }
}

function layoutAbsolutionChild(
  parent: Node,
  child: Node,
  parentWidth: number,
  parentHeight: number,
  pad: [number, number, number, number],
  bor: [number, number, number, number],
): void {
  const cs = child.style;
  const posLeft = resolveBoundaryRaw(cs.position, BOUNDARY_LEFT);
  const posRight = resolveBoundaryRaw(cs.position, BOUNDARY_RIGHT);
  const posTop = resolveBoundaryRaw(cs.position, BOUNDARY_TOP);
  const posBottom = resolveBoundaryRaw(cs.position, BOUNDARY_BOTTOM);

  const rLeft = resolveMetric(posLeft, parentWidth);
  const rRight = resolveMetric(posRight, parentWidth);
  const rTop = resolveMetric(posTop, parentHeight);
  const rBottom = resolveMetric(posBottom, parentHeight);

  const paddingBoxW = parentWidth - bor[0] - bor[2];
  const paddingBoxH = parentHeight - bor[1] - bor[3];
  let cw = resolveMetric(cs.width, paddingBoxW);
  let ch = resolveMetric(cs.height, paddingBoxH);

  if (!isMetricDefined(cw) && isMetricDefined(rLeft) && isMetricDefined(rRight)) {
    cw = paddingBoxW - rLeft - rRight;
  }
  if (!isMetricDefined(ch) && isMetricDefined(rTop) && isMetricDefined(rBottom)) {
    ch = paddingBoxH - rTop - rBottom;
  }

  computeLayout(
    child,
    cw,
    ch,
    isMetricDefined(cw) ? MeasureMode.Exactly : MeasureMode.Undefined,
    isMetricDefined(ch) ? MeasureMode.Exactly : MeasureMode.Undefined,
    paddingBoxW,
    paddingBoxH,
    true,
  );

  const mL = resolveBoundary(cs.margin, BOUNDARY_LEFT, parentWidth);
  const mT = resolveBoundary(cs.margin, BOUNDARY_TOP, parentWidth);
  const mR = resolveBoundary(cs.margin, BOUNDARY_RIGHT, parentWidth);
  const mB = resolveBoundary(cs.margin, BOUNDARY_BOTTOM, parentWidth);

  const mainAxis = parent.style.flexDirection;
  const reversed = isReverseDirection(mainAxis);
  const mainRow = isRowDirection(mainAxis);
  const wrapReverse = parent.style.flexWrap === Wrap.WrapReverse;

  const alignment = cs.alignSelf === Align.Auto ? parent.style.alignItems : cs.alignSelf;

  let left: number;
  if (isMetricDefined(rLeft)) {
    left = bor[0] + rLeft + mL;
  } else if (isMetricDefined(rRight)) {
    left = parentWidth - bor[2] - rRight - child.layout.width - mR;
  } else if (mainRow) {
    const lead = pad[0] + bor[0];
    const trail = parentWidth - pad[2] - bor[2];
    left = reversed
      ? trail - child.layout.width - mR
      : justifyAbsolutePosition(parent.style.justifyContent, lead, trail, child.layout.width) + mL;
  } else {
    left =
      alignAbsolutePosition(
        alignment,
        pad[0] + bor[0],
        parentWidth - pad[2] - bor[2],
        child.layout.width,
        wrapReverse,
      ) + mL;
  }

  let top: number;
  if (isMetricDefined(rTop)) {
    top = bor[1] + rTop + mT;
  } else if (isMetricDefined(rBottom)) {
    top = parentHeight - bor[3] - rBottom - child.layout.height - mB;
  } else if (mainRow) {
    top =
      alignAbsolutePosition(
        alignment,
        pad[1] + bor[1],
        parentHeight - pad[3] - bor[3],
        child.layout.height,
        wrapReverse,
      ) + mT;
  } else {
    const lead = pad[1] + bor[1];
    const trail = parentHeight - pad[3] - bor[3];
    top = reversed
      ? trail - child.layout.height - mB
      : justifyAbsolutePosition(parent.style.justifyContent, lead, trail, child.layout.height) + mT;
  }

  child.layout.left = left;
  child.layout.top = top;
}

function justifyAbsolutePosition(
  justify: Justify,
  leadEdge: number,
  trailEdge: number,
  childSize: number,
): number {
  switch (justify) {
    case Justify.Center:
      return leadEdge + (trailEdge - leadEdge - childSize) / 2;
    case Justify.FlexEnd:
      return trailEdge - childSize;
    default:
      return leadEdge;
  }
}

function alignAbsolutePosition(
  align: Align,
  leadEdge: number,
  trailEdge: number,
  childSize: number,
  wrapReverse: boolean,
): number {
  switch (align) {
    case Align.Center:
      return leadEdge + (trailEdge - leadEdge - childSize) / 2;
    case Align.FlexEnd:
      return wrapReverse ? leadEdge : trailEdge - childSize;
    default:
      return wrapReverse ? trailEdge - childSize : leadEdge;
  }
}

function calculateFlexBasis(
  child: Node,
  mainAxis: FlexDirection,
  availableMain: number,
  availableCross: number,
  crossMode: MeasureMode,
  ownerWidth: number,
  ownerHeight: number,
): number {
  const sameGen = child._fbGen === _layoutGeneration;
  if (
    (sameGen || !child.isDirty_) &&
    child._fbCrossMode === crossMode &&
    floatsEqual(child._fbOwnerW, ownerWidth) &&
    floatsEqual(child._fbOwnerH, ownerHeight) &&
    floatsEqual(child._fbAvailMain, availableMain) &&
    floatsEqual(child._fbAvailCross, availableCross)
  ) {
    return child._fbBasis;
  }
  const cs = child.style;
  const isMainRow = isRowDirection(mainAxis);

  const basis = resolveMetric(cs.flexBasis, availableMain);
  if (isMetricDefined(basis)) {
    const b = Math.max(0, basis);
    child._fbBasis = b;
    child._fbOwnerW = ownerWidth;
    child._fbOwnerH = ownerHeight;
    child._fbAvailMain = availableMain;
    child._fbAvailCross = availableCross;
    child._fbCrossMode = crossMode;
    child._fbGen = _layoutGeneration;
    return b;
  }

  const mainStyleDim = isMainRow ? cs.width : cs.height;
  const mainOwner = isMainRow ? ownerWidth : ownerHeight;
  const resolved = resolveMetric(mainStyleDim, mainOwner);
  if (isMetricDefined(resolved)) {
    const b = Math.max(0, resolved);
    child._fbBasis = b;
    child._fbOwnerW = ownerWidth;
    child._fbOwnerH = ownerHeight;
    child._fbAvailMain = availableMain;
    child._fbAvailCross = availableCross;
    child._fbCrossMode = crossMode;
    child._fbGen = _layoutGeneration;
    return b;
  }

  const crossStyleDim = isMainRow ? cs.height : cs.width;
  const crossOwner = isMainRow ? ownerHeight : ownerWidth;
  let crossConstraint = resolveMetric(crossStyleDim, crossOwner);
  let crossConstraintMode: MeasureMode = isMetricDefined(crossConstraint)
    ? MeasureMode.Exactly
    : MeasureMode.Undefined;
  if (!isMetricDefined(crossConstraint) && isMetricDefined(availableCross)) {
    crossConstraint = availableCross;
    crossConstraintMode =
      crossMode === MeasureMode.Exactly && isStretchAlignment(child)
        ? MeasureMode.Exactly
        : MeasureMode.AtMost;
  }

  let mainConstraint = NaN;
  let mainConstraintMode: MeasureMode = MeasureMode.Undefined;
  if (isMainRow && isMetricDefined(availableMain) && hasCustomMeasureInSubtree(child)) {
    mainConstraint = availableMain;
    mainConstraintMode = MeasureMode.AtMost;
  }

  const mw = isMainRow ? mainConstraint : crossConstraint;
  const mh = isMainRow ? crossConstraint : mainConstraint;
  const mwMode = isMainRow ? mainConstraintMode : crossConstraintMode;
  const mhMode = isMainRow ? crossConstraintMode : mainConstraintMode;

  computeLayout(child, mw, mh, mwMode, mhMode, ownerWidth, ownerHeight, false);
  const b = isMainRow ? child.layout.width : child.layout.height;
  child._fbBasis = b;
  child._fbOwnerW = ownerWidth;
  child._fbOwnerH = ownerHeight;
  child._fbAvailMain = availableMain;
  child._fbAvailCross = availableCross;
  child._fbCrossMode = crossMode;
  child._fbGen = _layoutGeneration;
  return b;
}

function hasCustomMeasureInSubtree(node: Node): boolean {
  if (node.measureFunc) return true;
  for (const c of node.children) {
    if (hasCustomMeasureInSubtree(c)) return true;
  }
  return false;
}

function distributeFlexSpace(
  children: Node[],
  availableInnerMain: number,
  totalFlexBasis: number,
  isMainRow: boolean,
  ownerW: number,
  ownerH: number,
): void {
  const n = children.length;
  const frozen: boolean[] = new Array(n).fill(false);
  const initialFree = isMetricDefined(availableInnerMain) ? availableInnerMain - totalFlexBasis : 0;

  for (let i = 0; i < n; i++) {
    const c = children[i]!;
    const clamped = constrainDimension(c.style, isMainRow, c._flexBasis, ownerW, ownerH);
    const inflexible =
      !isMetricDefined(availableInnerMain) ||
      (initialFree >= 0 ? c.style.flexGrow === 0 : c.style.flexShrink === 0);
    if (inflexible) {
      c._mainSize = Math.max(0, clamped);
      frozen[i] = true;
    } else {
      c._mainSize = c._flexBasis;
    }
  }

  const unclamped: number[] = new Array(n);
  for (let iter = 0; iter <= n; iter++) {
    let frozenDelta = 0;
    let totalGrow = 0;
    let totalShrinkScaled = 0;
    let unfrozenCount = 0;
    for (let i = 0; i < n; i++) {
      const c = children[i]!;
      if (frozen[i]) {
        frozenDelta += c._mainSize - c._flexBasis;
      } else {
        totalGrow += c.style.flexGrow;
        totalShrinkScaled += c.style.flexShrink * c._flexBasis;
        unfrozenCount++;
      }
    }
    if (unfrozenCount === 0) break;
    let remaining = initialFree - frozenDelta;

    if (remaining > 0 && totalGrow > 0 && totalGrow < 1) {
      const scaled = initialFree * totalGrow;
      if (scaled < remaining) remaining = scaled;
    } else if (remaining < 0 && totalShrinkScaled > 0) {
      let totalShrink = 0;
      for (let i = 0; i < n; i++) {
        if (!frozen[i]) totalShrink += children[i]!.style.flexShrink;
      }
      if (totalShrink < 1) {
        const scaled = initialFree * totalShrink;
        if (scaled > remaining) remaining = scaled;
      }
    }

    let totalViolation = 0;
    for (let i = 0; i < n; i++) {
      if (frozen[i]) continue;
      const c = children[i]!;
      let t = c._flexBasis;
      if (remaining > 0 && totalGrow > 0) {
        t += (remaining * c.style.flexGrow) / totalGrow;
      } else if (remaining < 0 && totalShrinkScaled > 0) {
        t += (remaining * (c.style.flexShrink * c._flexBasis)) / totalShrinkScaled;
      }
      unclamped[i] = t;
      const clamped = Math.max(0, constrainDimension(c.style, isMainRow, t, ownerW, ownerH));
      c._mainSize = clamped;
      totalViolation += clamped - t;
    }

    if (totalViolation === 0) break;
    let anyFrozen = false;
    for (let i = 0; i < n; i++) {
      if (frozen[i]) continue;
      const v = children[i]!._mainSize - unclamped[i]!;
      if ((totalViolation > 0 && v > 0) || (totalViolation < 0 && v < 0)) {
        frozen[i] = true;
        anyFrozen = true;
      }
    }
    if (!anyFrozen) break;
  }
}

function isStretchAlignment(child: Node): boolean {
  const p = child.parent;
  if (!p) return false;
  const align = child.style.alignSelf === Align.Auto ? p.style.alignItems : child.style.alignSelf;
  return align === Align.Stretch;
}

function resolveChildAlignment(parent: Node, child: Node): Align {
  return child.style.alignSelf === Align.Auto ? parent.style.alignItems : child.style.alignSelf;
}

function computeBaseline(node: Node): number {
  let baselineChild: Node | null = null;
  for (const c of node.children) {
    if (c._lineIndex > 0) break;
    if (c.style.positionType === PositionType.Absolute) continue;
    if (c.style.display === Display.None) continue;
    if (resolveChildAlignment(node, c) === Align.Baseline || c.isReferenceBaseline_) {
      baselineChild = c;
      break;
    }
    if (baselineChild === null) baselineChild = c;
  }
  if (baselineChild === null) return node.layout.height;
  return computeBaseline(baselineChild) + baselineChild.layout.top;
}

function isBaselineAligned(node: Node, flowChildren: Node[]): boolean {
  if (!isRowDirection(node.style.flexDirection)) return false;
  if (node.style.alignItems === Align.Baseline) return true;
  for (const c of flowChildren) {
    if (c.style.alignSelf === Align.Baseline) return true;
  }
  return false;
}

function getChildMarginAlongAxis(child: Node, axis: FlexDirection, ownerWidth: number): number {
  if (!child._hasMargin) return 0;
  const lead = resolveBoundary(child.style.margin, getOriginBoundary(axis), ownerWidth);
  const trail = resolveBoundary(child.style.margin, getTerminalBoundary(axis), ownerWidth);
  return lead + trail;
}

function resolveSpacing(style: DisplayStyle, gutter: Gutter, ownerSize: number): number {
  let v = style.gap[gutter]!;
  if (v.unit === Unit.Undefined) v = style.gap[Gutter.All]!;
  const r = resolveMetric(v, ownerSize);
  return isMetricDefined(r) ? Math.max(0, r) : 0;
}

function constrainDimension(
  style: DisplayStyle,
  isWidth: boolean,
  value: number,
  ownerWidth: number,
  ownerHeight: number,
): number {
  const minV = isWidth ? style.minWidth : style.minHeight;
  const maxV = isWidth ? style.maxWidth : style.maxHeight;
  const minU = minV.unit;
  const maxU = maxV.unit;

  if (minU === 0 && maxU === 0) return value;
  const owner = isWidth ? ownerWidth : ownerHeight;
  let v = value;

  if (maxU === 1) {
    if (v > maxV.value) v = maxV.value;
  } else if (maxU === 2) {
    const m = (maxV.value * owner) / 100;
    if (m === m && v > m) v = m;
  }
  if (minU === 1) {
    if (v < minV.value) v = minV.value;
  } else if (minU === 2) {
    const m = (minV.value * owner) / 100;
    if (m === m && v < m) v = m;
  }
  return v;
}

function resetLayoutRecursive(node: Node): void {
  for (const c of node.children) {
    c.layout.left = 0;
    c.layout.top = 0;
    c.layout.width = 0;
    c.layout.height = 0;

    c.isDirty_ = true;
    c._hasL = false;
    c._hasM = false;
    resetLayoutRecursive(c);
  }
}

function segregateChildren(node: Node, flow: Node[], abs: Node[]): void {
  for (const c of node.children) {
    const disp = c.style.display;
    if (disp === Display.None) {
      c.layout.left = 0;
      c.layout.top = 0;
      c.layout.width = 0;
      c.layout.height = 0;
      resetLayoutRecursive(c);
    } else if (disp === Display.Contents) {
      c.layout.left = 0;
      c.layout.top = 0;
      c.layout.width = 0;
      c.layout.height = 0;

      segregateChildren(c, flow, abs);
    } else if (c.style.positionType === PositionType.Absolute) {
      abs.push(c);
    } else {
      flow.push(c);
    }
  }
}

function snapLayoutToGrid(node: Node, scale: number, absLeft: number, absTop: number): void {
  if (scale === 0) return;
  const l = node.layout;
  const nodeLeft = l.left;
  const nodeTop = l.top;
  const nodeWidth = l.width;
  const nodeHeight = l.height;

  const absNodeLeft = absLeft + nodeLeft;
  const absNodeTop = absTop + nodeTop;

  const isText = node.measureFunc !== null;
  l.left = snapValueToGrid(nodeLeft, scale, false, isText);
  l.top = snapValueToGrid(nodeTop, scale, false, isText);

  const absRight = absNodeLeft + nodeWidth;
  const absBottom = absNodeTop + nodeHeight;
  const hasFracW = !isIntegerValue(nodeWidth * scale);
  const hasFracH = !isIntegerValue(nodeHeight * scale);
  l.width =
    snapValueToGrid(absRight, scale, isText && hasFracW, isText && !hasFracW) -
    snapValueToGrid(absNodeLeft, scale, false, isText);
  l.height =
    snapValueToGrid(absBottom, scale, isText && hasFracH, isText && !hasFracH) -
    snapValueToGrid(absNodeTop, scale, false, isText);

  for (const c of node.children) {
    snapLayoutToGrid(c, scale, absNodeLeft, absNodeTop);
  }
}

function isIntegerValue(v: number): boolean {
  const frac = v - Math.floor(v);
  return frac < 0.0001 || frac > 0.9999;
}

function snapValueToGrid(
  v: number,
  scale: number,
  forceCeil: boolean,
  forceFloor: boolean,
): number {
  let scaled = v * scale;
  let frac = scaled - Math.floor(scaled);
  if (frac < 0) frac += 1;

  if (frac < 0.0001) {
    scaled = Math.floor(scaled);
  } else if (frac > 0.9999) {
    scaled = Math.ceil(scaled);
  } else if (forceCeil) {
    scaled = Math.ceil(scaled);
  } else if (forceFloor) {
    scaled = Math.floor(scaled);
  } else {
    scaled = Math.floor(scaled) + (frac >= 0.4999 ? 1 : 0);
  }
  return scaled / scale;
}

function parseDimensionInput(v: number | string | undefined): Value {
  if (v === undefined) return UNDEFINED_METRIC;
  if (v === "auto") return AUTO_METRIC;
  if (typeof v === "number") {
    return Number.isFinite(v) ? metricPoints(v) : UNDEFINED_METRIC;
  }
  if (typeof v === "string" && v.endsWith("%")) {
    return metricPercent(parseFloat(v));
  }
  const n = parseFloat(v);
  return Number.isNaN(n) ? UNDEFINED_METRIC : metricPoints(n);
}

function resolvePhysicalBoundary(edge: Edge): number {
  switch (edge) {
    case Edge.Left:
    case Edge.Start:
      return BOUNDARY_LEFT;
    case Edge.Top:
      return BOUNDARY_TOP;
    case Edge.Right:
    case Edge.End:
      return BOUNDARY_RIGHT;
    case Edge.Bottom:
      return BOUNDARY_BOTTOM;
    default:
      return BOUNDARY_LEFT;
  }
}

export type Yoga = {
  LayoutConfig: {
    create(): LayoutConfig;
    destroy(config: LayoutConfig): void;
  };
  Node: {
    create(config?: LayoutConfig): Node;
    createDefault(): Node;
    createWithConfig(config: LayoutConfig): Node;
    destroy(node: Node): void;
  };
};

const LAYOUT_ENGINE: Yoga = {
  LayoutConfig: {
    create: createLayoutConfig,
    destroy() {},
  },
  Node: {
    create: (config?: LayoutConfig) => new Node(config),
    createDefault: () => new Node(),
    createWithConfig: (config: LayoutConfig) => new Node(config),
    destroy() {},
  },
};

export function loadLayoutEngine(): Promise<Yoga> {
  return Promise.resolve(LAYOUT_ENGINE);
}

export default LAYOUT_ENGINE;
