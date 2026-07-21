use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    env,
    io::{self, BufRead, Read, Write},
    net::{Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, EventTarget, State, Webview};
use uuid::Uuid;

pub(crate) const BROWSER_MCP_ARGUMENT: &str = "--browser-mcp";
pub(crate) const BROWSER_BRIDGE_ADDRESS_ENV: &str = "IHATECODING_BROWSER_BRIDGE_ADDR";
pub(crate) const BROWSER_ROUTE_TOKEN_ENV: &str = "IHATECODING_BROWSER_ROUTE_TOKEN";
pub(crate) const AGENT_BROWSER_COMMAND_EVENT: &str = "agent-browser-command";

const MAIN_WEBVIEW_LABEL: &str = "main";
const MAX_ROUTES: usize = 2_048;
const MAX_ACTIVE_CONNECTIONS: usize = 32;
const MAX_REQUEST_BYTES: usize = 256 * 1024;
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const MAX_MCP_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_ID_BYTES: usize = 128;
const MAX_PROJECT_ID_BYTES: usize = 512;
const MAX_TERMINAL_ID_BYTES: usize = 512;
const MAX_ERROR_BYTES: usize = 4 * 1024;
const BRIDGE_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
const BRIDGE_IO_TIMEOUT: Duration = Duration::from_secs(35);

const SUPPORTED_TOOLS: [&str; 7] = [
    "browser_list",
    "browser_open",
    "browser_navigate",
    "browser_screenshot",
    "browser_snapshot",
    "browser_click",
    "browser_type",
];

#[derive(Clone)]
pub(crate) struct AgentBrowserBridge {
    inner: Arc<BridgeInner>,
}

struct BridgeInner {
    address: SocketAddr,
    listener: Mutex<Option<TcpListener>>,
    app: Mutex<Option<AppHandle>>,
    routes: Mutex<RouteRegistry>,
    pending: Mutex<HashMap<String, mpsc::SyncSender<AgentBrowserCompletion>>>,
    started: AtomicBool,
    shutdown: AtomicBool,
    active_connections: AtomicUsize,
}

#[derive(Default)]
struct RouteRegistry {
    by_token: HashMap<String, BrowserRoute>,
    by_terminal: HashMap<(String, String), String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct BrowserRoute {
    project_id: String,
    terminal_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentBrowserCommand {
    pub(crate) id: String,
    pub(crate) method: String,
    pub(crate) params: Value,
    pub(crate) project_id: String,
    pub(crate) terminal_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BridgeWireRequest {
    route_token: String,
    id: String,
    method: String,
    #[serde(default = "empty_object")]
    params: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentBrowserCompletion {
    pub(crate) id: String,
    pub(crate) ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeWireResponse {
    id: String,
    ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl AgentBrowserBridge {
    /// Bind this before Tauri starts worker threads. The address is inherited by
    /// terminals; each terminal must additionally receive a token from
    /// `issue_route` in `IHATECODING_BROWSER_ROUTE_TOKEN`.
    pub(crate) fn bind() -> Result<Self, String> {
        Self::bind_inner(true)
    }

    fn bind_inner(export_address: bool) -> Result<Self, String> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .map_err(|error| format!("Could not bind the browser agent bridge: {error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("Could not configure the browser agent bridge: {error}"))?;
        let address = listener
            .local_addr()
            .map_err(|error| format!("Could not read the browser agent bridge address: {error}"))?;
        if address.ip() != Ipv4Addr::LOCALHOST {
            return Err("The browser agent bridge did not bind to IPv4 loopback.".to_owned());
        }
        if export_address {
            // SAFETY: `bind` is required to run before Tauri or PTY worker
            // threads are created. The value is immutable for this process.
            unsafe { env::set_var(BROWSER_BRIDGE_ADDRESS_ENV, address.to_string()) };
        }
        Ok(Self {
            inner: Arc::new(BridgeInner {
                address,
                listener: Mutex::new(Some(listener)),
                app: Mutex::new(None),
                routes: Mutex::new(RouteRegistry::default()),
                pending: Mutex::new(HashMap::new()),
                started: AtomicBool::new(false),
                shutdown: AtomicBool::new(false),
                active_connections: AtomicUsize::new(0),
            }),
        })
    }

    pub(crate) fn issue_route(
        &self,
        project_id: &str,
        terminal_id: &str,
    ) -> Result<String, String> {
        let project_id = validate_route_component(
            project_id,
            MAX_PROJECT_ID_BYTES,
            "The browser route project identifier is invalid.",
        )?;
        let terminal_id = validate_route_component(
            terminal_id,
            MAX_TERMINAL_ID_BYTES,
            "The browser route terminal identifier is invalid.",
        )?;
        let mut routes = self
            .inner
            .routes
            .lock()
            .map_err(|_| "The browser route registry is unavailable.".to_owned())?;
        let key = (project_id.clone(), terminal_id.clone());
        if let Some(token) = routes.by_terminal.get(&key) {
            return Ok(token.clone());
        }
        if routes.by_token.len() >= MAX_ROUTES {
            return Err("The browser route registry is full.".to_owned());
        }
        let token = unique_route_token(&routes.by_token);
        routes.by_token.insert(
            token.clone(),
            BrowserRoute {
                project_id,
                terminal_id,
            },
        );
        routes.by_terminal.insert(key, token.clone());
        Ok(token)
    }

    pub(crate) fn start(&self, app: AppHandle) -> Result<(), String> {
        self.inner
            .started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "The browser agent bridge has already started.".to_owned())?;
        if self.inner.shutdown.load(Ordering::Acquire) {
            return Err("The browser agent bridge has already shut down.".to_owned());
        }
        *self.inner.app.lock().map_err(|_| {
            "The browser agent bridge application state is unavailable.".to_owned()
        })? = Some(app);
        let listener = self
            .inner
            .listener
            .lock()
            .map_err(|_| "The browser agent bridge listener is unavailable.".to_owned())?
            .take()
            .ok_or_else(|| "The browser agent bridge listener is unavailable.".to_owned())?;
        let bridge = self.clone();
        thread::Builder::new()
            .name("ihc-browser-bridge".to_owned())
            .spawn(move || bridge.accept_loop(listener))
            .map_err(|error| format!("Could not start the browser agent bridge: {error}"))?;
        Ok(())
    }

    pub(crate) fn complete(&self, completion: AgentBrowserCompletion) -> Result<(), String> {
        validate_completion(&completion)?;
        let sender = self
            .inner
            .pending
            .lock()
            .map_err(|_| "The browser command response registry is unavailable.".to_owned())?
            .remove(&completion.id)
            .ok_or_else(|| "The browser command is no longer pending.".to_owned())?;
        sender
            .send(completion)
            .map_err(|_| "The browser command requester is no longer available.".to_owned())
    }

    pub(crate) fn shutdown(&self) {
        if self.inner.shutdown.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Ok(mut listener) = self.inner.listener.lock() {
            listener.take();
        }
        if let Ok(mut pending) = self.inner.pending.lock() {
            for (id, sender) in pending.drain() {
                let _ = sender.send(AgentBrowserCompletion {
                    id,
                    ok: false,
                    result: None,
                    error: Some("IHATECODING is shutting down.".to_owned()),
                });
            }
        }
        let _ = TcpStream::connect_timeout(&self.inner.address, Duration::from_millis(100));
    }

    fn accept_loop(&self, listener: TcpListener) {
        while !self.inner.shutdown.load(Ordering::Acquire) {
            match listener.accept() {
                Ok((stream, peer)) => {
                    if peer.ip() != Ipv4Addr::LOCALHOST {
                        let _ = stream.shutdown(Shutdown::Both);
                        continue;
                    }
                    if self.inner.active_connections.fetch_add(1, Ordering::AcqRel)
                        >= MAX_ACTIVE_CONNECTIONS
                    {
                        self.inner.active_connections.fetch_sub(1, Ordering::AcqRel);
                        let _ = stream.shutdown(Shutdown::Both);
                        continue;
                    }
                    let bridge = self.clone();
                    if thread::Builder::new()
                        .name("ihc-browser-request".to_owned())
                        .spawn(move || {
                            bridge.handle_connection(stream);
                            bridge
                                .inner
                                .active_connections
                                .fetch_sub(1, Ordering::AcqRel);
                        })
                        .is_err()
                    {
                        self.inner.active_connections.fetch_sub(1, Ordering::AcqRel);
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(20));
                }
                Err(_) if self.inner.shutdown.load(Ordering::Acquire) => break,
                Err(error) => {
                    eprintln!("browser agent bridge accept failed: {error}");
                    thread::sleep(Duration::from_millis(100));
                }
            }
        }
    }

    fn handle_connection(&self, mut stream: TcpStream) {
        let _ = stream.set_read_timeout(Some(BRIDGE_IO_TIMEOUT));
        let _ = stream.set_write_timeout(Some(BRIDGE_IO_TIMEOUT));
        let response = self
            .process_connection(&mut stream)
            .unwrap_or_else(|error| BridgeWireResponse {
                id: String::new(),
                ok: false,
                result: None,
                error: Some(error),
            });
        let _ = write_json_line(&mut stream, &response, MAX_RESPONSE_BYTES);
        let _ = stream.shutdown(Shutdown::Both);
    }

    fn process_connection(&self, stream: &mut TcpStream) -> Result<BridgeWireResponse, String> {
        let raw = read_bounded_line(stream, MAX_REQUEST_BYTES)
            .map_err(|error| format!("The browser bridge request could not be read: {error}"))?;
        let wire: BridgeWireRequest = serde_json::from_slice(&raw)
            .map_err(|_| "The browser bridge request is invalid.".to_owned())?;
        let (command, receiver) = self.prepare_command(wire)?;
        let id = command.id.clone();
        let app = self
            .inner
            .app
            .lock()
            .map_err(|_| "The browser agent bridge application state is unavailable.".to_owned())?
            .clone()
            .ok_or_else(|| "The IHATECODING browser bridge is not ready.".to_owned())?;
        if let Err(error) = app.emit_to(
            EventTarget::webview(MAIN_WEBVIEW_LABEL),
            AGENT_BROWSER_COMMAND_EVENT,
            &command,
        ) {
            self.remove_pending(&id);
            return Err(format!("Could not dispatch the browser command: {error}"));
        }
        let completion = match receiver.recv_timeout(BRIDGE_RESPONSE_TIMEOUT) {
            Ok(completion) => completion,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.remove_pending(&id);
                return Err("The browser command timed out after 30 seconds.".to_owned());
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                self.remove_pending(&id);
                return Err("The browser command was cancelled.".to_owned());
            }
        };
        Ok(BridgeWireResponse {
            id: completion.id,
            ok: completion.ok,
            result: completion.result,
            error: completion.error,
        })
    }

    fn prepare_command(
        &self,
        wire: BridgeWireRequest,
    ) -> Result<(AgentBrowserCommand, mpsc::Receiver<AgentBrowserCompletion>), String> {
        validate_wire_request(&wire)?;
        let route = self
            .inner
            .routes
            .lock()
            .map_err(|_| "The browser route registry is unavailable.".to_owned())?
            .by_token
            .get(&wire.route_token)
            .cloned()
            .ok_or_else(|| "The browser route is invalid.".to_owned())?;
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut pending = self
            .inner
            .pending
            .lock()
            .map_err(|_| "The browser command response registry is unavailable.".to_owned())?;
        if pending.contains_key(&wire.id) {
            return Err("The browser command identifier is already pending.".to_owned());
        }
        pending.insert(wire.id.clone(), sender);
        Ok((
            AgentBrowserCommand {
                id: wire.id,
                method: browser_event_method(&wire.method)?.to_owned(),
                params: wire.params,
                project_id: route.project_id,
                terminal_id: route.terminal_id,
            },
            receiver,
        ))
    }

    fn remove_pending(&self, id: &str) {
        if let Ok(mut pending) = self.inner.pending.lock() {
            pending.remove(id);
        }
    }
}

#[tauri::command]
pub(crate) fn complete_agent_browser_command(
    webview: Webview,
    bridge: State<'_, AgentBrowserBridge>,
    response: AgentBrowserCompletion,
) -> Result<(), String> {
    ensure_main_webview(&webview)?;
    bridge.complete(response)
}

pub fn run_browser_mcp_if_requested() -> Option<i32> {
    if env::args_os().nth(1).as_deref() != Some(std::ffi::OsStr::new(BROWSER_MCP_ARGUMENT)) {
        return None;
    }
    let stdin = io::stdin();
    let stdout = io::stdout();
    let transport = TcpBrowserTransport::from_environment();
    let result = serve_mcp(stdin.lock(), stdout.lock(), &transport);
    if let Err(error) = result {
        eprintln!("IHATECODING browser MCP stopped: {error}");
        Some(1)
    } else {
        Some(0)
    }
}

trait BrowserTransport {
    fn call(&self, method: &str, params: Value) -> Result<Value, String>;
}

struct TcpBrowserTransport {
    configuration: Result<(SocketAddr, String), String>,
}

impl TcpBrowserTransport {
    fn from_environment() -> Self {
        Self {
            configuration: read_transport_environment(),
        }
    }
}

impl BrowserTransport for TcpBrowserTransport {
    fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let (address, route_token) = self.configuration.as_ref().map_err(Clone::clone)?;
        let id = random_token();
        let request = BridgeWireRequest {
            route_token: route_token.clone(),
            id: id.clone(),
            method: method.to_owned(),
            params,
        };
        validate_wire_request(&request)?;
        let mut stream = TcpStream::connect_timeout(address, Duration::from_secs(2))
            .map_err(|error| format!("Could not connect to IHATECODING: {error}"))?;
        stream
            .set_read_timeout(Some(BRIDGE_IO_TIMEOUT))
            .map_err(|error| format!("Could not configure the browser bridge client: {error}"))?;
        stream
            .set_write_timeout(Some(BRIDGE_IO_TIMEOUT))
            .map_err(|error| format!("Could not configure the browser bridge client: {error}"))?;
        write_json_line(&mut stream, &request, MAX_REQUEST_BYTES)
            .map_err(|error| format!("Could not send the browser command: {error}"))?;
        let _ = stream.shutdown(Shutdown::Write);
        let raw = read_bounded_line(&mut stream, MAX_RESPONSE_BYTES)
            .map_err(|error| format!("Could not read the browser command response: {error}"))?;
        let response: BridgeWireResponse = serde_json::from_slice(&raw)
            .map_err(|_| "IHATECODING returned an invalid browser response.".to_owned())?;
        if response.id != id && !response.id.is_empty() {
            return Err("IHATECODING returned a mismatched browser response.".to_owned());
        }
        if response.ok {
            Ok(response.result.unwrap_or(Value::Null))
        } else {
            Err(response
                .error
                .unwrap_or_else(|| "The browser command failed.".to_owned()))
        }
    }
}

fn serve_mcp<R: BufRead, W: Write, T: BrowserTransport>(
    mut reader: R,
    mut writer: W,
    transport: &T,
) -> Result<(), String> {
    loop {
        let Some(raw) = read_bounded_buf_line(&mut reader, MAX_MCP_MESSAGE_BYTES)
            .map_err(|error| format!("Could not read MCP input: {error}"))?
        else {
            return Ok(());
        };
        if raw.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let request: Value = match serde_json::from_slice::<Value>(&raw) {
            Ok(value) if value.is_object() => value,
            _ => {
                write_mcp_response(
                    &mut writer,
                    json_rpc_error(Value::Null, -32700, "Parse error"),
                )?;
                continue;
            }
        };
        let id = request.get("id").cloned();
        let method = request.get("method").and_then(Value::as_str);
        let response = match method {
            Some("initialize") => id.clone().map(|id| {
                json_rpc_result(
                    id,
                    json!({
                        "protocolVersion": "2025-03-26",
                        "capabilities": { "tools": {} },
                        "serverInfo": { "name": "ihatecoding-browser", "version": "1.0.0" }
                    }),
                )
            }),
            Some("notifications/initialized") | Some("notifications/cancelled") => None,
            Some("ping") => id.clone().map(|id| json_rpc_result(id, json!({}))),
            Some("tools/list") => id
                .clone()
                .map(|id| json_rpc_result(id, json!({ "tools": mcp_tools() }))),
            Some("tools/call") => id.clone().map(|id| {
                let result = handle_mcp_tool_call(request.get("params"), transport);
                json_rpc_result(id, result)
            }),
            Some(_) => id
                .clone()
                .map(|id| json_rpc_error(id, -32601, "Method not found")),
            None => id
                .clone()
                .map(|id| json_rpc_error(id, -32600, "Invalid Request")),
        };
        if let Some(response) = response {
            write_mcp_response(&mut writer, response)?;
        }
    }
}

fn handle_mcp_tool_call<T: BrowserTransport>(params: Option<&Value>, transport: &T) -> Value {
    let Some(params) = params.and_then(Value::as_object) else {
        return mcp_tool_error("The tool call parameters are invalid.");
    };
    let Some(name) = params.get("name").and_then(Value::as_str) else {
        return mcp_tool_error("The tool name is missing.");
    };
    if !SUPPORTED_TOOLS.contains(&name) {
        return mcp_tool_error("The requested browser tool is not supported.");
    }
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(empty_object);
    if !arguments.is_object() {
        return mcp_tool_error("The browser tool arguments must be an object.");
    }
    if serde_json::to_vec(&arguments).map_or(true, |bytes| bytes.len() > MAX_REQUEST_BYTES) {
        return mcp_tool_error("The browser tool arguments are too large.");
    }
    match transport.call(name, arguments) {
        Ok(result) => mcp_tool_success(result),
        Err(error) => mcp_tool_error(&truncate(&error, MAX_ERROR_BYTES)),
    }
}

fn mcp_tool_success(mut result: Value) -> Value {
    let mut content = Vec::<Value>::new();
    if let Some(data_url) = result
        .as_object_mut()
        .and_then(|object| object.remove("dataUrl"))
        .and_then(|value| value.as_str().map(str::to_owned))
    {
        if let Some((mime_type, data)) = parse_image_data_url(&data_url) {
            content.push(json!({ "type": "image", "data": data, "mimeType": mime_type }));
        } else {
            return mcp_tool_error("IHATECODING returned an invalid screenshot.");
        }
    }
    let include_text = match &result {
        Value::Null => content.is_empty(),
        Value::Object(object) => !object.is_empty(),
        _ => true,
    };
    if include_text {
        let text = serde_json::to_string_pretty(&result).unwrap_or_else(|_| "null".to_owned());
        content.push(json!({ "type": "text", "text": text }));
    }
    json!({ "content": content, "isError": false })
}

fn mcp_tool_error(message: &str) -> Value {
    json!({
        "content": [{ "type": "text", "text": message }],
        "isError": true
    })
}

fn mcp_tools() -> Vec<Value> {
    vec![
        tool(
            "browser_list",
            "List browser panes in this terminal's project.",
            json!({
                "type": "object", "properties": {}, "additionalProperties": false
            }),
        ),
        tool(
            "browser_open",
            "Open an IHATECODING browser pane.",
            json!({
                "type": "object", "properties": { "url": { "type": "string" } },
                "required": ["url"], "additionalProperties": false
            }),
        ),
        tool(
            "browser_navigate",
            "Navigate an IHATECODING browser pane.",
            json!({
                "type": "object", "properties": {
                    "paneId": { "type": "string" }, "url": { "type": "string" }
                }, "required": ["paneId", "url"], "additionalProperties": false
            }),
        ),
        tool(
            "browser_screenshot",
            "Capture the visible IHATECODING browser pane.",
            json!({
                "type": "object", "properties": { "paneId": { "type": "string" } },
                "required": ["paneId"], "additionalProperties": false
            }),
        ),
        tool(
            "browser_snapshot",
            "Read a bounded semantic snapshot from an IHATECODING browser pane.",
            json!({
                "type": "object", "properties": { "paneId": { "type": "string" } },
                "required": ["paneId"], "additionalProperties": false
            }),
        ),
        tool(
            "browser_click",
            "Click an element in an IHATECODING browser pane.",
            json!({
                "type": "object", "properties": {
                    "paneId": { "type": "string" }, "selector": { "type": "string" }
                }, "required": ["paneId", "selector"], "additionalProperties": false
            }),
        ),
        tool(
            "browser_type",
            "Type into an IHATECODING browser pane.",
            json!({
                "type": "object", "properties": {
                    "paneId": { "type": "string" }, "selector": { "type": "string" },
                    "text": { "type": "string" }
                }, "required": ["paneId", "selector", "text"], "additionalProperties": false
            }),
        ),
    ]
}

fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({ "name": name, "description": description, "inputSchema": input_schema })
}

fn read_transport_environment() -> Result<(SocketAddr, String), String> {
    let address = env::var(BROWSER_BRIDGE_ADDRESS_ENV)
        .map_err(|_| "IHATECODING browser bridge address is not available.".to_owned())?
        .parse::<SocketAddr>()
        .map_err(|_| "IHATECODING browser bridge address is invalid.".to_owned())?;
    if address.ip() != Ipv4Addr::LOCALHOST || address.port() == 0 {
        return Err("IHATECODING browser bridge must use IPv4 loopback.".to_owned());
    }
    let route_token = env::var(BROWSER_ROUTE_TOKEN_ENV)
        .map_err(|_| "This terminal has no IHATECODING browser route.".to_owned())?;
    validate_token(&route_token)?;
    Ok((address, route_token))
}

fn validate_wire_request(request: &BridgeWireRequest) -> Result<(), String> {
    validate_token(&request.route_token)?;
    validate_request_id(&request.id)?;
    if !SUPPORTED_TOOLS.contains(&request.method.as_str()) {
        return Err("The browser command method is not supported.".to_owned());
    }
    if !request.params.is_object() {
        return Err("The browser command parameters must be an object.".to_owned());
    }
    let size = serde_json::to_vec(&request.params)
        .map_err(|_| "The browser command parameters are invalid.".to_owned())?
        .len();
    if size > MAX_REQUEST_BYTES {
        return Err("The browser command parameters are too large.".to_owned());
    }
    Ok(())
}

fn browser_event_method(method: &str) -> Result<&'static str, String> {
    match method {
        "browser_list" => Ok("list"),
        "browser_open" => Ok("open"),
        "browser_navigate" => Ok("navigate"),
        "browser_screenshot" => Ok("screenshot"),
        "browser_snapshot" => Ok("snapshot"),
        "browser_click" => Ok("click"),
        "browser_type" => Ok("type"),
        _ => Err("The browser command method is not supported.".to_owned()),
    }
}

fn validate_completion(response: &AgentBrowserCompletion) -> Result<(), String> {
    validate_request_id(&response.id)?;
    if response.ok {
        if response.error.is_some() {
            return Err("A successful browser response cannot contain an error.".to_owned());
        }
    } else {
        let error = response
            .error
            .as_deref()
            .ok_or_else(|| "A failed browser response must contain an error.".to_owned())?;
        if error.is_empty() || error.len() > MAX_ERROR_BYTES || error.chars().any(char::is_control)
        {
            return Err("The browser response error is invalid.".to_owned());
        }
        if response.result.is_some() {
            return Err("A failed browser response cannot contain a result.".to_owned());
        }
    }
    if serde_json::to_vec(&response.result)
        .map_err(|_| "The browser response is invalid.".to_owned())?
        .len()
        > MAX_RESPONSE_BYTES
    {
        return Err("The browser response is too large.".to_owned());
    }
    Ok(())
}

fn validate_request_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > MAX_ID_BYTES
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err("The browser command identifier is invalid.".to_owned());
    }
    Ok(())
}

fn validate_token(token: &str) -> Result<(), String> {
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("The browser route token is invalid.".to_owned());
    }
    Ok(())
}

fn validate_route_component(value: &str, maximum: usize, message: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > maximum
        || value.chars().any(|character| character.is_control())
    {
        return Err(message.to_owned());
    }
    Ok(value.to_owned())
}

fn unique_route_token(existing: &HashMap<String, BrowserRoute>) -> String {
    loop {
        let token = random_token();
        if !existing.contains_key(&token) {
            return token;
        }
    }
}

fn random_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn empty_object() -> Value {
    json!({})
}

fn ensure_main_webview(webview: &Webview) -> Result<(), String> {
    if webview.label() == MAIN_WEBVIEW_LABEL {
        Ok(())
    } else {
        Err("This browser command is available only to the local main view.".to_owned())
    }
}

fn read_bounded_line<R: Read>(reader: &mut R, maximum: usize) -> io::Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut byte = [0_u8; 1];
    loop {
        match reader.read(&mut byte) {
            Ok(0) if output.is_empty() => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "empty request",
                ));
            }
            Ok(0) => break,
            Ok(_) if byte[0] == b'\n' => break,
            Ok(_) => {
                output.push(byte[0]);
                if output.len() > maximum {
                    return Err(io::Error::new(io::ErrorKind::InvalidData, "line too large"));
                }
            }
            Err(error) => return Err(error),
        }
    }
    while matches!(output.last(), Some(b'\r')) {
        output.pop();
    }
    Ok(output)
}

fn read_bounded_buf_line<R: BufRead>(
    reader: &mut R,
    maximum: usize,
) -> io::Result<Option<Vec<u8>>> {
    let mut output = Vec::new();
    let read = reader
        .take((maximum + 2) as u64)
        .read_until(b'\n', &mut output)?;
    if read == 0 {
        return Ok(None);
    }
    if output.len() > maximum + 1 || (output.len() == maximum + 1 && output.last() != Some(&b'\n'))
    {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "line too large"));
    }
    if output.last() == Some(&b'\n') {
        output.pop();
    }
    if output.last() == Some(&b'\r') {
        output.pop();
    }
    Ok(Some(output))
}

fn write_json_line<W: Write, T: Serialize>(
    writer: &mut W,
    value: &T,
    maximum: usize,
) -> io::Result<()> {
    let bytes = serde_json::to_vec(value)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid JSON response"))?;
    if bytes.len() > maximum {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "JSON response too large",
        ));
    }
    writer.write_all(&bytes)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn write_mcp_response<W: Write>(writer: &mut W, value: Value) -> Result<(), String> {
    write_json_line(writer, &value, MAX_RESPONSE_BYTES)
        .map_err(|error| format!("Could not write MCP output: {error}"))
}

fn json_rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn json_rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
}

fn parse_image_data_url(value: &str) -> Option<(&'static str, &str)> {
    let (mime_type, data) = if let Some(data) = value.strip_prefix("data:image/png;base64,") {
        ("image/png", data)
    } else if let Some(data) = value.strip_prefix("data:image/jpeg;base64,") {
        ("image/jpeg", data)
    } else {
        let data = value.strip_prefix("data:image/webp;base64,")?;
        ("image/webp", data)
    };
    if data.is_empty()
        || data.len() > MAX_RESPONSE_BYTES
        || !data
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
    {
        return None;
    }
    Some((mime_type, data))
}

fn truncate(value: &str, maximum: usize) -> String {
    if value.len() <= maximum {
        return value.to_owned();
    }
    let mut boundary = maximum;
    while !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    value[..boundary].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[derive(Default)]
    struct FakeTransport {
        calls: Mutex<Vec<(String, Value)>>,
        result: Mutex<Option<Result<Value, String>>>,
    }

    impl BrowserTransport for FakeTransport {
        fn call(&self, method: &str, params: Value) -> Result<Value, String> {
            self.calls.lock().unwrap().push((method.to_owned(), params));
            self.result
                .lock()
                .unwrap()
                .take()
                .unwrap_or_else(|| Ok(json!({ "ok": true })))
        }
    }

    #[test]
    fn route_tokens_are_long_random_hex_values_and_reused_per_terminal() {
        let bridge = AgentBrowserBridge::bind_inner(false).unwrap();
        let first = bridge.issue_route("project-a", "terminal-a").unwrap();
        let repeated = bridge.issue_route("project-a", "terminal-a").unwrap();
        let second = bridge.issue_route("project-a", "terminal-b").unwrap();
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_eq!(first, repeated);
        assert_ne!(first, second);
    }

    #[test]
    fn route_token_derives_project_and_forbids_client_project_id() {
        let bridge = AgentBrowserBridge::bind_inner(false).unwrap();
        let token = bridge.issue_route("project-a", "terminal-a").unwrap();
        let wire: BridgeWireRequest = serde_json::from_value(json!({
            "routeToken": token,
            "id": "request-1",
            "method": "browser_list",
            "params": {}
        }))
        .unwrap();
        let (command, _receiver) = bridge.prepare_command(wire).unwrap();
        assert_eq!(command.project_id, "project-a");
        assert_eq!(command.terminal_id, "terminal-a");
        assert_eq!(command.method, "list");

        let supplied_project = serde_json::from_value::<BridgeWireRequest>(json!({
            "routeToken": random_token(),
            "id": "request-2",
            "method": "browser_list",
            "params": {},
            "projectId": "other-project"
        }));
        assert!(supplied_project.is_err());
    }

    #[test]
    fn request_validation_rejects_unknown_methods_and_non_object_params() {
        let token = random_token();
        let unknown = BridgeWireRequest {
            route_token: token.clone(),
            id: "request-1".to_owned(),
            method: "shell".to_owned(),
            params: json!({}),
        };
        assert!(validate_wire_request(&unknown).is_err());
        let array = BridgeWireRequest {
            route_token: token,
            id: "request-2".to_owned(),
            method: "browser_list".to_owned(),
            params: json!([]),
        };
        assert!(validate_wire_request(&array).is_err());
    }

    #[test]
    fn completion_contract_is_strict_and_bounded() {
        assert!(
            validate_completion(&AgentBrowserCompletion {
                id: "request-1".to_owned(),
                ok: true,
                result: Some(json!({ "panes": [] })),
                error: None,
            })
            .is_ok()
        );
        assert!(
            validate_completion(&AgentBrowserCompletion {
                id: "request-1".to_owned(),
                ok: false,
                result: None,
                error: None,
            })
            .is_err()
        );
        assert!(
            validate_completion(&AgentBrowserCompletion {
                id: "request-1".to_owned(),
                ok: true,
                result: None,
                error: Some("no".to_owned()),
            })
            .is_err()
        );
    }

    #[test]
    fn mcp_initialize_list_ping_and_eof_are_supported() {
        let input = concat!(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/list\"}"
        );
        let mut output = Vec::new();
        serve_mcp(
            Cursor::new(input.as_bytes()),
            &mut output,
            &FakeTransport::default(),
        )
        .unwrap();
        let responses = String::from_utf8(output).unwrap();
        let lines = responses.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 3);
        assert!(lines[0].contains("ihatecoding-browser"));
        assert!(lines[1].contains("\"result\":{}"));
        assert!(lines[2].contains("browser_screenshot"));
    }

    #[test]
    fn mcp_tool_call_routes_arguments_without_project_override() {
        let input = "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\"params\":{\"name\":\"browser_navigate\",\"arguments\":{\"paneId\":\"web-1\",\"url\":\"http://localhost:3000\"}}}\n";
        let transport = FakeTransport::default();
        let mut output = Vec::new();
        serve_mcp(Cursor::new(input.as_bytes()), &mut output, &transport).unwrap();
        let calls = transport.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "browser_navigate");
        assert_eq!(calls[0].1["paneId"], "web-1");
        assert!(!calls[0].1.as_object().unwrap().contains_key("projectId"));
        assert!(
            String::from_utf8(output)
                .unwrap()
                .contains("\"isError\":false")
        );
    }

    #[test]
    fn screenshot_data_url_becomes_mcp_image_content() {
        let input = "{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"tools/call\",\"params\":{\"name\":\"browser_screenshot\",\"arguments\":{\"paneId\":\"web-1\"}}}\n";
        let transport = FakeTransport {
            calls: Mutex::new(Vec::new()),
            result: Mutex::new(Some(Ok(json!({
                "dataUrl": "data:image/png;base64,iVBORw0KGgo=",
                "url": "http://localhost/"
            })))),
        };
        let mut output = Vec::new();
        serve_mcp(Cursor::new(input.as_bytes()), &mut output, &transport).unwrap();
        let response: Value = serde_json::from_slice(output.strip_suffix(b"\n").unwrap()).unwrap();
        let content = response["result"]["content"].as_array().unwrap();
        assert_eq!(content[0]["type"], "image");
        assert_eq!(content[0]["mimeType"], "image/png");
        assert_eq!(content[1]["type"], "text");
        assert!(!content[1]["text"].as_str().unwrap().contains("dataUrl"));
    }

    #[test]
    fn oversized_lines_and_malformed_json_do_not_panic() {
        let mut cursor = Cursor::new(vec![b'x'; 32]);
        assert!(read_bounded_line(&mut cursor, 16).is_err());

        let input = b"not-json\n";
        let mut output = Vec::new();
        serve_mcp(Cursor::new(input), &mut output, &FakeTransport::default()).unwrap();
        assert!(String::from_utf8(output).unwrap().contains("-32700"));
    }
}
