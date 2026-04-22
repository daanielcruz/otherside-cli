

use std::time::Instant;

use serde_json::Value;

use crate::tui::tool_render::{self, ToolPayload, ToolStatus};

#[derive(Debug, Clone)]
pub struct ToolCallEntry {
    pub id: String,
    pub name: String,
    pub args: Value,
    pub status: ToolStatus,
    pub payload: Option<ToolPayload>,
    pub started_at: Instant,
    pub elapsed_ms: u64,

    pub raw_result: Option<Value>,

    pub nested_lines: Vec<String>,
}

pub fn format_tool_history_entry(entry: &ToolCallEntry) -> String {
    let archive = tool_render::ToolCallArchive {
        status: entry.status,
        name: entry.name.clone(),
        elapsed_ms: entry.elapsed_ms,
        args: entry.args.clone(),
        payload: entry.payload.clone(),
        id: entry.id.clone(),
        raw_result: entry.raw_result.clone(),
    };
    serde_json::to_string(&archive).unwrap_or_default()
}
