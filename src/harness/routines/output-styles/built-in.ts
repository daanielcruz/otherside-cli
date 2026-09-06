import DEFAULT_MD from "./default.md" with { type: "text" };
import EXPLANATORY_MD from "./explanatory.md" with { type: "text" };
import LEARNING_MD from "./learning.md" with { type: "text" };
import PROACTIVE_MD from "./proactive.md" with { type: "text" };

export const DEFAULT_OUTPUT_STYLE = "default";

export interface OutputStyleRecord {
  name: string;
  description: string;
  prompt: string;
  /** Where the style was read from, lowest precedence first. */
  source: "built-in" | "plugin" | "user" | "project" | "policy";
  /**
   * A plugin style that stands in for whatever the reader chose. Only a plugin
   * can ask for it; on any other source it means nothing and is ignored.
   */
  forceForPlugin?: boolean;
  /** True keeps the coding-task guidance in the system prompt alongside the style. */
  keepCodingInstructions?: boolean;
  /** Per-turn reminder line; absent styles fall back to the generic sentence. */
  turnReminder?: string;
}

const PROACTIVE_TURN_REMINDER =
  "Execute autonomously, minimize interruptions, prefer action over planning.";

export const BUILT_IN_OUTPUT_STYLES: Readonly<Record<string, OutputStyleRecord>> = {
  [DEFAULT_OUTPUT_STYLE]: {
    name: DEFAULT_OUTPUT_STYLE,
    source: "built-in",
    description: "ADHD - Concise dialog",
    keepCodingInstructions: true,
    prompt: DEFAULT_MD,
  },
  Proactive: {
    name: "Proactive",
    source: "built-in",
    description:
      "Otherside executes immediately, minimizes interruptions, and prefers action over planning",
    keepCodingInstructions: true,
    prompt: PROACTIVE_MD,
    turnReminder: PROACTIVE_TURN_REMINDER,
  },
  Explanatory: {
    name: "Explanatory",
    source: "built-in",
    description: "Otherside explains its implementation choices and codebase patterns",
    keepCodingInstructions: true,
    prompt: EXPLANATORY_MD,
  },
  Learning: {
    name: "Learning",
    source: "built-in",
    description:
      "Otherside pauses and asks you to write small pieces of code for hands-on practice",
    keepCodingInstructions: true,
    prompt: LEARNING_MD,
  },
};

const GENERIC_TURN_REMINDER = "Remember to follow the specific guidelines for this style.";

/**
 * Per-turn reminder for the active style. The default style is permanent and
 * already stated in the system prompt, so it never spends a reminder; custom
 * and unknown names stay silent too.
 */
export function outputStyleTurnReminder(styleName: string | undefined): string | null {
  const name = styleName?.trim();
  if (!name || name === DEFAULT_OUTPUT_STYLE) return null;
  const record = BUILT_IN_OUTPUT_STYLES[name];
  if (!record) return null;
  return `${record.name} output style is active. ${record.turnReminder ?? GENERIC_TURN_REMINDER}`;
}
