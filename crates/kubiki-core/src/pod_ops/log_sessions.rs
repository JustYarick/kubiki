//! Cancellable, window-owned Pod log streams with bounded transport buffers.
use crate::core::api::{ApiError, ApiErrorCode, ResourceRef, validate_query};
use futures::AsyncReadExt;
use k8s_openapi::api::core::v1::Pod;
use kube::{Api, Client, api::LogParams};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, future::Future, sync::Arc, time::Duration};
use tokio::{
    sync::{Mutex, mpsc, watch},
    task::JoinHandle,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct LogRequest {
    pub resource: ResourceRef,
    pub container: String,
    pub follow: bool,
    pub previous: bool,
    pub tail_lines: i64,
    pub since_seconds: Option<i64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum LogEvent {
    Started,
    Output { data: Vec<u8> },
    Completed,
    Failed { error: ApiError },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LogMessage {
    pub sequence: u64,
    pub event: LogEvent,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LogBatch {
    pub session_id: String,
    pub messages: Vec<LogMessage>,
}
struct Session {
    owner: String,
    task: JoinHandle<()>,
    ack: watch::Sender<u64>,
}
#[derive(Default)]
struct Inner {
    sessions: Mutex<HashMap<String, Session>>,
}
impl Drop for Inner {
    fn drop(&mut self) {
        for s in self.sessions.get_mut().values() {
            s.task.abort();
        }
    }
}
#[derive(Clone, Default)]
pub struct PodLogManager {
    inner: Arc<Inner>,
}
pub struct LogSubscription {
    pub output: mpsc::Receiver<LogMessage>,
    pub acknowledgements: watch::Receiver<u64>,
}
fn error(request: &LogRequest, status: u16, message: impl Into<String>) -> ApiError {
    ApiError::from_status(
        status,
        message,
        "logs",
        Some(&request.resource.query.context),
    )
    .with_resource(&request.resource.query)
}
fn api_error(request: &LogRequest, err: kube::Error) -> ApiError {
    match err {
        kube::Error::Api(response) => error(request, response.code, response.message),
        err => ApiError::new(
            ApiErrorCode::Unavailable,
            err.to_string(),
            "logs",
            Some(&request.resource.query.context),
            None,
        )
        .with_resource(&request.resource.query),
    }
}
pub fn validate_request(request: &LogRequest) -> Result<(), ApiError> {
    validate_query(&request.resource.query)?;
    let valid_name = |s: &str, max| {
        !s.is_empty()
            && s.len() <= max
            && s.bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'.')
    };
    if request.resource.query.kind != "Pod"
        || request.resource.query.namespace.is_none()
        || request
            .resource
            .uid
            .as_ref()
            .is_none_or(|uid| uid.is_empty())
        || !valid_name(&request.resource.name, 253)
        || !valid_name(&request.container, 63)
        || !(0..=10000).contains(&request.tail_lines)
        || request
            .since_seconds
            .is_some_and(|s| !(1..=604800).contains(&s))
        || request.previous && request.follow
    {
        return Err(error(
            request,
            400,
            "Logs require a Pod UID/container, tail 0–10000, since 1–604800 seconds; previous logs cannot follow",
        ));
    }
    Ok(())
}
impl PodLogManager {
    pub async fn start<F>(
        &self,
        owner: &str,
        id: &str,
        request: LogRequest,
        client: F,
    ) -> Result<LogSubscription, ApiError>
    where
        F: Future<Output = Result<Client, ApiError>> + Send + 'static,
    {
        validate_request(&request)?;
        if id.is_empty()
            || id.len() > 128
            || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return Err(error(&request, 400, "Invalid log session ID"));
        }
        let mut sessions = self.inner.sessions.lock().await;
        let key = format!("{owner}:{id}");
        if sessions.contains_key(&key) {
            return Err(error(&request, 409, "Log session already exists"));
        }
        if sessions.len() >= 32 {
            return Err(error(&request, 429, "Too many log sessions"));
        }
        let (output, rx) = mpsc::channel(8);
        let (ack, acknowledgements) = watch::channel(0);
        let task = tokio::spawn(async move {
            let mut sequence = 0;
            let result = tokio::select! { _=output.closed()=>return, result=run(&request,client,&output,&mut sequence)=>result };
            if let Err(error) = result {
                emit(&output, &mut sequence, LogEvent::Failed { error }).await;
            }
        });
        sessions.insert(
            key,
            Session {
                owner: owner.into(),
                task,
                ack,
            },
        );
        Ok(LogSubscription {
            output: rx,
            acknowledgements,
        })
    }
    pub async fn acknowledge(&self, owner: &str, id: &str, sequence: u64) -> Result<(), ApiError> {
        let sessions = self.inner.sessions.lock().await;
        let s = sessions
            .get(&format!("{owner}:{id}"))
            .ok_or_else(|| ApiError::from_status(404, "Log session is closed", "logs", None))?;
        s.ack.send_replace(sequence);
        Ok(())
    }
    pub async fn stop(&self, owner: &str, id: &str) {
        if let Some(s) = self
            .inner
            .sessions
            .lock()
            .await
            .remove(&format!("{owner}:{id}"))
        {
            s.task.abort();
            let _ = s.task.await;
        }
    }
    pub async fn stop_owner(&self, owner: &str) {
        let mut sessions = self.inner.sessions.lock().await;
        let keys: Vec<_> = sessions
            .iter()
            .filter(|(_, s)| s.owner == owner)
            .map(|(k, _)| k.clone())
            .collect();
        for key in keys {
            if let Some(s) = sessions.remove(&key) {
                s.task.abort();
                let _ = s.task.await;
            }
        }
    }
    pub async fn session_count(&self) -> usize {
        self.inner.sessions.lock().await.len()
    }
}
async fn emit(output: &mpsc::Sender<LogMessage>, sequence: &mut u64, event: LogEvent) -> bool {
    *sequence += 1;
    output
        .send(LogMessage {
            sequence: *sequence,
            event,
        })
        .await
        .is_ok()
}
async fn run<F>(
    request: &LogRequest,
    client: F,
    output: &mpsc::Sender<LogMessage>,
    sequence: &mut u64,
) -> Result<(), ApiError>
where
    F: Future<Output = Result<Client, ApiError>>,
{
    let mut stream = tokio::time::timeout(Duration::from_secs(30), async {
        let pods: Api<Pod> = Api::namespaced(
            client.await?,
            request.resource.query.namespace.as_deref().unwrap(),
        );
        let pod = pods
            .get(&request.resource.name)
            .await
            .map_err(|e| api_error(request, e))?;
        if pod.metadata.uid != request.resource.uid {
            return Err(error(
                request,
                409,
                "Pod was recreated; open the current Pod to read its logs",
            ));
        }
        let spec = pod
            .spec
            .ok_or_else(|| error(request, 400, "Pod has no container spec"))?;
        if !spec
            .containers
            .iter()
            .map(|c| &c.name)
            .chain(spec.init_containers.iter().flatten().map(|c| &c.name))
            .chain(spec.ephemeral_containers.iter().flatten().map(|c| &c.name))
            .any(|name| name == &request.container)
        {
            return Err(error(
                request,
                400,
                "Container does not belong to the selected Pod",
            ));
        }
        // Kubernetes logs has no UID precondition: the GET detects known recreations before opening.
        pods.log_stream(
            &request.resource.name,
            &LogParams {
                container: Some(request.container.clone()),
                follow: request.follow,
                previous: request.previous,
                tail_lines: Some(request.tail_lines),
                since_seconds: request.since_seconds,
                timestamps: true,
                ..Default::default()
            },
        )
        .await
        .map_err(|e| api_error(request, e))
    })
    .await
    .map_err(|_| error(request, 504, "Timed out opening Pod logs"))??;
    if !emit(output, sequence, LogEvent::Started).await {
        return Ok(());
    }
    let mut buffer = [0; 8192];
    loop {
        let size = stream
            .read(&mut buffer)
            .await
            .map_err(|e| error(request, 503, format!("Log stream interrupted: {e}")))?;
        if size == 0 {
            break;
        }
        if !emit(
            output,
            sequence,
            LogEvent::Output {
                data: buffer[..size].to_vec(),
            },
        )
        .await
        {
            return Ok(());
        }
    }
    emit(output, sequence, LogEvent::Completed).await;
    Ok(())
}
