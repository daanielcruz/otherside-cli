

use std::collections::HashMap;

use crate::tools::ToolError;

#[derive(Debug, Clone)]
pub struct Parsed {
    pub fields: HashMap<String, String>,
    pub tools: Option<ToolsField>,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolsField {

    Wildcard,

    List(Vec<String>),
}

#[derive(Debug, thiserror::Error)]
pub enum FrontmatterError {
    #[error("missing opening `---` fence")]
    MissingOpenFence,
    #[error("missing closing `---` fence")]
    MissingCloseFence,
    #[error("malformed frontmatter line: `{0}`")]
    MalformedLine(String),
    #[error("unrecognized tools value: `{0}`")]
    UnknownToolsValue(String),
}

impl From<FrontmatterError> for ToolError {
    fn from(e: FrontmatterError) -> Self {
        ToolError::InvalidArgs(format!("frontmatter: {e}"))
    }
}

pub fn parse(src: &str) -> Result<Parsed, FrontmatterError> {
    let mut fields: HashMap<String, String> = HashMap::new();
    let mut tools: Option<ToolsField> = None;

    let normalized = src.replace("\r\n", "\n");
    let mut iter = normalized.split('\n');
    let first = iter.next().unwrap_or("");
    if first.trim() != "---" {
        return Err(FrontmatterError::MissingOpenFence);
    }

    let mut closed = false;
    let mut frontmatter_lines: Vec<String> = Vec::new();
    for line in iter.by_ref() {
        if line.trim() == "---" {
            closed = true;
            break;
        }
        frontmatter_lines.push(line.to_string());
    }
    if !closed {
        return Err(FrontmatterError::MissingCloseFence);
    }

    let body_parts: Vec<&str> = iter.collect();
    let body = body_parts.join("\n").trim_start_matches('\n').to_string();

    let mut i = 0;
    while i < frontmatter_lines.len() {
        let raw = &frontmatter_lines[i];
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            i += 1;
            continue;
        }
        let colon = trimmed
            .find(':')
            .ok_or_else(|| FrontmatterError::MalformedLine(trimmed.to_string()))?;
        let key = trimmed[..colon].trim().to_string();
        let rest = trimmed[colon + 1..].trim();

        if key == "tools" {
            if rest.is_empty() {

                let mut list: Vec<String> = Vec::new();
                i += 1;
                while i < frontmatter_lines.len() {
                    let inner = frontmatter_lines[i].trim();
                    if inner.is_empty() {
                        break;
                    }
                    if let Some(stripped) = inner.strip_prefix('-') {
                        list.push(unquote(stripped.trim()));
                        i += 1;
                    } else {
                        break;
                    }
                }
                tools = Some(ToolsField::List(list));
                continue;
            }
            let val = unquote(rest);
            if val == "*" {
                tools = Some(ToolsField::Wildcard);
            } else if val.starts_with('[') && val.ends_with(']') {
                let inner = &val[1..val.len() - 1];
                let list: Vec<String> = inner
                    .split(',')
                    .map(|s| unquote(s.trim()))
                    .filter(|s| !s.is_empty())
                    .collect();
                tools = Some(ToolsField::List(list));
            } else {
                return Err(FrontmatterError::UnknownToolsValue(val));
            }
            i += 1;
            continue;
        }

        fields.insert(key, unquote(rest));
        i += 1;
    }

    Ok(Parsed {
        fields,
        tools,
        body,
    })
}

fn unquote(s: &str) -> String {
    let t = s.trim();
    if (t.starts_with('"') && t.ends_with('"') && t.len() >= 2)
        || (t.starts_with('\'') && t.ends_with('\'') && t.len() >= 2)
    {
        return t[1..t.len() - 1].to_string();
    }
    t.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_wildcard() {
        let src = "---\nname: gp\ndescription: foo\ntools: \"*\"\n---\nhello world\n";
        let p = parse(src).unwrap();
        assert_eq!(p.fields["name"], "gp");
        assert_eq!(p.fields["description"], "foo");
        assert_eq!(p.tools, Some(ToolsField::Wildcard));
        assert_eq!(p.body.trim(), "hello world");
    }

    #[test]
    fn parses_inline_list() {
        let src = "---\nname: r\ntools: [Read, Glob, Grep]\n---\nbody\n";
        let p = parse(src).unwrap();
        assert_eq!(
            p.tools,
            Some(ToolsField::List(vec![
                "Read".into(),
                "Glob".into(),
                "Grep".into()
            ]))
        );
    }

    #[test]
    fn parses_block_sequence_tools() {
        let src = "---\nname: r\ntools:\n  - Read\n  - Glob\n---\nbody\n";
        let p = parse(src).unwrap();
        assert_eq!(
            p.tools,
            Some(ToolsField::List(vec!["Read".into(), "Glob".into()]))
        );
    }

    #[test]
    fn rejects_missing_open_fence() {
        let err = parse("name: x\n").unwrap_err();
        matches!(err, FrontmatterError::MissingOpenFence);
    }

    #[test]
    fn rejects_missing_close_fence() {
        let err = parse("---\nname: x\n").unwrap_err();
        matches!(err, FrontmatterError::MissingCloseFence);
    }

    #[test]
    fn rejects_malformed_key_line() {
        let err = parse("---\nname x\n---\n").unwrap_err();
        matches!(err, FrontmatterError::MalformedLine(_));
    }

    #[test]
    fn unquote_strips_surrounding_quotes() {
        assert_eq!(unquote("\"hi\""), "hi");
        assert_eq!(unquote("'hi'"), "hi");
        assert_eq!(unquote("hi"), "hi");
        assert_eq!(unquote(""), "");
    }

    #[test]
    fn ignores_comments_and_blank_lines() {
        let src = "---\n# comment\nname: x\n\ntools: \"*\"\n---\nbody\n";
        let p = parse(src).unwrap();
        assert_eq!(p.fields["name"], "x");
        assert_eq!(p.tools, Some(ToolsField::Wildcard));
    }
}
