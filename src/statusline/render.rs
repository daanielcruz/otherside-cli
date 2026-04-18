//! Native statusline renderer. Composes segments into a single
//! ANSI-escape-embedded line and returns a `StatuslineLine` ready to
//! paint on the bottom band.
//!
//! Segment order (reversed-world cue, right-weighted to subvert the
//! upstream left-anchored layout): model | cwd | context usage |
//! [yolo chip when active] | reversed-world glyph accent.
//!
//! Colors via truecolor ANSI escapes keyed off the mascot palette —
//! `#51158C` deep violet (primary) and `#EC4899` hot pink (accent).

use std::path::Path;

use unicode_width::UnicodeWidthChar;

use crate::config::settings::PermissionMode;

use super::types::{display_width, StatuslineCtx, StatuslineLine};

// Theme palette — truecolor RGB. Mirrors `tui::render::theme::PRIMARY`
// but as raw RGB so this module stays independent of ratatui.
const VIOLET_R: u8 = 0x51;
const VIOLET_G: u8 = 0x15;
const VIOLET_B: u8 = 0x8C;

const PINK_R: u8 = 0xEC;
const PINK_G: u8 = 0x48;
const PINK_B: u8 = 0x98;

// Soft grey for dim separators — readable but deferential.
const DIM_R: u8 = 0x80;
const DIM_G: u8 = 0x80;
const DIM_B: u8 = 0x80;

// Mascot-family truncation glyph (C48-adjacent / mascot aesthetic).
const TRUNCATE_GLYPH: &str = "·••";

const SEPARATOR: &str = " · ";

/// Build the statusline output for the given ctx.
pub fn native(ctx: &StatuslineCtx) -> StatuslineLine {
    let mut segments: Vec<String> = Vec::new();

    if !ctx.payload.model.display_name.is_empty() {
        segments.push(paint(
            &ctx.payload.model.display_name,
            VIOLET_R,
            VIOLET_G,
            VIOLET_B,
        ));
    }

    let cwd_short = collapse_cwd(
        Path::new(&ctx.payload.workspace.current_dir),
        ctx.home_dir.as_deref().map(Path::new),
    );
    if !cwd_short.is_empty() {
        segments.push(paint(&cwd_short, DIM_R, DIM_G, DIM_B));
    }

    segments.push(context_chip(ctx));

    if matches!(ctx.permission_mode, PermissionMode::Yolo) {
        segments.push(paint("yolo", PINK_R, PINK_G, PINK_B));
    }

    // Reversed-world accent character on the far right — mascot-family.
    segments.push(paint("·", PINK_R, PINK_G, PINK_B));

    let joined = join_segments(&segments);
    let truncated = truncate_to_width(&joined, ctx.terminal_width);
    let width_cols = display_width(&truncated);
    StatuslineLine {
        content: truncated,
        width_cols,
    }
}

fn paint(text: &str, r: u8, g: u8, b: u8) -> String {
    format!("\x1b[38;2;{r};{g};{b}m{text}\x1b[0m")
}

fn join_segments(segments: &[String]) -> String {
    let mut out = String::new();
    for (i, seg) in segments.iter().enumerate() {
        if seg.is_empty() {
            continue;
        }
        if i > 0 {
            out.push(' ');
            out.push_str(&paint(SEPARATOR.trim_matches(' '), DIM_R, DIM_G, DIM_B));
            out.push(' ');
        }
        out.push_str(seg);
    }
    out
}

/// Collapse a cwd against the home dir: `/Users/foo/projects/demo` under
/// home `/Users/foo` becomes `~/projects/demo`. Falls back to the raw
/// path if cwd is outside home.
pub fn collapse_cwd(cwd: &Path, home: Option<&Path>) -> String {
    let cwd_s = cwd.to_string_lossy();
    if let Some(h) = home {
        let h_s = h.to_string_lossy();
        if cwd == h {
            return "~".to_string();
        }
        if let Some(rest) = cwd_s.strip_prefix(h_s.as_ref()) {
            if rest.starts_with('/') {
                return format!("~{rest}");
            }
        }
    }
    cwd_s.into_owned()
}

fn context_chip(ctx: &StatuslineCtx) -> String {
    let used = ctx.payload.context_window.used_percentage;
    let label = format!("{used}%");
    if ctx.payload.exceeds_200k_tokens {
        paint(&format!("▲ {label}"), PINK_R, PINK_G, PINK_B)
    } else if used >= 80 {
        paint(&label, PINK_R, PINK_G, PINK_B)
    } else {
        paint(&label, VIOLET_R, VIOLET_G, VIOLET_B)
    }
}

/// Truncate a line to `width_cols` display columns, preserving ANSI
/// escape sequences (zero-width) and ending in the mascot-family
/// truncation glyph when truncation occurs.
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
    // Close any dangling SGR sequence before appending the glyph.
    out.push_str("\x1b[0m");
    out.push_str(TRUNCATE_GLYPH);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::statusline::types::StatuslineCtx;

    #[test]
    fn native_minimal_ctx_renders_non_empty_line() {
        let ctx = StatuslineCtx::minimal_for_test();
        let line = native(&ctx);
        assert!(line.content.contains("Opus 4.7"));
        assert!(line.content.contains("0%") || line.content.contains("0 %"));
    }

    #[test]
    fn native_includes_yolo_chip_when_mode_is_yolo() {
        let mut ctx = StatuslineCtx::minimal_for_test();
        ctx.permission_mode = PermissionMode::Yolo;
        let line = native(&ctx);
        assert!(line.content.contains("yolo"));
    }

    #[test]
    fn native_omits_yolo_chip_in_default_mode() {
        let ctx = StatuslineCtx::minimal_for_test();
        let line = native(&ctx);
        assert!(!line.content.contains("yolo"));
    }

    #[test]
    fn native_over_200k_uses_pink_warning() {
        let mut ctx = StatuslineCtx::minimal_for_test();
        ctx.payload.exceeds_200k_tokens = true;
        ctx.payload.context_window.used_percentage = 105;
        let line = native(&ctx);
        assert!(line.content.contains("▲"));
        // Pink truecolor escape.
        assert!(line.content.contains("236;72;152"));
    }

    #[test]
    fn collapse_cwd_under_home() {
        let home = Path::new("/Users/example");
        let cwd = Path::new("/Users/example/projects/demo");
        assert_eq!(collapse_cwd(cwd, Some(home)), "~/projects/demo");
    }

    #[test]
    fn collapse_cwd_equals_home() {
        let home = Path::new("/Users/example");
        assert_eq!(collapse_cwd(home, Some(home)), "~");
    }

    #[test]
    fn collapse_cwd_outside_home() {
        let home = Path::new("/Users/example");
        let cwd = Path::new("/tmp/other");
        assert_eq!(collapse_cwd(cwd, Some(home)), "/tmp/other");
    }

    #[test]
    fn collapse_cwd_with_no_home() {
        let cwd = Path::new("/tmp/demo");
        assert_eq!(collapse_cwd(cwd, None), "/tmp/demo");
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
        // Must still contain the opening escape.
        assert!(out.contains("\x1b[38;2;255;0;0m"));
        assert!(out.ends_with(TRUNCATE_GLYPH));
    }

    #[test]
    fn context_chip_under_80_is_violet() {
        let mut ctx = StatuslineCtx::minimal_for_test();
        ctx.payload.context_window.used_percentage = 40;
        let chip = context_chip(&ctx);
        assert!(chip.contains("81;21;140"));
        assert!(chip.contains("40%"));
    }

    #[test]
    fn context_chip_at_warning_threshold_is_pink() {
        let mut ctx = StatuslineCtx::minimal_for_test();
        ctx.payload.context_window.used_percentage = 85;
        let chip = context_chip(&ctx);
        assert!(chip.contains("236;72;152"));
    }
}
