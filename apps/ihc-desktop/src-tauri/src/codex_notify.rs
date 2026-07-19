#[cfg(windows)]
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    env, fs,
    fs::OpenOptions,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

pub(crate) const NOTIFY_ARGUMENT: &str = "--codex-notify";
pub(crate) const HOOK_ARGUMENT: &str = "--codex-hook";
pub(crate) const NOTIFY_ROUTE_ENV: &str = "IHATECODING_CODEX_NOTIFY_ROUTE";
const NOTIFY_CHAIN_ARGUMENT: &str = "--chain";
const NOTIFY_ROOT_NAME: &str = "ihatecoding-codex-notify-v1";
const HOOK_ROUTE_SUFFIX: &str = ".events";
const HOOK_FILE_NAME: &str = "hooks.json";
const MAX_HOOK_INPUT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_HOOK_FILE_BYTES: u64 = 256 * 1024;
const MAX_EVENT_FILE_BYTES: u64 = 4 * 1024;
const MAX_EVENTS_PER_ROUTE_READ: usize = 4_096;
const MAX_ROUTE_BYTES: u64 = 64 * 1024;
const MAX_ROUTE_CLEANUP_ENTRIES: usize = 4_096;
const ROUTE_TTL_SECONDS: u64 = 7 * 24 * 60 * 60;
const STABLE_EXECUTABLE_NAME: &str = "IHATECODING.exe";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CodexCompletionRoute {
    pub(crate) conversation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) turn_id: Option<String>,
    pub(crate) observed_at_unix_ms: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) enum CodexHookEvent {
    #[serde(rename = "SessionStart")]
    SessionStart,
    #[serde(rename = "UserPromptSubmit")]
    UserPromptSubmit,
    #[serde(rename = "Stop")]
    Stop,
}

impl CodexHookEvent {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "SessionStart" | "session_start" => Some(Self::SessionStart),
            "UserPromptSubmit" | "user_prompt_submit" => Some(Self::UserPromptSubmit),
            "Stop" | "stop" => Some(Self::Stop),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CodexHookEventRecord {
    pub(crate) session_id: String,
    pub(crate) event: CodexHookEvent,
    pub(crate) turn_id: Option<String>,
    pub(crate) observed_at_unix_ms: u64,
}

#[derive(Debug, Deserialize)]
struct CodexHookInput {
    #[serde(alias = "sessionId")]
    session_id: String,
    #[serde(alias = "hookEventName")]
    hook_event_name: String,
    #[serde(default, alias = "turnId")]
    turn_id: Option<String>,
}

pub(crate) fn run_if_requested() -> Option<i32> {
    if env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new(HOOK_ARGUMENT)) {
        // Passive lifecycle hooks must never interfere with the user's turn.
        // Invalid input or a missing pane route therefore fails open and does
        // not print anything into Codex's context.
        let _ = run_hook_notifier();
        return Some(0);
    }

    let args: Vec<String> = env::args().skip(1).collect();
    let marker = args
        .iter()
        .position(|argument| argument == NOTIFY_ARGUMENT)?;
    let payload_index = args
        .iter()
        .enumerate()
        .skip(marker + 1)
        .rev()
        .find(|(_, argument)| argument.trim_start().starts_with('{'))
        .map(|(index, _)| index);
    forward_previous_notifier(&args, marker, payload_index);

    let Some(payload) = payload_index.and_then(|index| args.get(index)) else {
        return Some(0);
    };
    let Some((conversation_id, turn_id)) = parse_turn_complete(payload) else {
        return Some(0);
    };
    let Some(route) = env::var_os(NOTIFY_ROUTE_ENV).map(PathBuf::from) else {
        return Some(0);
    };
    if let Ok(route) = validate_route_path(&route) {
        let notification = CodexCompletionRoute {
            conversation_id,
            turn_id,
            observed_at_unix_ms: unix_time_millis(),
        };
        let _ = write_route(&route, &notification);
    }
    Some(0)
}

pub(crate) fn ensure_configured() -> Result<(), String> {
    cleanup_stale_routes();
    let current_executable = env::current_exe()
        .map_err(|error| format!("Could not locate the IHATECODING executable: {error}"))?;
    let executable = configuration_executable(&current_executable);
    let codex_home = env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| profile_directory().map(|profile| profile.join(".codex")))
        .ok_or_else(|| "Could not locate the Codex configuration directory.".to_owned())?;
    // Keep the legacy notify callback for older Codex builds and short payloads,
    // but also install stdin-based lifecycle hooks. On Windows, notify appends
    // the full assistant response to CreateProcess argv and can fail with
    // ERROR_FILENAME_EXCED_RANGE; hook stdin is independent of response size.
    ensure_configured_at(&codex_home.join("config.toml"), &executable)?;
    ensure_hooks_configured_at(&codex_home.join(HOOK_FILE_NAME), &executable)
}

fn configuration_executable(current_executable: &Path) -> PathBuf {
    let manifest_directory = Path::new(env!("CARGO_MANIFEST_DIR"));
    let Some(workspace_root) = manifest_directory.ancestors().nth(3) else {
        return current_executable.to_path_buf();
    };
    select_configuration_executable(
        current_executable,
        workspace_root,
        &manifest_directory.join("target"),
    )
}

fn select_configuration_executable(
    current_executable: &Path,
    workspace_root: &Path,
    cargo_target_directory: &Path,
) -> PathBuf {
    let Ok(relative_artifact) = current_executable.strip_prefix(cargo_target_directory) else {
        return current_executable.to_path_buf();
    };
    let mut components = relative_artifact.iter();
    let Some(profile) = components.next().and_then(|component| component.to_str()) else {
        return current_executable.to_path_buf();
    };
    if !matches!(profile, "debug" | "release") || components.next().is_none() {
        return current_executable.to_path_buf();
    }
    workspace_root.join(STABLE_EXECUTABLE_NAME)
}

fn run_hook_notifier() -> Result<(), String> {
    let notify_route = env::var_os(NOTIFY_ROUTE_ENV)
        .map(PathBuf::from)
        .ok_or_else(|| "The Codex hook route is unavailable.".to_owned())?;
    let mut payload = Vec::new();
    std::io::stdin()
        .lock()
        .take(MAX_HOOK_INPUT_BYTES + 1)
        .read_to_end(&mut payload)
        .map_err(|error| format!("Could not read the Codex hook event: {error}"))?;
    if payload.len() as u64 > MAX_HOOK_INPUT_BYTES {
        return Err("The Codex hook event is too large.".to_owned());
    }
    let record = parse_hook_input(&payload, unix_time_millis())?;
    let route = hook_route_from_notify_path(&notify_route)?;
    write_hook_event(&route, &record)
}

fn parse_hook_input(
    payload: &[u8],
    observed_at_unix_ms: u64,
) -> Result<CodexHookEventRecord, String> {
    let input = serde_json::from_slice::<CodexHookInput>(payload)
        .map_err(|_| "The Codex hook event payload is invalid.".to_owned())?;
    let event = CodexHookEvent::parse(&input.hook_event_name)
        .ok_or_else(|| "The Codex hook event is not tracked.".to_owned())?;
    let session_id = Uuid::parse_str(&input.session_id)
        .map_err(|_| "The Codex hook session identifier is invalid.".to_owned())?;
    let turn_id = input
        .turn_id
        .as_deref()
        .map(normalize_turn_id)
        .transpose()?;
    Ok(CodexHookEventRecord {
        session_id: session_id.hyphenated().to_string(),
        event,
        turn_id,
        observed_at_unix_ms,
    })
}

fn ensure_hooks_configured_at(hooks_path: &Path, executable: &Path) -> Result<(), String> {
    if let Some(parent) = hooks_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create the Codex hooks directory: {error}"))?;
    }
    let existing = read_regular_file(hooks_path, MAX_HOOK_FILE_BYTES, "Codex hook configuration")?;
    let mut root = match existing.as_deref() {
        Some(bytes) => serde_json::from_slice::<Value>(bytes).map_err(|_| {
            "The existing Codex hook configuration is invalid and was left unchanged.".to_owned()
        })?,
        None => json!({ "hooks": {} }),
    };
    let root = root.as_object_mut().ok_or_else(|| {
        "The existing Codex hook configuration root must be an object.".to_owned()
    })?;
    let hooks = root.entry("hooks").or_insert_with(|| json!({}));
    let hooks = hooks
        .as_object_mut()
        .ok_or_else(|| "The existing Codex hooks value must be an object.".to_owned())?;
    let owned_group = owned_hook_group(executable)?;

    for event in ["SessionStart", "UserPromptSubmit", "Stop"] {
        let groups = hooks.entry(event).or_insert_with(|| json!([]));
        let groups = groups
            .as_array_mut()
            .ok_or_else(|| format!("The existing Codex {event} hook groups must be an array."))?;
        let mut preserved = Vec::with_capacity(groups.len() + 1);
        for mut group in std::mem::take(groups) {
            let group_object = group
                .as_object_mut()
                .ok_or_else(|| format!("An existing Codex {event} hook group is invalid."))?;
            let handlers = group_object
                .get_mut("hooks")
                .and_then(Value::as_array_mut)
                .ok_or_else(|| {
                    format!("An existing Codex {event} hook group has no handler array.")
                })?;
            handlers.retain(|handler| !is_owned_hook_handler(handler));
            if !handlers.is_empty() {
                preserved.push(group);
            }
        }
        preserved.push(owned_group.clone());
        *groups = preserved;
    }

    let mut updated = serde_json::to_vec_pretty(&Value::Object(root.clone()))
        .map_err(|error| format!("Could not encode the Codex hook configuration: {error}"))?;
    updated.push(b'\n');
    if updated.len() as u64 > MAX_HOOK_FILE_BYTES {
        return Err("The updated Codex hook configuration is too large.".to_owned());
    }
    if existing.as_deref() == Some(updated.as_slice()) {
        return Ok(());
    }
    write_hooks_file_atomically(hooks_path, &updated, existing.as_deref())
}

fn owned_hook_group(executable: &Path) -> Result<Value, String> {
    let command = hook_command(executable)?;
    #[cfg(windows)]
    let handler = {
        // Keep a readable ownership marker in the portable fallback.  The
        // Windows command itself is encoded so paths containing spaces,
        // Korean text, percent signs, or apostrophes cannot be reparsed by
        // whichever shell Codex selected for the terminal session.
        let fallback = direct_hook_command(executable)?;
        json!({
            "type": "command",
            "command": fallback,
            "commandWindows": command,
            "timeout": 5
        })
    };
    #[cfg(not(windows))]
    let handler = json!({
        "type": "command",
        "command": command,
        "timeout": 5
    });
    Ok(json!({ "hooks": [handler] }))
}

fn hook_command(executable: &Path) -> Result<String, String> {
    let executable = executable
        .to_str()
        .ok_or_else(|| "The IHATECODING executable path is not valid UTF-8.".to_owned())?;
    if executable.contains(['\r', '\n']) {
        return Err("The IHATECODING executable path is invalid.".to_owned());
    }
    #[cfg(windows)]
    {
        // Codex 0.144 can run hooks through the terminal's selected shell.
        // In a PowerShell session, cmd syntax such as `2>NUL & exit /B 0`
        // is a parse error before IHATECODING is launched.  An encoded child
        // PowerShell command is made only of shell-neutral ASCII tokens, so it
        // survives both an outer PowerShell and an outer cmd.exe unchanged.
        // The child inherits Codex's stdin pipe, suppresses every output
        // stream, and deliberately exits zero even during an update race.
        let quoted = executable.replace('\'', "''");
        let script = format!("try {{ & '{quoted}' {HOOK_ARGUMENT} *> $null }} catch {{}}; exit 0");
        let encoded = BASE64_STANDARD.encode(
            script
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        Ok(format!(
            "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand {encoded}"
        ))
    }
    #[cfg(not(windows))]
    {
        let quoted = executable.replace('\'', "'\"'\"'");
        Ok(format!("'{quoted}' {HOOK_ARGUMENT}"))
    }
}

#[cfg(windows)]
fn direct_hook_command(executable: &Path) -> Result<String, String> {
    let executable = executable
        .to_str()
        .ok_or_else(|| "The IHATECODING executable path is not valid UTF-8.".to_owned())?;
    if executable.contains(['\0', '\r', '\n', '"']) {
        return Err("The IHATECODING executable path is invalid.".to_owned());
    }
    Ok(format!("\"{executable}\" {HOOK_ARGUMENT}"))
}

fn is_owned_hook_handler(handler: &Value) -> bool {
    let Some(handler) = handler.as_object() else {
        return false;
    };
    handler.get("type").and_then(Value::as_str) == Some("command")
        && ["command", "commandWindows", "command_windows"]
            .into_iter()
            .filter_map(|key| handler.get(key).and_then(Value::as_str))
            .any(|command| command == HOOK_ARGUMENT || command.contains(HOOK_ARGUMENT))
}

fn write_hooks_file_atomically(
    target: &Path,
    bytes: &[u8],
    expected_existing: Option<&[u8]>,
) -> Result<(), String> {
    if let Some(expected) = expected_existing {
        let current = read_regular_file(target, MAX_HOOK_FILE_BYTES, "Codex hook configuration")?
            .ok_or_else(|| {
            "The Codex hook configuration changed while it was being updated.".to_owned()
        })?;
        if current != expected {
            return Err(
                "The Codex hook configuration changed while it was being updated and was left unchanged."
                    .to_owned(),
            );
        }
    } else if target.exists() {
        return Err(
            "The Codex hook configuration appeared while it was being installed and was left unchanged."
                .to_owned(),
        );
    }
    let parent = target
        .parent()
        .ok_or_else(|| "The Codex hook configuration has no parent directory.".to_owned())?;
    let temporary = parent.join(format!(".{HOOK_FILE_NAME}.{}.tmp", Uuid::new_v4().simple()));
    let mut guard = TemporaryPathGuard(temporary.clone());
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| format!("Could not create a temporary Codex hook file: {error}"))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Could not write the temporary Codex hook file: {error}"))?;
    drop(file);
    if expected_existing.is_some() {
        atomic_replace(&temporary, target, "Codex hook configuration")?;
    } else {
        atomic_create(&temporary, target, "Codex hook configuration")?;
    }
    guard.0.clear();
    Ok(())
}

fn cleanup_stale_routes() {
    let root = env::temp_dir().join(NOTIFY_ROOT_NAME);
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten().take(MAX_ROUTE_CLEANUP_ENTRIES) {
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        let stale = metadata
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age.as_secs() >= ROUTE_TTL_SECONDS);
        if stale && metadata.is_file() {
            let _ = fs::remove_file(path);
        } else if stale
            && metadata.is_dir()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(is_hook_route_name)
        {
            let _ = fs::remove_dir_all(path);
        }
    }
}

pub(crate) fn route_path(runtime_session_id: &str) -> Result<PathBuf, String> {
    if runtime_session_id.len() != 32
        || !runtime_session_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("The terminal notification route identifier is invalid.".to_owned());
    }
    let root = env::temp_dir().join(NOTIFY_ROOT_NAME);
    fs::create_dir_all(&root)
        .map_err(|error| format!("Could not create the Codex notification route: {error}"))?;
    let root = fs::canonicalize(root)
        .map_err(|error| format!("Could not verify the Codex notification route: {error}"))?;
    Ok(root.join(format!("{runtime_session_id}.jsonl")))
}

pub(crate) fn read_completion(
    runtime_session_id: &str,
) -> Result<Option<CodexCompletionRoute>, String> {
    let path = route_path(runtime_session_id)?;
    read_completion_file(&path)
}

pub(crate) fn acknowledge_completion(
    runtime_session_id: &str,
    expected: &CodexCompletionRoute,
) -> Result<bool, String> {
    let path = route_path(runtime_session_id)?;
    let Some(parent) = path.parent() else {
        return Ok(false);
    };
    let claim = parent.join(format!(
        ".{runtime_session_id}.{}.claim",
        Uuid::new_v4().simple()
    ));
    match fs::rename(&path, &claim) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "Could not claim the Codex notification route: {error}"
            ));
        }
    }
    let current = match read_completion_file(&claim) {
        Ok(current) => current,
        Err(error) => {
            if !path.exists() {
                let _ = fs::rename(&claim, &path);
            }
            return Err(error);
        }
    };
    if current
        .as_ref()
        .is_some_and(|current| completion_route_matches(current, expected))
    {
        let _ = fs::remove_file(claim);
        return Ok(true);
    }
    if !path.exists() {
        let _ = fs::rename(&claim, &path);
    } else {
        let _ = fs::remove_file(claim);
    }
    Ok(false)
}

fn completion_route_matches(
    current: &CodexCompletionRoute,
    expected: &CodexCompletionRoute,
) -> bool {
    if current.conversation_id != expected.conversation_id {
        return false;
    }
    match (current.turn_id.as_deref(), expected.turn_id.as_deref()) {
        (Some(current), Some(expected)) => current == expected,
        _ => current.observed_at_unix_ms == expected.observed_at_unix_ms,
    }
}

fn read_completion_file(path: &Path) -> Result<Option<CodexCompletionRoute>, String> {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return Ok(None);
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_ROUTE_BYTES
    {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .and_then(|file| file.take(MAX_ROUTE_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|error| format!("Could not read the Codex notification route: {error}"))?;
    if bytes.len() as u64 > MAX_ROUTE_BYTES {
        return Ok(None);
    }
    for line in bytes.split(|byte| *byte == b'\n').rev() {
        if line.is_empty() {
            continue;
        }
        if let Ok(route) = serde_json::from_slice::<CodexCompletionRoute>(line)
            && Uuid::parse_str(&route.conversation_id).is_ok()
            && route.turn_id.as_deref().is_none_or(is_canonical_turn_id)
        {
            return Ok(Some(route));
        }
    }
    Ok(None)
}

pub(crate) fn remove_route(runtime_session_id: &str) {
    if let Ok(path) = route_path(runtime_session_id) {
        let _ = fs::remove_file(path);
    }
    if let Ok(path) = hook_route_path(runtime_session_id)
        && path.is_dir()
    {
        let _ = fs::remove_dir_all(path);
    }
}

fn hook_route_from_notify_path(path: &Path) -> Result<PathBuf, String> {
    let path = validate_route_path(path)?;
    let identifier = path
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_suffix(".jsonl"))
        .ok_or_else(|| "The Codex hook route identifier is invalid.".to_owned())?;
    hook_route_path(identifier)
}

pub(crate) fn hook_route_path(runtime_session_id: &str) -> Result<PathBuf, String> {
    validate_runtime_session_id(runtime_session_id)?;
    let root = env::temp_dir().join(NOTIFY_ROOT_NAME);
    fs::create_dir_all(&root)
        .map_err(|error| format!("Could not create the Codex hook route root: {error}"))?;
    let metadata = fs::symlink_metadata(&root)
        .map_err(|error| format!("Could not inspect the Codex hook route root: {error}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("The Codex hook route root is not a regular directory.".to_owned());
    }
    let root = fs::canonicalize(root)
        .map_err(|error| format!("Could not verify the Codex hook route root: {error}"))?;
    let route = root.join(format!("{runtime_session_id}{HOOK_ROUTE_SUFFIX}"));
    match fs::create_dir(&route) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => {
            return Err(format!("Could not create the Codex hook route: {error}"));
        }
    }
    let metadata = fs::symlink_metadata(&route)
        .map_err(|error| format!("Could not inspect the Codex hook route: {error}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("The Codex hook route is not a regular directory.".to_owned());
    }
    let route = fs::canonicalize(route)
        .map_err(|error| format!("Could not verify the Codex hook route: {error}"))?;
    if route.parent() != Some(root.as_path())
        || !route
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(is_hook_route_name)
    {
        return Err("The Codex hook route is outside its owned directory.".to_owned());
    }
    Ok(route)
}

fn is_hook_route_name(name: &str) -> bool {
    name.strip_suffix(HOOK_ROUTE_SUFFIX)
        .is_some_and(|identifier| validate_runtime_session_id(identifier).is_ok())
}

fn validate_runtime_session_id(value: &str) -> Result<(), String> {
    if value.len() != 32 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("The terminal notification route identifier is invalid.".to_owned());
    }
    Ok(())
}

fn write_hook_event(route: &Path, record: &CodexHookEventRecord) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(record)
        .map_err(|error| format!("Could not encode the Codex hook event: {error}"))?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_EVENT_FILE_BYTES {
        return Err("The Codex hook event record is too large.".to_owned());
    }
    let nonce = Uuid::new_v4().simple().to_string();
    let name = format!("{:020}-{nonce}.event.json", record.observed_at_unix_ms);
    let destination = route.join(&name);
    let temporary = route.join(format!(".{name}.{}.tmp", Uuid::new_v4().simple()));
    let mut guard = TemporaryPathGuard(temporary.clone());
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| format!("Could not create a temporary Codex hook event: {error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Could not write the Codex hook event: {error}"))?;
    drop(file);
    atomic_create(&temporary, &destination, "Codex hook event")?;
    guard.0.clear();
    Ok(())
}

pub(crate) fn read_hook_events(
    runtime_session_id: &str,
) -> Result<Vec<CodexHookEventRecord>, String> {
    let route = hook_route_path(runtime_session_id)?;
    let mut records = hook_event_records(&route)?;
    records.sort_by(|left, right| {
        (left.1.observed_at_unix_ms, &left.0).cmp(&(right.1.observed_at_unix_ms, &right.0))
    });
    Ok(records.into_iter().map(|(_, record, _)| record).collect())
}

pub(crate) fn acknowledge_hook_event(
    runtime_session_id: &str,
    expected: &CodexHookEventRecord,
) -> Result<bool, String> {
    Uuid::parse_str(&expected.session_id)
        .map_err(|_| "The Codex hook acknowledgement session identifier is invalid.".to_owned())?;
    let route = hook_route_path(runtime_session_id)?;
    let records = hook_event_records(&route)?;
    for (name, record, path) in records {
        if &record != expected {
            continue;
        }
        let claim = route.join(format!(".{name}.{}.claim", Uuid::new_v4().simple()));
        match fs::rename(&path, &claim) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!("Could not claim the Codex hook event: {error}"));
            }
        }
        let claimed = read_regular_file(&claim, MAX_EVENT_FILE_BYTES, "claimed Codex hook event")
            .and_then(|bytes| {
                bytes.ok_or_else(|| "The claimed Codex hook event disappeared.".to_owned())
            })
            .and_then(|bytes| {
                serde_json::from_slice::<CodexHookEventRecord>(&bytes)
                    .map_err(|_| "The claimed Codex hook event is invalid.".to_owned())
            });
        match claimed {
            Ok(claimed) if &claimed == expected => {
                fs::remove_file(claim).map_err(|error| {
                    format!("Could not acknowledge the Codex hook event: {error}")
                })?;
                return Ok(true);
            }
            Ok(_) | Err(_) => {
                if path.exists() {
                    let _ = fs::remove_file(claim);
                } else {
                    fs::rename(claim, path).map_err(|error| {
                        format!("Could not restore the Codex hook event claim: {error}")
                    })?;
                }
                return Ok(false);
            }
        }
    }
    Ok(false)
}

pub(crate) fn acknowledge_hook_completion(
    runtime_session_id: &str,
    conversation_id: &str,
    turn_id: Option<&str>,
    observed_at_unix_ms: u64,
) -> Result<bool, String> {
    let conversation_id = Uuid::parse_str(conversation_id)
        .map_err(|_| "The Codex hook completion identifier is invalid.".to_owned())?;
    let turn_id = turn_id.map(normalize_turn_id).transpose()?;
    let matching = read_hook_events(runtime_session_id)?
        .into_iter()
        .filter(|record| {
            record.event == CodexHookEvent::Stop
                && Uuid::parse_str(&record.session_id).ok() == Some(conversation_id)
                && match (record.turn_id.as_deref(), turn_id.as_deref()) {
                    (Some(record), Some(expected)) => record == expected,
                    _ => record.observed_at_unix_ms == observed_at_unix_ms,
                }
        })
        .collect::<Vec<_>>();
    let mut acknowledged = false;
    for record in matching {
        acknowledged |= acknowledge_hook_event(runtime_session_id, &record)?;
    }
    Ok(acknowledged)
}

fn hook_event_records(
    route: &Path,
) -> Result<Vec<(String, CodexHookEventRecord, PathBuf)>, String> {
    let mut records = Vec::new();
    for entry in fs::read_dir(route)
        .map_err(|error| format!("Could not read the Codex hook route: {error}"))?
        .flatten()
        .take(MAX_EVENTS_PER_ROUTE_READ)
    {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !name.ends_with(".event.json") || name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let bytes = match read_regular_file(&path, MAX_EVENT_FILE_BYTES, "Codex hook event") {
            Ok(Some(bytes)) => bytes,
            Ok(None) => continue,
            Err(_) => continue,
        };
        let Ok(record) = serde_json::from_slice::<CodexHookEventRecord>(&bytes) else {
            let _ = fs::remove_file(path);
            continue;
        };
        if Uuid::parse_str(&record.session_id).is_err()
            || !record.turn_id.as_deref().is_none_or(is_canonical_turn_id)
        {
            let _ = fs::remove_file(path);
            continue;
        }
        records.push((name, record, path));
    }
    Ok(records)
}

fn validate_route_path(path: &Path) -> Result<PathBuf, String> {
    let expected_root = env::temp_dir().join(NOTIFY_ROOT_NAME);
    fs::create_dir_all(&expected_root)
        .map_err(|_| "The Codex notification route is unavailable.".to_owned())?;
    let expected_root = fs::canonicalize(expected_root)
        .map_err(|_| "The Codex notification route could not be verified.".to_owned())?;
    let parent = path
        .parent()
        .and_then(|parent| fs::canonicalize(parent).ok())
        .ok_or_else(|| "The Codex notification route parent is invalid.".to_owned())?;
    if parent != expected_root {
        return Err("The Codex notification route is outside its owned directory.".to_owned());
    }
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "The Codex notification route name is invalid.".to_owned())?;
    let Some(identifier) = file_name.strip_suffix(".jsonl") else {
        return Err("The Codex notification route extension is invalid.".to_owned());
    };
    if identifier.len() != 32 || !identifier.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("The Codex notification route identifier is invalid.".to_owned());
    }
    if let Ok(metadata) = fs::symlink_metadata(path)
        && (!metadata.is_file() || metadata.file_type().is_symlink())
    {
        return Err("The Codex notification route is not a regular file.".to_owned());
    }
    Ok(path.to_path_buf())
}

fn write_route(path: &Path, notification: &CodexCompletionRoute) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(notification)
        .map_err(|error| format!("Could not encode the Codex notification route: {error}"))?;
    bytes.push(b'\n');
    write_atomic_file(path, &bytes, "Codex notification route")
}

fn write_atomic_file(path: &Path, bytes: &[u8], context: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("The {context} has no parent directory."))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create the {context} directory: {error}"))?;
    let stem = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("notification");
    let temporary = parent.join(format!(".{stem}.{}.tmp", Uuid::new_v4().simple()));
    struct TemporaryGuard(PathBuf);
    impl Drop for TemporaryGuard {
        fn drop(&mut self) {
            if !self.0.as_os_str().is_empty() {
                let _ = fs::remove_file(&self.0);
            }
        }
    }
    let mut guard = TemporaryGuard(temporary.clone());
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| format!("Could not create a temporary {context}: {error}"))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Could not write the temporary {context}: {error}"))?;
    drop(file);
    atomic_replace(&temporary, path, context)?;
    guard.0.clear();
    Ok(())
}

struct TemporaryPathGuard(PathBuf);

impl Drop for TemporaryPathGuard {
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
    // SAFETY: Both arguments are owned, null-terminated paths valid for the call.
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

fn parse_turn_complete(payload: &str) -> Option<(String, Option<String>)> {
    let value = serde_json::from_str::<Value>(payload).ok()?;
    if !matches!(
        value.get("type").and_then(Value::as_str),
        Some("agent-turn-complete" | "agent_turn_complete")
    ) {
        return None;
    }
    let conversation_id = find_conversation_id(&value, 0)?;
    let turn_id = find_turn_id(&value, 0)
        .map(normalize_turn_id)
        .transpose()
        .ok()?;
    Some((conversation_id.to_string(), turn_id))
}

pub(crate) fn normalize_turn_id(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 256 || trimmed.chars().any(char::is_control) {
        return Err("The Codex turn identifier is invalid.".to_owned());
    }
    Ok(trimmed.to_owned())
}

fn is_canonical_turn_id(value: &str) -> bool {
    normalize_turn_id(value).is_ok_and(|normalized| normalized == value)
}

fn find_conversation_id(value: &Value, depth: usize) -> Option<Uuid> {
    if depth > 4 {
        return None;
    }
    let object = value.as_object()?;
    for (name, value) in object {
        let normalized: String = name
            .chars()
            .filter(|character| *character != '-' && *character != '_')
            .flat_map(char::to_lowercase)
            .collect();
        if matches!(
            normalized.as_str(),
            "threadid" | "sessionid" | "conversationid"
        ) && let Some(id) = value.as_str().and_then(|id| Uuid::parse_str(id).ok())
        {
            return Some(id);
        }
    }
    for name in ["payload", "data", "context", "thread", "session"] {
        if let Some(id) = object
            .get(name)
            .and_then(|nested| find_conversation_id(nested, depth + 1))
        {
            return Some(id);
        }
    }
    None
}

fn find_turn_id(value: &Value, depth: usize) -> Option<&str> {
    if depth > 4 {
        return None;
    }
    let object = value.as_object()?;
    for (name, value) in object {
        let normalized: String = name
            .chars()
            .filter(|character| *character != '-' && *character != '_')
            .flat_map(char::to_lowercase)
            .collect();
        if normalized == "turnid"
            && let Some(turn_id) = value.as_str()
        {
            return Some(turn_id);
        }
    }
    for name in ["payload", "data", "context", "thread", "session"] {
        if let Some(turn_id) = object
            .get(name)
            .and_then(|nested| find_turn_id(nested, depth + 1))
        {
            return Some(turn_id);
        }
    }
    None
}

fn forward_previous_notifier(args: &[String], marker: usize, payload_index: Option<usize>) {
    let Some(chain) = args
        .iter()
        .enumerate()
        .skip(marker + 1)
        .find(|(_, argument)| argument.as_str() == NOTIFY_CHAIN_ARGUMENT)
        .map(|(index, _)| index)
    else {
        return;
    };
    let end = payload_index.unwrap_or(args.len());
    if chain + 1 >= end {
        return;
    }
    let executable = &args[chain + 1];
    let mut command = Command::new(executable);
    command.args(&args[(chain + 2)..end]);
    if let Some(payload) = payload_index.and_then(|index| args.get(index)) {
        command.arg(payload);
    }
    let _ = command.spawn();
}

fn ensure_configured_at(config_path: &Path, executable: &Path) -> Result<(), String> {
    let existing = match fs::read_to_string(config_path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("Could not read the Codex configuration: {error}")),
    };
    let line_range = notify_line_range(&existing);
    let existing_arguments = line_range
        .as_ref()
        .and_then(|range| parse_toml_strings(&existing[range.clone()]));
    if line_range.is_some() && existing_arguments.is_none() {
        return Err("The existing Codex notify configuration could not be preserved.".to_owned());
    }
    let existing_arguments = existing_arguments.unwrap_or_default();
    let marker = existing_arguments
        .iter()
        .position(|argument| argument == NOTIFY_ARGUMENT);
    let mut replacement_arguments = vec![
        executable.to_string_lossy().into_owned(),
        NOTIFY_ARGUMENT.to_owned(),
    ];
    if let Some(marker) = marker {
        if let Some(chain) = existing_arguments
            .iter()
            .enumerate()
            .skip(marker + 1)
            .find(|(_, argument)| argument.as_str() == NOTIFY_CHAIN_ARGUMENT)
            .map(|(index, _)| index)
        {
            replacement_arguments.extend(collapse_owned_previous_notifiers(
                &existing_arguments[chain..],
            ));
        }
    } else if !existing_arguments.is_empty() {
        replacement_arguments.push(NOTIFY_CHAIN_ARGUMENT.to_owned());
        replacement_arguments.extend(collapse_owned_previous_notifiers(&existing_arguments));
    }
    let replacement = format!(
        "notify = [ {} ]",
        replacement_arguments
            .iter()
            .map(|argument| serde_json::to_string(argument).unwrap_or_else(|_| "\"\"".to_owned()))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let updated = if let Some(range) = line_range {
        if existing[range.clone()] == replacement {
            return Ok(());
        }
        format!(
            "{}{}{}",
            &existing[..range.start],
            replacement,
            &existing[range.end..]
        )
    } else {
        let insertion = existing
            .lines()
            .scan(0_usize, |offset, line| {
                let start = *offset;
                *offset += line.len() + 1;
                Some((start, line))
            })
            .find(|(_, line)| line.trim_start().starts_with('['))
            .map(|(start, _)| start)
            .unwrap_or(existing.len());
        let separator = if insertion > 0 && !existing[..insertion].ends_with('\n') {
            "\n"
        } else {
            ""
        };
        format!(
            "{}{}{}\n{}",
            &existing[..insertion],
            separator,
            replacement,
            &existing[insertion..]
        )
    };
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!("Could not create the Codex configuration directory: {error}")
        })?;
    }
    write_atomic_file(
        config_path,
        updated.as_bytes(),
        "Codex notify configuration",
    )
}

fn collapse_owned_previous_notifiers(arguments: &[String]) -> Vec<String> {
    let mut collapsed = Vec::with_capacity(arguments.len());
    let mut index = 0;
    while index < arguments.len() {
        if arguments[index] == "--previous-notify"
            && arguments
                .get(index + 1)
                .is_some_and(|value| serialized_notifier_contains_owned_marker(value, 0))
        {
            index += 2;
            continue;
        }
        collapsed.push(arguments[index].clone());
        index += 1;
    }
    collapsed
}

fn serialized_notifier_contains_owned_marker(value: &str, depth: usize) -> bool {
    if depth > 4 {
        return false;
    }
    let Ok(value) = serde_json::from_str::<Value>(value) else {
        return false;
    };
    value.as_array().is_some_and(|arguments| {
        arguments.iter().any(|argument| {
            argument.as_str().is_some_and(|argument| {
                argument == NOTIFY_ARGUMENT
                    || serialized_notifier_contains_owned_marker(argument, depth + 1)
            })
        })
    })
}

fn notify_line_range(config: &str) -> Option<std::ops::Range<usize>> {
    let mut offset = 0_usize;
    for segment in config.split_inclusive('\n') {
        let line = segment.strip_suffix('\n').unwrap_or(segment);
        let trimmed = line.trim_start();
        if trimmed.starts_with('[') {
            return None;
        }
        if trimmed.starts_with("notify")
            && line
                .trim_start()
                .strip_prefix("notify")
                .is_some_and(|rest| rest.trim_start().starts_with('='))
        {
            let leading = line.len() - line.trim_start().len();
            return Some((offset + leading)..(offset + line.len()));
        }
        offset += segment.len();
    }
    None
}

fn parse_toml_strings(line: &str) -> Option<Vec<String>> {
    let start = line.find('[')? + 1;
    let end = line.rfind(']')?;
    let bytes = line.as_bytes();
    let mut index = start;
    let mut values = Vec::new();
    while index < end {
        while index < end && (bytes[index].is_ascii_whitespace() || bytes[index] == b',') {
            index += 1;
        }
        if index >= end {
            break;
        }
        let quote = bytes[index];
        if quote != b'\'' && quote != b'"' {
            return None;
        }
        let value_start = index;
        index += 1;
        let mut escaped = false;
        while index < end {
            let byte = bytes[index];
            index += 1;
            if quote == b'"' && byte == b'\\' && !escaped {
                escaped = true;
                continue;
            }
            if byte == quote && !escaped {
                let token = &line[value_start..index];
                let value = if quote == b'"' {
                    serde_json::from_str::<String>(token).ok()?
                } else {
                    token[1..token.len() - 1].to_owned()
                };
                values.push(value);
                break;
            }
            escaped = false;
        }
        if index > end || bytes.get(index.saturating_sub(1)) != Some(&quote) {
            return None;
        }
    }
    Some(values)
}

fn profile_directory() -> Option<PathBuf> {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
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

    #[test]
    fn workspace_debug_and_release_artifacts_select_the_stable_root_executable() {
        let workspace = PathBuf::from("workspace-root");
        let target = workspace
            .join("apps")
            .join("ihc-desktop")
            .join("src-tauri")
            .join("target");
        let stable = workspace.join(STABLE_EXECUTABLE_NAME);

        for profile in ["debug", "release"] {
            let artifact = target.join(profile).join("ihatecoding.exe");
            assert_eq!(
                select_configuration_executable(&artifact, &workspace, &target),
                stable
            );
        }
    }

    #[test]
    fn root_and_installed_executables_remain_their_own_configuration_target() {
        let workspace = PathBuf::from("workspace-root");
        let target = workspace
            .join("apps")
            .join("ihc-desktop")
            .join("src-tauri")
            .join("target");
        let root_executable = workspace.join(STABLE_EXECUTABLE_NAME);
        let installed_executable = PathBuf::from("installed").join(STABLE_EXECUTABLE_NAME);

        assert_eq!(
            select_configuration_executable(&root_executable, &workspace, &target),
            root_executable
        );
        assert_eq!(
            select_configuration_executable(&installed_executable, &workspace, &target),
            installed_executable
        );
    }

    #[test]
    fn notifier_accepts_only_turn_complete_and_stores_no_prompt_text() {
        let id = Uuid::new_v4();
        let payload = format!(
            r#"{{"type":"agent-turn-complete","payload":{{"thread_id":"{id}","turn-id":" turn-1 ","last-assistant-message":"secret"}}}}"#
        );
        assert_eq!(
            parse_turn_complete(&payload),
            Some((id.to_string(), Some("turn-1".to_owned())))
        );
        assert_eq!(
            parse_turn_complete(&format!(r#"{{"type":"task_started","thread_id":"{id}"}}"#)),
            None
        );
        assert_eq!(
            parse_turn_complete(&format!(
                r#"{{"type":"agent-turn-complete","thread-id":"{id}"}}"#
            )),
            Some((id.to_string(), None))
        );
        assert_eq!(
            parse_turn_complete(&format!(
                r#"{{"type":"agent_turn_complete","payload":{{"session_id":"{id}","turn_id":"turn-2"}}}}"#
            )),
            Some((id.to_string(), Some("turn-2".to_owned())))
        );
        assert_eq!(
            parse_turn_complete(&format!(
                r#"{{"type":"agent-turn-complete","thread-id":"{id}","turn-id":"{}"}}"#,
                "x".repeat(257)
            )),
            None
        );
    }

    #[test]
    fn official_hook_input_accepts_documented_and_compatibility_names() {
        let session = Uuid::new_v4();
        let start = parse_hook_input(
            format!(
                r#"{{"session_id":"{session}","hook_event_name":"SessionStart","cwd":"C:\\work"}}"#
            )
            .as_bytes(),
            41,
        )
        .unwrap();
        assert_eq!(start.session_id, session.to_string());
        assert_eq!(start.event, CodexHookEvent::SessionStart);
        assert_eq!(start.turn_id, None);

        let prompt = parse_hook_input(
            format!(
                r#"{{"sessionId":"{session}","hookEventName":"user_prompt_submit","turnId":"turn-1"}}"#
            )
            .as_bytes(),
            42,
        )
        .unwrap();
        assert_eq!(prompt.event, CodexHookEvent::UserPromptSubmit);
        assert_eq!(prompt.turn_id.as_deref(), Some("turn-1"));
        assert!(
            parse_hook_input(
                format!(r#"{{"session_id":"{session}","hook_event_name":"PreToolUse"}}"#)
                    .as_bytes(),
                43,
            )
            .is_err()
        );
    }

    #[test]
    fn hook_event_queue_is_ordered_and_requires_exact_acknowledgement() {
        let runtime_session_id = Uuid::new_v4().simple().to_string();
        let route = hook_route_path(&runtime_session_id).unwrap();
        let session = Uuid::new_v4();
        let stop = CodexHookEventRecord {
            session_id: session.to_string(),
            event: CodexHookEvent::Stop,
            turn_id: Some("turn-1".to_owned()),
            observed_at_unix_ms: 52,
        };
        let start = CodexHookEventRecord {
            session_id: session.to_string(),
            event: CodexHookEvent::SessionStart,
            turn_id: None,
            observed_at_unix_ms: 50,
        };
        let duplicate_stop = CodexHookEventRecord {
            observed_at_unix_ms: 152,
            ..stop.clone()
        };
        let other_stop = CodexHookEventRecord {
            turn_id: Some("turn-2".to_owned()),
            observed_at_unix_ms: 153,
            ..stop.clone()
        };
        let legacy_stop = CodexHookEventRecord {
            turn_id: None,
            observed_at_unix_ms: 999,
            ..stop.clone()
        };
        write_hook_event(&route, &stop).unwrap();
        write_hook_event(&route, &start).unwrap();
        write_hook_event(&route, &duplicate_stop).unwrap();
        write_hook_event(&route, &other_stop).unwrap();
        write_hook_event(&route, &legacy_stop).unwrap();
        assert_eq!(
            read_hook_events(&runtime_session_id).unwrap(),
            vec![
                start.clone(),
                stop.clone(),
                duplicate_stop.clone(),
                other_stop.clone(),
                legacy_stop,
            ]
        );
        let wrong = CodexHookEventRecord {
            observed_at_unix_ms: 53,
            ..stop.clone()
        };
        assert!(!acknowledge_hook_event(&runtime_session_id, &wrong).unwrap());
        assert!(
            acknowledge_hook_completion(
                &runtime_session_id,
                &session.to_string(),
                Some("turn-1"),
                999,
            )
            .unwrap()
        );
        assert_eq!(
            read_hook_events(&runtime_session_id).unwrap(),
            vec![start, other_stop]
        );
        remove_route(&runtime_session_id);
    }

    #[test]
    fn completion_route_is_non_destructive_until_exact_acknowledgement() {
        let runtime_session_id = Uuid::new_v4().simple().to_string();
        let route = CodexCompletionRoute {
            conversation_id: Uuid::new_v4().to_string(),
            turn_id: None,
            observed_at_unix_ms: 123_456,
        };
        let path = route_path(&runtime_session_id).unwrap();
        write_route(&path, &route).unwrap();

        assert_eq!(
            read_completion(&runtime_session_id).unwrap(),
            Some(route.clone())
        );
        assert_eq!(
            read_completion(&runtime_session_id).unwrap(),
            Some(route.clone())
        );
        let wrong = CodexCompletionRoute {
            observed_at_unix_ms: route.observed_at_unix_ms + 1,
            ..route.clone()
        };
        assert!(!acknowledge_completion(&runtime_session_id, &wrong).unwrap());
        assert_eq!(
            read_completion(&runtime_session_id).unwrap(),
            Some(route.clone())
        );
        assert!(acknowledge_completion(&runtime_session_id, &route).unwrap());
        assert_eq!(read_completion(&runtime_session_id).unwrap(), None);
    }

    #[test]
    fn completion_route_turn_identity_is_backward_compatible_and_ignores_timestamp_drift() {
        let runtime_session_id = Uuid::new_v4().simple().to_string();
        let conversation_id = Uuid::new_v4().to_string();
        let legacy_json =
            format!(r#"{{"conversationId":"{conversation_id}","observedAtUnixMs":41}}"#);
        let path = route_path(&runtime_session_id).unwrap();
        fs::write(&path, format!("{legacy_json}\n")).unwrap();
        assert_eq!(
            read_completion(&runtime_session_id).unwrap(),
            Some(CodexCompletionRoute {
                conversation_id: conversation_id.clone(),
                turn_id: None,
                observed_at_unix_ms: 41,
            })
        );
        assert!(
            acknowledge_completion(
                &runtime_session_id,
                &CodexCompletionRoute {
                    conversation_id: conversation_id.clone(),
                    turn_id: Some("new-reader-turn".to_owned()),
                    observed_at_unix_ms: 41,
                },
            )
            .unwrap()
        );
        assert_eq!(read_completion(&runtime_session_id).unwrap(), None);

        let current = CodexCompletionRoute {
            conversation_id: conversation_id.clone(),
            turn_id: Some("turn-stable".to_owned()),
            observed_at_unix_ms: 100,
        };
        write_route(&path, &current).unwrap();
        let same_turn_later_source = CodexCompletionRoute {
            conversation_id,
            turn_id: Some("turn-stable".to_owned()),
            observed_at_unix_ms: 900,
        };
        assert!(acknowledge_completion(&runtime_session_id, &same_turn_later_source).unwrap());
        assert_eq!(read_completion(&runtime_session_id).unwrap(), None);
        remove_route(&runtime_session_id);
    }

    #[test]
    fn notify_configuration_preserves_and_chains_an_existing_command() {
        let directory = tempfile::tempdir().unwrap();
        let config = directory.path().join("config.toml");
        fs::write(
            &config,
            "notify = [ \"old.exe\", \"--flag\" ]\n[model]\nname='x'\n",
        )
        .unwrap();
        ensure_configured_at(&config, Path::new(r"C:\Apps\IHATECODING.exe")).unwrap();
        let updated = fs::read_to_string(config).unwrap();
        assert!(updated.contains(NOTIFY_ARGUMENT));
        assert!(updated.contains(NOTIFY_CHAIN_ARGUMENT));
        assert!(updated.contains("old.exe"));
        assert!(updated.contains("[model]"));
    }

    #[test]
    fn notify_configuration_inserts_only_a_root_key_before_tables() {
        let directory = tempfile::tempdir().unwrap();
        let config = directory.path().join("config.toml");
        fs::write(
            &config,
            "[custom]\nnotify = [ \"nested.exe\" ]\nvalue = true\n",
        )
        .unwrap();
        ensure_configured_at(&config, Path::new(r"C:\Apps\IHATECODING.exe")).unwrap();
        let updated = fs::read_to_string(config).unwrap();
        assert!(updated.starts_with("notify = ["));
        assert!(updated.contains("[custom]\nnotify = [ \"nested.exe\" ]"));
    }

    #[test]
    fn notify_configuration_is_idempotent_and_updates_its_executable() {
        let directory = tempfile::tempdir().unwrap();
        let config = directory.path().join("config.toml");
        ensure_configured_at(&config, Path::new(r"C:\Old\IHATECODING.exe")).unwrap();
        ensure_configured_at(&config, Path::new(r"C:\New\IHATECODING.exe")).unwrap();
        let updated = fs::read_to_string(&config).unwrap();
        ensure_configured_at(&config, Path::new(r"C:\New\IHATECODING.exe")).unwrap();
        assert_eq!(fs::read_to_string(&config).unwrap(), updated);
        assert_eq!(updated.matches(NOTIFY_ARGUMENT).count(), 1);
        assert!(updated.contains(r"C:\\New\\IHATECODING.exe"));
        assert!(!updated.contains(r"C:\\Old\\IHATECODING.exe"));
    }

    #[test]
    fn hook_configuration_preserves_user_handlers_and_updates_only_owned_handlers() {
        let directory = tempfile::tempdir().unwrap();
        let hooks = directory.path().join(HOOK_FILE_NAME);
        fs::write(
            &hooks,
            serde_json::to_vec_pretty(&json!({
                "custom": { "keep": true },
                "hooks": {
                    "Stop": [{
                        "matcher": "",
                        "hooks": [{ "type": "command", "command": "user-stop.exe" }]
                    }],
                    "PreToolUse": [{
                        "matcher": "Bash",
                        "hooks": [{ "type": "command", "command": "user-policy.exe" }]
                    }]
                }
            }))
            .unwrap(),
        )
        .unwrap();
        ensure_hooks_configured_at(&hooks, Path::new(r"C:\Old\IHATECODING.exe")).unwrap();
        ensure_hooks_configured_at(&hooks, Path::new(r"C:\New\IHATECODING.exe")).unwrap();
        let updated = fs::read_to_string(&hooks).unwrap();
        let value: Value = serde_json::from_str(&updated).unwrap();
        assert_eq!(value["custom"]["keep"], true);
        assert!(updated.contains("user-stop.exe"));
        assert!(updated.contains("user-policy.exe"));
        assert!(updated.contains("New\\\\IHATECODING.exe"));
        assert!(!updated.contains("Old\\\\IHATECODING.exe"));
        assert_eq!(updated.matches(HOOK_ARGUMENT).count(), 3);
    }

    #[cfg(windows)]
    #[test]
    fn windows_hook_command_is_silent_and_fail_open() {
        let executable = Path::new(r"C:\Apps\100% '한글 폴더'\IHATECODING.exe");
        let command = hook_command(executable).unwrap();
        let encoded = command
            .strip_prefix(
                "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ",
            )
            .unwrap();
        let bytes = BASE64_STANDARD.decode(encoded).unwrap();
        let utf16 = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        let script = String::from_utf16(&utf16).unwrap();
        assert_eq!(
            script,
            "try { & 'C:\\Apps\\100% ''한글 폴더''\\IHATECODING.exe' --codex-hook *> $null } catch {}; exit 0"
        );
        assert!(!command.contains(['&', '\'', '"', '%']));
        let group = owned_hook_group(executable).unwrap();
        assert_eq!(
            group["hooks"][0]["command"],
            r#""C:\Apps\100% '한글 폴더'\IHATECODING.exe" --codex-hook"#
        );
        assert_eq!(group["hooks"][0]["commandWindows"], command);
        assert!(is_owned_hook_handler(&json!({
            "type": "command",
            "command": group["hooks"][0]["command"],
            "commandWindows": command
        })));
        assert!(hook_command(Path::new(r"C:\Bad%TEMP%\IHATECODING.exe")).is_ok());
        assert!(direct_hook_command(Path::new("bad\npath.exe")).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_hook_wrapper_survives_powershell_and_cmd_outer_shells() {
        use std::io::Write as _;
        use std::process::Stdio;

        let directory = tempfile::Builder::new()
            .prefix("ihc hook 100% '한글' ")
            .tempdir()
            .unwrap();
        let helper = directory.path().join("hook helper.cmd");
        let captured = directory.path().join("captured.txt");
        fs::write(
            &helper,
            "@echo off\r\nset /p IHC_PAYLOAD=\r\n> \"%~dp0captured.txt\" echo(%IHC_PAYLOAD%\r\nexit /B 17\r\n",
        )
        .unwrap();
        let command = hook_command(&helper).unwrap();
        let payload = r#"{"session_id":"00000000-0000-4000-8000-000000000001","hook_event_name":"SessionStart"}"#;

        for (program, arguments) in [
            (
                "powershell.exe",
                vec!["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
            ),
            ("cmd.exe", vec!["/D", "/S", "/C"]),
        ] {
            let _ = fs::remove_file(&captured);
            let mut child = Command::new(program)
                .args(arguments)
                .arg(&command)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(format!("{payload}\r\n").as_bytes())
                .unwrap();
            let output = child.wait_with_output().unwrap();
            assert_eq!(output.status.code(), Some(0), "outer shell: {program}");
            assert!(output.stdout.is_empty(), "outer shell: {program}");
            assert!(output.stderr.is_empty(), "outer shell: {program}");
            assert_eq!(fs::read_to_string(&captured).unwrap().trim(), payload);
        }
    }

    #[test]
    fn recursive_previous_notifier_is_collapsed_but_unrelated_notifier_is_preserved() {
        let directory = tempfile::tempdir().unwrap();
        let config = directory.path().join("config.toml");
        let owned =
            serde_json::to_string(&vec![r"C:\Old\IHATECODING.exe", NOTIFY_ARGUMENT]).unwrap();
        let unrelated = serde_json::to_string(&vec!["other.exe", "--notify"]).unwrap();
        let arguments = [
            r"C:\Tools\codex-computer-use.exe".to_owned(),
            "turn-ended".to_owned(),
            "--previous-notify".to_owned(),
            owned,
            "--previous-notify".to_owned(),
            unrelated.clone(),
        ];
        fs::write(
            &config,
            format!(
                "notify = [ {} ]\n",
                arguments
                    .iter()
                    .map(|argument| serde_json::to_string(argument).unwrap())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        )
        .unwrap();
        ensure_configured_at(&config, Path::new(r"C:\Apps\IHATECODING.exe")).unwrap();
        let updated = fs::read_to_string(config).unwrap();
        assert_eq!(updated.matches(NOTIFY_ARGUMENT).count(), 1);
        assert_eq!(updated.matches("--previous-notify").count(), 1);
        assert!(updated.contains("other.exe"));
        assert!(updated.contains("codex-computer-use.exe"));
    }
}
