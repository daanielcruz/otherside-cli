import { describe, expect, test } from "bun:test";
import { envFor, HOOK_EVENT_VALUES, type HookEvent, SESSION_END_REASON_VALUES } from "../events.ts";

describe("HOOK_EVENT_VALUES SoT", () => {
  const NEW_EVENTS: HookEvent[] = [
    "sessionStart",
    "sessionEnd",
    "subagentStart",
    "permissionDenied",
    "Setup",
    "Notification",
    "FileChanged",
  ];

  test("all new events present", () => {
    for (const ev of NEW_EVENTS) expect(HOOK_EVENT_VALUES).toContain(ev);
  });

  test("envFor maps each new event to its env keys", () => {
    expect(
      envFor({ kind: "sessionStart", ctx: { sessionId: "s1", cwd: "/x", source: "startup" } }),
    ).toMatchObject({ SESSION_ID: "s1", CWD: "/x", SOURCE: "startup" });

    expect(
      envFor({ kind: "sessionEnd", ctx: { sessionId: "s1", cwd: "/x", reason: "other" } }),
    ).toEqual({ SESSION_ID: "s1", CWD: "/x", REASON: "other" });

    for (const reason of SESSION_END_REASON_VALUES) {
      expect(envFor({ kind: "sessionEnd", ctx: { sessionId: "s1", cwd: "/x", reason } })).toEqual({
        SESSION_ID: "s1",
        CWD: "/x",
        REASON: reason,
      });
    }

    expect(
      envFor({
        kind: "subagentStart",
        ctx: { sessionId: "s1", subagentId: "fork_1", agentType: "general-purpose" },
      }),
    ).toEqual({ SESSION_ID: "s1", SUBAGENT_ID: "fork_1", AGENT_TYPE: "general-purpose" });

    expect(
      envFor({
        kind: "permissionDenied",
        ctx: { toolName: "Bash", toolInput: "{}", toolUseId: "tu_1", reason: "rule-denied" },
      }),
    ).toEqual({ TOOL_NAME: "Bash", TOOL_INPUT: "{}", TOOL_USE_ID: "tu_1", REASON: "rule-denied" });

    expect(
      envFor({
        kind: "Setup",
        ctx: { hook_event_name: "Setup", trigger: "init" },
      }),
    ).toEqual({ TRIGGER: "init" });

    expect(
      envFor({
        kind: "Setup",
        ctx: { hook_event_name: "Setup", trigger: "maintenance" },
      }),
    ).toEqual({ TRIGGER: "maintenance" });

    expect(
      envFor({
        kind: "Notification",
        ctx: {
          hook_event_name: "Notification",
          message: "done",
          notification_type: "background_task",
        },
      }),
    ).toEqual({ MESSAGE: "done", NOTIFICATION_TYPE: "background_task" });

    expect(
      envFor({
        kind: "FileChanged",
        ctx: { hook_event_name: "FileChanged", file_path: "/tmp/project/a.txt", event: "change" },
      }),
    ).toEqual({ FILE_PATH: "/tmp/project/a.txt", EVENT: "change" });
  });
});
