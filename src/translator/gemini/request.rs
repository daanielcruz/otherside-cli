
use serde_json::{json, Map, Value};

use crate::inference::{OpenAiChatRequest, OpenAiChatRole, OpenAiToolDef};
#[cfg(test)]
use crate::inference::OpenAiChatMessage;
use crate::thinking::{ThinkingConfig, ThinkingLevel, ThinkingMode};

pub fn build_request_body(
    req: &OpenAiChatRequest,
    thinking: Option<&ThinkingConfig>,
    project_id: Option<&str>,
    session_id: Option<&str>,
    user_prompt_id: Option<&str>,
) -> Value {
    let mut contents: Vec<Value> = Vec::new();
    let mut system_text = String::new();

    for msg in &req.messages {
        match msg.role {
            OpenAiChatRole::System => {
                if !msg.content.is_empty() {
                    if !system_text.is_empty() {
                        system_text.push_str("\n\n");
                    }
                    system_text.push_str(&msg.content);
                }
            }
            OpenAiChatRole::User => {
                contents.push(json!({
                    "role": "user",
                    "parts": [{"text": msg.content}],
                }));
            }
            OpenAiChatRole::Assistant => {
                let mut parts: Vec<Value> = Vec::new();
                if !msg.content.is_empty() {
                    parts.push(json!({"text": msg.content}));
                }
                for tc in &msg.tool_calls {
                    let args_value: Value = serde_json::from_str::<Value>(&tc.function.arguments)
                        .unwrap_or_else(|_| Value::Object(Map::new()));
                    parts.push(json!({
                        "functionCall": {
                            "name": tc.function.name,
                            "args": args_value,
                        },
                    }));
                }
                if parts.is_empty() {
                    parts.push(json!({"text": ""}));
                }
                contents.push(json!({
                    "role": "model",
                    "parts": parts,
                }));
            }
            OpenAiChatRole::Tool => {
                let call_id = msg
                    .tool_call_id
                    .clone()
                    .unwrap_or_else(|| "unknown".to_string());
                let response_value: Value = match serde_json::from_str::<Value>(&msg.content) {
                    Ok(v) if v.is_object() => v,
                    _ => json!({"output": msg.content}),
                };
                contents.push(json!({
                    "role": "user",
                    "parts": [{
                        "functionResponse": {
                            "name": msg.name.clone().unwrap_or(call_id),
                            "response": response_value,
                        }
                    }],
                }));
            }
        }
    }

    let mut vertex_request = Map::new();
    vertex_request.insert("contents".into(), Value::Array(contents));

    if !system_text.is_empty() {
        vertex_request.insert(
            "systemInstruction".into(),
            json!({
                "role": "user",
                "parts": [{"text": system_text}],
            }),
        );
    }

    let tools_json = openai_tools_to_gemini_tools(&req.tools);
    if !tools_json.is_empty() {
        vertex_request.insert("tools".into(), Value::Array(tools_json));
        if let Some(tool_config) = build_tool_config(&req.tool_choice) {
            vertex_request.insert("toolConfig".into(), tool_config);
        }
    }

    let mut generation_config = Map::new();
    if let Some(t) = req.temperature {
        generation_config.insert("temperature".into(), json!(t));
    }
    if let Some(p) = req.top_p {
        generation_config.insert("topP".into(), json!(p));
    }
    if let Some(max) = req.max_tokens {
        generation_config.insert("maxOutputTokens".into(), json!(max));
    }
    if let Some(stop) = req.stop.as_ref().filter(|s| !s.is_empty()) {
        generation_config.insert("stopSequences".into(), json!(stop));
    }
    if let Some(tc) = thinking.and_then(thinking_config_json) {
        generation_config.insert("thinkingConfig".into(), tc);
    }
    if !generation_config.is_empty() {
        vertex_request.insert("generationConfig".into(), Value::Object(generation_config));
    }

    if let Some(sid) = session_id {
        vertex_request.insert("session_id".into(), Value::String(sid.to_string()));
    }

    let mut body = Map::new();
    body.insert("model".into(), Value::String(req.model.clone()));
    if let Some(pid) = project_id {
        body.insert("project".into(), Value::String(pid.to_string()));
    }
    if let Some(upid) = user_prompt_id {
        body.insert("user_prompt_id".into(), Value::String(upid.to_string()));
    }
    body.insert("request".into(), Value::Object(vertex_request));

    Value::Object(body)
}

pub fn openai_tools_to_gemini_tools(tools: &[OpenAiToolDef]) -> Vec<Value> {
    if tools.is_empty() {
        return Vec::new();
    }
    let declarations: Vec<Value> = tools
        .iter()
        .map(|t| {
            let params = sanitize_parameters_schema(&t.function.parameters);
            json!({
                "name": t.function.name,
                "description": t.function.description,
                "parameters": params,
            })
        })
        .collect();
    vec![json!({ "functionDeclarations": declarations })]
}

fn sanitize_parameters_schema(schema: &Value) -> Value {
    sanitize_schema_node(schema)
}

fn sanitize_schema_node(schema: &Value) -> Value {
    let Value::Object(map) = schema else {
        return schema.clone();
    };
    let mut out = Map::new();
    for (k, v) in map {
        if SCHEMA_KEYS_DROP.contains(&k.as_str()) {
            continue;
        }
        let converted = match k.as_str() {
            "properties" => match v {
                Value::Object(inner) => Value::Object(
                    inner
                        .iter()
                        .map(|(ik, iv)| (ik.clone(), sanitize_schema_node(iv)))
                        .collect(),
                ),
                other => other.clone(),
            },
            "items" => sanitize_schema_node(v),
            "allOf" | "anyOf" | "oneOf" => match v {
                Value::Array(arr) => {
                    Value::Array(arr.iter().map(sanitize_schema_node).collect())
                }
                other => other.clone(),
            },
            "required" | "enum" | "default" => v.clone(),
            _ => v.clone(),
        };
        out.insert(k.clone(), converted);
    }
    if !out.contains_key("type") && out.contains_key("properties") {
        out.insert("type".into(), Value::String("object".into()));
    }
    Value::Object(out)
}

const SCHEMA_KEYS_DROP: &[&str] = &[
    "additionalProperties",
    "$schema",
    "$id",
    "$ref",
    "$comment",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "patternProperties",
    "const",
    "examples",
];

fn build_tool_config(tool_choice: &Option<Value>) -> Option<Value> {
    let choice = tool_choice.as_ref()?;
    let mode = match choice {
        Value::String(s) => match s.as_str() {
            "auto" => "AUTO",
            "required" | "any" => "ANY",
            "none" => "NONE",
            _ => "AUTO",
        },
        Value::Object(_) => "ANY",
        _ => "AUTO",
    };
    Some(json!({
        "functionCallingConfig": { "mode": mode }
    }))
}

fn thinking_config_json(cfg: &ThinkingConfig) -> Option<Value> {
    if matches!(cfg.mode, ThinkingMode::None | ThinkingMode::Auto) {
        return None;
    }
    let budget: i32 = match cfg.level {
        ThinkingLevel::Off | ThinkingLevel::None => 0,
        ThinkingLevel::Minimal => 512,
        ThinkingLevel::Low => 2048,
        ThinkingLevel::Medium => 8192,
        ThinkingLevel::High => 16384,
        ThinkingLevel::XHigh => 24576,
        ThinkingLevel::Max | ThinkingLevel::On => 32768,
        ThinkingLevel::Auto => return None,
    };
    Some(json!({
        "thinkingBudget": budget,
        "includeThoughts": true,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inference::{OpenAiFunctionDef, OpenAiToolCall, OpenAiToolCallFunction};

    fn user(content: &str) -> OpenAiChatMessage {
        OpenAiChatMessage {
            role: OpenAiChatRole::User,
            content: content.into(),
            ..Default::default()
        }
    }

    fn system(content: &str) -> OpenAiChatMessage {
        OpenAiChatMessage {
            role: OpenAiChatRole::System,
            content: content.into(),
            ..Default::default()
        }
    }

    fn tool_def(name: &str) -> OpenAiToolDef {
        OpenAiToolDef {
            kind: "function".into(),
            function: OpenAiFunctionDef {
                name: name.into(),
                description: format!("{name} does the thing"),
                parameters: json!({"type":"object","properties":{"x":{"type":"string"}},"required":["x"],"additionalProperties":false}),
            },
        }
    }

    #[test]
    fn system_messages_become_system_instruction_text() {
        let req = OpenAiChatRequest {
            model: "gemini-3-pro-preview".into(),
            messages: vec![system("you are helpful"), user("hi")],
            ..Default::default()
        };
        let body = build_request_body(&req, None, None, None, None);
        assert_eq!(body["model"], "gemini-3-pro-preview");
        let vr = &body["request"];
        assert_eq!(
            vr["systemInstruction"]["parts"][0]["text"], "you are helpful",
            "system must be hoisted into systemInstruction, not left in contents"
        );
        let contents = vr["contents"].as_array().unwrap();
        assert_eq!(contents.len(), 1);
        assert_eq!(contents[0]["role"], "user");
    }

    #[test]
    fn multiple_system_messages_concatenate_with_double_newline() {
        let req = OpenAiChatRequest {
            model: "gemini-3-pro-preview".into(),
            messages: vec![system("a"), system("b"), user("hi")],
            ..Default::default()
        };
        let body = build_request_body(&req, None, None, None, None);
        assert_eq!(body["request"]["systemInstruction"]["parts"][0]["text"], "a\n\nb");
    }

    #[test]
    fn assistant_role_maps_to_model_role() {
        let mut asst = OpenAiChatMessage::default();
        asst.role = OpenAiChatRole::Assistant;
        asst.content = "sure".into();
        let req = OpenAiChatRequest {
            model: "gemini-3-pro-preview".into(),
            messages: vec![user("hi"), asst],
            ..Default::default()
        };
        let body = build_request_body(&req, None, None, None, None);
        let contents = body["request"]["contents"].as_array().unwrap();
        assert_eq!(contents[0]["role"], "user");
        assert_eq!(contents[1]["role"], "model");
        assert_eq!(contents[1]["parts"][0]["text"], "sure");
    }

    #[test]
    fn assistant_tool_call_becomes_function_call_part() {
        let mut asst = OpenAiChatMessage::default();
        asst.role = OpenAiChatRole::Assistant;
        asst.content = "".into();
        asst.tool_calls.push(OpenAiToolCall {
            id: "call-1".into(),
            kind: "function".into(),
            function: OpenAiToolCallFunction {
                name: "Glob".into(),
                arguments: r#"{"pattern":"*.rs"}"#.into(),
            },
        });
        let req = OpenAiChatRequest {
            model: "gemini-3-pro-preview".into(),
            messages: vec![asst],
            ..Default::default()
        };
        let body = build_request_body(&req, None, None, None, None);
        let parts = body["request"]["contents"][0]["parts"].as_array().unwrap();
        assert_eq!(parts[0]["functionCall"]["name"], "Glob");
        assert_eq!(parts[0]["functionCall"]["args"]["pattern"], "*.rs");
    }

    #[test]
    fn tool_role_becomes_function_response_part_under_user_role() {
        let msg = OpenAiChatMessage {
            role: OpenAiChatRole::Tool,
            content: r#"{"matches":["a.rs"]}"#.into(),
            tool_call_id: Some("call-1".into()),
            name: Some("Glob".into()),
            ..Default::default()
        };
        let req = OpenAiChatRequest {
            model: "gemini-3-pro-preview".into(),
            messages: vec![msg],
            ..Default::default()
        };
        let body = build_request_body(&req, None, None, None, None);
        let contents = body["request"]["contents"].as_array().unwrap();
        assert_eq!(contents[0]["role"], "user");
        let fr = &contents[0]["parts"][0]["functionResponse"];
        assert_eq!(fr["name"], "Glob");
        assert_eq!(fr["response"]["matches"][0], "a.rs");
    }

    #[test]
    fn tool_role_plain_text_wrapped_in_output_field() {
        let msg = OpenAiChatMessage {
            role: OpenAiChatRole::Tool,
            content: "exit=0\nhello".into(),
            tool_call_id: Some("call-1".into()),
            name: Some("Bash".into()),
            ..Default::default()
        };
        let req = OpenAiChatRequest {
            model: "gemini-3-pro-preview".into(),
            messages: vec![msg],
            ..Default::default()
        };
        let body = build_request_body(&req, None, None, None, None);
        let fr = &body["request"]["contents"][0]["parts"][0]["functionResponse"];
        assert_eq!(fr["response"]["output"], "exit=0\nhello");
    }

    #[test]
    fn tools_flatten_into_function_declarations_envelope() {
        let out = openai_tools_to_gemini_tools(&[tool_def("Glob"), tool_def("Bash")]);
        assert_eq!(out.len(), 1, "gemini wraps all declarations in one tools[] entry");
        let decls = out[0]["functionDeclarations"].as_array().unwrap();
        assert_eq!(decls.len(), 2);
        assert_eq!(decls[0]["name"], "Glob");
        assert_eq!(decls[1]["name"], "Bash");
    }

    #[test]
    fn tool_parameters_strip_additional_properties_for_vertex_compat() {
        let out = openai_tools_to_gemini_tools(&[tool_def("Glob")]);
        let params = &out[0]["functionDeclarations"][0]["parameters"];
        assert!(
            params.get("additionalProperties").is_none(),
            "vertex rejects additionalProperties; translator must strip it"
        );
        assert_eq!(params["type"], "object");
        assert!(params["properties"]["x"].is_object());
    }

    #[test]
    fn sanitizer_does_not_inject_type_into_properties_dict() {
        let schema = json!({
            "type": "object",
            "properties": {
                "a": {"type": "string"},
                "b": {"type": "integer"}
            }
        });
        let clean = sanitize_parameters_schema(&schema);
        let props = &clean["properties"];
        assert!(props.get("type").is_none(),
            "properties map is a dict of schemas, not a schema itself — must not gain a type:object row");
        assert_eq!(props["a"]["type"], "string");
    }

    #[test]
    fn sanitizer_strips_exclusive_minimum_and_maximum() {
        let schema = json!({
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "exclusiveMinimum": 0, "exclusiveMaximum": 100}
            }
        });
        let clean = sanitize_parameters_schema(&schema);
        let limit = &clean["properties"]["limit"];
        assert!(limit.get("exclusiveMinimum").is_none());
        assert!(limit.get("exclusiveMaximum").is_none());
        assert_eq!(limit["type"], "integer");
    }

    #[test]
    fn sanitizer_recurses_into_array_items() {
        let schema = json!({
            "type": "object",
            "properties": {
                "ids": {
                    "type": "array",
                    "items": {"type": "string", "$schema": "https://json-schema.org/draft/2020-12/schema"}
                }
            }
        });
        let clean = sanitize_parameters_schema(&schema);
        let items = &clean["properties"]["ids"]["items"];
        assert_eq!(items["type"], "string");
        assert!(items.get("$schema").is_none());
    }

    #[test]
    fn tool_choice_auto_maps_to_functioncallingconfig_auto() {
        let req = OpenAiChatRequest {
            model: "gemini-3-pro-preview".into(),
            messages: vec![user("hi")],
            tools: vec![tool_def("Glob")],
            tool_choice: Some(json!("auto")),
            ..Default::default()
        };
        let body = build_request_body(&req, None, None, None, None);
        assert_eq!(
            body["request"]["toolConfig"]["functionCallingConfig"]["mode"],
            "AUTO"
        );
    }

    #[test]
    fn tool_choice_required_maps_to_any() {
        let req = OpenAiChatRequest {
            model: "gemini-3-pro-preview".into(),
            messages: vec![user("hi")],
            tools: vec![tool_def("Glob")],
            tool_choice: Some(json!("required")),
            ..Default::default()
        };
        let body = build_request_body(&req, None, None, None, None);
        assert_eq!(
            body["request"]["toolConfig"]["functionCallingConfig"]["mode"],
            "ANY"
        );
    }

    #[test]
    fn generation_config_carries_temperature_and_max_tokens() {
        let req = OpenAiChatRequest {
            model: "gemini-3-pro-preview".into(),
            messages: vec![user("hi")],
            temperature: Some(0.7),
            max_tokens: Some(1024),
            top_p: Some(0.95),
            ..Default::default()
        };
        let body = build_request_body(&req, None, None, None, None);
        let gc = &body["request"]["generationConfig"];
        assert!((gc["temperature"].as_f64().unwrap() - 0.7).abs() < 1e-6);
        assert!((gc["topP"].as_f64().unwrap() - 0.95).abs() < 1e-6);
        assert_eq!(gc["maxOutputTokens"], 1024);
    }

    #[test]
    fn thinking_high_maps_to_non_zero_thinking_budget() {
        let req = OpenAiChatRequest {
            model: "gemini-3-pro-preview".into(),
            messages: vec![user("hi")],
            ..Default::default()
        };
        let body = build_request_body(
            &req,
            Some(&ThinkingConfig::level(ThinkingLevel::High)),
            None,
            None,
            None,
        );
        let tc = &body["request"]["generationConfig"]["thinkingConfig"];
        assert!(tc["thinkingBudget"].as_i64().unwrap() > 0);
        assert_eq!(tc["includeThoughts"], true);
    }

    #[test]
    fn thinking_auto_omits_thinking_config() {
        let req = OpenAiChatRequest {
            model: "gemini-3-pro-preview".into(),
            messages: vec![user("hi")],
            ..Default::default()
        };
        let body = build_request_body(&req, Some(&ThinkingConfig::auto()), None, None, None);
        assert!(body["request"].get("generationConfig").is_none(),
            "auto thinking + no other gen params → no generationConfig envelope");
    }

    #[test]
    fn project_id_and_prompt_id_serialize_at_top_level() {
        let req = OpenAiChatRequest {
            model: "gemini-3-pro-preview".into(),
            messages: vec![user("hi")],
            ..Default::default()
        };
        let body = build_request_body(&req, None, Some("proj-1"), Some("sess-1"), Some("prompt-1"));
        assert_eq!(body["project"], "proj-1");
        assert_eq!(body["user_prompt_id"], "prompt-1");
        assert_eq!(body["request"]["session_id"], "sess-1");
    }
}
