import { DesignCreateCapability } from "@/design/capabilities/design-create.ts";
import { DesignDeleteCapability } from "@/design/capabilities/design-delete.ts";
import { DesignDuplicateCapability } from "@/design/capabilities/design-duplicate.ts";
import { DesignFileDeleteCapability } from "@/design/capabilities/design-file-delete.ts";
import {
  DesignImageCapability,
  DesignImageChunkCapability,
} from "@/design/capabilities/design-image.ts";
import { DesignOpenCapability } from "@/design/capabilities/design-open.ts";
import { DesignRenameCapability } from "@/design/capabilities/design-rename.ts";
import {
  DesignListCapability,
  DesignSaveCapability,
} from "@/design/capabilities/design-storage.ts";
import { DesignUploadCapability } from "@/design/capabilities/design-upload.ts";
import { LlmCompleteCapability } from "@/design/capabilities/llm-complete.ts";
import { LlmStreamCapability } from "@/design/capabilities/llm-stream.ts";
import { MetaListCapability } from "@/design/capabilities/meta-list.ts";
import { ModelSetCapability } from "@/design/capabilities/model-set.ts";
import { PingCapability } from "@/design/capabilities/ping.ts";
import {
  EvalResultRespondCapability,
  LoadReportRespondCapability,
  PermissionRespondCapability,
  QuestionRespondCapability,
  ScreenshotRespondCapability,
  TurnCancelCapability,
  WebviewLogsRespondCapability,
} from "@/design/capabilities/turn-control.ts";
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
