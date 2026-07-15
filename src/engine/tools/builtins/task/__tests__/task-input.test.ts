import { describe, expect, it } from "bun:test";
import {
  coerceTaskGetInput,
  coerceTaskOutputInput,
  coerceTaskStopInput,
  coerceTaskUpdateInput,
} from "../task-input.ts";

describe("task id coercion", () => {
  it("normalizes camelCase taskId to task_id for TaskOutput", () => {
    expect(coerceTaskOutputInput({ taskId: "7" })).toEqual({ task_id: "7" });
  });

  it("normalizes id to task_id for TaskStop", () => {
    expect(coerceTaskStopInput({ id: "7" })).toEqual({ task_id: "7" });
  });

  it("normalizes snake_case task_id to taskId for TaskGet", () => {
    expect(coerceTaskGetInput({ task_id: "7" })).toEqual({ taskId: "7" });
  });

  it("normalizes id to taskId for TaskUpdate", () => {
    expect(coerceTaskUpdateInput({ id: "7", status: "completed" })).toEqual({
      taskId: "7",
      status: "completed",
    });
  });

  it("coerces block alongside id normalization for TaskOutput", () => {
    expect(coerceTaskOutputInput({ task_id: "7", block: "false" })).toEqual({
      task_id: "7",
      block: false,
    });
  });

  it("does not clobber an existing canonical key", () => {
    expect(coerceTaskOutputInput({ task_id: "real", taskId: "dupe" })).toEqual({
      task_id: "real",
    });
  });
});
