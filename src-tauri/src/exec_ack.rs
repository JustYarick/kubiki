use std::time::Duration;
use tokio::sync::watch;

/// Waits until the renderer acknowledges that it consumed the batch up to
/// `sequence`. `timeout_secs == 0` waits forever: a hidden or occluded window
/// simply resumes when it catches up, so sessions are not killed after a short
/// stall anymore. A positive value keeps the legacy backpressure kill switch.
pub async fn wait_for_ack(receiver: &watch::Receiver<u64>, sequence: u64, timeout_secs: u64) -> bool {
    let mut receiver = receiver.clone();
    let ack = async move {
        loop {
            if *receiver.borrow_and_update() == sequence {
                return Ok::<(), ()>(());
            }
            receiver.changed().await.map_err(|_| ())?;
        }
    };
    if timeout_secs == 0 { ack.await.is_ok() } else {
        matches!(tokio::time::timeout(Duration::from_secs(timeout_secs), ack).await, Ok(Ok(())))
    }
}
