use serde_json::Value;
use tauri::{AppHandle, Manager, Webview};

const MAX_SELECTOR_BYTES: usize = 2 * 1024;
const MAX_TYPE_TEXT_BYTES: usize = 16 * 1024;
const MAX_SNAPSHOT_VALUE_BYTES: usize = 64 * 1024;
const MAX_ACTION_VALUE_BYTES: usize = 16 * 1024;
const MAX_RUNTIME_RESPONSE_BYTES: usize = 512 * 1024;
#[cfg(windows)]
const BROWSER_AGENT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(4);

const SNAPSHOT_EXPRESSION: &str = r#"(() => {
  "use strict";
  const MAX_ELEMENTS = 200;
  const MAX_CANDIDATES = 5000;
  const MAX_RESULT_BYTES = 65536;
  const MAX_URL_CHARS = 16384;
  const MAX_TITLE_CHARS = 2048;
  const MAX_BODY_CHARS = 65536;
  const MAX_FIELD_CHARS = 512;
  const encoder = new TextEncoder();
  const byteLength = (value) => encoder.encode(JSON.stringify(value)).length;
  const normalize = (value, maximum = MAX_FIELD_CHARS) => String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);
  const isPassword = (element) => element instanceof HTMLInputElement
    && String(element.type).toLowerCase() === "password";
  const isVisible = (element) => {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const cssSelector = (element) => {
    if (!(element instanceof Element)) return "";
    if (element.id) return `#${CSS.escape(element.id)}`.slice(0, 2048);
    const parts = [];
    let current = element;
    for (let depth = 0; current instanceof Element && depth < 10; depth += 1) {
      const tag = current.tagName.toLowerCase();
      if (tag === "html" || tag === "body") {
        parts.unshift(tag);
        break;
      }
      let part = tag;
      const parent = current.parentElement;
      if (parent) {
        const peers = Array.from(parent.children).filter((candidate) => candidate.tagName === current.tagName);
        if (peers.length > 1) part += `:nth-of-type(${peers.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ").slice(0, 2048);
  };
  const inferredRole = (element) => {
    const explicit = normalize(element.getAttribute("role"), 128);
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "option") return "option";
    if (tag === "input") {
      const type = String(element.type || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      return "textbox";
    }
    if (element.isContentEditable) return "textbox";
    return "";
  };

  const candidates = document.querySelectorAll(
    "a[href],button,input:not([type='hidden']),select,textarea,[role],[contenteditable='true'],[contenteditable='plaintext-only'],[tabindex]:not([tabindex='-1'])",
  );
  const elements = [];
  let omittedElements = false;
  let inspectedCandidates = 0;
  for (const element of candidates) {
    if (inspectedCandidates >= MAX_CANDIDATES) {
      omittedElements = true;
      break;
    }
    inspectedCandidates += 1;
    if (elements.length >= MAX_ELEMENTS) {
      omittedElements = true;
      break;
    }
    if (!isVisible(element) || isPassword(element)) continue;
    const selector = cssSelector(element);
    if (!selector) continue;
    elements.push({
      tag: element.tagName.toLowerCase(),
      role: inferredRole(element),
      text: normalize(element.innerText || element.textContent),
      ariaLabel: normalize(element.getAttribute("aria-label")),
      placeholder: normalize(element.getAttribute("placeholder")),
      selector,
      disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
    });
  }

  const rawBodyText = String(document.body?.innerText || "");
  let snapshot = {
    url: String(location.href).slice(0, MAX_URL_CHARS),
    title: String(document.title || "").slice(0, MAX_TITLE_CHARS),
    bodyText: rawBodyText.slice(0, MAX_BODY_CHARS),
    elements,
    truncated: omittedElements || rawBodyText.length > MAX_BODY_CHARS,
  };
  while (snapshot.elements.length > 0 && byteLength(snapshot) > MAX_RESULT_BYTES) {
    snapshot.elements.pop();
    snapshot.truncated = true;
  }
  while (snapshot.bodyText.length > 0 && byteLength(snapshot) > MAX_RESULT_BYTES) {
    snapshot.bodyText = snapshot.bodyText.slice(0, Math.floor(snapshot.bodyText.length * 0.75));
    snapshot.truncated = true;
  }
  while (snapshot.url.length > 0 && byteLength(snapshot) > MAX_RESULT_BYTES) {
    snapshot.url = snapshot.url.slice(0, Math.floor(snapshot.url.length * 0.75));
    snapshot.truncated = true;
  }
  while (snapshot.title.length > 0 && byteLength(snapshot) > MAX_RESULT_BYTES) {
    snapshot.title = snapshot.title.slice(0, Math.floor(snapshot.title.length * 0.75));
    snapshot.truncated = true;
  }
  if (byteLength(snapshot) > MAX_RESULT_BYTES) {
    snapshot = { url: "", title: "", bodyText: "", elements: [], truncated: true };
  }
  return snapshot;
})()"#;

#[tauri::command]
pub(crate) async fn browser_agent_snapshot(
    webview: Webview,
    app: AppHandle,
    label: String,
) -> Result<Value, String> {
    let child = browser_child_webview(&webview, &app, &label)?;

    #[cfg(windows)]
    {
        evaluate_windows_browser_script(
            child,
            SNAPSHOT_EXPRESSION.to_owned(),
            MAX_SNAPSHOT_VALUE_BYTES,
        )
        .await
    }

    #[cfg(not(windows))]
    {
        let _ = child;
        Err("Browser agent automation is not available on this platform.".to_owned())
    }
}

#[tauri::command]
pub(crate) async fn browser_agent_click(
    webview: Webview,
    app: AppHandle,
    label: String,
    selector: String,
) -> Result<Value, String> {
    let selector = validate_selector(&selector)?;
    let expression = click_expression(selector)?;
    let child = browser_child_webview(&webview, &app, &label)?;

    #[cfg(windows)]
    {
        evaluate_windows_browser_script(child, expression, MAX_ACTION_VALUE_BYTES).await
    }

    #[cfg(not(windows))]
    {
        let _ = (child, expression);
        Err("Browser agent automation is not available on this platform.".to_owned())
    }
}

#[tauri::command]
pub(crate) async fn browser_agent_type(
    webview: Webview,
    app: AppHandle,
    label: String,
    selector: String,
    text: String,
) -> Result<Value, String> {
    let selector = validate_selector(&selector)?;
    let text = validate_type_text(&text)?;
    let expression = type_expression(selector, text)?;
    let child = browser_child_webview(&webview, &app, &label)?;

    #[cfg(windows)]
    {
        evaluate_windows_browser_script(child, expression, MAX_ACTION_VALUE_BYTES).await
    }

    #[cfg(not(windows))]
    {
        let _ = (child, expression);
        Err("Browser agent automation is not available on this platform.".to_owned())
    }
}

fn browser_child_webview(
    caller: &Webview,
    app: &AppHandle,
    label: &str,
) -> Result<Webview, String> {
    super::ensure_agent_main_webview(caller)?;
    if !super::is_browser_pane_webview_label(label) {
        return Err("The web pane identifier is invalid.".to_owned());
    }
    app.get_webview(label)
        .ok_or_else(|| "The web pane is no longer available.".to_owned())
}

fn validate_selector(selector: &str) -> Result<&str, String> {
    if selector.trim().is_empty() {
        return Err("The browser selector is empty.".to_owned());
    }
    if selector.len() > MAX_SELECTOR_BYTES {
        return Err("The browser selector is too long.".to_owned());
    }
    if selector.chars().any(char::is_control) {
        return Err("The browser selector contains unsupported characters.".to_owned());
    }
    Ok(selector)
}

fn validate_type_text(text: &str) -> Result<&str, String> {
    if text.len() > MAX_TYPE_TEXT_BYTES {
        return Err("The browser input text is too long.".to_owned());
    }
    if text
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\r' | '\n' | '\t'))
    {
        return Err("The browser input text contains unsupported characters.".to_owned());
    }
    Ok(text)
}

fn click_expression(selector: &str) -> Result<String, String> {
    let selector = serde_json::to_string(selector)
        .map_err(|_| "The browser selector could not be encoded.".to_owned())?;
    Ok(format!(
        r#"(() => {{
  "use strict";
  const selector = {selector};
  let element;
  try {{ element = document.querySelector(selector); }}
  catch (_) {{ return {{ ok: false, error: "invalid-selector" }}; }}
  if (!(element instanceof HTMLElement)) return {{ ok: false, error: "element-not-found" }};
  if (element instanceof HTMLInputElement && String(element.type).toLowerCase() === "password") {{
    return {{ ok: false, error: "password-input-refused" }};
  }}
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0 || rect.width <= 0 || rect.height <= 0) {{
    return {{ ok: false, error: "element-not-visible" }};
  }}
  element.scrollIntoView({{ block: "center", inline: "center", behavior: "auto" }});
  element.focus({{ preventScroll: true }});
  element.click();
  return {{ ok: true }};
}})()"#
    ))
}

fn type_expression(selector: &str, text: &str) -> Result<String, String> {
    let selector = serde_json::to_string(selector)
        .map_err(|_| "The browser selector could not be encoded.".to_owned())?;
    let text = serde_json::to_string(text)
        .map_err(|_| "The browser input text could not be encoded.".to_owned())?;
    Ok(format!(
        r#"(() => {{
  "use strict";
  const selector = {selector};
  const text = {text};
  let element;
  try {{ element = document.querySelector(selector); }}
  catch (_) {{ return {{ ok: false, error: "invalid-selector" }}; }}
  if (!(element instanceof HTMLElement)) return {{ ok: false, error: "element-not-found" }};
  if (element instanceof HTMLInputElement && String(element.type).toLowerCase() === "password") {{
    return {{ ok: false, error: "password-input-refused" }};
  }}
  if (element.disabled || element.readOnly || element.getAttribute("aria-disabled") === "true") {{
    return {{ ok: false, error: "element-not-editable" }};
  }}
  if (element instanceof HTMLInputElement) {{
    const rejectedTypes = new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]);
    if (rejectedTypes.has(String(element.type).toLowerCase())) {{
      return {{ ok: false, error: "element-not-editable" }};
    }}
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) return {{ ok: false, error: "element-not-editable" }};
    setter.call(element, text);
  }} else if (element instanceof HTMLTextAreaElement) {{
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter) return {{ ok: false, error: "element-not-editable" }};
    setter.call(element, text);
  }} else if (element.isContentEditable) {{
    element.textContent = text;
  }} else {{
    return {{ ok: false, error: "element-not-editable" }};
  }}
  element.scrollIntoView({{ block: "center", inline: "center", behavior: "auto" }});
  element.focus({{ preventScroll: true }});
  let inputEvent;
  try {{ inputEvent = new InputEvent("input", {{ bubbles: true, inputType: "insertText", data: text }}); }}
  catch (_) {{ inputEvent = new Event("input", {{ bubbles: true }}); }}
  element.dispatchEvent(inputEvent);
  element.dispatchEvent(new Event("change", {{ bubbles: true }}));
  if (typeof element.setSelectionRange === "function") {{
    try {{ element.setSelectionRange(text.length, text.length); }} catch (_) {{}}
  }}
  return {{ ok: true }};
}})()"#
    ))
}

#[cfg(windows)]
async fn evaluate_windows_browser_script(
    webview: Webview,
    expression: String,
    maximum_value_bytes: usize,
) -> Result<Value, String> {
    use std::sync::mpsc;

    let parameters = serde_json::json!({
        "expression": expression,
        "returnByValue": true,
        "awaitPromise": false,
        "userGesture": true,
    })
    .to_string();
    let (sender, receiver) = mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| {
            let callback_sender = sender.clone();
            let start = (|| -> Result<(), String> {
                use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, CoTaskMemPWSTR};

                let controller = platform_webview.controller();
                // SAFETY: Tauri invokes `with_webview` on the WebView2 UI thread and the
                // returned controller belongs to this live child webview.
                let core = unsafe { controller.CoreWebView2() }.map_err(|error| {
                    format!("Could not access WebView2 for browser automation: {error}")
                })?;
                let callback = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                    move |result, response| {
                        let value = if result.is_ok() {
                            runtime_evaluate_value(&response.to_string(), maximum_value_bytes)
                        } else {
                            Err("WebView2 did not complete browser automation.".to_owned())
                        };
                        let _ = callback_sender.send(value);
                        Ok(())
                    },
                ));
                let method = CoTaskMemPWSTR::from("Runtime.evaluate");
                let parameters = CoTaskMemPWSTR::from(parameters.as_str());
                // SAFETY: the COM objects are used on the WebView2 UI thread and WebView2
                // retains the one-shot callback until this CDP operation completes.
                unsafe {
                    core.CallDevToolsProtocolMethod(
                        *method.as_ref().as_pcwstr(),
                        *parameters.as_ref().as_pcwstr(),
                        &callback,
                    )
                }
                .map_err(|error| format!("Could not start browser automation: {error}"))?;
                Ok(())
            })();
            if let Err(error) = start {
                let _ = sender.send(Err(error));
            }
        })
        .map_err(|error| format!("Could not access the web pane for automation: {error}"))?;

    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(BROWSER_AGENT_TIMEOUT)
            .map_err(|error| {
                if matches!(error, mpsc::RecvTimeoutError::Timeout) {
                    "Timed out while running browser automation.".to_owned()
                } else {
                    "Browser automation ended unexpectedly.".to_owned()
                }
            })?
    })
    .await
    .map_err(|_| "The browser automation worker did not complete.".to_owned())?
}

fn runtime_evaluate_value(response: &str, maximum_value_bytes: usize) -> Result<Value, String> {
    if response.len() > MAX_RUNTIME_RESPONSE_BYTES {
        return Err("The browser automation response is too large.".to_owned());
    }
    let response: Value = serde_json::from_str(response)
        .map_err(|_| "The browser automation response is invalid.".to_owned())?;
    if response
        .get("exceptionDetails")
        .is_some_and(|details| !details.is_null())
    {
        return Err("The page rejected browser automation.".to_owned());
    }
    let value = response
        .pointer("/result/value")
        .ok_or_else(|| "The browser automation response has no value.".to_owned())?
        .clone();
    let encoded = serde_json::to_vec(&value)
        .map_err(|_| "The browser automation result is invalid.".to_owned())?;
    if encoded.len() > maximum_value_bytes {
        return Err("The browser automation result is too large.".to_owned());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_ACTION_VALUE_BYTES, MAX_RUNTIME_RESPONSE_BYTES, MAX_SELECTOR_BYTES,
        MAX_SNAPSHOT_VALUE_BYTES, MAX_TYPE_TEXT_BYTES, SNAPSHOT_EXPRESSION, click_expression,
        runtime_evaluate_value, type_expression, validate_selector, validate_type_text,
    };

    #[test]
    fn selector_validation_is_bounded_and_rejects_control_characters() {
        assert_eq!(validate_selector("button.primary"), Ok("button.primary"));
        assert!(validate_selector("   ").is_err());
        assert!(validate_selector("button\ninput").is_err());
        assert!(validate_selector(&"x".repeat(MAX_SELECTOR_BYTES + 1)).is_err());
    }

    #[test]
    fn type_text_validation_allows_multiline_text_but_is_bounded() {
        assert_eq!(
            validate_type_text("first\nsecond\tvalue"),
            Ok("first\nsecond\tvalue")
        );
        assert!(validate_type_text("bad\0text").is_err());
        assert!(validate_type_text(&"x".repeat(MAX_TYPE_TEXT_BYTES + 1)).is_err());
    }

    #[test]
    fn selector_and_text_are_json_literals_inside_fixed_expressions() {
        let selector = r#"button[x="];globalThis.pwned=true;//"]"#;
        let text = "value\";globalThis.pwned=true;//\nnext";
        let encoded_selector = serde_json::to_string(selector).unwrap();
        let encoded_text = serde_json::to_string(text).unwrap();
        let click = click_expression(selector).unwrap();
        let typed = type_expression(selector, text).unwrap();
        assert!(click.contains(&format!("const selector = {encoded_selector};")));
        assert!(typed.contains(&format!("const selector = {encoded_selector};")));
        assert!(typed.contains(&format!("const text = {encoded_text};")));
        assert!(click.contains("password-input-refused"));
        assert!(typed.contains("password-input-refused"));
    }

    #[test]
    fn snapshot_is_bounded_and_never_reads_private_browser_or_form_state() {
        assert!(SNAPSHOT_EXPRESSION.contains("const MAX_ELEMENTS = 200"));
        assert!(SNAPSHOT_EXPRESSION.contains("const MAX_CANDIDATES = 5000"));
        assert!(SNAPSHOT_EXPRESSION.contains("const MAX_RESULT_BYTES = 65536"));
        assert!(!SNAPSHOT_EXPRESSION.contains("document.cookie"));
        assert!(!SNAPSHOT_EXPRESSION.contains("localStorage"));
        assert!(!SNAPSHOT_EXPRESSION.contains("sessionStorage"));
        assert!(!SNAPSHOT_EXPRESSION.contains("element.value"));
    }

    #[test]
    fn runtime_response_parser_returns_only_the_by_value_result() {
        let response = serde_json::json!({
            "result": {
                "type": "object",
                "value": { "ok": true, "elements": [] }
            }
        })
        .to_string();
        assert_eq!(
            runtime_evaluate_value(&response, MAX_ACTION_VALUE_BYTES),
            Ok(serde_json::json!({ "ok": true, "elements": [] })),
        );
    }

    #[test]
    fn runtime_response_parser_rejects_exceptions_and_missing_values() {
        let exception = serde_json::json!({
            "result": { "type": "object" },
            "exceptionDetails": { "text": "private page error" }
        })
        .to_string();
        assert!(runtime_evaluate_value(&exception, MAX_ACTION_VALUE_BYTES).is_err());
        assert!(
            runtime_evaluate_value(r#"{"result":{"type":"undefined"}}"#, MAX_ACTION_VALUE_BYTES)
                .is_err()
        );
    }

    #[test]
    fn runtime_response_parser_enforces_raw_and_result_limits() {
        assert!(
            runtime_evaluate_value(
                &"x".repeat(MAX_RUNTIME_RESPONSE_BYTES + 1),
                MAX_SNAPSHOT_VALUE_BYTES,
            )
            .is_err()
        );
        let oversized = serde_json::json!({
            "result": { "value": "x".repeat(MAX_SNAPSHOT_VALUE_BYTES) }
        })
        .to_string();
        assert!(runtime_evaluate_value(&oversized, MAX_SNAPSHOT_VALUE_BYTES).is_err());
    }
}
