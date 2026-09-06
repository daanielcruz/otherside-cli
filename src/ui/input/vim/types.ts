/** Whether a visual selection covers graphemes or whole lines. */
export type VisualSpan = "characterwise" | "linewise";

/**
 * Where the prompt's key input goes while the vim editor mode is on. Visual is
 * one mode carrying its span, so a selection change is a field rather than a
 * separate state.
 */
export type VimMode =
  | { name: "insert" }
  | { name: "normal" }
  | { name: "visual"; span: VisualSpan };

/** How a single grapheme is classified when deciding where a run begins and ends. */
export type CharacterClass = "word" | "punctuation" | "blank";

/** Small-word motions treat a punctuation run as its own word; big ones split on blanks alone. */
export type WordKind = "small" | "big";

/** A character search either lands on its match or stops one grapheme short of it. */
export type FindStop = "on" | "before";

export type SearchDirection = "forward" | "backward";

/**
 * Where a motion puts the caret. A motion is a destination, not an edit: the
 * same vocabulary serves navigation in NORMAL and the range an operator acts on,
 * so nothing here mentions either.
 */
export type VimMotion =
  | { kind: "charLeft" }
  | { kind: "charRight" }
  | { kind: "lineDown" }
  | { kind: "lineUp" }
  | { kind: "displayLineDown" }
  | { kind: "displayLineUp" }
  | { kind: "wordForward"; word: WordKind }
  | { kind: "wordBackward"; word: WordKind }
  | { kind: "wordEnd"; word: WordKind }
  | { kind: "lineStart" }
  | { kind: "lineFirstNonBlank" }
  | { kind: "lineEnd" }
  | { kind: "firstLine" }
  | { kind: "lastLine" }
  | { kind: "find"; target: string; direction: SearchDirection; stop: FindStop };

/**
 * A span of the buffer an operator acts on, `end` exclusive. `linewise` spans
 * cover whole lines including the newline that ends them, which is what makes a
 * deleted line disappear rather than leave a blank one behind.
 */
export interface VimRange {
  start: number;
  end: number;
  linewise: boolean;
}

/** What the unnamed register holds. The flag decides whether `p` opens a line. */
export interface VimRegister {
  text: string;
  linewise: boolean;
}

/** A character search worth repeating: what `;` replays and `,` replays flipped. */
export interface VimFind {
  target: string;
  direction: SearchDirection;
  stop: FindStop;
}

/** An operator waits for a motion to tell it what to act on. */
export type VimOperator = "delete" | "change" | "yank" | "shiftRight" | "shiftLeft";

/**
 * What NORMAL is still waiting for. A key that cannot mean anything on its own
 * parks here until the key that completes it arrives; an unrecognised
 * continuation clears it rather than guessing.
 *
 * An operator carries the count typed before it, since a second count may follow
 * the operator and the two multiply — `2d3w` covers six words.
 */
export type VimPending =
  | { kind: "none" }
  | { kind: "gPrefix" }
  | { kind: "findTarget"; direction: SearchDirection; stop: FindStop }
  | { kind: "replaceTarget" }
  | {
      kind: "operator";
      operator: VimOperator;
      count: number | null;
      /** A `g` typed after the operator, awaiting the motion it prefixes. */
      gPrefix: boolean;
      /** A find awaiting its target, so `df,` reaches the comma. */
      find: { direction: SearchDirection; stop: FindStop } | null;
      /**
       * An `i` or `a` awaiting the object it qualifies. The prefix exists only
       * here: in NORMAL on its own those two keys enter insert, and only an
       * operator gives them an object to describe.
       */
      objectAround: boolean | null;
    };

/**
 * The slice of the prompt the mode machine works against. Every transition ends in
 * `moveTo` — even one that leaves the caret where it stands — because that is also
 * what asks the prompt to repaint, and a mode change is always visible.
 */
export interface VimBuffer {
  getText(): string;
  getCaretOffset(): number;
  moveTo(offset: number): void;
  /** Prompt width in columns, which the display-row motions need. */
  getColumns(): number;
  /** Replaces the draft and records an undo step, exactly as typing does. */
  applyEdit(edit: { text: string; caret: number }): void;
  /** Rewinds one step. `u` delegates: the mode keeps no history of its own. */
  undoLastEdit(): void;
}

/**
 * Settings the mode machine runs under. Resolved once, because the prompt repaints
 * on every keystroke and a config read on that path is disk I/O.
 */
export interface VimSettings {
  readonly enabled: boolean;
  readonly indicatorHidden: boolean;
}
