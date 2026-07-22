use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    env, fs,
    fs::OpenOptions,
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

pub(crate) const HOOK_ARGUMENT: &str = "--agent-lifecycle-hook";
pub(crate) const ROUTE_ENV: &str = "IHATECODING_AGENT_LIFECYCLE_ROUTE";
pub(crate) const EXECUTABLE_ENV: &str = "IHATECODING_AGENT_LIFECYCLE_EXE";
pub(crate) const CLINE_HOOKS_DIR_ENV: &str = "IHATECODING_CLINE_HOOKS_DIR";
pub(crate) const CLAUDE_SETTINGS_ENV: &str = "IHATECODING_CLAUDE_SETTINGS";
pub(crate) const OPENCODE_CONFIG_CONTENT_ENV: &str = "OPENCODE_CONFIG_CONTENT";

const ROUTE_ROOT_NAME: &str = "ihatecoding-agent-lifecycle-v1";
const ASSET_DIRECTORY_NAME: &str = "assets";
const MAX_HOOK_INPUT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_EVENT_LINE_BYTES: usize = 16 * 1024;
const MAX_ROUTE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_PROVIDER_ID_BYTES: usize = 512;
const MAX_ASSET_BYTES: u64 = 512 * 1024;
const MAX_CURSOR_HOOK_BYTES: u64 = 512 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ProfileAgentProvider {
    Claude,
    Opencode,
    Cline,
    Cursor,
}

impl ProfileAgentProvider {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "claude" => Some(Self::Claude),
            "opencode" => Some(Self::Opencode),
            "cline" => Some(Self::Cline),
            "cursor" => Some(Self::Cursor),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ProfileLifecycleEvent {
    Started,
    Finished,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProfileLifecycleRecord {
    pub(crate) provider: ProfileAgentProvider,
    pub(crate) event: ProfileLifecycleEvent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) provider_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) turn_id: Option<String>,
    pub(crate) observed_at_unix_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) succeeded: Option<bool>,
}

#[derive(Clone, Debug)]
pub(crate) struct ProviderLifecycleLaunch {
    route: PathBuf,
    environment: Vec<(String, String)>,
}

impl ProviderLifecycleLaunch {
    pub(crate) fn route(&self) -> &Path {
        &self.route
    }

    pub(crate) fn environment(&self) -> impl Iterator<Item = (&str, &str)> {
        self.environment
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
    }
}

pub(crate) fn prepare_launch(
    runtime_session_id: &str,
    provider: ProfileAgentProvider,
) -> Result<ProviderLifecycleLaunch, String> {
    let route = route_path(runtime_session_id)?;
    remove_regular_file_if_present(&route)?;
    let executable = env::current_exe()
        .map_err(|error| format!("Could not locate the IHATECODING executable: {error}"))?;
    let assets = ensure_assets(&executable)?;
    let mut environment = vec![
        (ROUTE_ENV.to_owned(), path_text(&route)?),
        (EXECUTABLE_ENV.to_owned(), path_text(&executable)?),
    ];
    match provider {
        ProfileAgentProvider::Cline => environment.push((
            CLINE_HOOKS_DIR_ENV.to_owned(),
            path_text(&assets.cline_hooks_directory)?,
        )),
        ProfileAgentProvider::Claude => environment.push((
            CLAUDE_SETTINGS_ENV.to_owned(),
            path_text(&assets.claude_settings)?,
        )),
        ProfileAgentProvider::Opencode => environment.push((
            OPENCODE_CONFIG_CONTENT_ENV.to_owned(),
            opencode_config_content(&assets.opencode_plugin)?,
        )),
        ProfileAgentProvider::Cursor => ensure_cursor_hooks()?,
    }
    Ok(ProviderLifecycleLaunch { route, environment })
}

pub(crate) fn run_if_requested() -> Option<i32> {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    let marker = arguments
        .iter()
        .position(|argument| argument == HOOK_ARGUMENT)?;
    // Lifecycle reporting is passive. A malformed hook payload must never
    // prevent the provider from completing the user's turn.
    let _ = run_hook(&arguments[(marker + 1)..]);
    Some(0)
}

fn run_hook(arguments: &[String]) -> Result<(), String> {
    let provider = arguments
        .first()
        .and_then(|value| ProfileAgentProvider::parse(value))
        .ok_or_else(|| "The lifecycle hook provider is invalid.".to_owned())?;
    let hook_name = arguments
        .get(1)
        .map(String::as_str)
        .ok_or_else(|| "The lifecycle hook event is missing.".to_owned())?;
    let route = env::var_os(ROUTE_ENV)
        .map(PathBuf::from)
        .ok_or_else(|| "The lifecycle route is unavailable.".to_owned())?;
    let route = validate_route_path(&route)?;
    let mut payload = Vec::new();
    std::io::stdin()
        .lock()
        .take(MAX_HOOK_INPUT_BYTES + 1)
        .read_to_end(&mut payload)
        .map_err(|error| format!("Could not read the lifecycle hook payload: {error}"))?;
    if payload.len() as u64 > MAX_HOOK_INPUT_BYTES {
        return Err("The lifecycle hook payload is too large.".to_owned());
    }
    let record = normalize_hook(provider, hook_name, &payload, unix_time_millis())?;
    append_record(&route, &record)
}

fn normalize_hook(
    provider: ProfileAgentProvider,
    hook_name: &str,
    payload: &[u8],
    observed_at_unix_ms: u64,
) -> Result<ProfileLifecycleRecord, String> {
    let value = if payload.iter().all(u8::is_ascii_whitespace) {
        Value::Null
    } else {
        serde_json::from_slice::<Value>(payload)
            .map_err(|_| "The lifecycle hook payload is invalid.".to_owned())?
    };
    let (event, succeeded) = match (provider, hook_name) {
        (ProfileAgentProvider::Claude, "UserPromptSubmit")
        | (ProfileAgentProvider::Cline, "UserPromptSubmit") => {
            (ProfileLifecycleEvent::Started, None)
        }
        (ProfileAgentProvider::Claude, "Stop") | (ProfileAgentProvider::Cline, "TaskComplete") => {
            (ProfileLifecycleEvent::Finished, Some(true))
        }
        (ProfileAgentProvider::Claude, "StopFailure")
        | (ProfileAgentProvider::Cline, "TaskCancel")
        | (ProfileAgentProvider::Cline, "TaskError") => {
            (ProfileLifecycleEvent::Finished, Some(false))
        }
        (ProfileAgentProvider::Opencode, "started") => (ProfileLifecycleEvent::Started, None),
        (ProfileAgentProvider::Opencode, "finished") => {
            (ProfileLifecycleEvent::Finished, Some(true))
        }
        (ProfileAgentProvider::Opencode, "failed") => {
            (ProfileLifecycleEvent::Finished, Some(false))
        }
        (ProfileAgentProvider::Cursor, "beforeSubmitPrompt") => {
            (ProfileLifecycleEvent::Started, None)
        }
        (ProfileAgentProvider::Cursor, "stop") => {
            let status = first_string(&value, &["status"])
                .ok_or_else(|| "The Cursor stop hook status is missing.".to_owned())?;
            match status {
                "completed" => (ProfileLifecycleEvent::Finished, Some(true)),
                "aborted" | "error" => (ProfileLifecycleEvent::Finished, Some(false)),
                _ => return Err("The Cursor stop hook status is invalid.".to_owned()),
            }
        }
        _ => return Err("The lifecycle hook event is not tracked.".to_owned()),
    };
    let provider_session_id = first_string(
        &value,
        &[
            "session_id",
            "sessionId",
            "task_id",
            "taskId",
            "sessionID",
            "conversation_id",
            "conversationId",
        ],
    )
    .map(normalize_opaque_id)
    .transpose()?;
    let turn_id = first_string(&value, &["turn_id", "turnId", "message_id", "messageId"])
        .map(normalize_opaque_id)
        .transpose()?;
    Ok(ProfileLifecycleRecord {
        provider,
        event,
        provider_session_id,
        turn_id,
        observed_at_unix_ms,
        succeeded,
    })
}

fn first_string<'a>(value: &'a Value, names: &[&str]) -> Option<&'a str> {
    let object = value.as_object()?;
    names
        .iter()
        .find_map(|name| object.get(*name).and_then(Value::as_str))
}

fn normalize_opaque_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > MAX_PROVIDER_ID_BYTES
        || value.chars().any(|character| character.is_control())
    {
        return Err("The provider lifecycle identifier is invalid.".to_owned());
    }
    Ok(value.to_owned())
}

fn append_record(route: &Path, record: &ProfileLifecycleRecord) -> Result<(), String> {
    let route = validate_route_path(route)?;
    if let Ok(metadata) = fs::symlink_metadata(&route) {
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("The lifecycle route is not a regular file.".to_owned());
        }
        if metadata.len() > MAX_ROUTE_BYTES {
            return Err("The lifecycle route is full.".to_owned());
        }
    }
    let mut line = serde_json::to_vec(record)
        .map_err(|error| format!("Could not encode the lifecycle event: {error}"))?;
    line.push(b'\n');
    if line.len() > MAX_EVENT_LINE_BYTES {
        return Err("The lifecycle event is too large.".to_owned());
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&route)
        .map_err(|error| format!("Could not open the lifecycle route: {error}"))?;
    file.write_all(&line)
        .map_err(|error| format!("Could not append the lifecycle event: {error}"))?;
    file.flush()
        .map_err(|error| format!("Could not flush the lifecycle event: {error}"))
}

pub(crate) fn read_records(
    route: &Path,
    offset: &mut u64,
) -> Result<Vec<ProfileLifecycleRecord>, String> {
    let route = validate_route_path(route)?;
    let metadata = match fs::symlink_metadata(&route) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("Could not inspect the lifecycle route: {error}")),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("The lifecycle route is not a regular file.".to_owned());
    }
    if metadata.len() > MAX_ROUTE_BYTES {
        return Err("The lifecycle route is too large.".to_owned());
    }
    if *offset > metadata.len() {
        *offset = 0;
    }
    let mut file = fs::File::open(&route)
        .map_err(|error| format!("Could not open the lifecycle route: {error}"))?;
    file.seek(SeekFrom::Start(*offset))
        .map_err(|error| format!("Could not seek the lifecycle route: {error}"))?;
    let mut reader = BufReader::new(file);
    let mut records = Vec::new();
    loop {
        let mut line = Vec::new();
        let bytes = reader
            .read_until(b'\n', &mut line)
            .map_err(|error| format!("Could not read the lifecycle route: {error}"))?;
        if bytes == 0 {
            break;
        }
        if line.last() != Some(&b'\n') {
            break;
        }
        *offset = offset.saturating_add(bytes as u64);
        if line.len() > MAX_EVENT_LINE_BYTES {
            continue;
        }
        line.pop();
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        if let Ok(record) = serde_json::from_slice::<ProfileLifecycleRecord>(&line) {
            records.push(record);
        }
    }
    Ok(records)
}

pub(crate) fn route_path(runtime_session_id: &str) -> Result<PathBuf, String> {
    validate_runtime_session_id(runtime_session_id)?;
    let root = ensure_owned_directory(&route_root(), "lifecycle route")?;
    Ok(root.join(format!("{runtime_session_id}.jsonl")))
}

pub(crate) fn remove_route(runtime_session_id: &str) {
    let Ok(route) = route_path(runtime_session_id) else {
        return;
    };
    let _ = remove_regular_file_if_present(&route);
}

fn validate_route_path(route: &Path) -> Result<PathBuf, String> {
    let file_name = route
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "The lifecycle route is invalid.".to_owned())?;
    let session_id = file_name
        .strip_suffix(".jsonl")
        .ok_or_else(|| "The lifecycle route is invalid.".to_owned())?;
    validate_runtime_session_id(session_id)?;
    let expected = route_path(session_id)?;
    if route != expected {
        return Err("The lifecycle route is outside the owned directory.".to_owned());
    }
    Ok(expected)
}

fn validate_runtime_session_id(value: &str) -> Result<(), String> {
    if value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("The runtime session identifier is invalid.".to_owned())
    }
}

fn route_root() -> PathBuf {
    env::temp_dir().join(ROUTE_ROOT_NAME)
}

#[derive(Debug)]
struct LifecycleAssets {
    // Cline documents --hooks-dir as the directory that directly owns the
    // event-named hook files. Cline 3.0.46 currently ignores the option, but
    // retain the documented flat layout as a future-compatible auxiliary path.
    cline_hooks_directory: PathBuf,
    claude_settings: PathBuf,
    opencode_plugin: PathBuf,
}

fn ensure_assets(executable: &Path) -> Result<LifecycleAssets, String> {
    ensure_assets_at(executable, &route_root().join(ASSET_DIRECTORY_NAME))
}

fn ensure_assets_at(executable: &Path, root: &Path) -> Result<LifecycleAssets, String> {
    let root = ensure_owned_directory(root, "lifecycle asset")?;
    let cline_hooks_directory =
        ensure_owned_directory(&root.join("cline-hooks"), "Cline lifecycle hook")?;
    for event in [
        "UserPromptSubmit",
        "TaskComplete",
        "TaskCancel",
        "TaskError",
    ] {
        let target = cline_hooks_directory.join(format!("{event}.ps1"));
        write_owned_file(&target, cline_hook_script(event).as_bytes())?;
    }
    let claude_settings = root.join("claude-settings.json");
    let settings = claude_settings_json(executable)?;
    let mut settings_bytes = serde_json::to_vec_pretty(&settings)
        .map_err(|error| format!("Could not encode Claude lifecycle settings: {error}"))?;
    settings_bytes.push(b'\n');
    write_owned_file(&claude_settings, &settings_bytes)?;

    let opencode_plugin = root.join("opencode-lifecycle.mjs");
    write_owned_file(&opencode_plugin, opencode_plugin_source().as_bytes())?;
    Ok(LifecycleAssets {
        cline_hooks_directory,
        claude_settings,
        opencode_plugin,
    })
}

fn cline_hook_script(event: &str) -> String {
    format!(
        "$ErrorActionPreference = 'SilentlyContinue'\ntry {{\n  $payload = [Console]::In.ReadToEnd()\n  if ($env:{EXECUTABLE_ENV}) {{ $payload | & $env:{EXECUTABLE_ENV} {HOOK_ARGUMENT} cline {event} | Out-Null }}\n}} catch {{}}\n[Console]::Out.Write('{{\"cancel\":false}}')\nexit 0\n"
    )
}

fn claude_settings_json(executable: &Path) -> Result<Value, String> {
    let executable = path_text(executable)?;
    if executable.contains('"') || executable.contains('\r') || executable.contains('\n') {
        return Err("The lifecycle executable path cannot be quoted safely.".to_owned());
    }
    let group = |event: &str| {
        json!([{
            "hooks": [{
                "type": "command",
                "command": format!("\"{executable}\" {HOOK_ARGUMENT} claude {event}"),
                "timeout": 5
            }]
        }])
    };
    Ok(json!({
        "hooks": {
            "UserPromptSubmit": group("UserPromptSubmit"),
            "Stop": group("Stop"),
            "StopFailure": group("StopFailure")
        }
    }))
}

fn ensure_cursor_hooks() -> Result<(), String> {
    let profile = env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| "Could not locate the Cursor configuration directory.".to_owned())?;
    ensure_cursor_hooks_at(&profile.join(".cursor").join("hooks.json"))
}

fn ensure_cursor_hooks_at(target: &Path) -> Result<(), String> {
    let existing = read_regular_file(target, MAX_CURSOR_HOOK_BYTES, "Cursor hooks")?;
    let mut root = match existing.as_deref() {
        Some(bytes) => serde_json::from_slice::<Value>(bytes)
            .map_err(|_| "The existing Cursor hook configuration is invalid.".to_owned())?,
        None => json!({ "version": 1, "hooks": {} }),
    };
    let object = root
        .as_object_mut()
        .ok_or_else(|| "The Cursor hook configuration root must be an object.".to_owned())?;
    object.entry("version").or_insert_with(|| json!(1));
    let hooks = object.entry("hooks").or_insert_with(|| json!({}));
    let hooks = hooks
        .as_object_mut()
        .ok_or_else(|| "The Cursor hooks value must be an object.".to_owned())?;
    for event in ["beforeSubmitPrompt", "stop"] {
        let handlers = hooks.entry(event).or_insert_with(|| json!([]));
        let handlers = handlers
            .as_array_mut()
            .ok_or_else(|| format!("The existing Cursor {event} hooks must be an array."))?;
        handlers.retain(|handler| !is_owned_cursor_hook(handler));
        handlers.push(json!({
            "command": cursor_hook_command(event)
        }));
    }
    let mut bytes = serde_json::to_vec_pretty(&root)
        .map_err(|error| format!("Could not encode the Cursor hook configuration: {error}"))?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_CURSOR_HOOK_BYTES {
        return Err("The updated Cursor hook configuration is too large.".to_owned());
    }
    write_owned_file(target, &bytes)
}

#[cfg(windows)]
fn cursor_hook_command(event: &str) -> String {
    // Cursor's hook file is global. Keep the owned entry inert for Cursor IDE
    // and other Cursor sessions: only a child of an IHATECODING terminal has
    // both route variables. Referring to the executable through the inherited
    // environment also leaves a harmless no-op instead of a stale install path.
    format!(
        "cmd.exe /d /s /c \"if defined {ROUTE_ENV} if defined {EXECUTABLE_ENV} \"\"%{EXECUTABLE_ENV}%\"\" {HOOK_ARGUMENT} cursor {event}\""
    )
}

#[cfg(not(windows))]
fn cursor_hook_command(event: &str) -> String {
    format!(
        "sh -c 'if [ -n \"${ROUTE_ENV}\" ] && [ -n \"${EXECUTABLE_ENV}\" ]; then \"${EXECUTABLE_ENV}\" {HOOK_ARGUMENT} cursor {event}; else cat >/dev/null; fi'"
    )
}

fn is_owned_cursor_hook(value: &Value) -> bool {
    value
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(|command| {
            command.contains(HOOK_ARGUMENT)
                && command
                    .split_ascii_whitespace()
                    .any(|component| component == "cursor")
        })
}

fn opencode_plugin_source() -> &'static str {
    r#"import { spawnSync } from "node:child_process";

const active = new Set();
const failed = new Set();

function report(kind, sessionID) {
  const executable = process.env.IHATECODING_AGENT_LIFECYCLE_EXE;
  if (!executable || !sessionID) return;
  spawnSync(executable, ["--agent-lifecycle-hook", "opencode", kind], {
    input: JSON.stringify({ sessionID }),
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
    stdio: ["pipe", "ignore", "ignore"],
  });
}

export default async function ihatecodingLifecycle() {
  return {
    event: async ({ event }) => {
      const properties = event?.properties ?? {};
      const sessionID = properties.sessionID;
      if (!sessionID) return;
      if (event.type === "session.status") {
        const status = properties.status?.type ?? properties.status;
        if ((status === "busy" || status === "retry") && !active.has(sessionID)) {
          active.add(sessionID);
          failed.delete(sessionID);
          report("started", sessionID);
          return;
        }
        if (status === "idle" && active.delete(sessionID)) {
          if (failed.delete(sessionID)) return;
          report("finished", sessionID);
        }
        return;
      }
      if (event.type === "session.error" && active.delete(sessionID)) {
        failed.add(sessionID);
        report("failed", sessionID);
      }
    },
  };
}
"#
}

fn opencode_config_content(plugin: &Path) -> Result<String, String> {
    let plugin_uri = file_uri(plugin)?;
    let mut root = match env::var(OPENCODE_CONFIG_CONTENT_ENV) {
        Ok(existing) if !existing.trim().is_empty() => serde_json::from_str::<Value>(&existing)
            .map_err(|_| {
                "Existing OPENCODE_CONFIG_CONTENT is not JSON; lifecycle integration was not applied."
                    .to_owned()
            })?,
        _ => json!({}),
    };
    let object = root.as_object_mut().ok_or_else(|| {
        "Existing OPENCODE_CONFIG_CONTENT must be an object; lifecycle integration was not applied."
            .to_owned()
    })?;
    let plugins = object.entry("plugin").or_insert_with(|| json!([]));
    let plugins = plugins.as_array_mut().ok_or_else(|| {
        "Existing OpenCode plugin configuration is invalid; lifecycle integration was not applied."
            .to_owned()
    })?;
    if !plugins
        .iter()
        .any(|value| value.as_str() == Some(&plugin_uri))
    {
        plugins.push(Value::String(plugin_uri));
    }
    serde_json::to_string(&root)
        .map_err(|error| format!("Could not encode OpenCode lifecycle configuration: {error}"))
}

fn file_uri(path: &Path) -> Result<String, String> {
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("Could not resolve the lifecycle plugin path: {error}"))?;
    let text = path_text(&canonical)?.replace('\\', "/");
    let mut encoded = String::with_capacity(text.len() + 16);
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b':' | b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    #[cfg(windows)]
    return Ok(format!("file:///{encoded}"));
    #[cfg(not(windows))]
    return Ok(format!("file://{encoded}"));
}

fn write_owned_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        ensure_owned_directory(parent, "lifecycle asset")?;
    }
    let existing = read_regular_file(path, MAX_ASSET_BYTES, "lifecycle asset")?;
    if existing.as_deref() == Some(bytes) {
        return Ok(());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "The lifecycle asset has no parent directory.".to_owned())?;
    let temporary = parent.join(format!(".ihc-lifecycle-{}.tmp", Uuid::new_v4().simple()));
    let mut guard = TemporaryFileGuard(temporary.clone());
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| format!("Could not create a temporary lifecycle asset: {error}"))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Could not write the lifecycle asset: {error}"))?;
    drop(file);
    if existing.is_some() {
        atomic_replace(&temporary, path, "lifecycle asset")?;
    } else if let Err(error) = atomic_create(&temporary, path, "lifecycle asset") {
        // Several restored panes can prepare the same immutable hook assets in
        // parallel on the first run. If another creator won the race with the
        // exact bytes we wanted, creation is already complete.
        let raced = read_regular_file(path, MAX_ASSET_BYTES, "lifecycle asset")?;
        if raced.as_deref() != Some(bytes) {
            return Err(error);
        }
    }
    guard.0.clear();
    Ok(())
}

struct TemporaryFileGuard(PathBuf);

impl Drop for TemporaryFileGuard {
    fn drop(&mut self) {
        if !self.0.as_os_str().is_empty() {
            let _ = fs::remove_file(&self.0);
        }
    }
}

fn atomic_create(source: &Path, destination: &Path, context: &str) -> Result<(), String> {
    fs::hard_link(source, destination)
        .map_err(|error| format!("Could not atomically create the {context}: {error}"))?;
    fs::remove_file(source)
        .map_err(|error| format!("Could not finish creating the {context}: {error}"))
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path, context: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: both buffers are owned, null-terminated paths for this call.
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(format!(
            "Could not atomically replace the {context}: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path, context: &str) -> Result<(), String> {
    fs::rename(source, destination)
        .map_err(|error| format!("Could not atomically replace the {context}: {error}"))
}

fn read_regular_file(path: &Path, limit: u64, context: &str) -> Result<Option<Vec<u8>>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not inspect the {context}: {error}")),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(format!("The {context} is not a regular file."));
    }
    if metadata.len() > limit {
        return Err(format!("The {context} is too large."));
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .and_then(|file| file.take(limit + 1).read_to_end(&mut bytes))
        .map_err(|error| format!("Could not read the {context}: {error}"))?;
    if bytes.len() as u64 > limit {
        return Err(format!("The {context} is too large."));
    }
    Ok(Some(bytes))
}

fn ensure_owned_directory(path: &Path, context: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("Could not create the {context} directory: {error}"))?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Could not inspect the {context} directory: {error}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(format!(
            "The {context} directory is not a regular directory."
        ));
    }
    fs::canonicalize(path)
        .map_err(|error| format!("Could not resolve the {context} directory: {error}"))
}

fn remove_regular_file_if_present(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err("The lifecycle route is not a regular file.".to_owned());
            }
            fs::remove_file(path)
                .map_err(|error| format!("Could not reset the lifecycle route: {error}"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    format!("Could not create the lifecycle route directory: {error}")
                })?;
            }
            Ok(())
        }
        Err(error) => Err(format!("Could not inspect the lifecycle route: {error}")),
    }
}

fn path_text(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "The lifecycle path is not valid UTF-8.".to_owned())
}

fn unix_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};
    use tempfile::TempDir;

    #[test]
    fn normalizes_exact_provider_events_and_opaque_ids() {
        let started = normalize_hook(
            ProfileAgentProvider::Claude,
            "UserPromptSubmit",
            br#"{"session_id":"claude-session","turn_id":"turn-1"}"#,
            42,
        )
        .unwrap();
        assert_eq!(started.event, ProfileLifecycleEvent::Started);
        assert_eq!(
            started.provider_session_id.as_deref(),
            Some("claude-session")
        );
        assert_eq!(started.turn_id.as_deref(), Some("turn-1"));
        assert_eq!(started.succeeded, None);

        let failed = normalize_hook(
            ProfileAgentProvider::Opencode,
            "failed",
            br#"{"sessionID":"open-session"}"#,
            43,
        )
        .unwrap();
        assert_eq!(failed.event, ProfileLifecycleEvent::Finished);
        assert_eq!(failed.succeeded, Some(false));
        assert!(normalize_hook(ProfileAgentProvider::Claude, "TaskComplete", b"{}", 44).is_err());
        let cline_error = normalize_hook(
            ProfileAgentProvider::Cline,
            "TaskError",
            br#"{"taskId":"cline-task"}"#,
            45,
        )
        .unwrap();
        assert_eq!(cline_error.succeeded, Some(false));
        let cursor_complete = normalize_hook(
            ProfileAgentProvider::Cursor,
            "stop",
            br#"{"conversation_id":"cursor-session","status":"completed"}"#,
            46,
        )
        .unwrap();
        assert_eq!(cursor_complete.succeeded, Some(true));
        assert_eq!(
            cursor_complete.provider_session_id.as_deref(),
            Some("cursor-session")
        );
        let cursor_error = normalize_hook(
            ProfileAgentProvider::Cursor,
            "stop",
            br#"{"conversation_id":"cursor-session","status":"error"}"#,
            47,
        )
        .unwrap();
        assert_eq!(cursor_error.succeeded, Some(false));
    }

    #[test]
    fn jsonl_reader_is_bounded_and_resumable() {
        let directory = TempDir::new().unwrap();
        let route = directory.path().join("records.jsonl");
        let records = [
            ProfileLifecycleRecord {
                provider: ProfileAgentProvider::Cline,
                event: ProfileLifecycleEvent::Started,
                provider_session_id: Some("task-a".to_owned()),
                turn_id: None,
                observed_at_unix_ms: 1,
                succeeded: None,
            },
            ProfileLifecycleRecord {
                provider: ProfileAgentProvider::Cline,
                event: ProfileLifecycleEvent::Finished,
                provider_session_id: Some("task-a".to_owned()),
                turn_id: None,
                observed_at_unix_ms: 2,
                succeeded: Some(true),
            },
        ];
        let mut bytes = Vec::new();
        for record in &records {
            serde_json::to_writer(&mut bytes, record).unwrap();
            bytes.push(b'\n');
        }
        fs::write(&route, bytes).unwrap();

        // read_records deliberately accepts only app-owned paths. Exercise the
        // streaming parser through a route in the owned root instead.
        let runtime_session_id = Uuid::new_v4().simple().to_string();
        let owned = route_path(&runtime_session_id).unwrap();
        fs::create_dir_all(owned.parent().unwrap()).unwrap();
        fs::copy(&route, &owned).unwrap();
        let mut offset = 0;
        assert_eq!(read_records(&owned, &mut offset).unwrap(), records);
        assert!(read_records(&owned, &mut offset).unwrap().is_empty());

        let partial = ProfileLifecycleRecord {
            provider: ProfileAgentProvider::Cline,
            event: ProfileLifecycleEvent::Started,
            provider_session_id: Some("partial-task".to_owned()),
            turn_id: None,
            observed_at_unix_ms: 3,
            succeeded: None,
        };
        let partial_bytes = serde_json::to_vec(&partial).unwrap();
        OpenOptions::new()
            .append(true)
            .open(&owned)
            .unwrap()
            .write_all(&partial_bytes)
            .unwrap();
        let before_partial = offset;
        assert!(read_records(&owned, &mut offset).unwrap().is_empty());
        assert_eq!(offset, before_partial, "an incomplete line must be retried");
        OpenOptions::new()
            .append(true)
            .open(&owned)
            .unwrap()
            .write_all(b"\n")
            .unwrap();
        assert_eq!(read_records(&owned, &mut offset).unwrap(), vec![partial]);
        remove_route(&runtime_session_id);
    }

    #[test]
    fn cursor_hook_merge_preserves_user_handlers_and_is_idempotent() {
        let directory = TempDir::new().unwrap();
        let target = directory.path().join("hooks.json");
        fs::write(
            &target,
            br#"{
  "version": 1,
  "hooks": {
    "beforeSubmitPrompt": [
      {"command":"user-before"},
      {"command":"\"C:\\Old\\IHATECODING.exe\" --agent-lifecycle-hook cursor beforeSubmitPrompt"}
    ],
    "stop": [{"command":"user-stop"}],
    "afterFileEdit": [{"command":"user-edit"}]
  }
}"#,
        )
        .unwrap();
        ensure_cursor_hooks_at(&target).unwrap();
        ensure_cursor_hooks_at(&target).unwrap();
        let root: Value = serde_json::from_slice(&fs::read(&target).unwrap()).unwrap();
        for event in ["beforeSubmitPrompt", "stop"] {
            let handlers = root["hooks"][event].as_array().unwrap();
            assert_eq!(handlers.len(), 2);
            assert!(handlers.iter().any(|handler| {
                handler["command"]
                    .as_str()
                    .is_some_and(|command| command.starts_with("user-"))
            }));
            assert_eq!(
                handlers
                    .iter()
                    .filter(|handler| is_owned_cursor_hook(handler))
                    .count(),
                1
            );
            let owned = handlers
                .iter()
                .find(|handler| is_owned_cursor_hook(handler))
                .and_then(|handler| handler["command"].as_str())
                .unwrap();
            assert!(owned.contains(ROUTE_ENV));
            assert!(owned.contains(EXECUTABLE_ENV));
            assert!(!owned.contains(r"C:\Old\IHATECODING.exe"));
        }
        assert_eq!(root["hooks"]["afterFileEdit"][0]["command"], "user-edit");
    }

    #[test]
    fn concurrent_identical_asset_creation_is_idempotent() {
        let directory = TempDir::new().unwrap();
        let target = Arc::new(directory.path().join("shared-hook.ps1"));
        let bytes = Arc::new(vec![b'x'; 64 * 1024]);
        let worker_count = 12;
        let barrier = Arc::new(Barrier::new(worker_count));
        let workers = (0..worker_count)
            .map(|_| {
                let target = Arc::clone(&target);
                let bytes = Arc::clone(&bytes);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    write_owned_file(&target, &bytes)
                })
            })
            .collect::<Vec<_>>();
        for worker in workers {
            worker.join().unwrap().unwrap();
        }
        assert_eq!(fs::read(&*target).unwrap(), *bytes);
    }

    #[test]
    fn generated_assets_cover_supported_interactive_providers() {
        let directory = TempDir::new().unwrap();
        let executable = env::current_exe().unwrap();
        let asset_root = directory.path().join("assets");
        let assets = ensure_assets_at(&executable, &asset_root).unwrap();
        let asset_root = fs::canonicalize(asset_root).unwrap();
        assert!(assets.cline_hooks_directory.starts_with(&asset_root));
        assert!(assets.claude_settings.starts_with(&asset_root));
        assert!(assets.opencode_plugin.starts_with(&asset_root));
        for event in [
            "UserPromptSubmit",
            "TaskComplete",
            "TaskCancel",
            "TaskError",
        ] {
            let script =
                fs::read_to_string(assets.cline_hooks_directory.join(format!("{event}.ps1")))
                    .unwrap();
            assert!(script.contains(HOOK_ARGUMENT));
            assert!(script.contains(event));
            assert!(script.contains("{\"cancel\":false}"));
        }
        let settings: Value =
            serde_json::from_slice(&fs::read(assets.claude_settings).unwrap()).unwrap();
        assert!(settings["hooks"]["UserPromptSubmit"].is_array());
        assert!(settings["hooks"]["Stop"].is_array());
        assert!(settings["hooks"]["StopFailure"].is_array());
        let plugin = fs::read_to_string(assets.opencode_plugin).unwrap();
        assert!(plugin.contains("session.status"));
        assert!(plugin.contains("session.error"));
    }
}
