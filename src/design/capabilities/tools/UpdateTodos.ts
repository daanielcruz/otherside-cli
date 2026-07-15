import type { ToolSchema } from "@/engine/tools/contract.ts";

export const UpdateTodosTool: ToolSchema = {
  name: "update_todos",
  description:
    "Update the list of development tasks for the current project. Call this tool to set initial tasks, start progress, or mark tasks as completed.",
  inputSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: {
              type: "string",
              description: "The description of the task.",
            },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
              description: "The status of the task.",
            },
          },
          required: ["label", "status"],
        },
      },
    },
    required: ["todos"],
  },
};
