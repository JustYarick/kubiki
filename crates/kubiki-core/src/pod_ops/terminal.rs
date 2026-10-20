//! Managed Pod exec: bounded input/output, window ownership and cancellation during handshake.
use crate::core::api::{ApiError, ApiErrorCode, ResourceRef, validate_query};
use futures::SinkExt;
use k8s_openapi::api::core::v1::{Pod, PodStatus};
use kube::{
    Api, Client,
    api::{AttachParams, AttachedProcess, TerminalSize},
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, future::Future, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{Mutex, mpsc, watch},
    task::JoinHandle,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExecRequest {
    pub resource: ResourceRef,
    pub container: String,
    pub shell: String,
    pub cols: u16,
    pub rows: u16,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum ExecEvent {
    Started,
    Output { data: Vec<u8> },
    Exited { code: i32 },
    Failed { error: ApiError },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExecMessage {
    pub sequence: u64,
    pub event: ExecEvent,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExecBatch {
    pub session_id: String,
    pub messages: Vec<ExecMessage>,
}
enum Control {
    Input(String),
    Resize(u16, u16),
}
struct Session {
    owner: String,
    request: ExecRequest,
    input: mpsc::Sender<Control>,
    ack: watch::Sender<u64>,
    task: JoinHandle<()>,
}
#[derive(Default)]
struct Inner {
    sessions: Mutex<HashMap<String, Session>>,
}
impl Drop for Inner {
    fn drop(&mut self) {
        for session in self.sessions.get_mut().values() {
            session.task.abort();
        }
    }
}
#[derive(Debug)]
pub struct ExecSubscription {
    pub output: mpsc::Receiver<ExecMessage>,
    pub acknowledgements: watch::Receiver<u64>,
}
#[derive(Clone, Default)]
pub struct PodTerminalManager {
    inner: Arc<Inner>,
}

fn error(request: &ExecRequest, status: u16, message: impl Into<String>) -> ApiError {
    ApiError::from_status(
        status,
        message,
        "exec",
        Some(&request.resource.query.context),
    )
    .with_resource(&request.resource.query)
}
fn api_error(request: &ExecRequest, err: kube::Error) -> ApiError {
    let result = match err {
        kube::Error::Api(response) => error(request, response.code, response.message),
        // kube-rs 0.98 reports a refused upgrade as ProtocolSwitch, not Error::Api.
        kube::Error::UpgradeConnection(kube::client::UpgradeConnectionError::ProtocolSwitch(
            status,
        )) => error(
            request,
            status.as_u16(),
            format!(
                "Pod exec WebSocket upgrade rejected ({status}); check pods/exec permissions and API proxy support"
            ),
        ),
        error => ApiError::new(
            ApiErrorCode::Unavailable,
            error.to_string(),
            "exec",
            Some(&request.resource.query.context),
            None,
        )
        .with_resource(&request.resource.query),
    };
    result
}
pub fn validate_request(request: &ExecRequest) -> Result<(), ApiError> {
    validate_query(&request.resource.query)?;
    if request.resource.query.kind != "Pod"
        || request.resource.query.namespace.is_none()
        || request
            .resource
            .uid
            .as_ref()
            .is_none_or(|uid| uid.is_empty())
        || request.resource.name.is_empty()
        || request.resource.name.len() > 253
        || !request
            .resource
            .name
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'.')
        || request.container.is_empty()
        || request.container.len() > 63
        || !request
            .container
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    {
        return Err(error(
            request,
            400,
            "A Pod reference with namespace, UID and container is required",
        ));
    }
    if !["/bin/sh", "/bin/bash", "/bin/ash", "/bin/zsh"].contains(&request.shell.as_str()) {
        return Err(error(request, 400, "Choose a supported shell binary"));
    }
    validate_size(request, request.cols, request.rows)
}
fn validate_size(request: &ExecRequest, cols: u16, rows: u16) -> Result<(), ApiError> {
    if cols == 0 || rows == 0 || cols > 1000 || rows > 1000 {
        Err(error(
            request,
            400,
            "Terminal size must be between 1 and 1000 cells",
        ))
    } else {
        Ok(())
    }
}
fn running(status: &PodStatus, container: &str) -> bool {
    [
        &status.container_statuses,
        &status.init_container_statuses,
        &status.ephemeral_container_statuses,
    ]
    .into_iter()
    .flatten()
    .flatten()
    .any(|s| {
        s.name == container
            && s.state
                .as_ref()
                .is_some_and(|state| state.running.is_some())
    })
}

impl PodTerminalManager {
    pub async fn start<F>(
        &self,
        owner: &str,
        id: &str,
        request: ExecRequest,
        client: F,
    ) -> Result<ExecSubscription, ApiError>
    where
        F: Future<Output = Result<Client, ApiError>> + Send + 'static,
    {
        validate_request(&request)?;
        if id.is_empty()
            || id.len() > 128
            || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return Err(error(&request, 400, "Invalid terminal session ID"));
        }
        let mut sessions = self.inner.sessions.lock().await;
        let key = format!("{owner}:{id}");
        if sessions.contains_key(&key) {
            return Err(error(&request, 409, "Terminal session already exists"));
        }
        if sessions.len() >= 32 {
            return Err(error(&request, 429, "Too many terminal sessions"));
        }
        let (ack, acknowledgements) = watch::channel(0);
        let (output, rx) = mpsc::channel(64);
        let (input, controls) = mpsc::channel(64);
        let target = request.clone();
        let task = tokio::spawn(async move {
            let mut sequence = 0;
            let result = tokio::select! {
                _=output.closed()=>return,
                result=run(&target,client,controls,&output,&mut sequence)=>result,
            };
            if let Err(error) = result {
                emit(&output, &mut sequence, ExecEvent::Failed { error }).await;
            }
        });
        sessions.insert(
            key,
            Session {
                owner: owner.into(),
                request,
                input,
                ack,
                task,
            },
        );
        Ok(ExecSubscription {
            output: rx,
            acknowledgements,
        })
    }
    pub async fn write(&self, owner: &str, id: &str, data: String) -> Result<(), ApiError> {
        let sessions = self.inner.sessions.lock().await;
        let session = sessions.get(&format!("{owner}:{id}")).ok_or_else(|| {
            ApiError::from_status(404, "Terminal session is closed", "exec", None)
        })?;
        if data.len() > 65536 {
            return Err(error(
                &session.request,
                400,
                "Terminal input exceeds 64 KiB",
            ));
        }
        session.input.try_send(Control::Input(data)).map_err(|_| {
            error(
                &session.request,
                429,
                "Terminal input is busy or closed; reconnect the session",
            )
        })
    }
    pub async fn resize(
        &self,
        owner: &str,
        id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), ApiError> {
        let sessions = self.inner.sessions.lock().await;
        let session = sessions.get(&format!("{owner}:{id}")).ok_or_else(|| {
            ApiError::from_status(404, "Terminal session is closed", "exec", None)
        })?;
        validate_size(&session.request, cols, rows)?;
        session
            .input
            .try_send(Control::Resize(cols, rows))
            .map_err(|_| {
                error(
                    &session.request,
                    429,
                    "Terminal resize queue is busy or closed",
                )
            })
    }
    pub async fn acknowledge(&self, owner: &str, id: &str, sequence: u64) -> Result<(), ApiError> {
        let sessions = self.inner.sessions.lock().await;
        let session = sessions.get(&format!("{owner}:{id}")).ok_or_else(|| {
            ApiError::from_status(404, "Terminal session is closed", "exec", None)
        })?;
        session.ack.send_replace(sequence);
        Ok(())
    }
    pub async fn stop(&self, owner: &str, id: &str) {
        let mut sessions = self.inner.sessions.lock().await;
        if let Some(session) = sessions.remove(&format!("{owner}:{id}")) {
            session.task.abort();
            let _ = session.task.await;
        }
    }
    pub async fn stop_owner(&self, owner: &str) {
        let mut sessions = self.inner.sessions.lock().await;
        let keys: Vec<_> = sessions
            .iter()
            .filter(|(_, s)| s.owner == owner)
            .map(|(key, _)| key.clone())
            .collect();
        for key in keys {
            if let Some(session) = sessions.remove(&key) {
                session.task.abort();
                let _ = session.task.await;
            }
        }
    }
    pub async fn active_count(&self) -> usize {
        self.inner.sessions.lock().await.len()
    }
}
async fn emit(tx: &mpsc::Sender<ExecMessage>, sequence: &mut u64, event: ExecEvent) -> bool {
    *sequence += 1;
    tx.send(ExecMessage {
        sequence: *sequence,
        event,
    })
    .await
    .is_ok()
}
// AttachedProcess does not abort its spawned WebSocket task when dropped.
struct AbortProcess(AttachedProcess);
impl Drop for AbortProcess {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn run<F>(
    request: &ExecRequest,
    client: F,
    mut controls: mpsc::Receiver<Control>,
    tx: &mpsc::Sender<ExecMessage>,
    sequence: &mut u64,
) -> Result<(), ApiError>
where
    F: Future<Output = Result<Client, ApiError>>,
{
    let connect = async {
        let client = client.await?;
        let pods: Api<Pod> =
            Api::namespaced(client, request.resource.query.namespace.as_deref().unwrap());
        let pod = pods
            .get(&request.resource.name)
            .await
            .map_err(|e| api_error(request, e))?;
        if pod.metadata.uid != request.resource.uid {
            return Err(error(
                request,
                409,
                "The Pod was recreated; open the current Pod before connecting",
            ));
        }
        if pod.metadata.deletion_timestamp.is_some()
            || !pod
                .status
                .as_ref()
                .is_some_and(|s| running(s, &request.container))
        {
            return Err(error(
                request,
                409,
                "The selected container is not running; inspect its status or logs",
            ));
        }
        let params = AttachParams {
            container: Some(request.container.clone()),
            stdin: true,
            stdout: true,
            stderr: false,
            tty: true,
            max_stdin_buf_size: Some(65536),
            max_stdout_buf_size: Some(65536),
            ..Default::default()
        };
        pods.exec(&request.resource.name, vec![request.shell.clone()], &params)
            .await
            .map_err(|e| api_error(request, e))
    };
    let attached = tokio::time::timeout(Duration::from_secs(20), connect)
        .await
        .map_err(|_| error(request, 504, "Pod exec connection timed out"))??;
    let mut process = AbortProcess(attached);
    let mut stdin = process
        .0
        .stdin()
        .ok_or_else(|| error(request, 500, "Exec stdin was not attached"))?;
    let mut stdout = process
        .0
        .stdout()
        .ok_or_else(|| error(request, 500, "Exec stdout was not attached"))?;
    let mut resize = process
        .0
        .terminal_size()
        .ok_or_else(|| error(request, 500, "Exec TTY resize was not attached"))?;
    let status = process
        .0
        .take_status()
        .ok_or_else(|| error(request, 500, "Exec status was not attached"))?;
    resize
        .send(TerminalSize {
            width: request.cols,
            height: request.rows,
        })
        .await
        .map_err(|_| error(request, 503, "Exec TTY closed before resize"))?;
    if !emit(tx, sequence, ExecEvent::Started).await {
        return Ok(());
    }
    // Read output concurrently with writes: a large paste must not block draining stdout.
    let output = async {
        let mut buffer = [0; 8192];
        loop {
            let count = stdout
                .read(&mut buffer)
                .await
                .map_err(|e| error(request, 503, format!("Exec output failed: {e}")))?;
            if count == 0 {
                return Ok::<_, ApiError>(());
            }
            if !emit(
                tx,
                sequence,
                ExecEvent::Output {
                    data: buffer[..count].to_vec(),
                },
            )
            .await
            {
                return Ok(());
            }
        }
    };
    let input = async {
        while let Some(control) = controls.recv().await {
            match control {
                Control::Input(data) => stdin
                    .write_all(data.as_bytes())
                    .await
                    .map_err(|e| error(request, 503, format!("Exec input failed: {e}")))?,
                Control::Resize(cols, rows) => resize
                    .send(TerminalSize {
                        width: cols,
                        height: rows,
                    })
                    .await
                    .map_err(|_| error(request, 503, "Exec TTY resize failed"))?,
            }
        }
        Ok::<_, ApiError>(())
    };
    tokio::select! {result=output=>result?,result=input=>return result,}
    let status = tokio::time::timeout(Duration::from_secs(3), status)
        .await
        .ok()
        .flatten()
        .ok_or_else(|| {
            ApiError::new(
                ApiErrorCode::Unavailable,
                "Exec connection closed without an exit status. Reconnect explicitly.",
                "exec",
                Some(&request.resource.query.context),
                None,
            )
            .with_resource(&request.resource.query)
        })?;
    let code =
        if status.status.as_deref() == Some("Success") {
            0
        } else {
            let code = status
                .details
                .as_ref()
                .and_then(|d| d.causes.as_ref())
                .and_then(|causes| {
                    causes
                        .iter()
                        .find(|c| c.reason.as_deref() == Some("ExitCode"))
                })
                .and_then(|cause| cause.message.as_ref())
                .and_then(|message| message.parse::<i32>().ok());
            match code {
                Some(code) => code,
                None => return Err(error(
                    request,
                    500,
                    status.message.unwrap_or_else(|| {
                        "Exec failed to start. Check that the selected shell exists in the image."
                            .into()
                    }),
                )),
            }
        };
    emit(tx, sequence, ExecEvent::Exited { code }).await;
    Ok(())
}
