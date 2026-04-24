
use serde_json::{json, Value};

use super::{REMINDER_DEFERRED_TOOLS, REMINDER_SKILLS, REMINDER_USER_CONTEXT_TMPL};

pub fn render_user_context(email: &str, current_date: &str) -> String {
    render_user_context_with_git(email, current_date, "")
}

pub fn render_user_context_with_git(
    email: &str,
    current_date: &str,
    git_status: &str,
) -> String {
    let git_section = if git_status.is_empty() {
        String::new()
    } else {
        format!("# gitStatus\n{git_status}\n")
    };
    REMINDER_USER_CONTEXT_TMPL
        .replace("{{email}}", email)
        .replace("{{current_date}}", current_date)
        .replace("{{git_status_section}}", &git_section)
}

pub fn build_preamble_blocks(email: &str, current_date: &str) -> [Value; 3] {
    build_preamble_blocks_with_git(email, current_date, "")
}

pub fn build_preamble_blocks_with_git(
    email: &str,
    current_date: &str,
    git_status: &str,
) -> [Value; 3] {
    [
        json!({ "type": "text", "text": REMINDER_DEFERRED_TOOLS }),
        json!({ "type": "text", "text": REMINDER_SKILLS }),
        json!({ "type": "text", "text": render_user_context_with_git(email, current_date, git_status) }),
    ]
}

pub const THIRD_PARTY_DEFERRED_CLARIFIER: &str = "\
The following deferred tools load on demand. To invoke one: first call \
`ToolSearch(query: \"select:<ToolName>\")` to load its schema, THEN call \
that tool directly by its own name. Do NOT dispatch a deferred tool via \
the `Skill` tool — `Skill` is ONLY for bundled skill workflows \
(e.g. `init`, `review`, `security-review`). TaskGet, TaskList, TaskOutput, \
WebFetch, WebSearch, CronCreate, etc. are deferred TOOLS, never skills. \
The deferred set is ADDITIVE — every tool already listed in the top-level \
`tools` array (Bash, Read, Edit, Glob, Grep, Write, Agent, Skill, ToolSearch) \
remains fully callable. Do NOT refuse a call for a tool in `tools[]` on the \
grounds that it isn't in this list.";

pub fn third_party_deferred_tools_reminder() -> String {
    format!("{THIRD_PARTY_DEFERRED_CLARIFIER}\n\n{}", REMINDER_DEFERRED_TOOLS)
}

pub fn build_preamble_blocks_third_party(
    email: &str,
    current_date: &str,
    git_status: &str,
) -> [Value; 3] {
    [
        json!({ "type": "text", "text": third_party_deferred_tools_reminder() }),
        json!({ "type": "text", "text": REMINDER_SKILLS }),
        json!({ "type": "text", "text": render_user_context_with_git(email, current_date, git_status) }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emits_three_blocks() {
        let blocks = build_preamble_blocks("a@b.com", "2026-04-18");
        assert_eq!(blocks.len(), 3);
        for b in blocks.iter() {
            assert_eq!(b["type"], "text");
            assert!(b["text"].is_string());
        }
    }

    #[test]
    fn user_context_substitutes_placeholders() {
        let rendered = render_user_context("user@example.com", "2099-12-31");
        assert!(rendered.contains("user@example.com"));
        assert!(rendered.contains("2099-12-31"));
        assert!(!rendered.contains("{{email}}"));
        assert!(!rendered.contains("{{current_date}}"));
    }

    #[test]
    fn deferred_tools_uses_available_deferred_tools_wrapper() {
        let blocks = build_preamble_blocks("e", "d");
        let text = blocks[0]["text"].as_str().unwrap();
        assert!(text.starts_with("<available-deferred-tools>"));
        assert!(text.contains("</available-deferred-tools>"));
        assert!(!text.contains("<system-reminder>"));
    }

    #[test]
    fn skills_trailing_newline_preserved() {

        let blocks = build_preamble_blocks("e", "d");
        let text = blocks[1]["text"].as_str().unwrap();
        assert!(text.ends_with("</system-reminder>\n"));
    }

    #[test]
    fn user_context_double_trailing_newline_preserved() {

        let blocks = build_preamble_blocks("e", "d");
        let text = blocks[2]["text"].as_str().unwrap();
        assert!(text.ends_with("</system-reminder>\n\n"));
    }

    #[test]
    fn git_status_section_absent_when_empty() {
        let rendered = render_user_context_with_git("a@b.com", "2026-04-22", "");
        assert!(!rendered.contains("# gitStatus"));
        assert!(!rendered.contains("{{git_status_section}}"));
    }

    #[test]
    fn git_status_section_present_when_populated() {
        let rendered = render_user_context_with_git(
            "a@b.com",
            "2026-04-22",
            "Current branch: main\n\nStatus:\n(clean)",
        );
        assert!(rendered.contains("# gitStatus"));
        assert!(rendered.contains("Current branch: main"));
        assert!(rendered.contains("Status:\n(clean)"));
        assert!(!rendered.contains("{{git_status_section}}"));
    }
}
