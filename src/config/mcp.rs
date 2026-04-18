//! `.mcp.json` loader — parent-directory walk from CWD upward,
//! child-wins merge on the `mcpServers` map.
//!
//! Why the walk: MCP servers are workspace-scoped by nature (a git
//! repo's MCP config is meaningful inside that repo's tree). Walking
//! up from CWD collecting every `.mcp.json` gives users the natural
//! "define it once at the root, override in a sub-project" UX without
//! any explicit registration step.
//!
//! Why child-wins: the file closest to CWD describes the most specific
//! intent. When `root/.mcp.json` and `root/sub/.mcp.json` both define
//! a server called `git`, the `sub/` entry is almost certainly the one
//! the user wants while CWD is inside `sub/`.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{Error, Result};

use super::paths;

/// `.mcp.json` top-level shape.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct McpJsonConfig {
    /// Map of server name → server config.
    pub mcp_servers: HashMap<String, McpServerConfig>,

    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Five server transports, discriminated by the `"type"` tag. Unknown
/// fields survive round-trips via `extra`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum McpServerConfig {
    /// Local subprocess speaking stdio JSON-RPC.
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: HashMap<String, String>,
        #[serde(flatten, default)]
        extra: Map<String, Value>,
    },
    /// Server-Sent Events endpoint.
    Sse {
        url: String,
        #[serde(default)]
        headers: HashMap<String, String>,
        #[serde(flatten, default)]
        extra: Map<String, Value>,
    },
    /// JSON-over-HTTP endpoint.
    Http {
        url: String,
        #[serde(default)]
        headers: HashMap<String, String>,
        #[serde(flatten, default)]
        extra: Map<String, Value>,
    },
    /// Persistent WebSocket connection.
    Ws {
        url: String,
        #[serde(flatten, default)]
        extra: Map<String, Value>,
    },
    /// SDK-embedded server (in-process).
    Sdk {
        #[serde(flatten, default)]
        extra: Map<String, Value>,
    },
}

/// Walk CWD upward, load every `.mcp.json` found. Returns them in
/// base→overlay order: element 0 is the farthest ancestor, last is
/// the closest. Caller folds with `merge_child_wins` to collapse.
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

/// Collapse a base→overlay chain into one effective config. Later
/// entries overwrite earlier entries on any server-name collision.
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

/// Convenience: load chain + collapse in one call.
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
        // Load the corpus fixture directly, simulate walking sub → root.
        // `mcp_json_chain` returns [root, sub] — fold that.
        let root = corpus_root().join("mcp/project_parent_walk/root");
        let sub = root.join("sub");

        let chain = load_chain(&sub).unwrap();
        assert_eq!(chain.len(), 2, "both .mcp.json files found");

        let effective = merge_child_wins(chain);
        // parent-only-server stays.
        assert!(effective.mcp_servers.contains_key("parent-only-server"));
        // child-only-server added.
        assert!(effective.mcp_servers.contains_key("child-only-server"));
        // git is the SUB version (has --verbose arg).
        let git = effective.mcp_servers.get("git").unwrap();
        match git {
            McpServerConfig::Stdio { args, .. } => {
                assert!(args.contains(&"--verbose".to_string()));
            }
            _ => panic!("git should be stdio"),
        }
        // filesystem only existed in parent — survives.
        assert!(effective.mcp_servers.contains_key("filesystem"));
    }

    #[test]
    fn cwd_at_root_sees_only_parent_config() {
        let root = corpus_root().join("mcp/project_parent_walk/root");
        let chain = load_chain(&root).unwrap();
        assert_eq!(chain.len(), 1);
        let effective = merge_child_wins(chain);
        // git at root lacks --verbose.
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

        // sdk-embedded has nested config field — preserved in extras.
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
