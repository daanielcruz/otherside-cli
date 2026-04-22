

use std::str::FromStr;

use crate::error::{Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThinkingMode {

    None,

    Auto,

    Budget,

    Level,
}

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
    /// Binary reasoning toggle used by Kimi. `On` leaves the
    /// `thinking:{type:"adaptive"}` envelope; `Off` strips it. Non-claude
    /// families that wire through the anthropic translator ride these.
    On,
    Off,
}

impl ThinkingLevel {

    pub fn as_label(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Auto => "auto",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::XHigh => "xhigh",
            Self::Max => "max",
            Self::On => "on",
            Self::Off => "off",
        }
    }
}

impl FromStr for ThinkingLevel {
    type Err = Error;

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
            "on" => Ok(Self::On),
            "off" => Ok(Self::Off),
            other => Err(Error::Parse(format!(
                "unknown thinking level `{other}` — expected one of: none, auto, minimal, low, medium, high, xhigh, max, on, off"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ThinkingConfig {
    pub mode: ThinkingMode,

    pub budget: i32,

    pub level: ThinkingLevel,
}

impl ThinkingConfig {

    pub const fn none() -> Self {
        Self {
            mode: ThinkingMode::None,
            budget: 0,
            level: ThinkingLevel::None,
        }
    }

    pub const fn level(level: ThinkingLevel) -> Self {
        Self {
            mode: ThinkingMode::Level,
            budget: 0,
            level,
        }
    }

    pub const fn budget(tokens: i32) -> Self {
        Self {
            mode: ThinkingMode::Budget,
            budget: tokens,
            level: ThinkingLevel::None,
        }
    }

    pub const fn auto() -> Self {
        Self {
            mode: ThinkingMode::Auto,
            budget: -1,
            level: ThinkingLevel::Auto,
        }
    }
}

pub fn parse_suffix(model_name: &str) -> Result<(String, Option<ThinkingConfig>)> {

    if !model_name.ends_with(')') {
        return Ok((model_name.to_string(), None));
    }

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

    if inner.is_empty() {
        return Err(Error::Parse(format!(
            "model name `{model_name}` has an empty thinking suffix `()`"
        )));
    }

    if let Ok(n) = inner.parse::<i32>() {
        return Ok((bare.to_string(), Some(ThinkingConfig::budget(n))));
    }

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

        let (id, cfg) = parse_suffix("claude-sonnet-4-5-20250929(high)").unwrap();
        assert_eq!(id, "claude-sonnet-4-5-20250929");
        assert_eq!(cfg.unwrap().level, ThinkingLevel::High);
    }
}
