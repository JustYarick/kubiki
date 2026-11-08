//! Bounded, policy-projected historical tool evidence.
use serde_json::Value;
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

#[derive(Default)]
pub struct EvidenceStore {
    next: u64,
    entries: VecDeque<(String, Instant, Value)>,
}
impl EvidenceStore {
    pub fn clear(&mut self) {
        // Keep the sequence: a revoked ID must never alias a newer result.
        self.entries.clear();
    }
    pub fn save(&mut self, value: &Value) -> Option<String> {
        let bytes = value.to_string().len();
        if bytes > 64_000 {
            return None;
        }
        self.entries
            .retain(|(_, at, _)| at.elapsed() < Duration::from_secs(600));
        while self.entries.len() >= 32
            || self
                .entries
                .iter()
                .map(|(_, _, v)| v.to_string().len())
                .sum::<usize>()
                + bytes
                > 512_000
        {
            self.entries.pop_front();
        }
        self.next += 1;
        let id = format!("e{}", self.next);
        self.entries
            .push_back((id.clone(), Instant::now(), value.clone()));
        Some(id)
    }
    pub fn get(&self, id: &str) -> Result<Value, String> {
        self.entries
            .iter()
            .find(|(key, at, _)| key == id && at.elapsed() < Duration::from_secs(600))
            .map(|(_, _, v)| v.clone())
            .ok_or_else(|| "Evidence expired or evicted; refresh the scoped live query".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn evidence_is_bounded_and_missing_ids_are_explicit() {
        let mut store = EvidenceStore::default();
        let first = store.save(&json!({"status":"Pending"})).unwrap();
        for _ in 0..32 {
            store.save(&json!({"status":"Running"}));
        }
        assert!(store.get(&first).is_err());
        assert!(store.get("e33").is_ok());
        assert!(store.save(&json!("x".repeat(64_001))).is_none());
    }
}
