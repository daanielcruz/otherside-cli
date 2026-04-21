//! Footer pill label — byte-match upstream.
//!
//! Source: `tasks/pillLabel.ts:10-67`. The strings here are TRAINING
//! ANCHORS (R-20 corollary): the model and the user both see them in
//! the upstream binary. Drift breaks parity.
//!
//! Forms (single-kind):
//! - `1 shell` / `N shells`
//! - `1 local agent` / `N local agents`
//!
//! Mixed (more than one kind active):
//! - `1 background task` / `N background tasks`
//!
//! Empty state: returns `None` so render skips the chip entirely.

use super::store::TaskCounts;

/// Build the footer pill label from a counts snapshot. `None` ⇒
/// no active tasks ⇒ chip not rendered.
pub fn get_pill_label(counts: TaskCounts) -> Option<String> {
    let total = counts.total();
    if total == 0 {
        return None;
    }
    if counts.is_mixed() {
        return Some(plural(total, "background task", "background tasks"));
    }
    if counts.shells > 0 {
        return Some(plural(counts.shells, "shell", "shells"));
    }
    if counts.agents > 0 {
        return Some(plural(counts.agents, "local agent", "local agents"));
    }
    if counts.generic > 0 {
        // Single-kind generic — fall back to the aggregate form per
        // upstream (no dedicated `N generics` label exists).
        return Some(plural(counts.generic, "background task", "background tasks"));
    }
    None
}

fn plural(n: usize, singular: &str, plural: &str) -> String {
    if n == 1 {
        format!("1 {singular}")
    } else {
        format!("{n} {plural}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counts(shells: usize, agents: usize, generic: usize) -> TaskCounts {
        TaskCounts { shells, agents, generic }
    }

    #[test]
    fn empty_returns_none() {
        assert_eq!(get_pill_label(counts(0, 0, 0)), None);
    }

    #[test]
    fn single_shell() {
        assert_eq!(get_pill_label(counts(1, 0, 0)).as_deref(), Some("1 shell"));
    }

    #[test]
    fn multiple_shells() {
        assert_eq!(
            get_pill_label(counts(3, 0, 0)).as_deref(),
            Some("3 shells")
        );
    }

    #[test]
    fn single_agent() {
        assert_eq!(
            get_pill_label(counts(0, 1, 0)).as_deref(),
            Some("1 local agent")
        );
    }

    #[test]
    fn multiple_agents() {
        assert_eq!(
            get_pill_label(counts(0, 5, 0)).as_deref(),
            Some("5 local agents")
        );
    }

    #[test]
    fn mixed_uses_aggregate_form() {
        assert_eq!(
            get_pill_label(counts(1, 1, 0)).as_deref(),
            Some("2 background tasks")
        );
        assert_eq!(
            get_pill_label(counts(2, 1, 0)).as_deref(),
            Some("3 background tasks")
        );
    }

    #[test]
    fn mixed_singular_form_when_total_one() {
        // (Defensive) is_mixed gates on >1 kind active. With one of
        // each kind active we'd expect at least 2 total. But if a
        // future record is ever single-kind generic with n=1, the
        // generic fallback uses the singular form.
        assert_eq!(
            get_pill_label(counts(0, 0, 1)).as_deref(),
            Some("1 background task")
        );
    }

    #[test]
    fn generic_only_falls_through_to_aggregate_form() {
        assert_eq!(
            get_pill_label(counts(0, 0, 4)).as_deref(),
            Some("4 background tasks")
        );
    }
}
