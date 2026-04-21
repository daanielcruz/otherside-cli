

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SseEvent {

    pub event: String,

    pub data: String,

    pub id: String,

    pub retry: Option<u64>,
}

#[derive(Debug, Default)]
pub struct SseBuffer {

    buf: Vec<u8>,

    events: std::collections::VecDeque<SseEvent>,
}

impl SseBuffer {

    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
        self.extract_complete_events();
    }

    pub fn pop(&mut self) -> Option<SseEvent> {
        self.events.pop_front()
    }

    pub fn drain(&mut self) -> impl Iterator<Item = SseEvent> + '_ {

        self.events.drain(..)
    }

    pub fn flush_on_eof(&mut self) -> Option<SseEvent> {
        if self.buf.is_empty() {
            return None;
        }

        let frame = std::mem::take(&mut self.buf);
        parse_frame(&frame)
    }

    fn extract_complete_events(&mut self) {
        loop {

            let crlf = find_subsequence(&self.buf, b"\r\n\r\n");
            let lf = find_subsequence(&self.buf, b"\n\n");

            let (cut, term_len) = match (crlf, lf) {
                (Some(a), Some(b)) if a < b => (a, 4),
                (Some(_), Some(b)) => (b, 2),
                (Some(a), None) => (a, 4),
                (None, Some(b)) => (b, 2),
                (None, None) => return,
            };

            let rest = self.buf.split_off(cut + term_len);
            let frame = std::mem::replace(&mut self.buf, rest);

            let payload = &frame[..frame.len() - term_len];
            if let Some(event) = parse_frame(payload) {
                self.events.push_back(event);
            }
        }
    }
}

fn parse_frame(frame: &[u8]) -> Option<SseEvent> {
    let text = std::str::from_utf8(frame).ok()?;
    let mut event = SseEvent::default();
    let mut data_parts: Vec<&str> = Vec::new();
    let mut saw_field = false;

    for raw_line in text.split('\n') {

        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if line.is_empty() {
            continue;
        }
        if line.starts_with(':') {

            continue;
        }

        let (field, value) = match line.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (line, ""),
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

            }
        }
    }

    if !saw_field {
        return None;
    }
    event.data = data_parts.join("\n");
    Some(event)
}

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

        let mut b = SseBuffer::new();
        b.push(b"event: ping\ndata: {}\n\n");
        let ev = b.pop().unwrap();
        assert_eq!(ev.event, "ping");
        assert_eq!(ev.data, "{}");
        assert!(b.pop().is_none());
    }

    #[test]
    fn partial_frame_requires_multiple_pushes() {

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

        let mut b = SseBuffer::new();
        b.push(b"event: ping\r\ndata: {}\r\n\r\n");
        let ev = b.pop().unwrap();
        assert_eq!(ev.event, "ping");
        assert_eq!(ev.data, "{}");
    }

    #[test]
    fn multi_data_lines_join_with_newline() {

        let mut b = SseBuffer::new();
        b.push(b"data: hello\ndata: world\n\n");
        let ev = b.pop().unwrap();
        assert_eq!(ev.data, "hello\nworld");
    }

    #[test]
    fn comment_lines_ignored() {

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

        let mut b = SseBuffer::new();
        b.push(b"retry: not-a-number\ndata: x\n\n");
        let ev = b.pop().unwrap();
        assert!(ev.retry.is_none());
    }

    #[test]
    fn field_without_space_after_colon_accepted() {

        let mut b = SseBuffer::new();
        b.push(b"event:ping\ndata:{}\n\n");
        let ev = b.pop().unwrap();
        assert_eq!(ev.event, "ping");
        assert_eq!(ev.data, "{}");
    }

    #[test]
    fn bare_field_name_no_colon_treated_as_empty_value() {

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

        let mut b = SseBuffer::new();
        b.push(b"event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0     }\n\n");
        let ev = b.pop().unwrap();
        assert_eq!(ev.event, "content_block_stop");
        assert!(ev.data.ends_with("     }"), "trailing whitespace padding should be preserved verbatim");
    }

    #[test]
    fn flush_on_eof_emits_unterminated_final_frame() {

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

        let wire = include_bytes!(
            "../../../fingerprint_corpus/hello/response.sse"
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

        assert!(events[3].data.contains(r#""text":"Hi! How""#));
        assert!(events[4].data.contains(r#""text":" can I help?""#));
    }
}
