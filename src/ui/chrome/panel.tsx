import type { ReactNode } from "react";
import {
  Box,
  type Color as InkColor,
  type Key,
  Text,
  useInput,
  useIsScreenReaderEnabled,
  useTerminalDimensions,
} from "@/ink";
import { computeListWindow } from "@/kernel/std/list-window.ts";
import { clamp } from "@/kernel/std/math.ts";
import { useIsInsideModal } from "@/ui/chrome/modal-reduced-context.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

export const PanelColor = {
  get chevron(): InkColor {
    return Color.highlight;
  },
  get selected(): InkColor {
    return Color.highlight;
  },
  get active(): InkColor {
    return Color.success;
  },
  get label(): InkColor {
    return Color.text;
  },
  get muted(): InkColor {
    return Color.muted;
  },
  get tab(): InkColor {
    return Color.muted;
  },
  get tabSelected(): InkColor {
    return Color.primaryGlow;
  },
  get tabSelectedText(): InkColor {
    return Color.tabSelectedText;
  },
};

export interface PanelFrameProps {
  title: string;
  hint?: string;
  width?: number;
  children: ReactNode;
}

export interface FooterPanelTab {
  label: string;
}

export interface FooterPanelSearch {
  query: string;
  placeholder: string;
  focused: boolean;
}

export interface FooterPanelProps {
  command?: string;
  title?: string | ReactNode;
  subtitle?: ReactNode;
  tabs?: FooterPanelTab[];
  activeTab?: number;
  tabsFocused?: boolean;
  search?: FooterPanelSearch | undefined;
  footerHints?: [string, string][];
  inputGuide?: string;
  onCancel?: (() => void) | undefined;
  disableCancelKey?: boolean;
  accent?: InkColor;
  titleColor?: InkColor;
  flushTop?: boolean;
  children: ReactNode;
}

export interface FooterPanelTabsProps {
  tabs: FooterPanelTab[];
  activeTab: number;
  focused?: boolean;
  marginTop?: number;
  paddingX?: number;
}

export interface FooterPanelRowProps {
  label: string | ReactNode;
  labelSuffix?: ReactNode | undefined;
  labelSuffixWidth?: number | undefined;
  value?: string | undefined;
  description?: string | undefined;
  descriptionPlacement?: "after-value" | "after-label" | undefined;
  selected?: boolean | undefined;
  active?: boolean | undefined;
  muted?: boolean | undefined;
  valueColor?: InkColor | undefined;
  width?: number;
}

export interface FooterPanelPickerRowProps {
  label: string | ReactNode;
  description?: string | ReactNode;
  selected?: boolean;
  marker?: string;
  labelBold?: boolean;
  labelItalic?: boolean;
  rows?: number;
}

export interface FooterPanelOutputBoxProps {
  children: ReactNode;
  height?: number;
  width?: number;
}

export function PanelFrame({ title, hint, width, children }: PanelFrameProps): React.JSX.Element {
  const screenReader = useIsScreenReaderEnabled();
  const insideModal = useIsInsideModal();
  if (screenReader) {
    return (
      <Box flexDirection="column" width={width ?? "100%"}>
        <Text bold>
          {title}
          {hint ? ` ${hint}` : ""}
        </Text>
        {children}
      </Box>
    );
  }
  if (insideModal) {
    return (
      <Box flexDirection="column" width={width ?? "100%"}>
        <Text bold color={Color.primaryGlow}>
          {title}
          {!!hint && ` ${hint}`}
        </Text>
        {children}
      </Box>
    );
  }
  return (
    <Box
      flexDirection="column"
      width={width ?? "100%"}
      borderStyle="single"
      borderColor={Color.primaryGlow}
    >
      <Box paddingX={1} borderStyle="single" borderColor={Color.border}>
        <Text bold color={Color.primaryGlow}>
          {title}
        </Text>
        {!!hint && (
          <>
            <Text> </Text>
            <Text color={Color.muted}>{hint}</Text>
          </>
        )}
      </Box>
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        {children}
      </Box>
    </Box>
  );
}

export function FooterPanelOutputBox({
  children,
  height,
  width,
}: FooterPanelOutputBoxProps): React.JSX.Element {
  return (
    <Box
      borderStyle="round"
      borderColor={Color.border}
      flexDirection="column"
      paddingX={1}
      {...(height !== undefined ? { height } : {})}
      {...(width !== undefined ? { width } : {})}
    >
      {children}
    </Box>
  );
}

export function FooterPanel({
  command,
  title,
  subtitle,
  tabs,
  activeTab = 0,
  tabsFocused = false,
  search,
  footerHints = [],
  inputGuide,
  onCancel,
  disableCancelKey = false,
  accent,
  titleColor,
  flushTop = false,
  children,
}: FooterPanelProps): React.JSX.Element {
  const { columns } = useTerminalDimensions();
  const screenReader = useIsScreenReaderEnabled();
  const insideModal = useIsInsideModal();
  useFooterPanelCancel(onCancel, disableCancelKey || insideModal);
  const width = Math.max(1, columns);
  const hue = accent ?? Color.primaryGlow;
  const headlineColor = titleColor ?? hue;

  if (screenReader) {
    return (
      <Box flexDirection="column" width="100%">
        {command !== undefined && <Text bold>{command}</Text>}
        {title !== undefined &&
          (typeof title === "string" ? <Text bold>{title}</Text> : <Box>{title}</Box>)}
        {!!subtitle && <Text>{subtitle}</Text>}
        <Box flexDirection="column">{children}</Box>
        {!!inputGuide && <Text italic>{inputGuide}</Text>}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width="100%">
      {command !== undefined && (
        <>
          <Box backgroundColor={Color.inverseBg}>
            <Text color={Color.chevron} backgroundColor={Color.inverseBg}>
              {Glyph.chevron}
            </Text>
            <Text color={Color.userText} backgroundColor={Color.inverseBg} bold>
              {command}
            </Text>
            <Text backgroundColor={Color.inverseBg}>
              {" ".repeat(Math.max(0, width - command.length - 2))}
            </Text>
          </Box>
          <Box height={1} />
        </>
      )}
      <Text color={hue}>{Glyph.boxHLine.repeat(width)}</Text>
      {(title !== undefined || (tabs !== undefined && tabs.length > 0)) && (
        <Box flexDirection="row" paddingX={2} alignItems="center">
          {title !== undefined && (
            <Box marginRight={tabs !== undefined && tabs.length > 0 ? 1 : 2}>
              {typeof title === "string" ? (
                <Text color={headlineColor} bold>
                  {title}
                </Text>
              ) : (
                title
              )}
            </Box>
          )}
          {tabs !== undefined && tabs.length > 0 && (
            <FooterPanelTabs
              tabs={tabs}
              activeTab={activeTab}
              focused={tabsFocused}
              marginTop={0}
              paddingX={0}
            />
          )}
        </Box>
      )}
      {!!subtitle && (
        <Box marginTop={1} paddingX={2}>
          {typeof subtitle === "string" ? <Text dim>{subtitle}</Text> : subtitle}
        </Box>
      )}
      {search !== undefined && (
        <Box marginBottom={1} paddingX={2}>
          <Box
            borderStyle="round"
            {...(search.focused ? { borderColor: Color.highlight } : { borderDimColor: true })}
            paddingX={1}
            width="100%"
          >
            <Text color={search.focused ? undefined : Color.muted}>
              <Text>{`${Glyph.search} `}</Text>
              {search.query.length > 0 ? (
                <>
                  <Text color={search.focused ? Color.text : undefined}>{search.query}</Text>
                  {search.focused && <Text inverse> </Text>}
                </>
              ) : (
                <PlaceholderCursor placeholder={search.placeholder} focused={search.focused} />
              )}
            </Text>
          </Box>
        </Box>
      )}
      <Box flexDirection="column" paddingX={2} marginTop={contentMarginTop(search, flushTop)}>
        {children}
      </Box>
      {!!inputGuide && (
        <Box marginTop={1} paddingX={2}>
          <Text color={Color.muted} italic wrap="truncate-end">
            {inputGuide}
          </Text>
        </Box>
      )}
      {footerHints.length > 0 && (
        <Box marginTop={1} paddingX={2} flexWrap="wrap">
          {footerHints.map(([key, label], index) => (
            <Box key={`${key}:${label}`} marginRight={index + 1 === footerHints.length ? 0 : 1}>
              <Text color={Color.muted}>
                {key} {label}
                {index + 1 === footerHints.length ? "" : " ·"}
              </Text>
            </Box>
          ))}
        </Box>
      )}
      <Box height={1} />
    </Box>
  );
}

function useFooterPanelCancel(onCancel: (() => void) | undefined, disableCancelKey: boolean): void {
  useInput(
    (_input, key) => {
      if (key.escape && onCancel) onCancel();
    },
    { isActive: !!onCancel && !disableCancelKey },
  );
}

function contentMarginTop(search: FooterPanelSearch | undefined, flushTop: boolean): number {
  if (search !== undefined) return 0;
  return flushTop ? 0 : 1;
}

export function FooterPanelTabs({
  tabs,
  activeTab,
  marginTop = 0,
  paddingX = 0,
}: FooterPanelTabsProps): React.JSX.Element {
  return (
    <Box marginTop={marginTop} paddingX={paddingX}>
      {tabs.map((tab, index) => {
        const active = index === activeTab;
        return (
          <Box key={tab.label} marginRight={tabMarginRight(index, tabs.length, active)}>
            <TabChip label={tab.label} active={active} />
          </Box>
        );
      })}
    </Box>
  );
}

function rowMarkerColor(active: boolean, selected: boolean): InkColor {
  if (active) return PanelColor.active;
  if (selected) return PanelColor.chevron;
  return PanelColor.muted;
}

function rowLabelColor(muted: boolean, selected: boolean): InkColor {
  if (muted) return PanelColor.muted;
  if (selected) return PanelColor.selected;
  return PanelColor.label;
}

export function FooterPanelRow({
  label,
  labelSuffix,
  labelSuffixWidth = 0,
  value,
  description,
  descriptionPlacement = "after-value",
  selected = false,
  active = false,
  muted = false,
  valueColor,
  width = 34,
}: FooterPanelRowProps): React.JSX.Element {
  const markerColor = rowMarkerColor(active, selected);
  const labelColor = rowLabelColor(muted, selected);
  const labelLen = typeof label === "string" ? label.length : 0;
  const descriptionText = description === undefined ? undefined : ` (${description})`;
  const descriptionWidth = Math.max(0, width - labelLen - labelSuffixWidth);
  const labelPadding =
    descriptionPlacement === "after-label" && descriptionText !== undefined
      ? 0
      : value !== undefined
        ? Math.max(1, width - labelLen - labelSuffixWidth)
        : Math.max(0, width - labelLen - labelSuffixWidth);
  return (
    <Box width="100%" overflow="hidden">
      {/* The marker never shrinks: as the row's only flexible child it would
          absorb narrow-width overflow, wrapping its spaces into a phantom
          second line that shifts every row below. */}
      <Box flexShrink={0}>
        <Text color={markerColor}>{selected || active ? Glyph.chevron : "  "}</Text>
      </Box>
      <Box width={width} flexShrink={0}>
        {typeof label === "string" ? (
          <Text color={labelColor} bold={selected}>
            {label}
          </Text>
        ) : (
          label
        )}
        {labelSuffix}
        {descriptionPlacement === "after-label" && descriptionText !== undefined && (
          <Box width={descriptionWidth} overflow="hidden">
            <Text color={Color.subtle} wrap="truncate-end">
              {descriptionText}
            </Text>
          </Box>
        )}
        <Text color={labelColor} bold={selected}>
          {" ".repeat(labelPadding)}
        </Text>
      </Box>
      {value !== undefined && (
        <Box flexShrink={0}>
          {/* One-line ellipsis: default wrap would fold an edge-clamped value
              onto a second row at narrow widths. */}
          <Text color={valueColor ?? (muted ? Color.muted : Color.text)} wrap="truncate-end">
            {value}
          </Text>
        </Box>
      )}
      {descriptionPlacement !== "after-label" && descriptionText !== undefined && (
        <Box flexGrow={1} overflow="hidden">
          <Text color={Color.muted} wrap="truncate-end">
            {descriptionText}
          </Text>
        </Box>
      )}
    </Box>
  );
}

export function FooterPanelPickerRow({
  label,
  description,
  selected = false,
  marker,
  labelBold = false,
  labelItalic = false,
  rows = 3,
}: FooterPanelPickerRowProps): React.JSX.Element {
  const rowMarker = marker ?? (selected ? Glyph.chevron : "  ");
  const labelColor = selected ? Color.highlight : Color.text;
  return (
    <Box flexDirection="column" height={rows} width="100%" overflow="hidden">
      <Box height={1} width="100%">
        <Text color={selected ? Color.highlight : Color.muted}>{rowMarker}</Text>
        {typeof label === "string" ? (
          <Text
            color={labelColor}
            bold={labelBold || selected}
            italic={labelItalic}
            wrap="truncate-end"
          >
            {label}
          </Text>
        ) : (
          label
        )}
      </Box>
      {description !== undefined && (
        <Box height={1} paddingLeft={2} width="100%">
          {typeof description === "string" ? (
            <Text color={Color.muted} wrap="truncate-end">
              {description}
            </Text>
          ) : (
            description
          )}
        </Box>
      )}
    </Box>
  );
}

function PlaceholderCursor({
  placeholder,
  focused,
}: {
  placeholder: string;
  focused: boolean;
}): React.JSX.Element {
  if (!focused) return <Text color={Color.muted}>{placeholder}</Text>;
  const [first = " ", ...rest] = [...placeholder];
  return (
    <>
      <Text inverse>{first}</Text>
      <Text color={Color.muted}>{rest.join("")}</Text>
    </>
  );
}

function TabChip({ label, active }: { label: string; active: boolean }): React.JSX.Element {
  if (!active) return <Text>{label}</Text>;
  return (
    <Text
      bold
      backgroundColor={PanelColor.tabSelected}
      color={PanelColor.tabSelectedText}
    >{` ${label} `}</Text>
  );
}

function tabMarginRight(index: number, count: number, active: boolean): number {
  if (index + 1 === count) return 0;
  return active ? 2 : 3;
}

export function ListOverflowIndicator({
  direction,
  count,
  suffix,
  paddingLeft = 0,
}: {
  direction: "up" | "down";
  count?: number;
  suffix?: "above" | "below";
  paddingLeft?: number;
}): React.JSX.Element {
  const arrow = direction === "up" ? Glyph.arrowUp : Glyph.arrowDown;
  return (
    <Box height={1} paddingLeft={paddingLeft} overflow="hidden">
      <Text
        color={Color.muted}
      >{`${arrow}${count === undefined ? "" : ` ${count}`} more${suffix === undefined ? "" : ` ${suffix}`}`}</Text>
    </Box>
  );
}

export function PanelDivider({ width }: { width: number }): React.JSX.Element {
  return <Text color={Color.border}>{Glyph.boxHLine.repeat(width)}</Text>;
}

export function panelDividerText(width: number): string {
  return Glyph.boxHLine.repeat(width);
}

const WINDOW_MIN_ROWS = 3;
const WINDOW_CHROME_ROWS = 7;
const WINDOW_OVERFLOW_INDICATOR_ROWS = 2;
export interface ListPanelItem {
  id: string;
  label: string | ReactNode;
  labelSuffix?: ReactNode;
  labelSuffixWidth?: number;
  value?: string;
  active?: boolean;
  muted?: boolean;
  valueColor?: InkColor;
}

export interface ListPanelProps {
  command?: string;
  title: string | ReactNode;
  subtitle?: ReactNode;
  items: ListPanelItem[];
  selectedIndex: number;
  onSelectedIndexChange: (index: number) => void;
  onSelect?: (item: ListPanelItem) => void;
  onCancel?: () => void;
  search?: FooterPanelSearch & {
    onChange: (query: string) => void;
  };
  footerHints?: [string, string][];
  onKey?: (input: string, key: Key) => boolean;
  rowWidth?: number;
  children?: ReactNode;
}

export function ListPanel({
  command,
  title,
  subtitle,
  items,
  selectedIndex,
  onSelectedIndexChange,
  onSelect,
  onCancel,
  search,
  footerHints = [],
  onKey,
  rowWidth,
  children,
}: ListPanelProps): React.JSX.Element {
  const { rows } = useTerminalDimensions();
  const cursor = Math.min(selectedIndex, Math.max(0, items.length - 1));

  useInput((input, key) => {
    if (key.escape) {
      onCancel?.();
      return;
    }

    if (onKey?.(input, key)) return;

    if (key.return && onSelect && items[cursor]) {
      onSelect(items[cursor]!);
      return;
    }

    if (key.upArrow) {
      onSelectedIndexChange(Math.max(0, cursor - 1));
      return;
    }

    if (key.downArrow) {
      onSelectedIndexChange(Math.min(Math.max(0, items.length - 1), cursor + 1));
      return;
    }
  });

  const size = clamp(rows - WINDOW_CHROME_ROWS, WINDOW_MIN_ROWS, items.length);
  const overflow = items.length > size;
  const itemWindowSize = overflow ? Math.max(1, size - WINDOW_OVERFLOW_INDICATOR_ROWS) : size;
  const window = computeListWindow({
    cursor,
    total: items.length,
    size: itemWindowSize,
    anchor: "bottom",
  });
  const visible = items.slice(window.from, window.to);

  const footerProps: FooterPanelProps = {
    title,
    subtitle,
    search,
    footerHints,
    children,
  };
  if (command !== undefined) {
    footerProps.command = command;
  }

  return (
    <FooterPanel {...footerProps}>
      {items.length === 0 ? (
        <Text color={Color.muted}>No items found.</Text>
      ) : (
        <Box flexDirection="column">
          {overflow &&
            (window.above > 0 ? (
              <ListOverflowIndicator
                direction="up"
                count={window.above}
                suffix="above"
                paddingLeft={2}
              />
            ) : (
              <Box height={1} />
            ))}
          {visible.map((item, index) => {
            const rowProps: FooterPanelRowProps = {
              label: item.label,
              labelSuffix: item.labelSuffix,
              labelSuffixWidth: item.labelSuffixWidth,
              value: item.value,
              selected: window.from + index === cursor,
              active: item.active,
              muted: item.muted,
              valueColor: item.valueColor,
            };
            if (rowWidth !== undefined) {
              rowProps.width = rowWidth;
            }
            return <FooterPanelRow key={item.id} {...rowProps} />;
          })}
          {overflow &&
            (window.below > 0 ? (
              <ListOverflowIndicator
                direction="down"
                count={window.below}
                suffix="below"
                paddingLeft={2}
              />
            ) : (
              <Box height={1} />
            ))}
        </Box>
      )}
    </FooterPanel>
  );
}
