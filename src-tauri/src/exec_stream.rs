//! Shared IPC batching and renderer backpressure for every terminal transport.
use kubiki_core::{
    core::api::ApiError,
    pod_ops::terminal::{ExecBatch, ExecEvent, ExecMessage, ExecSubscription},
};
use std::time::Duration;
use tauri::ipc::Channel;

pub async fn forward(
    subscription: &mut ExecSubscription,
    session_id: &str,
    on_event: &Channel<ExecBatch>,
    ack_timeout_secs: Option<u64>,
    operation: &str,
    context: Option<&str>,
) {
    let mut timer = tokio::time::interval(Duration::from_millis(16));
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut messages = Vec::new();
    let mut bytes = 0;
    loop {
        let (flush, ended) = tokio::select! {
            message = subscription.output.recv(), if messages.len() < 32 && bytes < 65536 => match message {
                Some(message) => { if let ExecEvent::Output { data } = &message.event { bytes += data.len(); } messages.push(message); (false, false) },
                None => (true, true),
            },
            _ = timer.tick() => (true, false),
        };
        if flush && !messages.is_empty() {
            let sequence = messages.last().unwrap().sequence;
            if on_event
                .send(ExecBatch {
                    session_id: session_id.into(),
                    messages: std::mem::take(&mut messages),
                })
                .is_err()
            {
                break;
            }
            bytes = 0;
            if !crate::exec_ack::wait_for_ack(
                &subscription.acknowledgements,
                sequence,
                ack_timeout_secs.unwrap_or(0),
            )
            .await
            {
                let _ = on_event.send(ExecBatch { session_id: session_id.into(), messages: vec![ExecMessage { sequence: sequence + 1, event: ExecEvent::Failed { error: ApiError::from_status(504, "Terminal renderer stopped consuming output. Reconnect the session.", operation, context) } }] });
                break;
            }
        }
        if ended {
            break;
        }
    }
}
