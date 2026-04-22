

use unicode_width::UnicodeWidthChar;

use super::types::{display_width, StatuslineCtx, StatuslineLine};

const TRUNCATE_GLYPH: &str = "·••";

pub fn native(ctx: &StatuslineCtx) -> StatuslineLine {
    let display_name = if ctx.payload.model.display_name.is_empty() {
        ctx.payload.model.id.as_str()
    } else {
        ctx.payload.model.display_name.as_str()
    };

    let window = ctx.payload.context_window.context_window_size;
    let used = ctx.payload.context_window.current_usage;
    let avail = window.saturating_sub(used);
    let avail_fmt = format_tokens(avail, window);
    let pct = ctx.payload.context_window.used_percentage;

    let content =
        format!("🤖 {display_name} | 📉 {avail_fmt} available | 🧠 {pct}% used");
    let truncated = truncate_to_width(&content, ctx.terminal_width);
    let width_cols = display_width(&truncated);
    StatuslineLine {
        content: truncated,
        width_cols,
    }
}

fn format_tokens(tokens: u64, window: u64) -> String {
    if window >= 1_000_000 {
        format!("{:.1}M", tokens as f64 / 1_000_000.0)
    } else {
        format!("{}K", tokens / 1_000)
    }
}

pub fn truncate_to_width(line: &str, width_cols: u16) -> String {
    if display_width(line) <= width_cols {
        return line.to_string();
    }

    let glyph_width = display_width(TRUNCATE_GLYPH);
    if width_cols <= glyph_width {
        return TRUNCATE_GLYPH.chars().take(width_cols as usize).collect();
    }
    let budget = width_cols.saturating_sub(glyph_width);

    let mut out = String::new();
    let mut rendered_width: u16 = 0;
    let mut in_escape = false;
    for ch in line.chars() {
        if in_escape {
            out.push(ch);
            if ch.is_ascii_alphabetic() {
                in_escape = false;
            }
            continue;
        }
        if ch == '\x1b' {
            out.push(ch);
            in_escape = true;
            continue;
        }
        let ch_w = ch.width().unwrap_or(0) as u16;
        if rendered_width + ch_w > budget {
            break;
        }
        out.push(ch);
        rendered_width += ch_w;
    }

    out.push_str("\x1b[0m");
    out.push_str(TRUNCATE_GLYPH);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::statusline::types::StatuslineCtx;

    #[test]
    fn native_minimal_ctx_renders_locked_emoji_shape() {
        let ctx = StatuslineCtx::minimal_for_test();
        let line = native(&ctx);
        assert!(
            line.content.starts_with("🤖 "),
            "missing robot prefix: {}",
            line.content
        );
        assert!(
            line.content.contains(" | 📉 "),
            "missing chart-decreasing segment: {}",
            line.content
        );
        assert!(
            line.content.contains(" | 🧠 "),
            "missing brain segment: {}",
            line.content
        );
        assert!(line.content.contains("available"));
        assert!(line.content.contains("% used"));
    }

    #[test]
    fn native_includes_display_name_from_payload() {
        let ctx = StatuslineCtx::minimal_for_test();
        let line = native(&ctx);
        assert!(line.content.contains(&ctx.payload.model.display_name));
    }

    #[test]
    fn native_contains_no_provider_identifier() {
        let ctx = StatuslineCtx::minimal_for_test();
        let line = native(&ctx);
        for banned in ["provider:", "anthropic-oauth", "openai-api", "provider_id"] {
            assert!(
                !line.content.contains(banned),
                "banned substring {banned} in: {}",
                line.content
            );
        }
    }

    #[test]
    fn native_contains_no_upstream_product_name() {
        let ctx = StatuslineCtx::minimal_for_test();
        let line = native(&ctx);
        let lower = line.content.to_lowercase();
        assert!(!lower.contains("claude code"));
        assert!(!lower.contains("claude-code"));
    }

    #[test]
    fn truncate_to_width_preserves_short_line() {
        let line = "hello";
        assert_eq!(truncate_to_width(line, 80), "hello");
    }

    #[test]
    fn truncate_to_width_trims_long_line_with_glyph() {
        let line = "abcdefghij";
        let out = truncate_to_width(line, 6);
        assert!(out.ends_with(TRUNCATE_GLYPH));
        assert!(display_width(&out) <= 6);
    }

    #[test]
    fn truncate_preserves_ansi_escapes_mid_segment() {
        let line = "\x1b[38;2;255;0;0mhello world\x1b[0m";
        let out = truncate_to_width(line, 7);

        assert!(out.contains("\x1b[38;2;255;0;0m"));
        assert!(out.ends_with(TRUNCATE_GLYPH));
    }
}
