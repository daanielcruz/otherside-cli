import { getActivePasteStore } from "@/kernel/std/paste/registry.ts";
import { createAutoClearDispatch } from "@/kernel/std/state/auto-clear-dispatch.ts";
import { setPromptPasteExpandHint } from "@/store/prompt/index.ts";
import { readImageFromClipboard } from "@/ui/input/paste/clipboard.ts";
import { readPastedImageFile, splitPastedImagePaths } from "@/ui/input/paste/image-path.ts";
import { joinWithLeadingSpace, normalizePastedText } from "@/ui/input/paste/references.ts";
import { pasteEdit } from "@/ui/input/prompt-edit-ops.ts";

const PASTE_EXPAND_HINT_MS = 3_000;

export interface PromptPasteIo {
  text(): string;
  caret(): number;
  terminalRows(): number;
  leaveHistory(): void;
  apply(text: string, caret: number): void;
}

export class PromptPaste {
  private readonly expandHint = createAutoClearDispatch({ holdMs: PASTE_EXPAND_HINT_MS });

  constructor(private readonly io: PromptPasteIo) {}

  insertClipboardImage(): boolean {
    const store = getActivePasteStore();
    if (!store) return false;
    const image = readImageFromClipboard();
    if (!image) return false;
    this.io.leaveHistory();
    const { placeholder } = store.add({
      type: "image",
      content: image.base64,
      mediaType: image.mediaType,
    });
    const { next, insertedLength } = joinWithLeadingSpace(
      this.io.text(),
      this.io.caret(),
      placeholder,
    );
    this.io.apply(next, this.io.caret() + insertedLength);
    return true;
  }

  insert(raw: string): void {
    const data = this.attachPastedImageFiles(normalizePastedText(raw));
    if (data.length === 0) return;
    const edit = pasteEdit(
      this.io.text(),
      this.io.caret(),
      data,
      getActivePasteStore(),
      this.io.terminalRows(),
    );
    if (edit === null) return;
    this.io.leaveHistory();
    this.io.apply(edit.text, edit.caret);
    if (edit.collapsed) this.showExpandHint();
  }

  /**
   * A pasted image file path becomes the image itself. Returns the text left
   * to insert; a path whose file cannot be read stays as text so the user
   * sees what arrived instead of losing it.
   */
  private attachPastedImageFiles(data: string): string {
    const store = getActivePasteStore();
    if (!store) return data;
    const { imagePaths, text } = splitPastedImagePaths(data);
    if (imagePaths.length === 0) return data;
    const unreadable: string[] = [];
    for (const path of imagePaths) {
      const image = readPastedImageFile(path);
      if (!image) {
        unreadable.push(path);
        continue;
      }
      this.io.leaveHistory();
      const { placeholder } = store.add({
        type: "image",
        content: image.base64,
        mediaType: image.mediaType,
      });
      const { next, insertedLength } = joinWithLeadingSpace(
        this.io.text(),
        this.io.caret(),
        placeholder,
      );
      this.io.apply(next, this.io.caret() + insertedLength);
    }
    return [...unreadable, text].filter((part) => part.length > 0).join("\n");
  }

  hideExpandHint(): void {
    this.expandHint.clear();
    setPromptPasteExpandHint(false);
  }

  dispose(): void {
    this.hideExpandHint();
  }

  private showExpandHint(): void {
    setPromptPasteExpandHint(true);
    this.expandHint.arm({ onTimeout: () => setPromptPasteExpandHint(false) });
  }
}
