

pub mod render;
pub mod subprocess;
pub mod types;

pub use types::{
    ContextWindowInput, CostInput, ModelInput, OutputStyleInput, StatuslineCache,
    StatuslineConfig, StatuslineCtx, StatuslineError, StatuslineInput, StatuslineLine,
    StatuslineTheme, WorkspaceInput,
};

use crate::config::{Scope, ValidationWarning, WarningKind};

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
