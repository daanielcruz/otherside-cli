export type {
  Action,
  Color,
  CursorAction,
  CursorDirection,
  EraseAction,
  Grapheme,
  LinkAction,
  ModeAction,
  NamedColor,
  TextSegment,
  TextStyle,
  TitleAction,
  UnderlineStyle,
} from "@/terminal-runtime/terminal/protocol-contracts.js";
export {
  colorsEqual,
  createDefaultStyle,
  stylesMatch,
} from "@/terminal-runtime/terminal/protocol-contracts.js";
export { Parser } from "@/terminal-runtime/terminal/sequence-reader.js";
