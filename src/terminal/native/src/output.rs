// Head/tail retention follows OpenAI Codex b8dceb0d, Apache-2.0.
use std::collections::VecDeque;

pub const MAX_BYTES: usize = 1024 * 1024;

#[derive(Default)]
pub struct Output {
    pub head: Vec<u8>,
    pub tail: VecDeque<u8>,
    pub omitted_bytes: usize,
}

impl Output {
    pub fn is_empty(&self) -> bool {
        self.head.is_empty() && self.tail.is_empty() && self.omitted_bytes == 0
    }

    pub fn push(&mut self, bytes: &[u8]) {
        let fill = bytes.len().min(MAX_BYTES / 2 - self.head.len());
        self.head.extend_from_slice(&bytes[..fill]);
        let bytes = &bytes[fill..];
        let budget = MAX_BYTES - MAX_BYTES / 2;
        if bytes.len() >= budget {
            self.omitted_bytes += self.tail.len() + bytes.len() - budget;
            self.tail = bytes[bytes.len() - budget..].iter().copied().collect();
        } else {
            let excess = (self.tail.len() + bytes.len()).saturating_sub(budget);
            self.tail.drain(..excess);
            self.omitted_bytes += excess;
            self.tail.extend(bytes);
        }
    }
}
