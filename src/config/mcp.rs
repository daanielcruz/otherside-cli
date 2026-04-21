

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{Error, Result};

use super::paths;

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct McpJsonConfig {

    pub mcp_servers: HashMap<String, McpServerConfig>,

    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum McpServerConfig {

    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: HashMap<String, String>,
        #[serde(flatten, default)]
        extra: Map<String, Value>,
    },

    Sse {
        url: String,
        #[serde(default)]
        headers: HashMap<String, String>,
        #[serde(flatten, default)]
        extra: Map<String, Value>,
    },

    Http {
        url: String,
        #[serde(default)]
        headers: HashMap<String, String>,
        #[serde(flatten, default)]
        extra: Map<String, Value>,
    },

    Ws {
        url: String,
        #[serde(flatten, default)]
        extra: Map<String, Value>,
    },

    Sdk {
        #[serde(flatten, default)]
        extra: Map<String, Value>,
    },
}

pub fn load_chain(cwd: &Path) -> Result<Vec<McpJsonConfig>> {
    let chain_paths = paths::mcp_json_chain(cwd);
    let mut configs = Vec::with_capacity(chain_paths.len());
    for path in chain_paths {
        let bytes = std::fs::read(&path).map_err(|e| {
            Error::Config(format!("failed to read {}: {e}", path.display()))
        })?;
        let cfg: McpJsonConfig = serde_json::from_slice(&bytes).map_err(|e| {
            Error::Config(format!("malformed mcp config in {}: {e}", path.display()))
        })?;
        configs.push(cfg);
    }
    Ok(configs)
}

pub fn merge_child_wins(chain: Vec<McpJsonConfig>) -> McpJsonConfig {
    let mut merged = McpJsonConfig::default();
    for cfg in chain {
        for (name, server) in cfg.mcp_servers {
            merged.mcp_servers.insert(name, server);
        }
        for (k, v) in cfg.extra {
            merged.extra.insert(k, v);
        }
    }
    merged
}

pub fn load_effective(cwd: &Path) -> Result<McpJsonConfig> {
    Ok(merge_child_wins(load_chain(cwd)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn corpus_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("config_corpus")
    }

    #[test]
    fn corpus_stdio_parses_all_servers() {
        let bytes = std::fs::read(corpus_root().join("mcp/stdio.json")).unwrap();
        let cfg: McpJsonConfig = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(cfg.mcp_servers.len(), 3);
        for server in cfg.mcp_servers.values() {
            assert!(matches!(server, McpServerConfig::Stdio { .. }));
        }
    }

    #[test]
    fn corpus_sse_http_mix_parses_all_five_transports() {
        let bytes = std::fs::read(corpus_root().join("mcp/sse_http_mix.json")).unwrap();
        let cfg: McpJsonConfig = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(cfg.mcp_servers.len(), 5);
        assert!(matches!(
            cfg.mcp_servers.get("local-tool").unwrap(),
            McpServerConfig::Stdio { .. }
        ));
        assert!(matches!(
            cfg.mcp_servers.get("sse-endpoint").unwrap(),
            McpServerConfig::Sse { .. }
        ));
        assert!(matches!(
            cfg.mcp_servers.get("http-endpoint").unwrap(),
            McpServerConfig::Http { .. }
        ));
        assert!(matches!(
            cfg.mcp_servers.get("ws-endpoint").unwrap(),
            McpServerConfig::Ws { .. }
        ));
        assert!(matches!(
            cfg.mcp_servers.get("sdk-embedded").unwrap(),
            McpServerConfig::Sdk { .. }
        ));
    }

    #[test]
    fn project_parent_walk_child_wins_on_collision() {

        let root = corpus_root().join("mcp/project_parent_walk/root");
        let sub = root.join("sub");

        let chain = load_chain(&sub).unwrap();
        assert_eq!(chain.len(), 2, "both .mcp.json files found");

        let effective = merge_child_wins(chain);

        assert!(effective.mcp_servers.contains_key("parent-only-server"));

        assert!(effective.mcp_servers.contains_key("child-only-server"));

        let git = effective.mcp_servers.get("git").unwrap();
        match git {
            McpServerConfig::Stdio { args, .. } => {
                assert!(args.contains(&"--verbose".to_string()));
            }
            _ => panic!("git should be stdio"),
        }

        assert!(effective.mcp_servers.contains_key("filesystem"));
    }

    #[test]
    fn cwd_at_root_sees_only_parent_config() {
        let root = corpus_root().join("mcp/project_parent_walk/root");
        let chain = load_chain(&root).unwrap();
        assert_eq!(chain.len(), 1);
        let effective = merge_child_wins(chain);

        let git = effective.mcp_servers.get("git").unwrap();
        match git {
            McpServerConfig::Stdio { args, .. } => {
                assert!(!args.contains(&"--verbose".to_string()));
            }
            _ => panic!("git should be stdio"),
        }
        assert!(!effective.mcp_servers.contains_key("child-only-server"));
    }

    #[test]
    fn round_trip_preserves_sdk_config_field() {
        let bytes = std::fs::read(corpus_root().join("mcp/sse_http_mix.json")).unwrap();
        let first: McpJsonConfig = serde_json::from_slice(&bytes).unwrap();
        let reemitted = serde_json::to_vec(&first).unwrap();
        let second: McpJsonConfig = serde_json::from_slice(&reemitted).unwrap();
        assert_eq!(first, second);

        let sdk = second.mcp_servers.get("sdk-embedded").unwrap();
        match sdk {
            McpServerConfig::Sdk { extra } => {
                assert!(extra.contains_key("package"));
                assert!(extra.contains_key("config"));
            }
            _ => panic!("expected Sdk variant"),
        }
    }
}
