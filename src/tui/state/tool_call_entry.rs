//! `ToolCallEntry` + archive serializer — the tool-call data carrier
//! separated from the mutating façade in [`super`].
//!
//! The struct stays `pub` and re-exported from `super` so external
//! paths (`crate::tui::state::ToolCallEntry`) keep resolving. Mutation
//! still happens on [`super::ConversationState`]; this module only
//! defines the shape + one pure serializer.

use std::time::Instant;

use serde_json::Value;

use crate::tui::tool_render::{self, ToolPayload, ToolStatus};

/// One tool-call entry on the active list.
///
/// Created by [`super::ConversationState::begin_tool_call`] with
/// `status = Running` and `payload = None`; transitioned by
/// [`super::ConversationState::finish_tool_call`] to `Ok` or `Error`
/// with a payload picked by [`tool_render::payload_from_result`] /
/// [`tool_render::payload_from_error`].
///
/// The render path builds a [`tool_render::ToolCallView`] from each
/// entry on every frame, so field access is intentionally public.
#[derive(Debug, Clone)]
pub struct ToolCallEntry {
    pub id: String,
    pub name: String,
    pub args: Value,
    pub status: ToolStatus,
    pub payload: Option<ToolPayload>,
    pub started_at: Instant,
    pub elapsed_ms: u64,
    /// Raw dispatcher output, kept so the render layer can recompute
    /// `payload` when `/verbose` toggles mid-session. `None` for
    /// error paths and legacy entries deserialized from the
    /// transcript archive.
    pub raw_result: Option<Value>,
}

/// Serialize a finalized [`ToolCallEntry`] into a JSON string the
/// `Role::Tool` archived render path can deserialize and feed through
/// [`tool_render::render_tool_call`] — same code path as the live
/// render. Previously emitted a pipe-delimited summary that lost the
/// payload preview on archival; JSON preserves the full shape (args,
/// status, elapsed, payload) so archived tool calls show the `⎿`
/// preview body just like live ones.
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
