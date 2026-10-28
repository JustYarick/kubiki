//! Window-owned, cancellable reads. Dropping a read future also drops paginated
//! HTTP work and kill-on-drop Helm subprocesses.
use kubiki_core::core::api::{ApiError, ApiErrorCode};
use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Semaphore, oneshot};

const MAX_PENDING: usize = 128;
const COMPLETED_HISTORY: usize = 128;
static NEXT_READ: AtomicU64 = AtomicU64::new(1);

enum Task {
    Active(oneshot::Sender<()>),
    Cancelled,
    Completed,
}
struct Owner {
    tasks: HashMap<String, Task>,
    completed: VecDeque<String>,
    permits: Arc<Semaphore>,
    contexts: HashMap<String, Weak<Semaphore>>,
}
impl Default for Owner {
    fn default() -> Self {
        Self {
            tasks: HashMap::new(),
            completed: VecDeque::new(),
            permits: Arc::new(Semaphore::new(8)),
            contexts: HashMap::new(),
        }
    }
}
#[derive(Clone, Default)]
pub struct ReadTasks {
    owners: Arc<Mutex<HashMap<String, Owner>>>,
}
struct ReadGuard {
    manager: ReadTasks,
    owner: String,
    id: String,
}
impl Drop for ReadGuard {
    fn drop(&mut self) {
        let mut owners = self.manager.owners.lock().unwrap();
        if let Some(owner) = owners.get_mut(&self.owner) {
            owner.tasks.insert(self.id.clone(), Task::Completed);
            owner.completed.push_back(self.id.clone());
            while owner.completed.len() > COMPLETED_HISTORY {
                if let Some(id) = owner.completed.pop_front() {
                    owner.tasks.remove(&id);
                }
            }
        }
    }
}
impl ReadTasks {
    pub async fn run<T, F>(
        &self,
        owner: &str,
        request_id: Option<String>,
        context: Option<&str>,
        operation: &str,
        timeout: Duration,
        future: F,
    ) -> Result<T, ApiError>
    where
        F: Future<Output = Result<T, ApiError>>,
    {
        let id = request_id
            .unwrap_or_else(|| format!("native-{}", NEXT_READ.fetch_add(1, Ordering::Relaxed)));
        if id.is_empty() || id.len() > 128 {
            return Err(ApiError::from_status(
                400,
                "Invalid read request ID",
                operation,
                context,
            ));
        }
        let cancelled = || {
            ApiError::new(
                ApiErrorCode::Cancelled,
                "Read was cancelled",
                operation,
                context,
                None,
            )
        };
        let (sender, mut cancellation) = oneshot::channel();
        let (window_permits, context_permits) = {
            let mut owners = self.owners.lock().unwrap();
            let owner = owners.entry(owner.to_owned()).or_default();
            match owner.tasks.get(&id) {
                Some(Task::Cancelled) => {
                    owner.tasks.remove(&id);
                    return Err(cancelled());
                }
                Some(_) => {
                    return Err(ApiError::from_status(
                        409,
                        "Read request ID was already used",
                        operation,
                        context,
                    ));
                }
                None => {}
            }
            if owner.tasks.len() - owner.completed.len() >= MAX_PENDING {
                return Err(ApiError::from_status(
                    429,
                    "Too many queued reads",
                    operation,
                    context,
                ));
            }
            owner.tasks.insert(id.clone(), Task::Active(sender));
            owner
                .contexts
                .retain(|_, semaphore| semaphore.strong_count() > 0);
            let key = context.unwrap_or("").to_owned();
            let permits = owner
                .contexts
                .get(&key)
                .and_then(Weak::upgrade)
                .unwrap_or_else(|| {
                    let permits = Arc::new(Semaphore::new(4));
                    owner.contexts.insert(key, Arc::downgrade(&permits));
                    permits
                });
            (owner.permits.clone(), permits)
        };
        let _guard = ReadGuard {
            manager: self.clone(),
            owner: owner.to_owned(),
            id,
        };
        let read = async {
            let _context = context_permits
                .acquire_owned()
                .await
                .map_err(|_| cancelled())?;
            let _window = window_permits
                .acquire_owned()
                .await
                .map_err(|_| cancelled())?;
            future.await
        };
        tokio::select! {
            biased;
            _ = &mut cancellation => Err(cancelled()),
            result = tokio::time::timeout(timeout, read) => result.unwrap_or_else(|_| Err(ApiError::from_status(504, "Read timed out", operation, context))),
        }
    }

    pub fn cancel(&self, owner: &str, id: &str) -> Result<(), ApiError> {
        if id.is_empty() || id.len() > 128 {
            return Err(ApiError::from_status(
                400,
                "Invalid read request ID",
                "cancel_read",
                None,
            ));
        }
        let mut owners = self.owners.lock().unwrap();
        let owner = owners.entry(owner.to_owned()).or_default();
        // Keep pre-registration cancellations until the corresponding command
        // arrives; completed IDs make a late cancellation a no-op.
        if matches!(owner.tasks.get(id), Some(Task::Completed | Task::Cancelled)) {
            return Ok(());
        }
        if !owner.tasks.contains_key(id) && owner.tasks.len() - owner.completed.len() >= MAX_PENDING
        {
            return Err(ApiError::from_status(
                429,
                "Too many queued reads",
                "cancel_read",
                None,
            ));
        }
        if let Some(Task::Active(sender)) = owner.tasks.insert(id.to_owned(), Task::Cancelled) {
            let _ = sender.send(());
        }
        Ok(())
    }

    pub fn stop_owner(&self, owner: &str) {
        if let Some(owner) = self.owners.lock().unwrap().remove(owner) {
            for (_, task) in owner.tasks {
                if let Task::Active(sender) = task {
                    let _ = sender.send(());
                }
            }
        }
    }
}

#[tauri::command]
pub fn cancel_read_task(
    request_id: String,
    window: tauri::WebviewWindow,
    reads: tauri::State<'_, ReadTasks>,
) -> Result<(), ApiError> {
    reads.cancel(window.label(), &request_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancellation_before_registration_never_polls_read_and_is_owner_bound() {
        let tasks = ReadTasks::default();
        tasks.cancel("one", "read").unwrap();
        let result = tasks
            .run(
                "one",
                Some("read".into()),
                Some("prod"),
                "test",
                Duration::from_secs(1),
                async {
                    panic!("cancelled read ran");
                    #[allow(unreachable_code)]
                    Ok::<_, ApiError>(())
                },
            )
            .await;
        assert!(matches!(result.unwrap_err().code, ApiErrorCode::Cancelled));
        assert_eq!(
            tasks
                .run(
                    "two",
                    Some("read".into()),
                    Some("prod"),
                    "test",
                    Duration::from_secs(1),
                    async { Ok::<_, ApiError>(42) }
                )
                .await
                .unwrap(),
            42
        );
    }
    #[tokio::test]
    async fn cancellation_drops_an_active_read_future_and_releases_its_permits() {
        struct Dropped(Arc<std::sync::atomic::AtomicBool>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let tasks = ReadTasks::default();
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let inside = dropped.clone();
        let (started, ready) = oneshot::channel();
        let running = tasks.clone();
        let job = tokio::spawn(async move {
            running
                .run(
                    "one",
                    Some("read".into()),
                    Some("prod"),
                    "test",
                    Duration::from_secs(1),
                    async move {
                        let _drop = Dropped(inside);
                        let _ = started.send(());
                        std::future::pending::<Result<(), ApiError>>().await
                    },
                )
                .await
        });
        ready.await.unwrap();
        tasks.cancel("one", "read").unwrap();
        assert!(matches!(
            job.await.unwrap().unwrap_err().code,
            ApiErrorCode::Cancelled
        ));
        assert!(dropped.load(Ordering::SeqCst));
        assert_eq!(
            tasks
                .run(
                    "one",
                    Some("next".into()),
                    Some("prod"),
                    "test",
                    Duration::from_secs(1),
                    async { Ok::<_, ApiError>(42) }
                )
                .await
                .unwrap(),
            42
        );
    }

    #[tokio::test]
    async fn context_reads_are_bounded_and_cancelled_queued_reads_never_start() {
        let tasks = ReadTasks::default();
        let release = Arc::new(Semaphore::new(0));
        let (started, mut events) = tokio::sync::mpsc::unbounded_channel();
        let mut jobs = Vec::new();
        for index in 0..6 {
            let tasks = tasks.clone();
            let release = release.clone();
            let started = started.clone();
            jobs.push(tokio::spawn(async move {
                tasks
                    .run(
                        "one",
                        Some(index.to_string()),
                        Some("prod"),
                        "test",
                        Duration::from_secs(2),
                        async move {
                            started.send(index).unwrap();
                            release.acquire().await.unwrap().forget();
                            Ok(())
                        },
                    )
                    .await
            }));
        }
        for _ in 0..4 {
            events.recv().await.unwrap();
        }
        assert!(events.try_recv().is_err());
        tasks.cancel("one", "5").unwrap();
        release.add_permits(5);
        for (index, job) in jobs.into_iter().enumerate() {
            let result = job.await.unwrap();
            if index == 5 {
                assert!(matches!(result.unwrap_err().code, ApiErrorCode::Cancelled));
            } else {
                result.unwrap();
            }
        }
        assert_eq!(events.recv().await, Some(4));
        assert!(events.try_recv().is_err());
    }
}
