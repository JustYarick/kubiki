//! Session-local, bounded continuation state. Tokens never contain Kubernetes data.
use serde_json::Value;
use std::{
    collections::VecDeque,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

static NEXT_CURSOR: AtomicU64 = AtomicU64::new(1);
const TTL: Duration = Duration::from_secs(300);
const MAX_BYTES: usize = 1024 * 1024;

#[derive(Clone)]
pub struct QueryPage {
    pub items: Vec<Value>,
    pub continuation: Option<String>,
    pub captured_at: u128,
    pub omitted: usize,
}
struct Entry {
    token: String,
    binding: Value,
    revision: u64,
    created: Instant,
    bytes: usize,
    page: QueryPage,
}
#[derive(Default)]
pub struct CursorStore {
    entries: VecDeque<Entry>,
}
impl CursorStore {
    pub fn save(
        &mut self,
        binding: Value,
        revision: u64,
        page: QueryPage,
    ) -> Result<String, String> {
        self.entries
            .retain(|e| e.created.elapsed() < TTL && e.revision == revision);
        let bytes = serde_json::to_vec(&binding)
            .map_err(|_| "Invalid query binding")?
            .len()
            + page
                .items
                .iter()
                .map(|v| v.to_string().len())
                .sum::<usize>()
            + page.continuation.as_ref().map_or(0, String::len);
        if bytes > MAX_BYTES {
            return Err(
                "Continuation exceeds memory budget; request fewer fields or a smaller page".into(),
            );
        }
        while self.entries.len() >= 16
            || self.entries.iter().map(|e| e.bytes).sum::<usize>() + bytes > MAX_BYTES
        {
            self.entries.pop_front();
        }
        let token = format!("q{:x}", NEXT_CURSOR.fetch_add(1, Ordering::Relaxed));
        self.entries.push_back(Entry {
            token: token.clone(),
            binding,
            revision,
            created: Instant::now(),
            bytes,
            page,
        });
        Ok(token)
    }
    pub fn load(&self, token: &str, binding: &Value, revision: u64) -> Result<QueryPage, String> {
        let e = self
            .entries
            .iter()
            .find(|e| e.token == token)
            .ok_or("Unknown or expired cursor; start a new scoped query")?;
        if e.created.elapsed() >= TTL || e.revision != revision || e.binding != *binding {
            return Err(
                "Cursor expired or query/session permissions changed; start a new scoped query"
                    .into(),
            );
        }
        Ok(e.page.clone())
    }
}

/// Keep a prefix without dropping the rest of a fetched page.
pub fn split_page(mut page: QueryPage, budget: usize) -> Result<(Vec<Value>, QueryPage), String> {
    let mut bytes = 0;
    let mut count = 0;
    for item in &page.items {
        let size = item.to_string().len() + 1;
        if size > budget {
            return Err(
                "One selected object exceeds the output budget; request fewer fields".into(),
            );
        }
        if bytes + size > budget {
            break;
        }
        bytes += size;
        count += 1;
    }
    let tail = page.items.split_off(count);
    let items = std::mem::replace(&mut page.items, tail);
    Ok((items, page))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn byte_split_preserves_tail_before_server_continuation() {
        let page = QueryPage {
            items: vec![json!({"id":1}), json!({"id":2}), json!({"id":3})],
            continuation: Some("server-token".into()),
            captured_at: 42,
            omitted: 0,
        };
        let (first, tail) = split_page(page, 20).unwrap();
        assert_eq!(first, vec![json!({"id":1}), json!({"id":2})]);
        assert_eq!(tail.items, vec![json!({"id":3})]);
        assert_eq!(tail.continuation.as_deref(), Some("server-token"));
        assert_eq!(tail.captured_at, 42);
    }
    #[test]
    fn cursors_are_bound_to_session_revision_and_query_and_can_replay_reads() {
        let mut store = CursorStore::default();
        let binding = json!({"namespace":"apps","fields":["metadata.name"]});
        let token = store
            .save(
                binding.clone(),
                4,
                QueryPage {
                    items: vec![],
                    continuation: Some("private".into()),
                    captured_at: 1,
                    omitted: 0,
                },
            )
            .unwrap();
        assert!(store.load(&token, &binding, 4).is_ok());
        assert!(store.load(&token, &binding, 4).is_ok());
        assert!(store.load(&token, &binding, 5).is_err());
        assert!(
            store
                .load(&token, &json!({"namespace":"other"}), 4)
                .is_err()
        );
        assert!(CursorStore::default().load(&token, &binding, 4).is_err());
        store.entries[0].created = Instant::now() - TTL;
        assert!(store.load(&token, &binding, 4).is_err());
    }
    #[test]
    fn memory_and_count_are_bounded_and_oversize_items_do_not_skip() {
        let mut store = CursorStore::default();
        for _ in 0..20 {
            store
                .save(
                    json!({}),
                    0,
                    QueryPage {
                        items: vec![],
                        continuation: None,
                        captured_at: 0,
                        omitted: 0,
                    },
                )
                .unwrap();
        }
        assert_eq!(store.entries.len(), 16);
        assert!(
            split_page(
                QueryPage {
                    items: vec![json!("x".repeat(50))],
                    continuation: None,
                    captured_at: 0,
                    omitted: 0
                },
                20
            )
            .is_err()
        );
    }
}
