//! Statusline: native renderer + optional user-supplied shell-command
//! override. Renders a single line in the TUI's bottom band.
//!
//! # Boundary
//!
//! The JSON payload piped to a user's custom `statusline.command` uses
//! upstream-faithful field names (snake_case, shape byte-compatible
//! with existing user `jq` pipelines). This is harness-level fidelity
//! — the input is user-observable and user scripts parse those keys.
//!
//! The otherside-internal ctx (`StatuslineCtx`) uses otherside-native
//! names and carries extra fields that never cross the subprocess
//! boundary (terminal width, theme, permission mode). See
//! `docs/decisions-log.md` C48/C49/C50/C51 for the dual-naming
//! rationale and the privacy boundary (yolo state never leaks into
//! user-script territory).

pub mod render;
pub mod subprocess;
pub mod types;

pub use types::{
    ContextWindowInput, CostInput, ModelInput, OutputStyleInput, StatuslineCache,
    StatuslineConfig, StatuslineCtx, StatuslineError, StatuslineInput, StatuslineLine,
    StatuslineTheme, WorkspaceInput,
};

use crate::config::{Scope, ValidationWarning, WarningKind};

/// Top-level entry point: given render ctx + configured override (if
/// any), produce the line to paint on the statusline row. On
/// subprocess failure, falls back to the native renderer and emits a
/// ValidationWarning so the UI can surface it on `/status`.
///
/// Single call site — R-30 analog applied to the statusline pipeline.
pub fn dispatch(
    ctx: &StatuslineCtx,
    cfg: Option<&StatuslineConfig>,
) -> (StatuslineLine, Option<ValidationWarning>) {
    match cfg {
        None | Some(StatuslineConfig::Native { .. }) => (render::native(ctx), None),
        Some(StatuslineConfig::Command { command, .. }) => {
            match subprocess::execute(command, ctx) {
                Ok(text) => (StatuslineLine::from_text(&text), None),
                Err(err) => {
                    let warn = ValidationWarning::new(
                        Scope::UserGlobal,
                        WarningKind::UnknownTopLevelKey,
                        format!("statusline command failed, fell back to native: {err}"),
                    );
                    (render::native(ctx), Some(warn))
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatch_none_renders_native() {
        let ctx = StatuslineCtx::minimal_for_test();
        let (line, warn) = dispatch(&ctx, None);
        assert!(!line.content.is_empty());
        assert!(warn.is_none());
    }

    #[test]
    fn dispatch_native_variant_skips_subprocess() {
        let ctx = StatuslineCtx::minimal_for_test();
        let cfg = StatuslineConfig::Native {
            padding: Some(1),
            theme: None,
            extra: Default::default(),
        };
        let (line, warn) = dispatch(&ctx, Some(&cfg));
        assert!(!line.content.is_empty());
        assert!(warn.is_none());
    }
}
