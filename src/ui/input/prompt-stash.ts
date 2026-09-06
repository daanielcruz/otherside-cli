export interface PromptDraft {
  readonly text: string;
  readonly caret: number;
}

export type PromptStashResult =
  | { readonly kind: "stashed"; readonly draft: PromptDraft }
  | { readonly kind: "restored"; readonly draft: PromptDraft }
  | { readonly kind: "none" };

const EMPTY_DRAFT: PromptDraft = { text: "", caret: 0 };

/**
 * One slot the prompt parks a draft in. A stash with text saves it and hands back an
 * empty buffer; the same key on an empty buffer hands the parked draft — caret
 * included — back and empties the slot. The slot holds one draft: stashing again
 * before restoring replaces what was parked.
 */
export class PromptStash {
  private slot: PromptDraft | null = null;

  toggle(current: PromptDraft): PromptStashResult {
    if (current.text.length > 0) {
      this.slot = current;
      return { kind: "stashed", draft: EMPTY_DRAFT };
    }
    const parked = this.slot;
    if (parked === null) return { kind: "none" };
    this.slot = null;
    return { kind: "restored", draft: parked };
  }

  has(): boolean {
    return this.slot !== null;
  }

  clear(): void {
    this.slot = null;
  }
}
