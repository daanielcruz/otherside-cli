pub use crate::harness::TOOL_SEND_MESSAGE_JSON;

use serde_json::{json, Value};

use crate::tools::ToolError;

pub fn dispatch(args: &Value) -> Result<Value, ToolError> {
    let to = args
        .get("to")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("to is required".into()))?;
    let _ = args
        .get("message")
        .ok_or_else(|| ToolError::InvalidArgs("message is required".into()))?;

    let Some(store) = crate::tasks::store::current_global() else {
        return Ok(json!({
            "success": false,
            "message": format!(
                "No agent named '{to}' is currently addressable. Spawn a new one or use the agent ID."
            ),
        }));
    };

    let record = store.list().into_iter().find(|r| {
        r.id.as_str() == to || r.agent_id.as_deref() == Some(to)
    });

    match record {
        None => Ok(json!({
            "success": false,
            "message": format!(
                "No agent named '{to}' is currently addressable. Spawn a new one or use the agent ID."
            ),
        })),
        Some(r) if r.state.is_active() => Ok(json!({
            "success": true,
            "message": format!(
                "Message queued for delivery to {to} at its next tool round."
            ),
        })),
        Some(_) => Ok(json!({
            "success": true,
            "message": format!(
                "Agent \"{to}\" was stopped (completed); queued your message. otherside does not resume completed agents yet — spawn a fresh Agent with the same description to continue."
            ),
        })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_parses_as_json() {
        let _: Value = serde_json::from_str(TOOL_SEND_MESSAGE_JSON).unwrap();
    }

    #[test]
    fn schema_requires_to_and_message() {
        let v: Value = serde_json::from_str(TOOL_SEND_MESSAGE_JSON).unwrap();
        let required = v["input_schema"]["required"].as_array().unwrap();
        let names: Vec<&str> = required.iter().filter_map(|v| v.as_str()).collect();
        assert!(names.contains(&"to"));
        assert!(names.contains(&"message"));
    }

    #[test]
    fn dispatch_requires_to() {
        let err = dispatch(&json!({"message": "hi"})).unwrap_err();
        assert!(matches!(err, ToolError::InvalidArgs(_)));
    }

    #[test]
    fn dispatch_requires_message() {
        let err = dispatch(&json!({"to": "name"})).unwrap_err();
        assert!(matches!(err, ToolError::InvalidArgs(_)));
    }

    #[test]
    fn dispatch_without_store_surfaces_not_addressable() {
        let res = dispatch(&json!({"to": "ghost", "message": "hi"})).unwrap();
        assert_eq!(res["success"], false);
        assert!(res["message"]
            .as_str()
            .unwrap()
            .contains("currently addressable"));
    }
}
