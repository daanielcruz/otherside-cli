

use crate::error::{Error, Result};
use crate::inference::OpenAiChunk;

pub fn encode_chunk(chunk: &OpenAiChunk) -> Result<String> {

    let json = serde_json::to_string(chunk)
        .map_err(|e| Error::Other(format!("serialize chunk: {e}")))?;
    Ok(format!("data: {json}\n\n"))
}

pub const DONE_TERMINATOR: &str = "data: [DONE]\n\n";

pub fn done_terminator() -> &'static str {
    DONE_TERMINATOR
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inference::{OpenAiChatRole, OpenAiChoice, OpenAiDelta};

    fn sample_chunk() -> OpenAiChunk {
        OpenAiChunk {
            id: "chatcmpl-1".to_string(),
            object: OpenAiChunk::OBJECT.to_string(),
            created: 1700000000,
            model: "claude-opus-4-7".to_string(),
            choices: vec![OpenAiChoice {
                index: 0,
                delta: OpenAiDelta {
                    role: Some(OpenAiChatRole::Assistant),
                    content: Some("Hi".to_string()),
                    tool_calls: Vec::new(),
                    ..Default::default()
                },
                finish_reason: None,
            }],
            usage: None,
        }
    }

    #[test]
    fn encode_chunk_wraps_in_data_prefix_and_blank_line() {
        let encoded = encode_chunk(&sample_chunk()).unwrap();

        assert!(encoded.starts_with("data: "), "got: {encoded:?}");

        assert!(encoded.ends_with("\n\n"), "got: {encoded:?}");
    }

    #[test]
    fn encode_chunk_body_is_valid_openai_json() {
        let encoded = encode_chunk(&sample_chunk()).unwrap();

        let body = encoded
            .strip_prefix("data: ")
            .and_then(|s| s.strip_suffix("\n\n"))
            .unwrap();
        let back: OpenAiChunk = serde_json::from_str(body).unwrap();
        assert_eq!(back, sample_chunk());
    }

    #[test]
    fn encode_chunk_has_no_internal_newlines_in_data_payload() {

        let encoded = encode_chunk(&sample_chunk()).unwrap();
        let body = encoded.strip_prefix("data: ").unwrap();

        let body_core = body.strip_suffix("\n\n").unwrap();
        assert!(!body_core.contains('\n'), "body contained newline: {body_core:?}");
    }

    #[test]
    fn done_terminator_matches_openai_literal() {

        assert_eq!(done_terminator(), "data: [DONE]\n\n");
    }
}
