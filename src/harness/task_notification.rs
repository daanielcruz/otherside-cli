

use crate::tasks::{TaskRecord, TaskState};

const TASK_NOTIFICATION_TAG: &str = "task-notification";
const TASK_ID_TAG: &str = "task-id";
const TOOL_USE_ID_TAG: &str = "tool-use-id";
const OUTPUT_FILE_TAG: &str = "output-file";
const STATUS_TAG: &str = "status";
const SUMMARY_TAG: &str = "summary";
const RESULT_TAG: &str = "result";
const USAGE_TAG: &str = "usage";
const WORKTREE_TAG: &str = "worktree";
const WORKTREE_PATH_TAG: &str = "worktreePath";
const WORKTREE_BRANCH_TAG: &str = "worktreeBranch";

#[derive(Debug, Default, Clone)]
pub struct NotificationExtras<'a> {
    pub tool_use_id: Option<&'a str>,
    pub final_result: Option<&'a str>,
    pub usage: Option<NotificationUsage>,
    pub worktree: Option<NotificationWorktree<'a>>,
}

#[derive(Debug, Clone, Copy)]
pub struct NotificationUsage {
    pub total_tokens: u64,
    pub tool_uses: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Copy)]
pub struct NotificationWorktree<'a> {
    pub path: &'a str,
    pub branch: Option<&'a str>,
}

pub fn render(
    record: &TaskRecord,
    output_path: &str,
    extras: NotificationExtras<'_>,
) -> String {
    let status = status_text(record.state);
    let summary = summary_line(&record.name, record.state, extras.final_result);

    let tool_use_id_line = match extras.tool_use_id {
        Some(id) => format!(
            "\n<{TOOL_USE_ID_TAG}>{id}</{TOOL_USE_ID_TAG}>",
        ),
        None => String::new(),
    };
    let result_section = match extras.final_result {
        Some(r) => format!("\n<{RESULT_TAG}>{r}</{RESULT_TAG}>"),
        None => String::new(),
    };
    let usage_section = match extras.usage {
        Some(u) => format!(
            "\n<{USAGE_TAG}><total_tokens>{}</total_tokens><tool_uses>{}</tool_uses><duration_ms>{}</duration_ms></{USAGE_TAG}>",
            u.total_tokens, u.tool_uses, u.duration_ms,
        ),
        None => String::new(),
    };
    let worktree_section = match extras.worktree {
        Some(w) => {
            let branch_seg = match w.branch {
                Some(b) => format!("<{WORKTREE_BRANCH_TAG}>{b}</{WORKTREE_BRANCH_TAG}>"),
                None => String::new(),
            };
            format!(
                "\n<{WORKTREE_TAG}><{WORKTREE_PATH_TAG}>{}</{WORKTREE_PATH_TAG}>{branch_seg}</{WORKTREE_TAG}>",
                w.path,
            )
        }
        None => String::new(),
    };

    format!(
        "<{TASK_NOTIFICATION_TAG}>\n\
         <{TASK_ID_TAG}>{id}</{TASK_ID_TAG}>{tool_use_id_line}\n\
         <{OUTPUT_FILE_TAG}>{output_path}</{OUTPUT_FILE_TAG}>\n\
         <{STATUS_TAG}>{status}</{STATUS_TAG}>\n\
         <{SUMMARY_TAG}>{summary}</{SUMMARY_TAG}>{result_section}{usage_section}{worktree_section}\n\
         </{TASK_NOTIFICATION_TAG}>",
        id = record.id,
    )
}

fn status_text(state: TaskState) -> &'static str {
    match state {
        TaskState::Completed => "completed",
        TaskState::Failed => "failed",
        TaskState::Stopped => "stopped",

        _ => "stopped",
    }
}

fn summary_line(name: &str, state: TaskState, final_message: Option<&str>) -> String {
    match state {
        TaskState::Completed => format!(r#"Agent "{name}" completed"#),
        TaskState::Failed => {
            let err = final_message.unwrap_or("Unknown error");
            format!(r#"Agent "{name}" failed: {err}"#)
        }
        TaskState::Stopped => format!(r#"Agent "{name}" was stopped"#),
        _ => format!(r#"Agent "{name}" was stopped"#),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::{TaskId, TaskRecord};

    fn rec_completed() -> TaskRecord {
        let mut r = TaskRecord::new_agent(
            TaskId::from_string("bqqmh45aj"),
            "Sleep 60 seconds".into(),
            "prompt body".into(),
        );
        r.state = TaskState::Completed;
        r
    }

    #[test]
    fn minimal_completed_block_byte_match() {
        let r = rec_completed();
        let out = render(&r, "/tmp/out.log", NotificationExtras::default());
        let expected = "<task-notification>\n\
                        <task-id>bqqmh45aj</task-id>\n\
                        <output-file>/tmp/out.log</output-file>\n\
                        <status>completed</status>\n\
                        <summary>Agent \"Sleep 60 seconds\" completed</summary>\n\
                        </task-notification>";
        assert_eq!(out, expected);
    }

    #[test]
    fn block_with_tool_use_id_inserts_after_task_id() {
        let r = rec_completed();
        let out = render(
            &r,
            "/tmp/out.log",
            NotificationExtras {
                tool_use_id: Some("toolu_abc"),
                ..Default::default()
            },
        );
        assert!(out.contains("<task-id>bqqmh45aj</task-id>\n<tool-use-id>toolu_abc</tool-use-id>"));
    }

    #[test]
    fn failed_summary_uses_error_text() {
        let mut r = rec_completed();
        r.state = TaskState::Failed;
        let out = render(
            &r,
            "/tmp/out.log",
            NotificationExtras {
                final_result: Some("network unreachable"),
                ..Default::default()
            },
        );
        assert!(out.contains(r#"<summary>Agent "Sleep 60 seconds" failed: network unreachable</summary>"#));
        assert!(out.contains("<result>network unreachable</result>"));
    }

    #[test]
    fn failed_summary_unknown_error_when_no_message() {
        let mut r = rec_completed();
        r.state = TaskState::Failed;
        let out = render(&r, "/tmp/out.log", NotificationExtras::default());
        assert!(out.contains(r#"<summary>Agent "Sleep 60 seconds" failed: Unknown error</summary>"#));
    }

    #[test]
    fn stopped_summary_uses_was_stopped() {
        let mut r = rec_completed();
        r.state = TaskState::Stopped;
        let out = render(&r, "/tmp/out.log", NotificationExtras::default());
        assert!(out.contains(r#"<summary>Agent "Sleep 60 seconds" was stopped</summary>"#));
    }

    #[test]
    fn usage_section_renders_inline_format() {
        let r = rec_completed();
        let out = render(
            &r,
            "/tmp/out.log",
            NotificationExtras {
                usage: Some(NotificationUsage {
                    total_tokens: 1234,
                    tool_uses: 5,
                    duration_ms: 8765,
                }),
                ..Default::default()
            },
        );
        assert!(out.contains("<usage><total_tokens>1234</total_tokens><tool_uses>5</tool_uses><duration_ms>8765</duration_ms></usage>"));
    }

    #[test]
    fn worktree_section_with_branch() {
        let r = rec_completed();
        let out = render(
            &r,
            "/tmp/out.log",
            NotificationExtras {
                worktree: Some(NotificationWorktree {
                    path: "/tmp/wt/abc",
                    branch: Some("feature-x"),
                }),
                ..Default::default()
            },
        );
        assert!(out.contains("<worktree><worktreePath>/tmp/wt/abc</worktreePath><worktreeBranch>feature-x</worktreeBranch></worktree>"));
    }

    #[test]
    fn worktree_section_without_branch_omits_branch_tag() {
        let r = rec_completed();
        let out = render(
            &r,
            "/tmp/out.log",
            NotificationExtras {
                worktree: Some(NotificationWorktree {
                    path: "/tmp/wt/abc",
                    branch: None,
                }),
                ..Default::default()
            },
        );
        assert!(out.contains("<worktree><worktreePath>/tmp/wt/abc</worktreePath></worktree>"));
        assert!(!out.contains("worktreeBranch"));
    }

    #[test]
    fn full_envelope_with_all_optional_fields() {
        let r = rec_completed();
        let out = render(
            &r,
            "/tmp/out.log",
            NotificationExtras {
                tool_use_id: Some("toolu_xyz"),
                final_result: Some("agent reply"),
                usage: Some(NotificationUsage {
                    total_tokens: 500,
                    tool_uses: 2,
                    duration_ms: 1000,
                }),
                worktree: Some(NotificationWorktree {
                    path: "/wt/path",
                    branch: Some("main"),
                }),
            },
        );

        let positions: Vec<usize> = [
            "<task-id>",
            "<tool-use-id>",
            "<output-file>",
            "<status>",
            "<summary>",
            "<result>",
            "<usage>",
            "<worktree>",
        ]
        .iter()
        .map(|tag| out.find(tag).expect(tag))
        .collect();
        for w in positions.windows(2) {
            assert!(w[0] < w[1], "wire-shape ordering violated");
        }
    }
}
