

use super::store::TaskCounts;

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
