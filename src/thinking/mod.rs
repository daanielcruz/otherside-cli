//! Unified thinking / reasoning configuration across providers.
//!
//! Each provider expresses effort differently:
//! - Anthropic: `thinking: { type: "enabled", budget_tokens: N }` or level names (xhigh/max).
//! - Gemini: `generationConfig.thinkingConfig.thinkingBudget: N`.
//! - OpenAI / Codex: `reasoning.effort: "minimal"|"low"|"medium"|"high"`.
//!
//! otherside normalizes these into a single [`ThinkingConfig`] struct with
//! four modes (`None`, `Auto`, `Budget(i32)`, `Level(ThinkingLevel)`). Each
//! provider has an applier that mutates the native body per its own shape.
//!
//! # Model name suffix (C12, C28)
//!
//! Intent travels with the model name: `claude-opus-4-7(xhigh)` or
//! `gemini-2.5-pro(8192)`. [`parse_suffix`] is the pure parser called once
//! at router entry. Its result takes priority over any `reasoning` /
//! `thinking` field in the request body.
//!
//! # Levels (C13)
//!
//! Eight discrete levels cover all providers:
//! `none`, `auto`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
//!
//! # See also
//!
//! - `openspec/specs/thinking/spec.md` — capability spec
//! - `openspec/changes/001-mvp-anthropic-hello/specs/thinking/spec.md` — MVP delta

use std::str::FromStr;

use crate::error::{Error, Result};

/// Modes for a thinking configuration.
///
/// Exactly one of the modes is active at a time. The companion fields on
/// [`ThinkingConfig`] carry the per-mode payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThinkingMode {
    /// Thinking disabled. Budget=0, Level ignored.
    None,
    /// Automatic thinking (provider decides).
    Auto,
    /// Explicit numeric budget (tokens). Only meaningful when Mode=Budget.
    Budget,
    /// Discrete level. Only meaningful when Mode=Level.
    Level,
}

/// Discrete thinking levels supported by otherside, mirrored from
/// CLIProxyAPI conventions so users familiar with either tool see the same
/// vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThinkingLevel {
    None,
    Auto,
    Minimal,
    Low,
    Medium,
    High,
    XHigh,
    Max,
}

impl FromStr for ThinkingLevel {
    type Err = Error;

    /// Parse a level from its canonical lowercase name.
    ///
    /// Only the eight canonical variants are accepted. Anything else
    /// returns `Error::Parse`. We deliberately do NOT accept abbreviations
    /// or alternate spellings — suffix grammar is strict so mistakes
    /// surface early rather than silently picking the wrong level.
    fn from_str(s: &str) -> Result<Self> {
        match s {
            "none" => Ok(Self::None),
            "auto" => Ok(Self::Auto),
            "minimal" => Ok(Self::Minimal),
            "low" => Ok(Self::Low),
            "medium" => Ok(Self::Medium),
            "high" => Ok(Self::High),
            "xhigh" => Ok(Self::XHigh),
            "max" => Ok(Self::Max),
            other => Err(Error::Parse(format!(
                "unknown thinking level `{other}` — expected one of: none, auto, minimal, low, medium, high, xhigh, max"
            ))),
        }
    }
}

/// Unified thinking configuration passed across the translator matrix.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ThinkingConfig {
    pub mode: ThinkingMode,
    /// Effective only when `mode == ThinkingMode::Budget`. Special values:
    /// `0` means disabled, `-1` means automatic.
    pub budget: i32,
    /// Effective only when `mode == ThinkingMode::Level`.
    pub level: ThinkingLevel,
}

impl ThinkingConfig {
    /// Construct a `ThinkingConfig` representing "no thinking".
    pub const fn none() -> Self {
        Self {
            mode: ThinkingMode::None,
            budget: 0,
            level: ThinkingLevel::None,
        }
    }

    /// Construct a level-based config.
    pub const fn level(level: ThinkingLevel) -> Self {
        Self {
            mode: ThinkingMode::Level,
            budget: 0,
            level,
        }
    }

    /// Construct a budget-based config.
    pub const fn budget(tokens: i32) -> Self {
        Self {
            mode: ThinkingMode::Budget,
            budget: tokens,
            level: ThinkingLevel::None,
        }
    }

    /// Construct an auto-mode config.
    pub const fn auto() -> Self {
        Self {
            mode: ThinkingMode::Auto,
            budget: -1,
            level: ThinkingLevel::Auto,
        }
    }
}

/// Parse a model name for an optional thinking suffix.
///
/// The suffix grammar (CLIProxyAPI-compatible):
///
/// ```text
/// model_name := bare_id [ "(" spec ")" ]
/// spec       := level_name | integer_budget
/// level_name := "none" | "auto" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
/// ```
///
/// The suffix is matched ONLY at the end of the string — mid-string
/// parens are considered part of the bare id (defensive: future model
/// names could legitimately contain parens, though none currently do).
///
/// # Returns
///
/// `(bare_model_id, Some(config))` when a suffix is present and well-formed,
/// or `(bare_model_id, None)` when no suffix is present. Returns
/// [`Error::Parse`] on a malformed suffix.
///
/// # Examples
///
/// ```
/// use otherside::thinking::{parse_suffix, ThinkingLevel, ThinkingMode};
///
/// let (id, cfg) = parse_suffix("claude-opus-4-7(xhigh)").unwrap();
/// assert_eq!(id, "claude-opus-4-7");
/// let cfg = cfg.unwrap();
/// assert_eq!(cfg.mode, ThinkingMode::Level);
/// assert_eq!(cfg.level, ThinkingLevel::XHigh);
///
/// let (id, cfg) = parse_suffix("gemini-2.5-pro(8192)").unwrap();
/// assert_eq!(id, "gemini-2.5-pro");
/// let cfg = cfg.unwrap();
/// assert_eq!(cfg.mode, ThinkingMode::Budget);
/// assert_eq!(cfg.budget, 8192);
///
/// let (id, cfg) = parse_suffix("claude-opus-4-7").unwrap();
/// assert_eq!(id, "claude-opus-4-7");
/// assert!(cfg.is_none());
/// ```
pub fn parse_suffix(model_name: &str) -> Result<(String, Option<ThinkingConfig>)> {
    // Quick path: no suffix if the string doesn't end with ')'.
    if !model_name.ends_with(')') {
        return Ok((model_name.to_string(), None));
    }

    // Find the matching '(' — must pair with the trailing ')'.
    //
    // We search from the right so that if the bare id contains a '(' of
    // its own (unusual), we split at the rightmost paren pair which is
    // always the suffix carrier.
    let open = match model_name.rfind('(') {
        Some(idx) => idx,
        None => {
            return Err(Error::Parse(format!(
                "model name `{model_name}` ends with `)` but has no matching `(`"
            )));
        }
    };

    let bare = &model_name[..open];
    let inner = &model_name[open + 1..model_name.len() - 1];

    // Empty suffix `model()` is not valid — disambiguates from genuine
    // "no suffix" case and catches user typos.
    if inner.is_empty() {
        return Err(Error::Parse(format!(
            "model name `{model_name}` has an empty thinking suffix `()`"
        )));
    }

    // Numeric → Budget mode. We accept signed ints because `-1` is the
    // documented "auto" sentinel for budget.
    if let Ok(n) = inner.parse::<i32>() {
        return Ok((bare.to_string(), Some(ThinkingConfig::budget(n))));
    }

    // Otherwise must be a level name.
    let level = ThinkingLevel::from_str(inner)?;
    let cfg = match level {
        ThinkingLevel::None => ThinkingConfig::none(),
        ThinkingLevel::Auto => ThinkingConfig::auto(),
        other => ThinkingConfig::level(other),
    };
    Ok((bare.to_string(), Some(cfg)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_no_suffix() {
        let (id, cfg) = parse_suffix("claude-opus-4-7").unwrap();
        assert_eq!(id, "claude-opus-4-7");
        assert!(cfg.is_none());
    }

    #[test]
    fn parse_level_xhigh() {
        let (id, cfg) = parse_suffix("claude-opus-4-7(xhigh)").unwrap();
        assert_eq!(id, "claude-opus-4-7");
        let cfg = cfg.unwrap();
        assert_eq!(cfg.mode, ThinkingMode::Level);
        assert_eq!(cfg.level, ThinkingLevel::XHigh);
    }

    #[test]
    fn parse_level_max() {
        let (_, cfg) = parse_suffix("claude-opus-4-7(max)").unwrap();
        let cfg = cfg.unwrap();
        assert_eq!(cfg.level, ThinkingLevel::Max);
    }

    #[test]
    fn parse_level_minimal_low_medium_high() {
        for (name, expected) in [
            ("minimal", ThinkingLevel::Minimal),
            ("low", ThinkingLevel::Low),
            ("medium", ThinkingLevel::Medium),
            ("high", ThinkingLevel::High),
        ] {
            let (_, cfg) = parse_suffix(&format!("gpt-5({name})")).unwrap();
            let cfg = cfg.unwrap();
            assert_eq!(cfg.mode, ThinkingMode::Level);
            assert_eq!(cfg.level, expected, "expected {:?} for {}", expected, name);
        }
    }

    #[test]
    fn parse_budget() {
        let (id, cfg) = parse_suffix("gemini-2.5-pro(8192)").unwrap();
        assert_eq!(id, "gemini-2.5-pro");
        let cfg = cfg.unwrap();
        assert_eq!(cfg.mode, ThinkingMode::Budget);
        assert_eq!(cfg.budget, 8192);
    }

    #[test]
    fn parse_budget_auto_sentinel() {
        // Negative-one budget = provider-managed auto.
        let (_, cfg) = parse_suffix("gemini-2.5-pro(-1)").unwrap();
        let cfg = cfg.unwrap();
        assert_eq!(cfg.mode, ThinkingMode::Budget);
        assert_eq!(cfg.budget, -1);
    }

    #[test]
    fn parse_none_suffix() {
        let (_, cfg) = parse_suffix("claude-opus-4-7(none)").unwrap();
        let cfg = cfg.unwrap();
        assert_eq!(cfg.mode, ThinkingMode::None);
        assert_eq!(cfg.level, ThinkingLevel::None);
    }

    #[test]
    fn parse_auto_suffix() {
        let (_, cfg) = parse_suffix("claude-opus-4-7(auto)").unwrap();
        let cfg = cfg.unwrap();
        assert_eq!(cfg.mode, ThinkingMode::Auto);
        assert_eq!(cfg.level, ThinkingLevel::Auto);
    }

    #[test]
    fn parse_invalid_level() {
        let err = parse_suffix("claude-opus-4-7(extreme)").unwrap_err();
        assert!(
            matches!(err, Error::Parse(_)),
            "expected Parse error, got {err:?}"
        );
    }

    #[test]
    fn parse_empty_suffix_is_error() {
        let err = parse_suffix("claude-opus-4-7()").unwrap_err();
        assert!(matches!(err, Error::Parse(_)));
    }

    #[test]
    fn parse_trailing_paren_without_open_is_error() {
        let err = parse_suffix("claude-opus-4-7)").unwrap_err();
        assert!(matches!(err, Error::Parse(_)));
    }

    #[test]
    fn parse_handles_dashes_and_digits_in_bare() {
        // Canary: real model names have dashes and version digits.
        let (id, cfg) = parse_suffix("claude-sonnet-4-5-20250929(high)").unwrap();
        assert_eq!(id, "claude-sonnet-4-5-20250929");
        assert_eq!(cfg.unwrap().level, ThinkingLevel::High);
    }
}
