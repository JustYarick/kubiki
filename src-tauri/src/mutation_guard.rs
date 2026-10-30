//! Trusted desktop consent via in-app confirmation dialog.
use kubiki_core::core::{
    api::{ApiError, ResourceRef},
    mutations::{MAX_YAML_REVIEW_CHARS, MutationReview, ReviewKind, error},
};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex as StdMutex};
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub simple: Option<SimpleConfirmation>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct SimpleConfirmation {
    pub title: String,
    pub confirm_label: String,
    pub destructive: bool,
}

struct PendingConfirmation {
    owner: String,
    sender: tokio::sync::oneshot::Sender<bool>,
}

static PENDING_CONFIRMS: LazyLock<StdMutex<HashMap<String, PendingConfirmation>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

pub fn cancel_owner(owner: &str) {
    if let Ok(mut map) = PENDING_CONFIRMS.lock() {
        map.retain(|_, pending| pending.owner != owner);
    }
}

struct PendingRegistration(String);
impl Drop for PendingRegistration {
    fn drop(&mut self) {
        if let Ok(mut map) = PENDING_CONFIRMS.lock() {
            map.remove(&self.0);
        }
    }
}

async fn await_confirmation(rx: tokio::sync::oneshot::Receiver<bool>) -> bool {
    rx.await.unwrap_or(false)
}

#[tauri::command]
pub async fn resolve_mutation_confirm(id: String, approved: bool) -> Result<bool, ()> {
    if let Ok(mut map) = PENDING_CONFIRMS.lock() {
        if let Some(pending) = map.remove(&id) {
            let _ = pending.sender.send(approved);
            return Ok(true);
        }
    }
    Ok(false)
}

#[derive(Default)]
pub struct MutationGuard(tokio::sync::Mutex<()>);
impl MutationGuard {
    /// Installation and cluster changes share one gate. Never wait and restart
    /// unexpectedly after a long-running change finishes.
    pub fn acquire_for_update(&self) -> Result<tokio::sync::MutexGuard<'_, ()>, String> {
        if DIALOG_OPEN.load(Ordering::Acquire) {
            return Err("Close the pending confirmation before installing the update.".into());
        }
        self.0.try_lock().map_err(|_| {
            "A cluster change is still running. Finish it before installing the update.".into()
        })
    }

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

pub async fn confirm_details(
    window: tauri::WebviewWindow,
    resource: &ResourceRef,
    review: String,
    details: Option<MutationReview>,
) -> Result<bool, ApiError> {
    if details
        .as_ref()
        .is_some_and(|details| details.kind == ReviewKind::Yaml)
    {
        return confirm_request(window, resource, review, details, None).await;
    }
    let operation = details
        .as_ref()
        .map(|details| {
            if details.kind == ReviewKind::Batch {
                "batch".to_owned()
            } else {
                details
                    .steps
                    .first()
                    .map(|step| step.operation.clone())
                    .unwrap_or_default()
            }
        })
        .unwrap_or_default();
    let summary = details
        .as_ref()
        .filter(|details| details.kind == ReviewKind::Action)
        .and_then(|details| details.steps.first())
        .map(|step| step.summary.clone())
        .unwrap_or(review);
    confirm_action(window, resource, summary, &operation).await
}

pub async fn confirm_action(
    window: tauri::WebviewWindow,
    resource: &ResourceRef,
    summary: String,
    operation: &str,
) -> Result<bool, ApiError> {
    let (title, label, destructive) = match operation {
        "DELETE" | "delete_debug_pod" => ("Delete resource?", "Delete", true),
        "REMOVE_FINALIZER" => ("Remove finalizer?", "Remove", true),
        "SCALE" => ("Scale workload?", "Scale", false),
        "EVICT" => ("Evict Pod?", "Evict", true),
        "RESTART" => ("Restart workload?", "Restart", false),
        "FLUX_RETRY" => ("Retry Flux Helm release?", "Retry", false),
        "UPDATE_SECRET" | "UPDATE_CONFIG_MAP" => ("Save resource data?", "Save", false),
        "CORDON" => ("Cordon Node?", "Cordon", false),
        "UNCORDON" => ("Uncordon Node?", "Uncordon", false),
        "SUSPEND" => ("Suspend workload?", "Suspend", false),
        "RESUME" => ("Resume workload?", "Resume", false),
        "SYNC" => ("Synchronize resource?", "Sync", false),
        "REFRESH" => ("Refresh resource?", "Refresh", false),
        "RUN_JOB" => ("Run Job?", "Run", false),
        "ROLLBACK" => ("Roll back workload?", "Roll back", false),
        "batch" => ("Confirm operation?", "Confirm", false),
        "node_shell" => ("Open node shell?", "Open", false),
        "container_shell" => ("Open container shell?", "Open", false),
        "uninstall" => ("Uninstall Helm release?", "Uninstall", true),
        "install" => ("Install Helm release?", "Install", false),
        "upgrade" => ("Upgrade Helm release?", "Upgrade", false),
        "rollback" => ("Roll back Helm release?", "Roll back", false),
        "repository_remove" => ("Remove Helm repository?", "Remove", true),
        "repository_set" => ("Configure Helm repository?", "Save", false),
        "repository_update" => ("Update Helm repository cache?", "Update", false),
        _ => ("Confirm operation?", "Confirm", false),
    };
    confirm_request(
        window,
        resource,
        summary,
        None,
        Some(SimpleConfirmation {
            title: title.into(),
            confirm_label: label.into(),
            destructive,
        }),
    )
    .await
}

async fn confirm_request(
    window: tauri::WebviewWindow,
    resource: &ResourceRef,
    review: String,
    details: Option<MutationReview>,
    simple: Option<SimpleConfirmation>,
) -> Result<bool, ApiError> {
    if details
        .as_ref()
        .is_some_and(|details| details.kind == ReviewKind::Yaml)
        && review.chars().count() > MAX_YAML_REVIEW_CHARS
    {
        return Err(error(
            resource,
            422,
            "YAML changes are too large to display. Split the edit.",
        ));
    }
    if DIALOG_OPEN
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err(error(resource, 409, "A confirmation is already open"));
    }
    let _reservation = DialogReservation;
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
        map.insert(
            id.clone(),
            PendingConfirmation {
                owner: window.label().to_owned(),
                sender: tx,
            },
        );
    }
    let _registration = PendingRegistration(id.clone());

    let payload = MutationConfirmRequest {
        id: id.clone(),
        resource: resource.clone(),
        review,
        details,
        simple,
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

    Ok(await_confirmation(rx).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn every_confirmation_waits_for_the_user_without_expiry() {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let pending = tokio::spawn(async move { await_confirmation(receiver).await });
        tokio::task::yield_now().await;
        tokio::time::advance(std::time::Duration::from_secs(180)).await;
        assert!(!pending.is_finished());
        sender.send(true).unwrap();
        assert!(pending.await.unwrap());
    }

    #[tokio::test]
    async fn closing_a_window_cancels_only_its_pending_confirmation() {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let id = "window-close-unit-test".to_owned();
        PENDING_CONFIRMS.lock().unwrap().insert(
            id.clone(),
            PendingConfirmation {
                owner: "closed-test-window".into(),
                sender,
            },
        );
        cancel_owner("another-window");
        assert!(PENDING_CONFIRMS.lock().unwrap().contains_key(&id));
        cancel_owner("closed-test-window");
        assert!(receiver.await.is_err());
        assert!(!PENDING_CONFIRMS.lock().unwrap().contains_key(&id));
    }

    #[test]
    fn double_click_does_not_queue_or_reuse_another_changes_consent() {
        let resource: ResourceRef = serde_json::from_value(serde_json::json!({"context":"prod","group":"","version":"v1","kind":"Pod","namespace":"team","name":"web","uid":"uid"})).unwrap();
        let guard = MutationGuard::default();
        let permit = guard.acquire(&resource).unwrap();
        assert_eq!(guard.acquire(&resource).unwrap_err().status, Some(409));
        drop(permit);
        assert!(guard.acquire(&resource).is_ok());
    }

    #[test]
    fn update_installation_and_cluster_changes_are_mutually_exclusive() {
        let resource: ResourceRef = serde_json::from_value(serde_json::json!({"context":"prod","group":"","version":"v1","kind":"Pod","namespace":"team","name":"web","uid":"uid"})).unwrap();
        let guard = MutationGuard::default();
        let change = guard.acquire(&resource).unwrap();
        assert!(guard.acquire_for_update().is_err());
        drop(change);
        let install = guard.acquire_for_update().unwrap();
        assert!(guard.acquire(&resource).is_err());
        assert!(guard.acquire_for_update().is_err());
        drop(install);
        assert!(guard.acquire(&resource).is_ok());
    }
}
