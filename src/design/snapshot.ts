import type { DesignSnapshot } from "@/design/types.ts";

export interface CreateDesignSnapshotArgs {
  designId: string;
  initialPrompt?: string | undefined;
}

export function createDesignSnapshot(args: CreateDesignSnapshotArgs): DesignSnapshot {
  const updatedAt = new Date().toISOString();
  const prompt = args.initialPrompt?.trim() ?? "";
  return {
    designId: args.designId,
    messages:
      prompt.length > 0
        ? [
            {
              id: `${args.designId}:user:initial`,
              role: "user",
              content: prompt,
              createdAt: updatedAt,
              source: "left",
              status: "done",
            },
          ]
        : [],
    files: [],
    artifacts: [],
    viewState: {
      activeFileTab: null,
      openFiles: [],
      activeChatId: null,
    },
    designSystem: {
      designSystemId: "default",
      isDefault: true,
    },
    status: "idle",
    updatedAt,
  };
}
