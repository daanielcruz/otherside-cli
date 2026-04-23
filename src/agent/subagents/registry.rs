

use std::sync::OnceLock;

use super::frontmatter::{self, ToolsField};

#[derive(Debug, Clone)]
pub struct AgentDefinition {
    pub name: String,
    pub description: String,
    pub tools: ToolsField,
    pub model: Option<String>,
    pub system_prompt: String,
}

impl AgentDefinition {

    pub fn allows_tool(&self, name: &str) -> bool {
        match &self.tools {
            ToolsField::Wildcard => true,
            ToolsField::List(list) => list.iter().any(|t| t == name),
        }
    }
}

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

const GENERAL_PURPOSE_SRC: &str = include_str!("../../../agents_corpus/general-purpose.md");
const EXPLORE_SRC: &str = include_str!("../../../agents_corpus/explore.md");
const PLAN_SRC: &str = include_str!("../../../agents_corpus/plan.md");
const VERIFICATION_SRC: &str = include_str!("../../../agents_corpus/verification.md");

fn bundled() -> &'static [AgentDefinition] {
    static CELL: OnceLock<Vec<AgentDefinition>> = OnceLock::new();
    CELL.get_or_init(|| {
        vec![
            parse_bundled("general-purpose.md", GENERAL_PURPOSE_SRC),
            parse_bundled("explore.md", EXPLORE_SRC),
            parse_bundled("plan.md", PLAN_SRC),
            parse_bundled("verification.md", VERIFICATION_SRC),
        ]
    })
    .as_slice()
}

pub fn resolve(name: &str) -> Option<&'static AgentDefinition> {
    bundled().iter().find(|d| d.name == name)
}

pub fn len() -> usize {
    bundled().len()
}

pub fn all() -> &'static [AgentDefinition] {
    bundled()
}

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
        assert!(names.contains(&"Explore"));
        assert!(names.contains(&"Plan"));
        assert!(names.contains(&"verification"));
    }

    #[test]
    fn verification_disallows_mutation_tools() {
        let d = resolve("verification").expect("verification must load");
        assert!(tool_is_allowed(d, "Bash"));
        assert!(tool_is_allowed(d, "Read"));
        assert!(tool_is_allowed(d, "Grep"));
        assert!(!tool_is_allowed(d, "Edit"));
        assert!(!tool_is_allowed(d, "Write"));
        assert!(!tool_is_allowed(d, "NotebookEdit"));
        assert!(!tool_is_allowed(d, "Agent"));
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
