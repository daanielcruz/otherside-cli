//! `NotebookEdit` — minimal `.ipynb` cell-source replace.
//!
//! # Status
//!
//! Schema in this module is **otherside-native** — NOT byte-fidelity
//! against a captured `ToolSearch` response. Shape mirrors upstream's
//! Zod at `tools/NotebookEditTool/NotebookEditTool.ts:39-66`. When a
//! live capture records the real schema, `TOOL_NOTEBOOK_EDIT_JSON`
//! gets swapped byte-verbatim.
//!
//! # Scope — first wave (018)
//!
//! Only `edit_mode: "replace"` is implemented. `insert` and `delete`
//! return `InvalidArgs` with a deferral hint — they land in a later
//! wave along with cell-id generation, nbformat compat checks, and
//! splice-semantics validation.
//!
//! # Deferred gates (tracked in `openspec/changes/018-.../tasks.md` §1)
//!
//! - **TODO-1:** Read-before-Edit guard. Upstream requires the notebook
//!   have been `Read` before any edit; this wave skips that check to
//!   avoid threading `read_set::global()` through every dispatcher
//!   signature. Partial mitigation: the dispatcher validates file
//!   extension + cell-id existence before any write, so a wrong path
//!   or wrong cell errors before corrupting anything.
//! - **TODO-2:** Write-permission gate. Same signature-refactor
//!   reason — a later wave plumbs `PermissionContext` through the
//!   dispatcher.
//!
//! Zone: identity — R-103 applies.

use std::path::Path;

use serde_json::{json, Value};

use crate::tools::ToolError;

/// Edit a single cell's source inside a `.ipynb` file. See module
/// docstring for the supported subset in this wave.
pub fn notebook_edit(args: &Value) -> Result<Value, ToolError> {
    let notebook_path = args
        .get("notebook_path")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("notebook_path is required".into()))?;
    let new_source = args
        .get("new_source")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("new_source is required".into()))?;
    let cell_id = args
        .get("cell_id")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArgs("cell_id is required for replace mode".into()))?;

    let edit_mode = args
        .get("edit_mode")
        .and_then(Value::as_str)
        .unwrap_or("replace");

    match edit_mode {
        "replace" => {}
        "insert" => {
            return Err(ToolError::InvalidArgs(
                "edit_mode=insert is deferred to a later wave; only `replace` is supported today"
                    .into(),
            ))
        }
        "delete" => {
            return Err(ToolError::InvalidArgs(
                "edit_mode=delete is deferred to a later wave; only `replace` is supported today"
                    .into(),
            ))
        }
        other => {
            return Err(ToolError::InvalidArgs(format!(
                "unknown edit_mode `{other}` (valid: replace)"
            )))
        }
    }

    let path = Path::new(notebook_path);
    if path.extension().and_then(|s| s.to_str()) != Some("ipynb") {
        return Err(ToolError::InvalidArgs(format!(
            "notebook_path `{notebook_path}` does not have a .ipynb extension",
        )));
    }

    // Read file. Wrap blocking I/O per R-107 so this behaves correctly
    // when called from the tokio multi-thread runtime.
    let raw = tokio::task::block_in_place(|| std::fs::read_to_string(path))?;

    let mut notebook: Value = serde_json::from_str(&raw).map_err(|e| {
        ToolError::InvalidArgs(format!("notebook is not valid JSON: {e}"))
    })?;

    let language = notebook
        .get("metadata")
        .and_then(|m| m.get("language_info"))
        .and_then(|l| l.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("python")
        .to_string();

    let cells = notebook
        .get_mut("cells")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| {
            ToolError::InvalidArgs("notebook has no `cells` array".into())
        })?;

    let cell_index = cells.iter().position(|c| {
        c.get("id")
            .and_then(Value::as_str)
            .map(|id| id == cell_id)
            .unwrap_or(false)
    });

    let cell_index = match cell_index {
        Some(i) => i,
        None => {
            return Err(ToolError::InvalidArgs(format!(
                "cell_id `{cell_id}` not found in notebook"
            )))
        }
    };

    let cell = &mut cells[cell_index];
    let cell_type = cell
        .get("cell_type")
        .and_then(Value::as_str)
        .unwrap_or("code")
        .to_string();

    if let Some(obj) = cell.as_object_mut() {
        obj.insert("source".to_string(), Value::String(new_source.to_string()));
        if cell_type == "code" {
            // Mutating a code cell invalidates prior execution artifacts;
            // match upstream's reset behavior at
            // tools/NotebookEditTool/NotebookEditTool.ts:429-433.
            obj.insert("execution_count".to_string(), Value::Null);
            obj.insert("outputs".to_string(), Value::Array(Vec::new()));
        }
    }

    // Re-serialize with a one-space indent — upstream `IPYNB_INDENT = 1`.
    // `preserve_order` is already enabled on serde_json via Cargo.toml
    // (R-56) so cell key order round-trips intact.
    let updated = serialize_ipynb(&notebook)?;
    let path_owned = path.to_path_buf();
    let bytes = updated.clone();
    tokio::task::block_in_place(move || std::fs::write(&path_owned, bytes.as_bytes()))?;

    Ok(json!({
        "new_source": new_source,
        "cell_id": cell_id,
        "cell_type": cell_type,
        "language": language,
        "edit_mode": "replace",
        "notebook_path": notebook_path,
    }))
}

/// Serialize with a 1-space indent to match upstream's `IPYNB_INDENT`.
/// `serde_json::to_string_pretty` only supports multi-char indentation
/// through a custom formatter; we build one explicitly so the output
/// stays byte-comparable to the canonical ipynb layout.
fn serialize_ipynb(v: &Value) -> Result<String, ToolError> {
    let mut buf = Vec::new();
    let indent = b" ";
    let formatter = serde_json::ser::PrettyFormatter::with_indent(indent);
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, formatter);
    serde::Serialize::serialize(v, &mut ser).map_err(|e| {
        ToolError::InvalidArgs(format!("failed to re-serialize notebook: {e}"))
    })?;
    String::from_utf8(buf).map_err(|e| {
        ToolError::InvalidArgs(format!("notebook serialization is not utf-8: {e}"))
    })
}

/// `NotebookEdit` schema — otherside-native synthesis of upstream's Zod
/// at `tools/NotebookEditTool/NotebookEditTool.ts:39-66`. 018 implements
/// `replace` only.
pub const TOOL_NOTEBOOK_EDIT_JSON: &str =
    include_str!("../../../harness_corpus/tools/NotebookEdit.json");

#[cfg(test)]
mod tests {
    use super::*;

    fn write_fixture_code(path: &std::path::Path, cell_id: &str, source: &str) {
        let ipynb = json!({
            "cells": [{
                "cell_type": "code",
                "id": cell_id,
                "source": source,
                "metadata": {},
                "execution_count": 3,
                "outputs": [{"output_type": "stream", "text": "old"}]
            }],
            "metadata": {
                "language_info": { "name": "python" }
            },
            "nbformat": 4,
            "nbformat_minor": 5
        });
        std::fs::write(path, serde_json::to_string_pretty(&ipynb).unwrap()).unwrap();
    }

    fn write_fixture_markdown(path: &std::path::Path, cell_id: &str, source: &str) {
        let ipynb = json!({
            "cells": [{
                "cell_type": "markdown",
                "id": cell_id,
                "source": source,
                "metadata": {}
            }],
            "metadata": {
                "language_info": { "name": "python" }
            },
            "nbformat": 4,
            "nbformat_minor": 5
        });
        std::fs::write(path, serde_json::to_string_pretty(&ipynb).unwrap()).unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn notebook_edit_replaces_code_cell_source_and_resets_outputs() {
        let dir = tempdir();
        let nb = dir.path().join("fixture.ipynb");
        write_fixture_code(&nb, "abc", "print(1)");

        let out = notebook_edit(&json!({
            "notebook_path": nb.to_str().unwrap(),
            "cell_id": "abc",
            "new_source": "print(42)",
        }))
        .unwrap();
        assert_eq!(out["cell_id"], "abc");
        assert_eq!(out["edit_mode"], "replace");
        assert_eq!(out["new_source"], "print(42)");

        let written: Value = serde_json::from_str(&std::fs::read_to_string(&nb).unwrap()).unwrap();
        assert_eq!(written["cells"][0]["source"], "print(42)");
        assert!(written["cells"][0]["execution_count"].is_null());
        assert_eq!(written["cells"][0]["outputs"], json!([]));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn notebook_edit_preserves_markdown_cell_type() {
        let dir = tempdir();
        let nb = dir.path().join("fixture.ipynb");
        write_fixture_markdown(&nb, "md-1", "# old heading");

        let out = notebook_edit(&json!({
            "notebook_path": nb.to_str().unwrap(),
            "cell_id": "md-1",
            "new_source": "# new heading",
        }))
        .unwrap();
        assert_eq!(out["cell_type"], "markdown");

        let written: Value = serde_json::from_str(&std::fs::read_to_string(&nb).unwrap()).unwrap();
        assert_eq!(written["cells"][0]["cell_type"], "markdown");
        assert_eq!(written["cells"][0]["source"], "# new heading");
        // Markdown cells don't carry execution_count / outputs.
        assert!(written["cells"][0].get("execution_count").is_none());
        assert!(written["cells"][0].get("outputs").is_none());
    }

    #[test]
    fn notebook_edit_rejects_non_ipynb_extension() {
        let err = notebook_edit(&json!({
            "notebook_path": "/tmp/not-a-notebook.txt",
            "cell_id": "abc",
            "new_source": "x",
        }))
        .unwrap_err();
        match err {
            ToolError::InvalidArgs(msg) => assert!(msg.contains(".ipynb")),
            _ => panic!("expected InvalidArgs"),
        }
    }

    #[test]
    fn notebook_edit_rejects_insert_mode() {
        let err = notebook_edit(&json!({
            "notebook_path": "/tmp/x.ipynb",
            "cell_id": "abc",
            "new_source": "x",
            "edit_mode": "insert",
        }))
        .unwrap_err();
        match err {
            ToolError::InvalidArgs(msg) => {
                assert!(msg.contains("insert"));
                assert!(msg.contains("deferred"));
            }
            _ => panic!("expected InvalidArgs"),
        }
    }

    #[test]
    fn notebook_edit_rejects_delete_mode() {
        let err = notebook_edit(&json!({
            "notebook_path": "/tmp/x.ipynb",
            "cell_id": "abc",
            "new_source": "x",
            "edit_mode": "delete",
        }))
        .unwrap_err();
        match err {
            ToolError::InvalidArgs(msg) => {
                assert!(msg.contains("delete"));
                assert!(msg.contains("deferred"));
            }
            _ => panic!("expected InvalidArgs"),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn notebook_edit_rejects_unknown_cell_id() {
        let dir = tempdir();
        let nb = dir.path().join("fixture.ipynb");
        write_fixture_code(&nb, "abc", "print(1)");

        let err = notebook_edit(&json!({
            "notebook_path": nb.to_str().unwrap(),
            "cell_id": "nonexistent",
            "new_source": "print(42)",
        }))
        .unwrap_err();
        match err {
            ToolError::InvalidArgs(msg) => assert!(msg.contains("not found")),
            _ => panic!("expected InvalidArgs"),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn notebook_edit_errors_on_bad_json() {
        let dir = tempdir();
        let nb = dir.path().join("bad.ipynb");
        std::fs::write(&nb, "{ not json ").unwrap();

        let err = notebook_edit(&json!({
            "notebook_path": nb.to_str().unwrap(),
            "cell_id": "abc",
            "new_source": "x",
        }))
        .unwrap_err();
        match err {
            ToolError::InvalidArgs(msg) => assert!(msg.contains("not valid JSON")),
            _ => panic!("expected InvalidArgs"),
        }
    }

    #[test]
    fn notebook_edit_requires_notebook_path_cell_id_new_source() {
        assert!(notebook_edit(&json!({})).is_err());
        assert!(notebook_edit(&json!({ "notebook_path": "/x.ipynb" })).is_err());
        assert!(notebook_edit(&json!({
            "notebook_path": "/x.ipynb",
            "cell_id": "abc",
        }))
        .is_err());
    }

    #[test]
    fn schema_const_parses_as_json() {
        let _: Value = serde_json::from_str(TOOL_NOTEBOOK_EDIT_JSON).unwrap();
    }

    // Ephemeral scratch directory helper — std library only, no tempfile
    // crate dependency. Creates a unique subdirectory under the OS temp
    // dir; the handle removes it on drop.
    struct ScratchDir(std::path::PathBuf);
    impl ScratchDir {
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }
    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn tempdir() -> ScratchDir {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let base = std::env::temp_dir();
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let pid = std::process::id();
        let path = base.join(format!("otherside-nbedit-{pid}-{ts}-{n}"));
        std::fs::create_dir_all(&path).unwrap();
        ScratchDir(path)
    }
}
