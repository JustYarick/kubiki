//! Conversation state is separate from the portable execution session.
use crate::{Completion, ToolCall, Turn, memory::ConversationMemory};
use serde_json::Value;
use std::sync::{Arc, Mutex};
#[derive(Clone, Default)]
pub struct ConversationState {
    history: Arc<tokio::sync::Mutex<Vec<Turn>>>,
    memory: Arc<Mutex<ConversationMemory>>,
}
impl ConversationState {
    pub async fn history_guard(&self) -> tokio::sync::MutexGuard<'_, Vec<Turn>> {
        self.history.lock().await
    }
    pub fn compact(&self, history: &mut Vec<Turn>, bytes: usize) -> Result<(), String> {
        let mut memory = self
            .memory
            .lock()
            .map_err(|_| "Conversation memory unavailable")?;
        crate::memory::compact_history(history, bytes, &mut memory);
        Ok(())
    }
    pub async fn seed_history(&self, turns: Vec<Turn>) {
        *self.history.lock().await = turns;
    }
    pub async fn inspect_history(&self) -> Vec<Turn> {
        self.history.lock().await.clone()
    }
    pub async fn record_execution(&self, call: ToolCall, result: Value) {
        let mut history = self.history.lock().await;
        history.push(Turn::Assistant(Completion {
            text: "User-requested execution of a reviewed plan step".into(),
            calls: vec![call.clone()],
            ..Default::default()
        }));
        history.push(Turn::Tool { call, result });
        let _ = self.compact(&mut history, 48000);
    }
}
