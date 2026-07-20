use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Deserialize;
use tauri::{AppHandle, Manager, Webview};

const MAX_BROWSER_PREVIEW_BYTES: usize = 24 * 1024 * 1024;
#[cfg(windows)]
const BROWSER_PREVIEW_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(4);

#[derive(Deserialize)]
struct DevToolsScreenshotResponse {
    data: String,
}

#[tauri::command]
pub(crate) async fn capture_browser_webview_preview(
    webview: Webview,
    app: AppHandle,
    label: String,
) -> Result<String, String> {
    super::ensure_agent_main_webview(&webview)?;
    if !super::is_browser_pane_webview_label(&label) {
        return Err("The web pane identifier is invalid.".to_owned());
    }
    let child = app
        .get_webview(&label)
        .ok_or_else(|| "The web pane is no longer available for preview.".to_owned())?;

    #[cfg(windows)]
    {
        capture_windows_browser_preview(child).await
    }

    #[cfg(not(windows))]
    {
        let _ = child;
        Err("Browser previews are not available on this platform.".to_owned())
    }
}

#[cfg(windows)]
async fn capture_windows_browser_preview(webview: Webview) -> Result<String, String> {
    use std::sync::mpsc;

    let (sender, receiver) = mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| {
            let callback_sender = sender.clone();
            let start = (|| -> Result<(), String> {
                use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, CoTaskMemPWSTR};

                let controller = platform_webview.controller();
                // SAFETY: Tauri invokes `with_webview` on the WebView2 UI thread and the
                // returned controller belongs to this live child webview.
                let core = unsafe { controller.CoreWebView2() }
                    .map_err(|error| format!("Could not access WebView2 for preview: {error}"))?;
                let callback = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                    move |result, response| {
                        let preview = if result.is_ok() {
                            browser_preview_data_url(&response.to_string())
                        } else {
                            Err("WebView2 did not complete the browser preview capture.".to_owned())
                        };
                        let _ = callback_sender.send(preview);
                        Ok(())
                    },
                ));
                let method = CoTaskMemPWSTR::from("Page.captureScreenshot");
                let parameters = CoTaskMemPWSTR::from(
                    r#"{"format":"png","fromSurface":true,"captureBeyondViewport":false}"#,
                );
                // SAFETY: the COM objects are used on the WebView2 UI thread and WebView2
                // retains the one-shot callback until this CDP operation completes.
                unsafe {
                    core.CallDevToolsProtocolMethod(
                        *method.as_ref().as_pcwstr(),
                        *parameters.as_ref().as_pcwstr(),
                        &callback,
                    )
                }
                .map_err(|error| format!("Could not start the browser preview capture: {error}"))?;
                Ok(())
            })();
            if let Err(error) = start {
                let _ = sender.send(Err(error));
            }
        })
        .map_err(|error| format!("Could not access the browser pane for preview: {error}"))?;

    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(BROWSER_PREVIEW_TIMEOUT)
            .map_err(|error| {
                if matches!(error, mpsc::RecvTimeoutError::Timeout) {
                    "Timed out while capturing the browser preview.".to_owned()
                } else {
                    "The browser preview capture ended unexpectedly.".to_owned()
                }
            })?
    })
    .await
    .map_err(|_| "The browser preview worker did not complete.".to_owned())?
}

fn browser_preview_data_url(response: &str) -> Result<String, String> {
    if response.len() > MAX_BROWSER_PREVIEW_BYTES.saturating_mul(2) {
        return Err("The browser preview is too large.".to_owned());
    }
    let response: DevToolsScreenshotResponse = serde_json::from_str(response)
        .map_err(|_| "The browser preview response is invalid.".to_owned())?;
    let bytes = STANDARD
        .decode(response.data.as_bytes())
        .map_err(|_| "The browser preview image is invalid.".to_owned())?;
    if bytes.len() > MAX_BROWSER_PREVIEW_BYTES || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("The browser preview image is invalid.".to_owned());
    }
    Ok(format!("data:image/png;base64,{}", response.data))
}

#[cfg(test)]
mod tests {
    use super::{MAX_BROWSER_PREVIEW_BYTES, browser_preview_data_url};
    use base64::{Engine as _, engine::general_purpose::STANDARD};

    #[test]
    fn preview_response_becomes_an_in_memory_png_data_url() {
        let encoded = STANDARD.encode(b"\x89PNG\r\n\x1a\npixels");
        let response = serde_json::json!({ "data": encoded }).to_string();
        assert_eq!(
            browser_preview_data_url(&response),
            Ok(format!("data:image/png;base64,{encoded}")),
        );
    }

    #[test]
    fn preview_response_rejects_non_png_and_oversized_data() {
        let encoded = STANDARD.encode(b"not a png");
        let response = serde_json::json!({ "data": encoded }).to_string();
        assert!(browser_preview_data_url(&response).is_err());
        assert!(browser_preview_data_url(&"x".repeat(MAX_BROWSER_PREVIEW_BYTES * 2 + 1)).is_err());
    }
}
