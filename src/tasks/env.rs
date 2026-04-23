

pub const ENV_VAR: &str = "OTHERSIDE_DISABLE_BACKGROUND_TASKS";

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
    fn truthy_values_detected_case_insensitive() {

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
