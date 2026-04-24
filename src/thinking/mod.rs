
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

pub fn config_from_effort_label(label: &str) -> Option<ThinkingConfig> {
    if label.eq_ignore_ascii_case("auto") {
        return Some(ThinkingConfig::auto());
    }
    ThinkingLevel::from_str(label).ok().map(ThinkingConfig::level)
}

pub fn label_from_thinking(cfg: &ThinkingConfig) -> Option<&'static str> {
    match cfg.level {
        ThinkingLevel::Auto | ThinkingLevel::None => None,
        other => Some(other.as_label()),
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
    fn parse_level_suffix_covers_every_level_name() {
        for (name, expected) in [
            ("minimal", ThinkingLevel::Minimal),
            ("low", ThinkingLevel::Low),
            ("medium", ThinkingLevel::Medium),
            ("high", ThinkingLevel::High),
            ("xhigh", ThinkingLevel::XHigh),
            ("max", ThinkingLevel::Max),
        ] {
            let (id, cfg) = parse_suffix(&format!("claude-opus-4-7({name})")).unwrap();
            assert_eq!(id, "claude-opus-4-7");
            let cfg = cfg.unwrap();
            assert_eq!(cfg.mode, ThinkingMode::Level);
            assert_eq!(cfg.level, expected, "level {name}");
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

    fn commit_effort_label(resolved: Option<&'static str>) -> String {
        resolved.map(|s| s.to_string()).unwrap_or_else(|| "auto".into())
    }

    #[test]
    fn config_from_effort_label_handles_every_level() {
        for (label, expected_level) in [
            ("minimal", ThinkingLevel::Minimal),
            ("low", ThinkingLevel::Low),
            ("medium", ThinkingLevel::Medium),
            ("high", ThinkingLevel::High),
            ("xhigh", ThinkingLevel::XHigh),
            ("max", ThinkingLevel::Max),
            ("on", ThinkingLevel::On),
            ("off", ThinkingLevel::Off),
            ("none", ThinkingLevel::None),
        ] {
            let cfg = config_from_effort_label(label).unwrap_or_else(|| {
                panic!("config_from_effort_label({label:?}) returned None")
            });
            assert_eq!(cfg.mode, ThinkingMode::Level, "label={label}");
            assert_eq!(cfg.level, expected_level, "label={label}");
        }

        let auto_cfg = config_from_effort_label("auto").expect("auto");
        assert_eq!(auto_cfg.mode, ThinkingMode::Auto);
        assert_eq!(auto_cfg.level, ThinkingLevel::Auto);

        assert_eq!(config_from_effort_label("auto"), config_from_effort_label("AUTO"));

        assert!(config_from_effort_label("nope").is_none());
    }

    #[test]
    fn label_from_thinking_hides_auto_and_none() {
        assert_eq!(label_from_thinking(&ThinkingConfig::auto()), None);
        assert_eq!(label_from_thinking(&ThinkingConfig::none()), None);
        assert_eq!(
            label_from_thinking(&ThinkingConfig::level(ThinkingLevel::None)),
            None,
            "Level(None) collapses to None for UI — this is the G1 drift seed",
        );
        for level in [
            ThinkingLevel::Minimal,
            ThinkingLevel::Low,
            ThinkingLevel::Medium,
            ThinkingLevel::High,
            ThinkingLevel::XHigh,
            ThinkingLevel::Max,
            ThinkingLevel::On,
            ThinkingLevel::Off,
        ] {
            let cfg = ThinkingConfig::level(level);
            assert_eq!(label_from_thinking(&cfg), Some(level.as_label()));
        }
    }

    #[test]
    fn boot_effort_round_trip_is_stable_for_user_facing_labels() {
        let user_facing = [
            "auto", "minimal", "low", "medium", "high", "xhigh", "max", "on", "off",
        ];

        for seed in user_facing {
            let cfg1 = config_from_effort_label(seed)
                .unwrap_or_else(|| panic!("seed label {seed} must map to a config"));

            let resolved_label = label_from_thinking(&cfg1);
            let persisted = commit_effort_label(resolved_label);

            let cfg2 = config_from_effort_label(&persisted)
                .unwrap_or_else(|| panic!("re-derive of {persisted:?} must succeed"));

            assert_eq!(
                cfg1, cfg2,
                "label {seed} drifted across boot → persist → boot: {cfg1:?} != {cfg2:?}",
            );
        }
    }

    #[test]
    fn boot_effort_round_trip_documents_none_drift() {
        let cfg1 = config_from_effort_label("none").unwrap();
        assert_eq!(cfg1.level, ThinkingLevel::None);
        assert_eq!(cfg1.mode, ThinkingMode::Level);

        let persisted = commit_effort_label(label_from_thinking(&cfg1));
        assert_eq!(persisted, "auto", "commit rewrites Level(None) → auto");

        let cfg2 = config_from_effort_label(&persisted).unwrap();
        assert_eq!(cfg2.mode, ThinkingMode::Auto);
        assert_ne!(cfg1, cfg2, "drift is intentional and pinned");
    }
}
