//! Trusted desktop consent. This module has no IPC commands and no renderer
//! permission to show/accept dialogs. Callers must hold the guard through commit.
use kubiki_core::core::{
    api::{ApiError, ResourceRef},
    mutations::{MAX_REVIEW_CHARS, REVIEW_TTL, error},
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use tauri::Manager;
#[cfg(not(target_os = "linux"))]
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

static DIALOG_OPEN: AtomicBool = AtomicBool::new(false);
struct DialogReservation;
impl Drop for DialogReservation {
    fn drop(&mut self) {
        DIALOG_OPEN.store(false, Ordering::Release);
    }
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
                "A system confirmation is still open. Close it before requesting another change",
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
    if review.chars().count() > MAX_REVIEW_CHARS {
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
        return Err(error(
            resource,
            409,
            "A system confirmation is already open",
        ));
    }
    let reservation = DialogReservation;
    let started = Instant::now();
    let result = show_native(window, review, reservation)
        .await
        .map_err(|_| {
            error(
                resource,
                503,
                "Cannot obtain system confirmation. Nothing was changed",
            )
        })?;
    if started.elapsed() > REVIEW_TTL {
        return Err(error(
            resource,
            409,
            "Confirmation expired. Request and review the change again",
        ));
    }
    Ok(result)
}

#[cfg(not(target_os = "linux"))]
async fn show_native(
    window: tauri::WebviewWindow,
    review: String,
    reservation: DialogReservation,
) -> Result<bool, ()> {
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let _reservation = reservation;
        if app.get_webview_window(&label).is_none() {
            return false;
        }
        let approved = app
            .dialog()
            .message(review)
            .title("Kubiki · Confirm Kubernetes change")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Apply change".into(),
                "Cancel".into(),
            ))
            .parent(&window)
            .blocking_show();
        approved && app.get_webview_window(&label).is_some()
    })
    .await
    .map_err(|_| ())
}

/// Linux uses the existing GTK main loop, rather than a webview or an unscrollable
/// message box. TextBuffer receives literal text (never markup/printf formats).
#[cfg(target_os = "linux")]
async fn show_native(
    window: tauri::WebviewWindow,
    review: String,
    reservation: DialogReservation,
) -> Result<bool, ()> {
    use gtk::prelude::*;
    use std::{cell::RefCell, rc::Rc};
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    window
        .clone()
        .run_on_main_thread(move || {
            let Ok(parent) = window.gtk_window() else {
                let _ = sender.send(false);
                return;
            };
            if app.get_webview_window(&label).is_none() {
                let _ = sender.send(false);
                return;
            }
            let dialog = gtk::Dialog::builder()
                .title("Kubiki · Confirm Kubernetes change")
                .transient_for(&parent)
                .modal(true)
                .destroy_with_parent(true)
                .default_width(760)
                .default_height(600)
                .resizable(true)
                .build();
            dialog.add_buttons(&[
                ("Cancel", gtk::ResponseType::Cancel),
                ("Apply change", gtk::ResponseType::Accept),
            ]);
            dialog.set_default_response(gtk::ResponseType::Cancel);
            if let Some(button) = dialog.widget_for_response(gtk::ResponseType::Accept) {
                button.style_context().add_class("destructive-action");
            }
            let content = dialog.content_area();
            content.set_spacing(12);
            content.set_border_width(16);
            let title = gtk::Label::new(Some(
                "Review the exact Kubernetes operation below. Approval expires after 2 minutes.",
            ));
            title.set_line_wrap(true);
            title.set_xalign(0.0);
            content.pack_start(&title, false, false, 0);
            let text = gtk::TextView::new();
            text.set_editable(false);
            text.set_cursor_visible(false);
            text.set_monospace(true);
            text.set_wrap_mode(gtk::WrapMode::WordChar);
            text.set_left_margin(12);
            text.set_right_margin(12);
            text.set_top_margin(12);
            text.set_bottom_margin(12);
            text.buffer()
                .expect("TextView has a buffer")
                .set_text(&review);
            let scroll =
                gtk::ScrolledWindow::new(None::<&gtk::Adjustment>, None::<&gtk::Adjustment>);
            scroll.set_policy(gtk::PolicyType::Automatic, gtk::PolicyType::Automatic);
            scroll.set_shadow_type(gtk::ShadowType::In);
            scroll.add(&text);
            content.pack_start(&scroll, true, true, 0);
            let sender = Rc::new(RefCell::new(Some(sender)));
            let response_sender = sender.clone();
            dialog.connect_response(move |dialog, response| {
                if let Some(sender) = response_sender.borrow_mut().take() {
                    let _ = sender.send(
                        response == gtk::ResponseType::Accept
                            && app.get_webview_window(&label).is_some(),
                    );
                }
                // gtk_window_close emits DeleteEvent on GtkDialog and would recurse
                // through this response handler. Destroy the modal widget directly.
                unsafe {
                    dialog.destroy();
                }
            });
            dialog.connect_destroy(move |_| {
                // Keep the reservation alive even if the command future was cancelled.
                let _reservation = &reservation;
                if let Some(sender) = sender.borrow_mut().take() {
                    let _ = sender.send(false);
                }
            });
            dialog.show_all();
            if let Some(button) = dialog.widget_for_response(gtk::ResponseType::Cancel) {
                button.grab_focus();
            }
        })
        .map_err(|_| ())?;
    receiver.await.map_err(|_| ())
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
