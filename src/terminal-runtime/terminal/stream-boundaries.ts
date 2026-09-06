import { C0, ESC_TYPE, isEscFinal } from "@/terminal-runtime/terminal/ansi-control.js";
import {
  isCSIFinal,
  isCSIIntermediate,
  isCSIParam,
} from "@/terminal-runtime/terminal/control-sequences.js";

export type InputFragment = { type: "text"; value: string } | { type: "sequence"; value: string };

export type BoundaryScanner = {
  accept(chunk: string): InputFragment[];
  drain(): InputFragment[];
  clear(): void;
  remainder(): string;
};

type BoundaryPolicy = {
  legacyMousePayload?: boolean;
};

type LexicalMode =
  | "plain"
  | "afterEscape"
  | "escapeBody"
  | "controlBody"
  | "applicationKey"
  | "stringBody";

type LexicalState = {
  mode: LexicalMode;
  pending: string;
  stringKind?: "osc" | "controlString";
};

const LEGACY_MOUSE_BYTES = 3;
const MOUSE_MARKER_OFFSET = 2;
const PRINTABLE_CODE_START = 0x20;

export function openBoundaryScanner(policy: BoundaryPolicy = {}): BoundaryScanner {
  let lexicalState: LexicalState = { mode: "plain", pending: "" };
  const keepLegacyMousePayload = policy.legacyMousePayload === true;

  const partition = (chunk: string, finish: boolean): InputFragment[] => {
    const result = partitionTerminalStream(lexicalState, chunk, finish, keepLegacyMousePayload);
    lexicalState = result.next;
    return result.fragments;
  };

  return {
    accept: (chunk) => partition(chunk, false),
    drain: () => partition("", true),
    clear: () => {
      lexicalState = { mode: "plain", pending: "" };
    },
    remainder: () => lexicalState.pending,
  };
}

type BoundaryResult = {
  fragments: InputFragment[];
  next: LexicalState;
};

function partitionTerminalStream(
  starting: LexicalState,
  incoming: string,
  finish: boolean,
  keepLegacyMousePayload: boolean,
): BoundaryResult {
  const source = starting.pending + incoming;
  const fragments: InputFragment[] = [];
  let mode = starting.mode;
  let stringKind = starting.stringKind;
  let position = 0;
  let plainStart = 0;
  let sequenceStart = 0;

  const appendPlain = (end: number): void => {
    if (end > plainStart) fragments.push({ type: "text", value: source.slice(plainStart, end) });
  };

  const appendSequence = (end: number): void => {
    if (end > sequenceStart) {
      fragments.push({ type: "sequence", value: source.slice(sequenceStart, end) });
    }
    mode = "plain";
    stringKind = undefined;
    plainStart = end;
  };

  const rejectSequence = (): void => {
    mode = "plain";
    stringKind = undefined;
    plainStart = sequenceStart;
  };

  while (position < source.length) {
    const code = source.charCodeAt(position);

    if (mode === "plain") {
      if (code === C0.ESC) {
        appendPlain(position);
        sequenceStart = position;
        mode = "afterEscape";
      }
      position++;
      continue;
    }

    if (mode === "afterEscape") {
      if (code === ESC_TYPE.CSI) {
        mode = "controlBody";
        position++;
      } else if (code === ESC_TYPE.OSC || code === ESC_TYPE.DCS || code === ESC_TYPE.APC) {
        mode = "stringBody";
        stringKind = code === ESC_TYPE.OSC ? "osc" : "controlString";
        position++;
      } else if (code === 0x4f) {
        mode = "applicationKey";
        position++;
      } else if (isCSIIntermediate(code)) {
        mode = "escapeBody";
        position++;
      } else if (isEscFinal(code)) {
        position++;
        appendSequence(position);
      } else if (code === C0.ESC) {
        appendSequence(position);
        sequenceStart = position;
        mode = "afterEscape";
        position++;
      } else {
        rejectSequence();
      }
      continue;
    }

    if (mode === "escapeBody") {
      if (isCSIIntermediate(code)) {
        position++;
      } else if (isEscFinal(code)) {
        position++;
        appendSequence(position);
      } else {
        rejectSequence();
      }
      continue;
    }

    if (mode === "controlBody") {
      const mouseEnd = keepLegacyMousePayload
        ? legacyMouseEndpoint(source, sequenceStart, position)
        : undefined;
      if (mouseEnd !== undefined) {
        if (mouseEnd <= source.length) {
          position = mouseEnd;
          appendSequence(position);
        } else {
          position = source.length;
        }
      } else if (isCSIFinal(code)) {
        position++;
        appendSequence(position);
      } else if (isCSIParam(code) || isCSIIntermediate(code)) {
        position++;
      } else {
        rejectSequence();
      }
      continue;
    }

    if (mode === "applicationKey") {
      if (isCSIFinal(code)) {
        position++;
        appendSequence(position);
      } else {
        rejectSequence();
      }
      continue;
    }

    const hasStringTerminator =
      code === C0.ESC &&
      position + 1 < source.length &&
      source.charCodeAt(position + 1) === ESC_TYPE.ST;
    if (code === C0.BEL || hasStringTerminator) {
      position += hasStringTerminator ? 2 : 1;
      appendSequence(position);
    } else {
      position++;
    }
  }

  if (mode === "plain") {
    appendPlain(position);
    return { fragments, next: { mode: "plain", pending: "" } };
  }

  const pending = source.slice(sequenceStart);
  if (finish) {
    if (pending) fragments.push({ type: "sequence", value: pending });
    return { fragments, next: { mode: "plain", pending: "" } };
  }

  const next: LexicalState = { mode, pending };
  if (stringKind !== undefined) next.stringKind = stringKind;
  return { fragments, next };
}

function legacyMouseEndpoint(
  source: string,
  sequenceStart: number,
  position: number,
): number | undefined {
  if (position - sequenceStart !== MOUSE_MARKER_OFFSET || source.charCodeAt(position) !== 0x4d) {
    return undefined;
  }

  const boundary = position + LEGACY_MOUSE_BYTES + 1;
  for (let payloadPosition = position + 1; payloadPosition < boundary; payloadPosition++) {
    if (
      payloadPosition < source.length &&
      source.charCodeAt(payloadPosition) < PRINTABLE_CODE_START
    ) {
      return undefined;
    }
  }
  return boundary;
}
