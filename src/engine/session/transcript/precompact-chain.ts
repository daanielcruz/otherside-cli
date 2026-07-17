export interface PreservedSegment {
  headUuid: string;
  tailUuid: string;
  anchorUuid: string;
}

export interface PreservedMessages {
  uuids: string[];
  anchorUuid: string;
}

export interface PrecompactChainEntry {
  uuid: string;
  parentUuid: string | null;
  logicalParentUuid?: string;
  offset: number;
  type: string;
  subtype?: string;
  compactMetadata?: unknown;
  /** False when a legacy compact marker has no usable summary and is not a boundary. */
  hasCompactionSummary?: boolean;
}

export interface PrecompactChainPlan {
  ordered: PrecompactChainEntry[];
  parentOverrides: ReadonlyMap<string, string | null>;
  boundaryOffset: number | null;
  preserve: "none" | "live" | "broken";
  brokenBoundaryUuid?: string;
}

/**
 * "boundary" selects the active model-context segment from the last valid
 * compact boundary onward. "full" keeps the whole recorded render history: the
 * walk still selects the active lineage (dead branches drop), but ancestry
 * continues across boundaries into pre-compact history and preserves file order.
 */
export type PrecompactChainScope = "boundary" | "full";

interface PreserveSpec {
  uuids: string[];
  anchorUuid: string;
  headUuid: string;
  tailUuid: string;
}

export function planPrecompactChain(
  entries: readonly PrecompactChainEntry[],
  latestUuid: string | undefined,
  selectedLeafUuid: string | undefined,
  scope: PrecompactChainScope = "boundary",
): PrecompactChainPlan {
  const { entries: chainEntries, parentOverrides: invalidBoundaryParents } =
    reconnectInvalidBoundaries(entries);
  const compactMarkers = chainEntries.filter(
    (entry) => entry.type === "system" && entry.subtype === "compact_boundary",
  );
  const boundaries = compactMarkers.filter((entry) => entry.hasCompactionSummary !== false);
  const lastBoundary = boundaries.at(-1);
  if (lastBoundary === undefined) {
    if (compactMarkers.length === 0) {
      return walkPlan(entries, latestUuid, selectedLeafUuid, new Map(), null, "none", scope);
    }
    // An empty legacy marker has no summary to replace the preceding transcript,
    // so leave every line untouched rather than following its reset parent.
    return {
      ordered: [...entries],
      parentOverrides: new Map(),
      boundaryOffset: null,
      preserve: "none",
    };
  }

  const byUuid = new Map(chainEntries.map((entry) => [entry.uuid, entry]));
  const preserve = preserveSpec(lastBoundary, byUuid);
  if (preserve === "broken") {
    return {
      ordered: [...entries],
      parentOverrides: new Map(),
      boundaryOffset: null,
      preserve: "broken",
      brokenBoundaryUuid: lastBoundary.uuid,
    };
  }
  if (preserve === null) {
    return walkPlan(
      scope === "full"
        ? chainEntries
        : chainEntries.filter((entry) => entry.offset >= lastBoundary.offset),
      latestUuid,
      dropStaleLeaf(selectedLeafUuid, byUuid, lastBoundary.offset, null),
      invalidBoundaryParents,
      lastBoundary.offset,
      "none",
      scope,
    );
  }

  const kept = new Set(preserve.uuids);
  const active =
    scope === "full"
      ? [...chainEntries]
      : chainEntries.filter((entry) => entry.offset >= lastBoundary.offset || kept.has(entry.uuid));
  const parentOverrides = new Map<string, string | null>(invalidBoundaryParents);
  let parent = preserve.anchorUuid;
  for (const uuid of preserve.uuids) {
    parentOverrides.set(uuid, parent);
    parent = uuid;
  }
  for (const entry of active) {
    const effectiveParent = parentOverrides.get(entry.uuid) ?? entry.parentUuid;
    if (effectiveParent === preserve.anchorUuid && entry.uuid !== preserve.headUuid) {
      parentOverrides.set(entry.uuid, preserve.tailUuid);
    }
  }
  const latestLeafUuid = latestUuid === lastBoundary.uuid ? preserve.tailUuid : latestUuid;
  const remappedLeaf =
    selectedLeafUuid === lastBoundary.uuid ? preserve.tailUuid : selectedLeafUuid;
  return walkPlan(
    active,
    latestLeafUuid,
    dropStaleLeaf(remappedLeaf, byUuid, lastBoundary.offset, kept),
    parentOverrides,
    lastBoundary.offset,
    "live",
    scope,
  );
}

// A leaf recorded before the last boundary belongs to the replaced history
// (unless it is part of the preserved tail); selecting it would walk a
// pre-compact lineage and lose the live segment.
function dropStaleLeaf(
  leafUuid: string | undefined,
  byUuid: ReadonlyMap<string, PrecompactChainEntry>,
  boundaryOffset: number,
  kept: ReadonlySet<string> | null,
): string | undefined {
  if (leafUuid === undefined) return undefined;
  if (kept?.has(leafUuid)) return leafUuid;
  const entry = byUuid.get(leafUuid);
  if (entry !== undefined && entry.offset < boundaryOffset) return undefined;
  return leafUuid;
}

function reconnectInvalidBoundaries(entries: readonly PrecompactChainEntry[]): {
  entries: readonly PrecompactChainEntry[];
  parentOverrides: Map<string, string | null>;
} {
  const parentOverrides = new Map<string, string | null>();
  let priorUuid: string | null = null;
  for (const entry of entries) {
    const isInvalidBoundary =
      entry.type === "system" &&
      entry.subtype === "compact_boundary" &&
      entry.hasCompactionSummary === false;
    if (isInvalidBoundary) {
      const logicalParent =
        typeof entry.logicalParentUuid === "string" && entry.logicalParentUuid.length > 0
          ? entry.logicalParentUuid
          : null;
      const parent: string | null =
        logicalParent ?? (entry.parentUuid !== null ? entry.parentUuid : priorUuid);
      if (parent !== null && parent !== entry.uuid) parentOverrides.set(entry.uuid, parent);
    }
    priorUuid = entry.uuid;
  }
  return { entries, parentOverrides };
}

function preserveSpec(
  boundary: PrecompactChainEntry,
  byUuid: ReadonlyMap<string, PrecompactChainEntry>,
): PreserveSpec | "broken" | null {
  const metadata = objectRecord(boundary.compactMetadata);
  if (metadata === null) return null;

  const messages = objectRecord(metadata.preservedMessages);
  const segment = objectRecord(metadata.preservedSegment);
  if (messages === null && segment === null) return null;

  const messageSpec =
    messages === null ? null : preservedMessagesSpec(messages, boundary.uuid, byUuid);
  if (messageSpec === "broken") return "broken";
  const segmentSpec =
    segment === null ? null : preservedSegmentSpec(segment, boundary.uuid, byUuid);
  if (segmentSpec === "broken") return "broken";
  return messageSpec ?? segmentSpec;
}

function preservedMessagesSpec(
  messages: Record<string, unknown>,
  boundaryUuid: string,
  byUuid: ReadonlyMap<string, PrecompactChainEntry>,
): PreserveSpec | "broken" {
  const anchorUuid = stringValue(messages.anchorUuid);
  const uuids = Array.isArray(messages.uuids)
    ? messages.uuids.filter((uuid): uuid is string => typeof uuid === "string")
    : [];
  if (
    anchorUuid === null ||
    anchorUuid !== boundaryUuid ||
    !byUuid.has(anchorUuid) ||
    uuids.length === 0 ||
    uuids.some((uuid) => !byUuid.has(uuid))
  ) {
    return "broken";
  }
  return {
    uuids,
    anchorUuid,
    headUuid: uuids[0]!,
    tailUuid: uuids.at(-1)!,
  };
}

function preservedSegmentSpec(
  segment: Record<string, unknown>,
  boundaryUuid: string,
  byUuid: ReadonlyMap<string, PrecompactChainEntry>,
): PreserveSpec | "broken" {
  const headUuid = stringValue(segment.headUuid);
  const tailUuid = stringValue(segment.tailUuid);
  const anchorUuid = stringValue(segment.anchorUuid);
  if (
    headUuid === null ||
    tailUuid === null ||
    anchorUuid === null ||
    anchorUuid !== boundaryUuid ||
    !byUuid.has(anchorUuid)
  )
    return "broken";

  const reversed: string[] = [];
  const seen = new Set<string>();
  let current = byUuid.get(tailUuid);
  while (current !== undefined && !seen.has(current.uuid)) {
    seen.add(current.uuid);
    reversed.push(current.uuid);
    if (current.uuid === headUuid) {
      return { uuids: reversed.reverse(), headUuid, tailUuid, anchorUuid };
    }
    current = current.parentUuid === null ? undefined : byUuid.get(current.parentUuid);
  }
  return "broken";
}

function walkPlan(
  entries: readonly PrecompactChainEntry[],
  latestUuid: string | undefined,
  selectedLeafUuid: string | undefined,
  parentOverrides: ReadonlyMap<string, string | null>,
  boundaryOffset: number | null,
  preserve: PrecompactChainPlan["preserve"],
  scope: PrecompactChainScope = "boundary",
): PrecompactChainPlan {
  const byUuid = new Map(entries.map((entry) => [entry.uuid, entry]));
  const preferredLeaf =
    selectedLeafUuid !== undefined && byUuid.has(selectedLeafUuid)
      ? selectedLeafUuid
      : latestUuid !== undefined && byUuid.has(latestUuid)
        ? latestUuid
        : entries.at(-1)?.uuid;
  const reversed: PrecompactChainEntry[] = [];
  const seen = new Set<string>();
  let uuid = preferredLeaf;
  let broken = false;
  while (uuid !== undefined && !seen.has(uuid)) {
    seen.add(uuid);
    const entry = byUuid.get(uuid);
    if (entry === undefined) {
      broken = true;
      break;
    }
    reversed.push(entry);
    const parent = parentOverrides.has(uuid) ? parentOverrides.get(uuid) : entry.parentUuid;
    uuid = parent ?? undefined;
  }

  if (broken || reversed.length === 0) {
    return { ordered: [...entries], parentOverrides, boundaryOffset, preserve };
  }
  if (scope === "full") {
    // The stitched walk stops where a preserve relink or a boundary's reset
    // parent meets an already-visited uuid; flood the ORIGINAL ancestry so the
    // pre-compact history stays loaded. Dead branches never join: flooding
    // follows parent pointers only, so descendants off the lineage stay out.
    const stack = [...reversed];
    while (stack.length > 0) {
      const entry = stack.pop();
      if (entry === undefined) break;
      for (const parent of [entry.logicalParentUuid, entry.parentUuid]) {
        if (typeof parent !== "string" || seen.has(parent)) continue;
        const parentEntry = byUuid.get(parent);
        if (parentEntry === undefined) continue;
        seen.add(parent);
        reversed.push(parentEntry);
        stack.push(parentEntry);
      }
    }
    const ordered = reversed.sort((a, b) => a.offset - b.offset);
    return { ordered, parentOverrides, boundaryOffset, preserve };
  }
  return { ordered: reversed.reverse(), parentOverrides, boundaryOffset, preserve };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
