//! Bundled subagent definitions + lookup + tool-subset enforcement.
//!
//! Definitions ship with the binary via `include_str!` on files under
//! `otherside-cli/agents/`. Each file is a YAML-frontmatter markdown doc (see
//! [`super::frontmatter`] for the accepted shape). The registry is a
//! process-global `OnceLock<Vec<AgentDefinition>>` initialized on first
//! access; `load_bundled` panics on malformed frontmatter because a corrupt
//! bundled file means the ship pipeline is broken — not a runtime edge case.
//!
//! Custom agent loading (from `~/.otherside/agents/` or project-local
//! `.otherside/agents/`) is a later-wave concern. The registry is structured
//! to accept additive sources (`load_bundled` + future `load_user_scope`)
//! without churning the public API.

use std::sync::OnceLock;

use super::frontmatter::{self, ToolsField};

/// A single subagent definition: its type name (wire-visible via
/// `subagent_type` arg), the description surfaced in the `Agent` tool
/// schema, the tools it's permitted to call, an optional model override, and
/// the prompt body that becomes its system prompt.
#[derive(Debug, Clone)]
pub struct AgentDefinition {
    pub name: String,
    pub description: String,
    pub tools: ToolsField,
    pub model: Option<String>,
    pub system_prompt: String,
}

impl AgentDefinition {
    /// True iff this definition permits the named tool. Wildcard grants all.
    pub fn allows_tool(&self, name: &str) -> bool {
        match &self.tools {
            ToolsField::Wildcard => true,
            ToolsField::List(list) => list.iter().any(|t| t == name),
        }
    }
}

/// Parse a bundled markdown file into an [`AgentDefinition`]. Panics with
/// context on malformed input — callers only hit this path at startup.
fn parse_bundled(source_path: &str, src: &str) -> AgentDefinition {
    let parsed = frontmatter::parse(src).unwrap_or_else(|e| {
        panic!("bundled agent `{source_path}` has malformed frontmatter: {e}")
    });
    let name = parsed
        .fields
        .get("name")
        .cloned()
        .unwrap_or_else(|| panic!("bundled agent `{source_path}` missing `name` field"));
    let description = parsed
        .fields
        .get("description")
        .cloned()
        .unwrap_or_else(|| panic!("bundled agent `{source_path}` missing `description` field"));
    let tools = parsed.tools.unwrap_or_else(|| {
        panic!("bundled agent `{source_path}` missing `tools` field (required)")
    });
    let model = parsed.fields.get("model").cloned();
    AgentDefinition {
        name,
        description,
        tools,
        model,
        system_prompt: parsed.body,
    }
}

// Bundled agent definitions. `include_str!` pulls the markdown at compile
// time — zero filesystem lookups at runtime; zero chance the binary ships
// with a missing definition.
const GENERAL_PURPOSE_SRC: &str = include_str!("../../agents/general-purpose.md");
const READER_SRC: &str = include_str!("../../agents/reader.md");
const EXPLORE_SRC: &str = include_str!("../../agents/explore.md");
const PLAN_SRC: &str = include_str!("../../agents/plan.md");

/// Lazy-initialized bundled registry.
fn bundled() -> &'static [AgentDefinition] {
    static CELL: OnceLock<Vec<AgentDefinition>> = OnceLock::new();
    CELL.get_or_init(|| {
        vec![
            parse_bundled("general-purpose.md", GENERAL_PURPOSE_SRC),
            parse_bundled("reader.md", READER_SRC),
            parse_bundled("explore.md", EXPLORE_SRC),
            parse_bundled("plan.md", PLAN_SRC),
        ]
    })
    .as_slice()
}

/// Resolve a subagent type name to its definition. Returns `None` when no
/// bundled (or future user-scoped) entry matches. Lookup is case-sensitive
/// to match upstream behavior (`subagent_type: "general-purpose"` is not
/// the same as `"General-Purpose"`).
pub fn resolve(name: &str) -> Option<&'static AgentDefinition> {
    bundled().iter().find(|d| d.name == name)
}

/// Total number of loaded definitions. Useful for tests + the proposal
/// scaffold's acceptance checks.
pub fn len() -> usize {
    bundled().len()
}

/// Iterate every registered definition. Used by future tooling (e.g. a
/// `/agents` slash command) and the tool-schema builder if it ever surfaces
/// per-agent descriptions in the `Agent` schema `description` field.
pub fn all() -> &'static [AgentDefinition] {
    bundled()
}

/// Check whether a given subagent is allowed to invoke the named tool.
/// Separated from `AgentDefinition::allows_tool` so the dispatcher can
/// enforce the subset without holding the definition reference any longer
/// than it needs to.
pub fn tool_is_allowed(def: &AgentDefinition, tool_name: &str) -> bool {
    def.allows_tool(tool_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_registry_loads_at_least_two_definitions() {
        assert!(len() >= 2);
    }

    #[test]
    fn registry_contains_expected_bundled_set() {
        let names: Vec<&str> = all().iter().map(|d| d.name.as_str()).collect();
        assert!(names.contains(&"general-purpose"));
        assert!(names.contains(&"reader"));
        assert!(names.contains(&"Explore"));
        assert!(names.contains(&"Plan"));
    }

    #[test]
    fn explore_is_read_only() {
        let d = resolve("Explore").expect("Explore must load");
        assert!(tool_is_allowed(d, "Read"));
        assert!(tool_is_allowed(d, "Grep"));
        assert!(tool_is_allowed(d, "Glob"));
        assert!(!tool_is_allowed(d, "Bash"));
        assert!(!tool_is_allowed(d, "Write"));
        assert!(!tool_is_allowed(d, "Edit"));
    }

    #[test]
    fn plan_is_read_only() {
        let d = resolve("Plan").expect("Plan must load");
        assert!(tool_is_allowed(d, "Read"));
        assert!(tool_is_allowed(d, "Grep"));
        assert!(!tool_is_allowed(d, "Bash"));
        assert!(!tool_is_allowed(d, "Write"));
    }

    #[test]
    fn resolves_general_purpose() {
        let d = resolve("general-purpose").expect("general-purpose must load");
        assert_eq!(d.name, "general-purpose");
        assert!(matches!(d.tools, ToolsField::Wildcard));
    }

    #[test]
    fn resolves_reader() {
        let d = resolve("reader").expect("reader must load");
        assert_eq!(d.name, "reader");
        match &d.tools {
            ToolsField::List(list) => {
                assert!(list.iter().any(|t| t == "Read"));
                assert!(!list.iter().any(|t| t == "Write"));
                assert!(!list.iter().any(|t| t == "Edit"));
                assert!(!list.iter().any(|t| t == "Bash"));
            }
            _ => panic!("reader must carry an explicit tool list, not wildcard"),
        }
    }

    #[test]
    fn returns_none_for_unknown_type() {
        assert!(resolve("nonexistent-xyz").is_none());
    }

    #[test]
    fn wildcard_definition_allows_any_tool() {
        let d = resolve("general-purpose").unwrap();
        assert!(tool_is_allowed(d, "Read"));
        assert!(tool_is_allowed(d, "Bash"));
        assert!(tool_is_allowed(d, "Write"));
        assert!(tool_is_allowed(d, "Agent"));
    }

    #[test]
    fn reader_rejects_bash_and_write() {
        let d = resolve("reader").unwrap();
        assert!(tool_is_allowed(d, "Read"));
        assert!(tool_is_allowed(d, "Glob"));
        assert!(tool_is_allowed(d, "Grep"));
        assert!(!tool_is_allowed(d, "Bash"));
        assert!(!tool_is_allowed(d, "Write"));
        assert!(!tool_is_allowed(d, "Edit"));
    }

    #[test]
    fn system_prompt_body_is_non_empty() {
        for d in all() {
            assert!(
                !d.system_prompt.trim().is_empty(),
                "agent `{}` must ship a non-empty system prompt",
                d.name
            );
        }
    }
}
