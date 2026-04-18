//! Server-Sent Events (SSE) line-based byte parser.
//!
//! # Why a hand-rolled parser
//!
//! reqwest's `.bytes_stream()` delivers TCP chunks of arbitrary size. A
//! single SSE event (`event: X\ndata: Y\n\n`) might arrive in one chunk,
//! or split across many. We need an accumulator that consumes bytes,
//! buffers partial frames, and emits whole [`SseEvent`]s as their
//! terminator (`\n\n` or `\r\n\r\n`) is observed.
//!
//! Existing SSE crates exist (`eventsource-stream`, `reqwest-eventsource`)
//! but they pull async-compat machinery we don't need here — this parser
//! is pure, synchronous-over-bytes, and easy to unit-test with fixed
//! fixtures.
//!
//! # Spec surface implemented (W3C SSE, minimal subset)
//!
//! - `event:` / `data:` / `id:` / `retry:` lines with a colon separator.
//!   Per spec, a single space after the colon is consumed (if present).
//! - Multiple `data:` lines in the same event concatenate with `\n`.
//! - Lines starting with `:` are comments — ignored.
//! - Empty line terminates the current event.
//! - Both LF (`\n`) and CRLF (`\r\n`) line endings are accepted.
//! - Unknown field names are silently ignored (forward-compat).
//!
//! # Not implemented (not needed by the providers we target)
//!
//! - `Last-Event-ID` connection reconnect logic (caller's responsibility).
//! - BOM stripping at connection start (captured corpus has no BOM).
//!
//! # Anthropic SSE quirks observed in corpus
//!
//! Anthropic pads `data:` payloads with trailing whitespace before the
//! closing `}` of the JSON — this is flush padding to push the frame
//! through proxies. JSON parsers tolerate it (whitespace before `}` is
//! legal JSON) so we pass the raw payload through untouched.

/// One parsed SSE event.
///
/// Fields correspond to the W3C spec. Any field may be empty (default).
/// Callers interpret `data` as the payload — for Anthropic's stream that
/// is a JSON object whose `type` field identifies the event shape.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SseEvent {
    /// The `event:` field. Empty string if the frame had no `event:` line
    /// — callers should treat that as the `"message"` default per spec.
    pub event: String,
    /// The `data:` field — multiple `data:` lines joined with `\n`.
    pub data: String,
    /// The `id:` field if present.
    pub id: String,
    /// The `retry:` field as a milliseconds integer, if present and
    /// numeric.
    pub retry: Option<u64>,
}

/// Streaming accumulator: push bytes in, drain completed events out.
///
/// # Lifecycle
///
/// 1. `push(chunk)` for each byte slice delivered by the HTTP client.
/// 2. Drain completed events via [`SseBuffer::pop`] or iterate via
///    [`SseBuffer::drain`] — both are non-blocking.
/// 3. When the underlying stream ends, call [`SseBuffer::flush_on_eof`]
///    to surface any final event that lacked a trailing blank line (rare
///    in practice but permitted by spec).
///
/// # Invariants
///
/// - `buf` always holds bytes up to but NOT including the next known
///   event terminator. Whenever `push` observes a terminator, it consumes
///   the bytes-through-terminator and appends the completed event to
///   `events`.
/// - Events are produced in arrival order. There is no re-ordering.
#[derive(Debug, Default)]
pub struct SseBuffer {
    /// Raw bytes that have been pushed but not yet closed into an event.
    buf: Vec<u8>,
    /// Completed events waiting to be drained by the caller.
    events: std::collections::VecDeque<SseEvent>,
}

impl SseBuffer {
    /// Construct an empty buffer.
    pub fn new() -> Self {
        Self::default()
    }

    /// Push the next byte slice from the HTTP stream.
    ///
    /// Any events whose terminator (`\n\n` or `\r\n\r\n`) falls inside
    /// the combined buffer are parsed and queued for draining.
    pub fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
        self.extract_complete_events();
    }

    /// Pop the oldest completed event, if any.
    pub fn pop(&mut self) -> Option<SseEvent> {
        self.events.pop_front()
    }

    /// Drain all currently-completed events as an iterator.
    pub fn drain(&mut self) -> impl Iterator<Item = SseEvent> + '_ {
        // `std::mem::take` would reset the deque; using `drain(..)` keeps
        // ordering and clears in one pass.
        self.events.drain(..)
    }

    /// Signal end-of-stream. Returns any final event that was still in
    /// the buffer without a trailing blank line. Per spec, an incomplete
    /// trailing frame SHOULD be discarded — we keep a conservative mode
    /// where it is emitted if non-empty, so callers can decide.
    pub fn flush_on_eof(&mut self) -> Option<SseEvent> {
        if self.buf.is_empty() {
            return None;
        }
        // Treat remaining bytes as a complete frame even without the
        // terminating blank line. This matches how most SSE clients
        // handle abrupt disconnects that still deliver a full final
        // event. Anthropic's stream always terminates with a proper
        // `message_stop` + blank line, so this path is a safety net.
        let frame = std::mem::take(&mut self.buf);
        parse_frame(&frame)
    }

    /// Scan `self.buf` for every complete event terminator currently in
    /// the buffer, parse each, and push them into `self.events`. Leaves
    /// any trailing partial frame in place for a future `push` to
    /// complete.
    fn extract_complete_events(&mut self) {
        loop {
            // Find the next event terminator. Prefer `\r\n\r\n`; fall
            // back to `\n\n`. Accept either because captured corpora
            // show both styles in the wild — and the parser should be
            // lenient.
            let crlf = find_subsequence(&self.buf, b"\r\n\r\n");
            let lf = find_subsequence(&self.buf, b"\n\n");

            let (cut, term_len) = match (crlf, lf) {
                (Some(a), Some(b)) if a < b => (a, 4),
                (Some(_), Some(b)) => (b, 2),
                (Some(a), None) => (a, 4),
                (None, Some(b)) => (b, 2),
                (None, None) => return,
            };

            // Split the buffer: `frame_bytes` is the completed event's
            // raw lines; the rest (after the terminator) stays in
            // `self.buf` for the next iteration.
            let rest = self.buf.split_off(cut + term_len);
            let frame = std::mem::replace(&mut self.buf, rest);
            // `frame` still contains the terminator bytes at the end —
            // strip them so `parse_frame` sees only the event lines.
            let payload = &frame[..frame.len() - term_len];
            if let Some(event) = parse_frame(payload) {
                self.events.push_back(event);
            }
        }
    }
}

/// Parse a single SSE frame (bytes up to but not including the blank
/// line that terminates it). Returns `None` only if the frame contained
/// no meaningful fields (e.g. a frame made entirely of comment lines).
fn parse_frame(frame: &[u8]) -> Option<SseEvent> {
    let text = std::str::from_utf8(frame).ok()?;
    let mut event = SseEvent::default();
    let mut data_parts: Vec<&str> = Vec::new();
    let mut saw_field = false;

    for raw_line in text.split('\n') {
        // Normalize CRLF: each `\r\n` split on `\n` leaves a trailing
        // `\r` on the line, strip it.
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if line.is_empty() {
            continue;
        }
        if line.starts_with(':') {
            // Comment line — ignored per spec.
            continue;
        }
        // `field: value` split on FIRST colon. `value` has one leading
        // space consumed per spec.
        let (field, value) = match line.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (line, ""), // A bare field name with no colon is legal.
        };
        saw_field = true;
        match field {
            "event" => event.event = value.to_string(),
            "data" => data_parts.push(value),
            "id" => event.id = value.to_string(),
            "retry" => {
                if let Ok(ms) = value.parse::<u64>() {
                    event.retry = Some(ms);
                }
            }
            _ => {
                // Unknown field — ignored per spec forward-compat rule.
            }
        }
    }

    if !saw_field {
        return None;
    }
    event.data = data_parts.join("\n");
    Some(event)
}

/// `memmem`-style subsequence search. Used to find SSE event terminators.
/// Inlined instead of pulling `memchr` — the needles are tiny (2-4 bytes)
/// and the haystacks are short (a single event frame).
fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_event_single_push() {
        // Canonical minimal event: one `event:`, one `data:`, terminated
        // by a blank line.
        let mut b = SseBuffer::new();
        b.push(b"event: ping\ndata: {}\n\n");
        let ev = b.pop().unwrap();
        assert_eq!(ev.event, "ping");
        assert_eq!(ev.data, "{}");
        assert!(b.pop().is_none());
    }

    #[test]
    fn partial_frame_requires_multiple_pushes() {
        // Simulate a chunked delivery: the terminator straddles two
        // pushes. `pop` should only return the event once the full
        // terminator has been observed.
        let mut b = SseBuffer::new();
        b.push(b"event: ping\ndata: {");
        assert!(b.pop().is_none());
        b.push(b"}\n");
        assert!(b.pop().is_none(), "terminator not yet complete");
        b.push(b"\n");
        let ev = b.pop().unwrap();
        assert_eq!(ev.event, "ping");
        assert_eq!(ev.data, "{}");
    }

    #[test]
    fn crlf_terminator_accepted() {
        // Some servers use CRLF line endings; spec allows it.
        let mut b = SseBuffer::new();
        b.push(b"event: ping\r\ndata: {}\r\n\r\n");
        let ev = b.pop().unwrap();
        assert_eq!(ev.event, "ping");
        assert_eq!(ev.data, "{}");
    }

    #[test]
    fn multi_data_lines_join_with_newline() {
        // Per spec, multiple `data:` lines in the same event concatenate
        // separated by a single `\n`.
        let mut b = SseBuffer::new();
        b.push(b"data: hello\ndata: world\n\n");
        let ev = b.pop().unwrap();
        assert_eq!(ev.data, "hello\nworld");
    }

    #[test]
    fn comment_lines_ignored() {
        // Leading `:` marks a comment. Used by some servers as a
        // keep-alive heartbeat — must not produce a spurious event.
        let mut b = SseBuffer::new();
        b.push(b": keepalive\n\n");
        assert!(b.pop().is_none());
    }

    #[test]
    fn retry_field_parsed_as_integer() {
        let mut b = SseBuffer::new();
        b.push(b"retry: 1500\ndata: x\n\n");
        let ev = b.pop().unwrap();
        assert_eq!(ev.retry, Some(1500));
        assert_eq!(ev.data, "x");
    }

    #[test]
    fn retry_field_non_numeric_ignored() {
        // Spec: non-integer retry values are discarded (no panic, no error).
        let mut b = SseBuffer::new();
        b.push(b"retry: not-a-number\ndata: x\n\n");
        let ev = b.pop().unwrap();
        assert!(ev.retry.is_none());
    }

    #[test]
    fn field_without_space_after_colon_accepted() {
        // Spec: exactly one leading space is stripped if present. If the
        // server omits it, the value starts immediately after the colon.
        let mut b = SseBuffer::new();
        b.push(b"event:ping\ndata:{}\n\n");
        let ev = b.pop().unwrap();
        assert_eq!(ev.event, "ping");
        assert_eq!(ev.data, "{}");
    }

    #[test]
    fn bare_field_name_no_colon_treated_as_empty_value() {
        // Edge case from spec: `field\n` with no colon is legal and the
        // value is the empty string.
        let mut b = SseBuffer::new();
        b.push(b"data\n\n");
        let ev = b.pop().unwrap();
        assert_eq!(ev.data, "");
    }

    #[test]
    fn unknown_field_ignored_forward_compat() {
        let mut b = SseBuffer::new();
        b.push(b"unknown: whatever\ndata: yes\n\n");
        let ev = b.pop().unwrap();
        assert_eq!(ev.data, "yes");
        assert_eq!(ev.event, "");
    }

    #[test]
    fn multiple_events_drained_in_order() {
        let mut b = SseBuffer::new();
        b.push(b"event: a\ndata: 1\n\nevent: b\ndata: 2\n\n");
        let all: Vec<_> = b.drain().collect();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].event, "a");
        assert_eq!(all[0].data, "1");
        assert_eq!(all[1].event, "b");
        assert_eq!(all[1].data, "2");
    }

    #[test]
    fn bytewise_chunking_preserves_events() {
        // Torture test: feed every single byte separately — the parser
        // must still produce the same event sequence.
        let wire = b"event: a\ndata: 1\n\nevent: b\ndata: 2\n\n";
        let mut b = SseBuffer::new();
        for &byte in wire {
            b.push(&[byte]);
        }
        let all: Vec<_> = b.drain().collect();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].event, "a");
        assert_eq!(all[1].data, "2");
    }

    #[test]
    fn anthropic_corpus_padding_preserved_in_data() {
        // Anthropic pads JSON payloads with whitespace before the
        // closing brace as an SSE flush hint. The raw `data` field must
        // preserve that — JSON consumers tolerate it.
        let mut b = SseBuffer::new();
        b.push(b"event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0     }\n\n");
        let ev = b.pop().unwrap();
        assert_eq!(ev.event, "content_block_stop");
        assert!(ev.data.ends_with("     }"), "trailing whitespace padding should be preserved verbatim");
    }

    #[test]
    fn flush_on_eof_emits_unterminated_final_frame() {
        // An event with no trailing blank line is normally discarded,
        // but our conservative implementation surfaces it on EOF so a
        // caller can choose what to do.
        let mut b = SseBuffer::new();
        b.push(b"event: final\ndata: {}");
        assert!(b.pop().is_none());
        let ev = b.flush_on_eof().unwrap();
        assert_eq!(ev.event, "final");
    }

    #[test]
    fn flush_on_eof_returns_none_when_buffer_empty() {
        let mut b = SseBuffer::new();
        assert!(b.flush_on_eof().is_none());
    }

    #[test]
    fn parses_full_anthropic_hello_corpus() {
        // Real captured bytes: 8 events (message_start, content_block_start,
        // ping, 2×content_block_delta, content_block_stop, message_delta,
        // message_stop). The scrubbed corpus lost the final blank line
        // that the real server sends before the TCP close, so we model
        // "connection closed" with `flush_on_eof` — matches what the
        // production stream driver will do in §11.
        let wire = include_bytes!(
            "../../fingerprint_corpus/hello/response.sse"
        );
        let mut b = SseBuffer::new();
        b.push(wire);
        let mut events: Vec<_> = b.drain().collect();
        if let Some(final_event) = b.flush_on_eof() {
            events.push(final_event);
        }
        assert_eq!(events.len(), 8, "expected 8 events, got {}", events.len());
        assert_eq!(events[0].event, "message_start");
        assert_eq!(events[1].event, "content_block_start");
        assert_eq!(events[2].event, "ping");
        assert_eq!(events[3].event, "content_block_delta");
        assert_eq!(events[4].event, "content_block_delta");
        assert_eq!(events[5].event, "content_block_stop");
        assert_eq!(events[6].event, "message_delta");
        assert_eq!(events[7].event, "message_stop");

        // Spot-check that JSON `data` is preserved as raw text (padding
        // preserved; parser doesn't re-serialize).
        assert!(events[3].data.contains(r#""text":"Hi! How""#));
        assert!(events[4].data.contains(r#""text":" can I help?""#));
    }
}
