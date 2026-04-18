//! Deep-merge engine for config overlays: recursive object merge,
//! array concat + order-preserving dedupe, scalar last-wins.
//!
//! Why centralized: the five-scope resolver, the managed drop-in
//! loader, and the `.mcp.json` parent walk all need the same merge
//! semantics. A single `deep_merge(base, overlay)` keeps the rule set
//! consistent — change the rules here and every caller picks it up.
//!
//! Why array concat + dedupe: permission rules, hook entries, and MCP
//! server lists all compose additively across scopes. User-global adds
//! a rule, project-local adds two more — the user sees all three, not
//! the last list to win. Dedupe keeps the composite clean when the
//! same rule appears in multiple scopes.
//!
//! `null` semantics: overlay value of `null` is treated as a scalar
//! (last-wins), setting the key to JSON null rather than deleting it.
//! This matches the conservative default discussed in design.md; if a
//! future user decision flips to delete-on-null, touch this one
//! function and every caller picks it up.

use serde_json::Value;

/// Merge `overlay` into `base`, returning the effective value.
///
/// - Both objects → recursive merge on every key present in either.
/// - Both arrays  → concat `base ++ overlay` with first-seen dedupe.
/// - Anything else → overlay wins (scalar last-wins).
pub fn deep_merge(base: Value, overlay: Value) -> Value {
    match (base, overlay) {
        (Value::Object(mut base_map), Value::Object(overlay_map)) => {
            for (k, v) in overlay_map {
                let existing = base_map.remove(&k).unwrap_or(Value::Null);
                // If the base lacked the key entirely, `existing` is Null and
                // overlay wins by last-wins. If both had it, recurse.
                let merged = if matches!(existing, Value::Null) {
                    v
                } else {
                    deep_merge(existing, v)
                };
                base_map.insert(k, merged);
            }
            Value::Object(base_map)
        }
        (Value::Array(base_arr), Value::Array(overlay_arr)) => {
            let mut out: Vec<Value> = Vec::with_capacity(base_arr.len() + overlay_arr.len());
            for v in base_arr.into_iter().chain(overlay_arr.into_iter()) {
                if !out.contains(&v) {
                    out.push(v);
                }
            }
            Value::Array(out)
        }
        (_, overlay) => overlay,
    }
}

/// Fold a chain of overlays onto a base: applied left-to-right,
/// later entries win on scalar collisions.
pub fn deep_merge_chain(base: Value, chain: impl IntoIterator<Item = Value>) -> Value {
    chain.into_iter().fold(base, deep_merge)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn scalar_overlay_wins() {
        let base = json!({"x": 1, "y": 2});
        let overlay = json!({"x": 99});
        let merged = deep_merge(base, overlay);
        assert_eq!(merged, json!({"x": 99, "y": 2}));
    }

    #[test]
    fn nested_object_merges_recursively() {
        let base = json!({"outer": {"a": 1, "b": 2}, "other": "keep"});
        let overlay = json!({"outer": {"b": 22, "c": 3}});
        let merged = deep_merge(base, overlay);
        assert_eq!(
            merged,
            json!({"outer": {"a": 1, "b": 22, "c": 3}, "other": "keep"})
        );
    }

    #[test]
    fn arrays_concat_preserving_order() {
        let base = json!({"list": [1, 2, 3]});
        let overlay = json!({"list": [4, 5]});
        let merged = deep_merge(base, overlay);
        assert_eq!(merged, json!({"list": [1, 2, 3, 4, 5]}));
    }

    #[test]
    fn arrays_dedupe_first_seen_wins() {
        let base = json!({"list": ["a", "b", "c"]});
        let overlay = json!({"list": ["b", "d", "a"]});
        let merged = deep_merge(base, overlay);
        assert_eq!(merged, json!({"list": ["a", "b", "c", "d"]}));
    }

    #[test]
    fn arrays_of_objects_dedupe_structurally() {
        let base = json!({"rules": [{"tool": "Bash", "pat": "ls"}]});
        let overlay = json!({"rules": [
            {"tool": "Bash", "pat": "ls"},
            {"tool": "Bash", "pat": "cat"}
        ]});
        let merged = deep_merge(base, overlay);
        assert_eq!(
            merged,
            json!({"rules": [
                {"tool": "Bash", "pat": "ls"},
                {"tool": "Bash", "pat": "cat"}
            ]})
        );
    }

    #[test]
    fn unknown_keys_from_both_sides_survive() {
        let base = json!({"known": 1, "unknown_base": "b"});
        let overlay = json!({"known": 2, "unknown_overlay": "o"});
        let merged = deep_merge(base, overlay);
        assert_eq!(
            merged,
            json!({"known": 2, "unknown_base": "b", "unknown_overlay": "o"})
        );
    }

    #[test]
    fn null_in_overlay_sets_key_to_null_not_delete() {
        // §9.4: conservative default. delete semantics would require
        // tooling; null as scalar keeps the merge invariant simple.
        let base = json!({"x": 42});
        let overlay = json!({"x": null});
        let merged = deep_merge(base, overlay);
        assert_eq!(merged, json!({"x": null}));
    }

    #[test]
    fn object_overlay_on_scalar_replaces_wholesale() {
        let base = json!({"x": "was a string"});
        let overlay = json!({"x": {"y": 1}});
        let merged = deep_merge(base, overlay);
        assert_eq!(merged, json!({"x": {"y": 1}}));
    }

    #[test]
    fn chain_fold_applies_left_to_right() {
        let base = json!({"x": 1});
        let chain = vec![json!({"x": 2}), json!({"x": 3}), json!({"y": 99})];
        let merged = deep_merge_chain(base, chain);
        assert_eq!(merged, json!({"x": 3, "y": 99}));
    }

    #[test]
    fn empty_overlay_returns_base() {
        let base = json!({"a": 1});
        let merged = deep_merge(base.clone(), json!({}));
        assert_eq!(merged, base);
    }

    #[test]
    fn permission_list_composition_across_scopes() {
        // Real-world shape: two scopes each add to permissions.deny.
        let base = json!({"permissions": {"deny": [{"toolName": "Bash", "matchPattern": "rm -rf *"}]}});
        let overlay = json!({"permissions": {"deny": [
            {"toolName": "Bash", "matchPattern": "sudo *"},
            {"toolName": "Bash", "matchPattern": "rm -rf *"}
        ]}});
        let merged = deep_merge(base, overlay);
        assert_eq!(
            merged,
            json!({"permissions": {"deny": [
                {"toolName": "Bash", "matchPattern": "rm -rf *"},
                {"toolName": "Bash", "matchPattern": "sudo *"}
            ]}})
        );
    }
}
