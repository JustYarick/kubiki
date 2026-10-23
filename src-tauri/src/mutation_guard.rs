//! Trusted desktop consent via in-app confirmation dialog.
use kubiki_core::core::{
    api::{ApiError, ResourceRef},
    mutations::{MAX_REVIEW_CHARS, MutationReview, REVIEW_TTL, ReviewKind, error},
};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex as StdMutex};
use std::time::Instant;
use tauri::Emitter;

static REQUEST_SEQ: AtomicU64 = AtomicU64::new(1);
static DIALOG_OPEN: AtomicBool = AtomicBool::new(false);
struct DialogReservation;
impl Drop for DialogReservation {
    fn drop(&mut self) {
        DIALOG_OPEN.store(false, Ordering::Release);
    }
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct MutationConfirmRequest {
    pub id: String,
    pub resource: ResourceRef,
    pub review: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<MutationReview>,
}

static PENDING_CONFIRMS: LazyLock<StdMutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

#[tauri::command]
pub async fn resolve_mutation_confirm(id: String, approved: bool) -> Result<bool, ()> {
    if let Ok(mut map) = PENDING_CONFIRMS.lock() {
        if let Some(sender) = map.remove(&id) {
            let _ = sender.send(approved);
            return Ok(true);
        }
    }
    Ok(false)
}

#[derive(Default)]
pub struct MutationGuard(tokio::sync::Mutex<()>);
impl MutationGuard {
    pub fn acquire(
        &self,
        resource: &ResourceRef,
    ) -> Result<tokio::sync::MutexGuard<'_, ()>, ApiError> {
        if DIALOG_OPEN.load(Ordering::Acquire) {
            return Err(error(
                resource,
                409,
                "A confirmation is still open. Close it before requesting another change",
            ));
        }
        self.0.try_lock().map_err(|_| error(resource, 409, "Another change is awaiting confirmation or completing. Finish it before requesting another change"))
    }
}

pub async fn confirm(
    window: tauri::WebviewWindow,
    resource: &ResourceRef,
    review: String,
) -> Result<bool, ApiError> {
    confirm_details(window, resource, review, None).await
}

pub async fn confirm_details(
    window: tauri::WebviewWindow,
    resource: &ResourceRef,
    review: String,
    details: Option<MutationReview>,
) -> Result<bool, ApiError> {
    let limit = if details
        .as_ref()
        .is_some_and(|d| d.kind == ReviewKind::Batch)
    {
        2 * 1024 * 1024
    } else {
        MAX_REVIEW_CHARS
    };
    if review.chars().count() > limit {
        return Err(error(
            resource,
            422,
            "Change is too large for a complete confirmation dialog. Split it into smaller changes",
        ));
    }
    if DIALOG_OPEN
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err(error(resource, 409, "A confirmation is already open"));
    }
    let _reservation = DialogReservation;
    let started = Instant::now();
    let seq = REQUEST_SEQ.fetch_add(1, Ordering::Relaxed);
    let id = format!(
        "{}-{}-{}",
        resource.name,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_micros(),
        seq
    );

    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let mut map = PENDING_CONFIRMS
            .lock()
            .map_err(|_| error(resource, 500, "Internal error in confirmation registry"))?;
        map.insert(id.clone(), tx);
    }

    let payload = MutationConfirmRequest {
        id: id.clone(),
        resource: resource.clone(),
        review,
        details,
    };

    if window.emit("mutation-confirm-request", &payload).is_err() {
        if let Ok(mut map) = PENDING_CONFIRMS.lock() {
            map.remove(&id);
        }
        return Err(error(
            resource,
            503,
            "Cannot display confirmation dialog. Window is not available",
        ));
    }

    let approved = tokio::select! {
        res = rx => res.unwrap_or(false),
        _ = tokio::time::sleep(REVIEW_TTL) => {
            if let Ok(mut map) = PENDING_CONFIRMS.lock() {
                map.remove(&id);
            }
            return Err(error(
                resource,
                409,
                "Confirmation expired. Request and review the change again",
            ));
        }
    };

    if started.elapsed() > REVIEW_TTL {
        return Err(error(
            resource,
            409,
            "Confirmation expired. Request and review the change again",
        ));
    }

    Ok(approved)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn double_click_does_not_queue_or_reuse_another_changes_consent() {
        let resource: ResourceRef = serde_json::from_value(serde_json::json!({"context":"prod","group":"","version":"v1","kind":"Pod","namespace":"team","name":"web","uid":"uid"})).unwrap();
        let guard = MutationGuard::default();
        let permit = guard.acquire(&resource).unwrap();
        assert_eq!(guard.acquire(&resource).unwrap_err().status, Some(409));
        drop(permit);
        assert!(guard.acquire(&resource).is_ok());
    }
}
