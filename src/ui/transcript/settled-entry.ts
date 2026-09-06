import type {
  AskAnswerPayload,
  SkillProgressItem,
  TranscriptImage,
} from "@/engine/session/record/types.ts";
import type { ToolEntryData } from "@/ui/transcript/string-view-tool.ts";
import type { ToolPayload, ToolStatus } from "@/ui/transcript/tool-render/types.ts";

/**
 * One entry of the rendered conversation document. The store projects
 * transcript records into this shape; the transcript component decides which
 * prefix of them has settled and lays each one out into terminal rows.
 */
export type SettledEntry =
  | {
      readonly kind: "user";
      readonly text: string;
      readonly anchor?: string;
      readonly images?: readonly TranscriptImage[];
    }
  | { readonly kind: "assistant"; readonly text: string; readonly continuation?: boolean }
  | { readonly kind: "tool"; readonly data: ToolEntryData }
  | { readonly kind: "thinking"; readonly text: string; readonly detailOnly?: boolean }
  | { readonly kind: "system"; readonly text: string; readonly isError: boolean }
  | { readonly kind: "api_error"; readonly text: string }
  | {
      readonly kind: "bash_input";
      readonly text: string;
      readonly payload: ToolPayload | null;
      readonly status: ToolStatus;
    }
  | { readonly kind: "slash_error"; readonly text: string }
  | { readonly kind: "retry"; readonly text: string; readonly input?: string }
  | { readonly kind: "command_output"; readonly text: string }
  | { readonly kind: "quota_gutter"; readonly text: string }
  | { readonly kind: "ask_answer"; readonly text: string; readonly payload?: AskAnswerPayload }
  | { readonly kind: "task_notice"; readonly text: string; readonly isError: boolean }
  | {
      readonly kind: "skill";
      readonly text: string;
      readonly isError: boolean;
      readonly progress?: readonly SkillProgressItem[];
      readonly isActive?: boolean;
    }
  | {
      readonly kind: "compaction";
      readonly text: string;
      readonly isError: boolean;
      readonly filesRead: readonly { path: string; numLines: number }[];
    }
  | { readonly kind: "compact_done"; readonly text: string };
