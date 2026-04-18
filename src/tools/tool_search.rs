//! `ToolSearch` tool — resolves deferred tools on demand.
//!
//! Captured upstream schema: `{ query: String, max_results?: number }`.
//! The model uses `query = "select:<ToolName>"` for a direct fetch or a
//! keyword for a substring search.
//!
//! MVP scope: search the 9 advertised tools (the canonical set from
//! `harness::build_tools_array`). Broader deferred-tool catalogs (MCP,
//! skills-graph-bound tools) arrive in Phase 3.

use serde_json::{json, Value};

use super::{schemas, ToolError};

pub const DEFAULT_MAX_RESULTS: usize = 5;

pub fn tool_search(args: &Value) -> Result<Value, ToolError> {
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("query is required".into()))?;
    let max_results = args
        .get("max_results")
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .unwrap_or(DEFAULT_MAX_RESULTS);

    let all = schemas::tool_schemas();
    let matches: Vec<&schemas::ToolSchema> = if let Some(rest) = query.strip_prefix("select:") {
        let wanted: Vec<&str> = rest.split(',').map(str::trim).collect();
        all.iter().filter(|s| wanted.contains(&s.name.as_str())).collect()
    } else if query.trim().is_empty() {
        all.iter().collect()
    } else {
        let q_lower = query.to_lowercase();
        all.iter()
            .filter(|s| {
                s.name.to_lowercase().contains(&q_lower)
                    || s.description.to_lowercase().contains(&q_lower)
            })
            .collect()
    };

    let tools: Vec<Value> = matches
        .iter()
        .take(max_results)
        .map(|s| {
            json!({
                "name": s.name,
                "description": s.description,
                "input_schema": s.input_schema,
            })
        })
        .collect();

    Ok(json!({
        "query": query,
        "max_results": max_results,
        "tools": tools,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_search_requires_query() {
        assert!(tool_search(&json!({})).is_err());
    }

    #[test]
    fn tool_search_empty_query_returns_all_up_to_max() {
        let res = tool_search(&json!({"query": "", "max_results": 100})).unwrap();
        let tools = res["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 9);
    }

    #[test]
    fn tool_search_substring_match() {
        let res = tool_search(&json!({"query": "glob", "max_results": 10})).unwrap();
        let tools = res["tools"].as_array().unwrap();
        assert!(
            tools.iter().any(|t| t["name"] == "Glob"),
            "substring match on `glob` should surface Glob"
        );
    }

    #[test]
    fn tool_search_select_syntax_exact_match() {
        let res = tool_search(&json!({"query": "select:Agent", "max_results": 10})).unwrap();
        let tools = res["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], "Agent");
    }

    #[test]
    fn tool_search_select_multiple() {
        let res =
            tool_search(&json!({"query": "select:Read,Glob,Grep", "max_results": 10})).unwrap();
        let tools = res["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 3);
    }

    #[test]
    fn tool_search_no_match_returns_empty() {
        let res = tool_search(&json!({"query": "zzz-nothing-matches-this", "max_results": 5}))
            .unwrap();
        assert!(res["tools"].as_array().unwrap().is_empty());
    }

    #[test]
    fn tool_search_max_results_caps_output() {
        let res = tool_search(&json!({"query": "", "max_results": 3})).unwrap();
        assert_eq!(res["tools"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn tool_search_default_max_results_is_five() {
        let res = tool_search(&json!({"query": ""})).unwrap();
        assert_eq!(res["tools"].as_array().unwrap().len(), DEFAULT_MAX_RESULTS);
    }
}
