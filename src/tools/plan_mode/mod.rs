

use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{json, Value};

use crate::tools::ToolError;

static PLAN_MODE: AtomicBool = AtomicBool::new(false);

pub fn plan_mode_active() -> bool {
    PLAN_MODE.load(Ordering::Relaxed)
}

#[cfg(test)]
pub fn reset_plan_mode() {
    PLAN_MODE.store(false, Ordering::Relaxed);
}

pub fn enter_plan_mode(_args: &Value) -> Result<Value, ToolError> {
    PLAN_MODE.store(true, Ordering::Relaxed);
    Ok(json!({
        "ok": true,
        "mode": "plan",
        "message": "Plan mode engaged. Every mutating tool will be denied until ExitPlanMode fires.",
    }))
}

pub fn exit_plan_mode(_args: &Value) -> Result<Value, ToolError> {
    PLAN_MODE.store(false, Ordering::Relaxed);
    Ok(json!({
        "ok": true,
        "mode": "default",
        "message": "Plan mode cleared.",
    }))
}

pub use crate::harness::{TOOL_ENTER_PLAN_MODE_JSON, TOOL_EXIT_PLAN_MODE_JSON};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_mode_flips_and_resets() {
        reset_plan_mode();
        assert!(!plan_mode_active());
        enter_plan_mode(&json!({})).unwrap();
        assert!(plan_mode_active());
        exit_plan_mode(&json!({})).unwrap();
        assert!(!plan_mode_active());
    }

    #[test]
    fn schemas_parse_as_json() {
        for raw in [TOOL_ENTER_PLAN_MODE_JSON, TOOL_EXIT_PLAN_MODE_JSON] {
            let _: Value = serde_json::from_str(raw).unwrap();
        }
    }
}
