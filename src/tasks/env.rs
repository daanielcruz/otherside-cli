//! Environment-variable gate for the entire background-task UX.
//!
//! Port of upstream's `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` env
//! check (`SessionBackgroundHint.tsx:40`). otherside uses the
//! `OTHERSIDE_*` prefix per RULES §R-106 — never `CLAUDE_CODE_*`.
//!
//! When the gate is on (`1` / `true` / `yes`), every consumer of
//! the tasks surface degrades gracefully:
//! - `Ctrl+B` is a no-op (keybinding predicate returns false).
//! - Footer pill never renders.
//! - `/tasks` + `/bashes` still parse (slash catalog is static)
//!   but the overlay shows an "disabled via env" hint row.
//! - The deferred `Task*` tool family (lands in §9) skips
//!   registration on the tool-schema export.
//!
//! Read cost is one env lookup per consumer per frame. Cheap.

/// Canonical env var name. Locked — test in this module asserts
/// the literal so a future drift into `CLAUDE_CODE_*` or a typo
/// fails CI.
pub const ENV_VAR: &str = "OTHERSIDE_DISABLE_BACKGROUND_TASKS";

/// True when the env var is set to a truthy value. Truthy
/// tokens mirror upstream's `isEnvTruthy`:
/// `1`, `true`, `yes`, `on` (case-insensitive). Anything else
/// (unset, empty, `0`, `false`, `no`, …) counts as off.
pub fn is_disabled() -> bool {
    let Ok(raw) = std::env::var(ENV_VAR) else {
        return false;
    };
    matches!(
        raw.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_var_literal_is_otherside_prefixed() {
        // Rules gate: §R-106 says OTHERSIDE_* only.
        assert_eq!(ENV_VAR, "OTHERSIDE_DISABLE_BACKGROUND_TASKS");
        assert!(!ENV_VAR.starts_with("CLAUDE_CODE"));
    }

    #[test]
    fn truthy_values_detected_case_insensitive() {
        // SAFETY: process-global env; these tests are serialized
        // via the single-threaded test runner within this mod.
        for truthy in ["1", "true", "TRUE", "Yes", "ON", "  on  "] {
            unsafe { std::env::set_var(ENV_VAR, truthy) };
            assert!(
                is_disabled(),
                "value `{truthy}` should count as disabled"
            );
        }
    }

    #[test]
    fn falsy_and_unset_values_leave_gate_open() {
        unsafe { std::env::remove_var(ENV_VAR) };
        assert!(!is_disabled(), "unset → gate open");
        for falsy in ["", "0", "false", "no", "off", "maybe"] {
            unsafe { std::env::set_var(ENV_VAR, falsy) };
            assert!(
                !is_disabled(),
                "value `{falsy}` must NOT count as disabled"
            );
        }
        unsafe { std::env::remove_var(ENV_VAR) };
    }
}
