import { DesignCreateCapability } from "@/design/capabilities/create.ts";
import { DesignDeleteCapability } from "@/design/capabilities/delete.ts";
import { DesignDuplicateCapability } from "@/design/capabilities/duplicate.ts";
import { DesignFileDeleteCapability } from "@/design/capabilities/file-delete.ts";
import { DesignImageCapability, DesignImageChunkCapability } from "@/design/capabilities/image.ts";
import { LlmCompleteCapability } from "@/design/capabilities/llm-complete.ts";
import { LlmStreamCapability } from "@/design/capabilities/llm-stream.ts";
import { MetaListCapability } from "@/design/capabilities/meta-list.ts";
import { ModelSetCapability } from "@/design/capabilities/model-set.ts";
import { DesignOpenCapability } from "@/design/capabilities/open.ts";
import { PingCapability } from "@/design/capabilities/ping.ts";
import { DesignRenameCapability } from "@/design/capabilities/rename.ts";
import { DesignListCapability, DesignSaveCapability } from "@/design/capabilities/storage.ts";
import {
  EvalResultRespondCapability,
  LoadReportRespondCapability,
  PermissionRespondCapability,
  QuestionRespondCapability,
  ScreenshotRespondCapability,
  TurnCancelCapability,
  WebviewLogsRespondCapability,
} from "@/design/capabilities/turn-control.ts";
import { DesignUploadCapability } from "@/design/capabilities/upload.ts";
import type { DesignCapability } from "@/design/types.ts";

export const DESIGN_CAPABILITIES: readonly DesignCapability[] = [
  PingCapability,
  MetaListCapability,
  ModelSetCapability,
  DesignCreateCapability,
  DesignDeleteCapability,
  DesignFileDeleteCapability,
  DesignDuplicateCapability,
  DesignOpenCapability,
  DesignRenameCapability,
  DesignListCapability,
  DesignSaveCapability,
  DesignImageCapability,
  DesignImageChunkCapability,
  DesignUploadCapability,
  LlmStreamCapability,
  LlmCompleteCapability,
  TurnCancelCapability,
  PermissionRespondCapability,
  QuestionRespondCapability,
  ScreenshotRespondCapability,
  LoadReportRespondCapability,
  WebviewLogsRespondCapability,
  EvalResultRespondCapability,
];
