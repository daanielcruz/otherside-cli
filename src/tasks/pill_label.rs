

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
    fn pill_label_plural_rules_match_upstream() {
        let cases: &[(TaskCounts, Option<&str>)] = &[
            (counts(0, 0, 0), None),
            (counts(1, 0, 0), Some("1 shell")),
            (counts(3, 0, 0), Some("3 shells")),
            (counts(0, 1, 0), Some("1 local agent")),
            (counts(0, 5, 0), Some("5 local agents")),
            (counts(0, 0, 1), Some("1 background task")),
            (counts(0, 0, 4), Some("4 background tasks")),
            (counts(1, 1, 0), Some("2 background tasks")),
            (counts(2, 1, 0), Some("3 background tasks")),
        ];
        for (input, expected) in cases {
            assert_eq!(
                get_pill_label(*input).as_deref(),
                *expected,
                "input={input:?}"
            );
        }
    }
}
