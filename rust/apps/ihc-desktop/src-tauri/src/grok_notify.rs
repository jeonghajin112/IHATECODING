use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    env, fs,
    fs::OpenOptions,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

pub(crate) const NOTIFY_ARGUMENT: &str = "--grok-notify";
pub(crate) const NOTIFY_ROUTE_ENV: &str = "IHATECODING_GROK_NOTIFY_ROUTE";

const GROK_HOOK_EVENT_ENV: &str = "GROK_HOOK_EVENT";
const GROK_SESSION_ID_ENV: &str = "GROK_SESSION_ID";
const NOTIFY_ROOT_NAME: &str = "ihatecoding-grok-notify-v1";
const HOOK_FILE_NAME: &str = "ihatecoding.json";
const MAX_HOOK_INPUT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_HOOK_FILE_BYTES: u64 = 256 * 1024;
const MAX_EVENT_FILE_BYTES: u64 = 4 * 1024;
const MAX_ROUTE_CLEANUP_ENTRIES: usize = 4_096;
const MAX_EVENTS_PER_ROUTE_READ: usize = 4_096;
const ROUTE_TTL_MILLIS: u64 = 7 * 24 * 60 * 60 * 1_000;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) enum GrokHookEvent {
    #[serde(rename = "SessionStart")]
    SessionStart,
    #[serde(rename = "UserPromptSubmit")]
    UserPromptSubmit,
    #[serde(rename = "Stop")]
    Stop,
    #[serde(rename = "StopFailure")]
    StopFailure,
}

impl GrokHookEvent {
    fn parse(value: &str) -> Option<Self> {
        match value {
            // Hook manifest keys use the official PascalCase names, while
            // Grok 0.2.93 exposes the selected event to commands and stdin
            // using snake_case. Accept exactly those two documented forms so
            // the environment and payload can still be compared by meaning.
            "SessionStart" | "session_start" => Some(Self::SessionStart),
            "UserPromptSubmit" | "user_prompt_submit" => Some(Self::UserPromptSubmit),
            "Stop" | "stop" => Some(Self::Stop),
            "StopFailure" | "stop_failure" => Some(Self::StopFailure),
            _ => None,
        }
    }

    #[cfg(test)]
    fn as_str(self) -> &'static str {
        match self {
            Self::SessionStart => "SessionStart",
            Self::UserPromptSubmit => "UserPromptSubmit",
            Self::Stop => "Stop",
            Self::StopFailure => "StopFailure",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GrokHookEventRecord {
    pub(crate) session_id: String,
    pub(crate) event: GrokHookEvent,
    pub(crate) observed_at_unix_ms: u64,
}

#[derive(Debug, Deserialize)]
struct GrokHookInput {
    #[serde(rename = "hookEventName", alias = "hook_event_name")]
    hook_event_name: String,
    #[serde(rename = "sessionId", alias = "session_id")]
    session_id: String,
}

pub(crate) fn run_if_requested() -> Option<i32> {
    if env::args_os().nth(1).as_deref() != Some(std::ffi::OsStr::new(NOTIFY_ARGUMENT)) {
        return None;
    }

    // Passive Grok hooks must never interfere with the user's turn. Invalid or
    // unavailable routes are intentionally fail-open and produce no stdout.
    let _ = run_notifier();
    Some(0)
}

fn run_notifier() -> Result<(), String> {
    let route = env::var_os(NOTIFY_ROUTE_ENV)
        .map(PathBuf::from)
        .ok_or_else(|| "The Grok notification route is unavailable.".to_owned())?;
    let hook_event = env::var(GROK_HOOK_EVENT_ENV)
        .map_err(|_| "The Grok hook event is unavailable.".to_owned())?;
    let session_id = env::var(GROK_SESSION_ID_ENV)
        .map_err(|_| "The Grok session identifier is unavailable.".to_owned())?;

    let mut payload = Vec::new();
    std::io::stdin()
        .lock()
        .take(MAX_HOOK_INPUT_BYTES + 1)
        .read_to_end(&mut payload)
        .map_err(|error| format!("Could not read the Grok hook event: {error}"))?;
    if payload.len() as u64 > MAX_HOOK_INPUT_BYTES {
        return Err("The Grok hook event is too large.".to_owned());
    }

    let record = parse_hook_input(&payload, &hook_event, &session_id, unix_time_millis())?;
    let route = validate_route_path(&route)?;
    write_event(&route, &record)
}

fn parse_hook_input(
    payload: &[u8],
    expected_event: &str,
    expected_session_id: &str,
    observed_at_unix_ms: u64,
) -> Result<GrokHookEventRecord, String> {
    let input = serde_json::from_slice::<GrokHookInput>(payload)
        .map_err(|_| "The Grok hook event payload is invalid.".to_owned())?;
    let payload_event = GrokHookEvent::parse(&input.hook_event_name)
        .ok_or_else(|| "The Grok hook event is not tracked.".to_owned())?;
    let environment_event = GrokHookEvent::parse(expected_event)
        .ok_or_else(|| "The Grok hook environment event is not tracked.".to_owned())?;
    if payload_event != environment_event {
        return Err("The Grok hook event does not match its environment.".to_owned());
    }
    let payload_session_id = Uuid::parse_str(&input.session_id)
        .map_err(|_| "The Grok hook session identifier is invalid.".to_owned())?;
    let environment_session_id = Uuid::parse_str(expected_session_id)
        .map_err(|_| "The Grok hook environment session identifier is invalid.".to_owned())?;
    if payload_session_id != environment_session_id {
        return Err("The Grok hook session identifier does not match its environment.".to_owned());
    }

    Ok(GrokHookEventRecord {
        session_id: payload_session_id.hyphenated().to_string(),
        event: payload_event,
        observed_at_unix_ms,
    })
}

pub(crate) fn ensure_configured() -> Result<(), String> {
    cleanup_stale_routes();
    let executable = env::current_exe()
        .map_err(|error| format!("Could not locate the IHATECODING executable: {error}"))?;
    let grok_home = env::var_os("GROK_HOME")
        .map(PathBuf::from)
        .or_else(|| profile_directory().map(|profile| profile.join(".grok")))
        .ok_or_else(|| "Could not locate the Grok configuration directory.".to_owned())?;
    ensure_configured_at(&grok_home.join("hooks"), &executable)
}

fn ensure_configured_at(hooks_directory: &Path, executable: &Path) -> Result<(), String> {
    fs::create_dir_all(hooks_directory)
        .map_err(|error| format!("Could not create the Grok hooks directory: {error}"))?;
    let target = hooks_directory.join(HOOK_FILE_NAME);
    let manifest = hook_manifest(executable)?;
    let mut bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("Could not encode the Grok hook configuration: {error}"))?;
    bytes.push(b'\n');

    let existing = read_regular_file(&target, MAX_HOOK_FILE_BYTES, "Grok hook configuration")?;
    if let Some(existing) = &existing {
        if existing == &bytes {
            return Ok(());
        }
        if !is_owned_manifest(existing) {
            return Err(format!(
                "The existing {} is not owned by IHATECODING and was left unchanged.",
                target.display()
            ));
        }
    }

    write_manifest_atomically(&target, &bytes, existing.as_deref())
}

fn hook_manifest(executable: &Path) -> Result<Value, String> {
    let command = hook_command(executable)?;
    let command_hook = || {
        json!({
            "hooks": [{
                "type": "command",
                "command": command,
                "timeout": 5
            }]
        })
    };
    Ok(json!({
        "hooks": {
            "SessionStart": [command_hook()],
            "UserPromptSubmit": [command_hook()],
            "Stop": [command_hook()],
            "StopFailure": [command_hook()]
        }
    }))
}

fn hook_command(executable: &Path) -> Result<String, String> {
    let executable = executable
        .to_str()
        .ok_or_else(|| "The IHATECODING executable path is not valid UTF-8.".to_owned())?;
    if executable.contains('\r') || executable.contains('\n') {
        return Err("The IHATECODING executable path is invalid.".to_owned());
    }

    #[cfg(windows)]
    {
        if executable.contains('"') {
            return Err("The IHATECODING executable path cannot be quoted safely.".to_owned());
        }
        Ok(format!("\"{executable}\" {NOTIFY_ARGUMENT}"))
    }
    #[cfg(not(windows))]
    {
        let quoted = executable.replace('\'', "'\"'\"'");
        Ok(format!("'{quoted}' {NOTIFY_ARGUMENT}"))
    }
}

fn is_owned_manifest(bytes: &[u8]) -> bool {
    let Ok(root) = serde_json::from_slice::<Value>(bytes) else {
        return false;
    };
    let Some(root) = root.as_object() else {
        return false;
    };
    if root.len() != 1 {
        return false;
    }
    let Some(hooks) = root.get("hooks").and_then(Value::as_object) else {
        return false;
    };
    let expected_events = ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure"];
    if hooks.len() != expected_events.len()
        || expected_events
            .iter()
            .any(|event| !hooks.contains_key(*event))
    {
        return false;
    }

    hooks.values().all(|groups| {
        let Some(groups) = groups.as_array() else {
            return false;
        };
        let Some(group) = (groups.len() == 1)
            .then(|| groups.first())
            .flatten()
            .and_then(Value::as_object)
        else {
            return false;
        };
        if group.len() != 1 {
            return false;
        }
        let Some(commands) = group.get("hooks").and_then(Value::as_array) else {
            return false;
        };
        let Some(command) = (commands.len() == 1)
            .then(|| commands.first())
            .flatten()
            .and_then(Value::as_object)
        else {
            return false;
        };
        command.get("type").and_then(Value::as_str) == Some("command")
            && command.get("timeout").and_then(Value::as_u64) == Some(5)
            && command
                .get("command")
                .and_then(Value::as_str)
                .is_some_and(|value| value.ends_with(&format!(" {NOTIFY_ARGUMENT}")))
    })
}

fn write_manifest_atomically(
    target: &Path,
    bytes: &[u8],
    expected_existing: Option<&[u8]>,
) -> Result<(), String> {
    if let Some(expected) = expected_existing {
        let current = read_regular_file(target, MAX_HOOK_FILE_BYTES, "Grok hook configuration")?
            .ok_or_else(|| {
                "The Grok hook configuration changed while it was being updated.".to_owned()
            })?;
        if current != expected {
            return Err(
                "The Grok hook configuration changed while it was being updated and was left unchanged."
                    .to_owned(),
            );
        }
    } else if target.exists() {
        return Err(
            "The Grok hook configuration appeared while it was being installed and was left unchanged."
                .to_owned(),
        );
    }

    let parent = target
        .parent()
        .ok_or_else(|| "The Grok hook configuration has no parent directory.".to_owned())?;
    let temporary = parent.join(format!(".{HOOK_FILE_NAME}.{}.tmp", Uuid::new_v4().simple()));
    let mut guard = TemporaryFileGuard(temporary.clone());
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| format!("Could not create a temporary Grok hook file: {error}"))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Could not write the temporary Grok hook file: {error}"))?;
    drop(file);

    if expected_existing.is_some() {
        atomic_replace(&temporary, target, "Grok hook configuration")?;
    } else {
        atomic_create(&temporary, target, "Grok hook configuration")?;
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
    // SAFETY: Both values are owned, null-terminated paths valid for this call.
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

pub(crate) fn route_path(runtime_session_id: &str) -> Result<PathBuf, String> {
    route_path_at(&env::temp_dir().join(NOTIFY_ROOT_NAME), runtime_session_id)
}

fn route_path_at(root: &Path, runtime_session_id: &str) -> Result<PathBuf, String> {
    validate_runtime_session_id(runtime_session_id)?;
    fs::create_dir_all(root)
        .map_err(|error| format!("Could not create the Grok notification root: {error}"))?;
    let root_metadata = fs::symlink_metadata(root)
        .map_err(|error| format!("Could not inspect the Grok notification root: {error}"))?;
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return Err("The Grok notification root is not a regular directory.".to_owned());
    }
    let root = fs::canonicalize(root)
        .map_err(|error| format!("Could not verify the Grok notification root: {error}"))?;
    let route = root.join(runtime_session_id);
    match fs::create_dir(&route) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => {
            return Err(format!(
                "Could not create the Grok notification route: {error}"
            ));
        }
    }
    validate_route_path_at(&root, &route)
}

fn validate_route_path(path: &Path) -> Result<PathBuf, String> {
    let root = env::temp_dir().join(NOTIFY_ROOT_NAME);
    fs::create_dir_all(&root)
        .map_err(|_| "The Grok notification root is unavailable.".to_owned())?;
    let root = fs::canonicalize(root)
        .map_err(|_| "The Grok notification root could not be verified.".to_owned())?;
    validate_route_path_at(&root, path)
}

fn validate_route_path_at(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "The Grok notification route is unavailable.".to_owned())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("The Grok notification route is not a regular directory.".to_owned());
    }
    let route = fs::canonicalize(path)
        .map_err(|_| "The Grok notification route could not be verified.".to_owned())?;
    let parent = route
        .parent()
        .ok_or_else(|| "The Grok notification route has no parent.".to_owned())?;
    let canonical_root = fs::canonicalize(root)
        .map_err(|_| "The Grok notification root could not be verified.".to_owned())?;
    if parent != canonical_root {
        return Err("The Grok notification route is outside its owned directory.".to_owned());
    }
    let identifier = route
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "The Grok notification route identifier is invalid.".to_owned())?;
    validate_runtime_session_id(identifier)?;
    Ok(route)
}

fn validate_runtime_session_id(value: &str) -> Result<(), String> {
    if value.len() != 32 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("The terminal notification route identifier is invalid.".to_owned());
    }
    Ok(())
}

fn write_event(route: &Path, record: &GrokHookEventRecord) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(record)
        .map_err(|error| format!("Could not encode the Grok hook event: {error}"))?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_EVENT_FILE_BYTES {
        return Err("The Grok hook event record is too large.".to_owned());
    }
    let nonce = Uuid::new_v4().simple().to_string();
    let final_name = event_file_name(record.observed_at_unix_ms, &nonce);
    let destination = route.join(&final_name);
    let temporary = route.join(format!(".{final_name}.{}.tmp", Uuid::new_v4().simple()));
    let mut guard = TemporaryFileGuard(temporary.clone());
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| format!("Could not create a temporary Grok hook event: {error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Could not write the Grok hook event: {error}"))?;
    drop(file);
    atomic_create(&temporary, &destination, "Grok hook event")?;
    guard.0.clear();
    Ok(())
}

pub(crate) fn read_events(runtime_session_id: &str) -> Result<Vec<GrokHookEventRecord>, String> {
    read_events_at(&env::temp_dir().join(NOTIFY_ROOT_NAME), runtime_session_id)
}

fn read_events_at(
    root: &Path,
    runtime_session_id: &str,
) -> Result<Vec<GrokHookEventRecord>, String> {
    let route = route_path_at(root, runtime_session_id)?;
    let mut entries = event_entries(&route)?;
    entries.sort_by(|left, right| (left.0, &left.1).cmp(&(right.0, &right.1)));

    let mut records = Vec::with_capacity(entries.len());
    for (_, _, path) in entries {
        let bytes = match read_regular_file(&path, MAX_EVENT_FILE_BYTES, "Grok hook event") {
            Ok(Some(bytes)) => bytes,
            Ok(None) => continue,
            Err(_) => continue,
        };
        let Ok(record) = serde_json::from_slice::<GrokHookEventRecord>(&bytes) else {
            let _ = fs::remove_file(path);
            continue;
        };
        if Uuid::parse_str(&record.session_id).is_err() {
            let _ = fs::remove_file(path);
            continue;
        }
        records.push(record);
    }
    Ok(records)
}

pub(crate) fn acknowledge_event(
    runtime_session_id: &str,
    expected: &GrokHookEventRecord,
) -> Result<bool, String> {
    acknowledge_event_at(
        &env::temp_dir().join(NOTIFY_ROOT_NAME),
        runtime_session_id,
        expected,
    )
}

fn acknowledge_event_at(
    root: &Path,
    runtime_session_id: &str,
    expected: &GrokHookEventRecord,
) -> Result<bool, String> {
    Uuid::parse_str(&expected.session_id)
        .map_err(|_| "The Grok hook acknowledgement session identifier is invalid.".to_owned())?;
    let route = route_path_at(root, runtime_session_id)?;
    let mut entries = event_entries(&route)?;
    entries.sort_by(|left, right| (left.0, &left.1).cmp(&(right.0, &right.1)));

    for (_, name, path) in entries {
        let bytes = match read_regular_file(&path, MAX_EVENT_FILE_BYTES, "Grok hook event") {
            Ok(Some(bytes)) => bytes,
            Ok(None) => continue,
            Err(_) => continue,
        };
        let Ok(record) = serde_json::from_slice::<GrokHookEventRecord>(&bytes) else {
            let _ = fs::remove_file(path);
            continue;
        };
        if Uuid::parse_str(&record.session_id).is_err() {
            let _ = fs::remove_file(path);
            continue;
        }
        if &record != expected {
            continue;
        }

        let claim = route.join(format!(".{name}.{}.claim", Uuid::new_v4().simple()));
        match fs::rename(&path, &claim) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "Could not claim the Grok hook event acknowledgement: {error}"
                ));
            }
        }

        let claimed = read_regular_file(&claim, MAX_EVENT_FILE_BYTES, "claimed Grok hook event")
            .and_then(|bytes| {
                bytes.ok_or_else(|| "The claimed Grok hook event disappeared.".to_owned())
            })
            .and_then(|bytes| {
                serde_json::from_slice::<GrokHookEventRecord>(&bytes)
                    .map_err(|_| "The claimed Grok hook event is invalid.".to_owned())
            });
        match claimed {
            Ok(claimed) if &claimed == expected => {
                fs::remove_file(&claim).map_err(|error| {
                    format!("Could not acknowledge the claimed Grok hook event: {error}")
                })?;
                return Ok(true);
            }
            Ok(_) | Err(_) => {
                restore_claim(&claim, &path)?;
                return Ok(false);
            }
        }
    }
    Ok(false)
}

fn event_entries(route: &Path) -> Result<Vec<(u64, String, PathBuf)>, String> {
    Ok(fs::read_dir(route)
        .map_err(|error| format!("Could not read the Grok notification route: {error}"))?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_str()?.to_owned();
            event_file_timestamp(&name).map(|timestamp| (timestamp, name, entry.path()))
        })
        .take(MAX_EVENTS_PER_ROUTE_READ)
        .collect())
}

fn restore_claim(claim: &Path, original: &Path) -> Result<(), String> {
    if original.exists() {
        return Err(
            "The Grok hook event changed while its acknowledgement was being verified.".to_owned(),
        );
    }
    fs::rename(claim, original)
        .map_err(|error| format!("Could not restore the Grok hook event claim: {error}"))
}

pub(crate) fn remove_route(runtime_session_id: &str) {
    let root = env::temp_dir().join(NOTIFY_ROOT_NAME);
    let Ok(route) = route_path_at(&root, runtime_session_id) else {
        return;
    };
    let Ok(entries) = fs::read_dir(&route) else {
        return;
    };
    for entry in entries.flatten().take(MAX_ROUTE_CLEANUP_ENTRIES) {
        let path = entry.path();
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.is_file()
            && !metadata.file_type().is_symlink()
            && (event_file_timestamp(&name).is_some()
                || claimed_event_timestamp(&name).is_some()
                || is_owned_temporary_name(&name))
        {
            let _ = fs::remove_file(path);
        }
    }
    let _ = fs::remove_dir(route);
}

fn cleanup_stale_routes() {
    cleanup_stale_routes_at(&env::temp_dir().join(NOTIFY_ROOT_NAME), unix_time_millis());
}

fn cleanup_stale_routes_at(root: &Path, now_unix_ms: u64) {
    let Ok(root_metadata) = fs::symlink_metadata(root) else {
        return;
    };
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return;
    }
    let Ok(routes) = fs::read_dir(root) else {
        return;
    };
    for route in routes.flatten().take(MAX_ROUTE_CLEANUP_ENTRIES) {
        let route_path = route.path();
        let Some(route_name) = route.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if validate_runtime_session_id(&route_name).is_err() {
            continue;
        }
        let Ok(route_metadata) = fs::symlink_metadata(&route_path) else {
            continue;
        };
        if !route_metadata.is_dir() || route_metadata.file_type().is_symlink() {
            continue;
        }
        let Ok(entries) = fs::read_dir(&route_path) else {
            continue;
        };
        let mut kept_entry = false;
        for entry in entries.flatten().take(MAX_ROUTE_CLEANUP_ENTRIES) {
            let path = entry.path();
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                kept_entry = true;
                continue;
            };
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                kept_entry = true;
                continue;
            }
            let stale_event = event_file_timestamp(&name)
                .or_else(|| claimed_event_timestamp(&name))
                .is_some_and(|timestamp| now_unix_ms.saturating_sub(timestamp) >= ROUTE_TTL_MILLIS);
            let stale_temporary = is_owned_temporary_name(&name)
                && metadata
                    .modified()
                    .ok()
                    .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                    .is_some_and(|age| age.as_millis() >= u128::from(ROUTE_TTL_MILLIS));
            if stale_event || stale_temporary {
                if fs::remove_file(path).is_err() {
                    kept_entry = true;
                }
            } else {
                kept_entry = true;
            }
        }
        if !kept_entry {
            let _ = fs::remove_dir(route_path);
        }
    }
}

fn event_file_name(observed_at_unix_ms: u64, nonce: &str) -> String {
    format!("{observed_at_unix_ms:020}-{nonce}.event.json")
}

fn event_file_timestamp(name: &str) -> Option<u64> {
    let stem = name.strip_suffix(".event.json")?;
    let (timestamp, nonce) = stem.split_once('-')?;
    if timestamp.len() != 20
        || nonce.len() != 32
        || !timestamp.bytes().all(|byte| byte.is_ascii_digit())
        || !nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return None;
    }
    timestamp.parse().ok()
}

fn claimed_event_timestamp(name: &str) -> Option<u64> {
    let claim = name.strip_prefix('.')?.strip_suffix(".claim")?;
    let (event_name, nonce) = claim.rsplit_once('.')?;
    if nonce.len() != 32 || !nonce.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    event_file_timestamp(event_name)
}

fn is_owned_temporary_name(name: &str) -> bool {
    name.starts_with('.')
        && name.contains(".event.json.")
        && name.ends_with(".tmp")
        && name.len() < 160
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
    fn hook_input_keeps_only_event_session_and_observation_time() {
        let session_id = Uuid::new_v4();
        let secret_prompt = "do not persist this prompt";
        let payload = serde_json::to_vec(&json!({
            "hookEventName": "user_prompt_submit",
            "sessionId": session_id,
            "cwd": "C:\\private\\project",
            "prompt": secret_prompt,
            "response": "also secret"
        }))
        .unwrap();
        let record = parse_hook_input(
            &payload,
            "user_prompt_submit",
            &session_id.to_string(),
            123_456,
        )
        .unwrap();
        let stored = serde_json::to_string(&record).unwrap();

        assert_eq!(record.session_id, session_id.to_string());
        assert_eq!(record.event, GrokHookEvent::UserPromptSubmit);
        assert_eq!(record.observed_at_unix_ms, 123_456);
        assert!(!stored.contains(secret_prompt));
        assert!(!stored.contains("private"));
        assert!(!stored.contains("response"));
    }

    #[test]
    fn hook_input_accepts_manifest_and_runtime_event_spellings() {
        let session_id = Uuid::new_v4();
        for (manifest_event, runtime_event, expected) in [
            ("SessionStart", "session_start", GrokHookEvent::SessionStart),
            (
                "UserPromptSubmit",
                "user_prompt_submit",
                GrokHookEvent::UserPromptSubmit,
            ),
            ("Stop", "stop", GrokHookEvent::Stop),
            ("StopFailure", "stop_failure", GrokHookEvent::StopFailure),
        ] {
            let payload = serde_json::to_vec(&json!({
                "hookEventName": runtime_event,
                "sessionId": session_id
            }))
            .unwrap();

            let runtime_record =
                parse_hook_input(&payload, runtime_event, &session_id.to_string(), 1).unwrap();
            let manifest_record =
                parse_hook_input(&payload, manifest_event, &session_id.to_string(), 1).unwrap();
            assert_eq!(runtime_record.event, expected);
            assert_eq!(manifest_record.event, expected);
        }
    }

    #[test]
    fn hook_input_accepts_snake_case_field_aliases() {
        let session_id = Uuid::new_v4();
        let payload = serde_json::to_vec(&json!({
            "hook_event_name": "stop",
            "session_id": session_id,
            "workspace_root": "C:\\private\\project"
        }))
        .unwrap();

        let record = parse_hook_input(&payload, "stop", &session_id.to_string(), 99).unwrap();
        assert_eq!(record.event, GrokHookEvent::Stop);
        assert_eq!(record.session_id, session_id.to_string());
        assert_eq!(record.observed_at_unix_ms, 99);
    }

    #[test]
    fn hook_input_requires_official_event_and_matching_uuid() {
        let session_id = Uuid::new_v4();
        let other = Uuid::new_v4();
        let payload = serde_json::to_vec(&json!({
            "hookEventName": "stop",
            "sessionId": session_id
        }))
        .unwrap();
        assert!(parse_hook_input(&payload, "stop", &session_id.to_string(), 1).is_ok());
        assert!(parse_hook_input(&payload, "stop_failure", &session_id.to_string(), 1).is_err());
        assert!(parse_hook_input(&payload, "stop", &other.to_string(), 1).is_err());

        let unsupported = serde_json::to_vec(&json!({
            "hookEventName": "post_tool_use",
            "sessionId": session_id
        }))
        .unwrap();
        assert!(
            parse_hook_input(&unsupported, "post_tool_use", &session_id.to_string(), 1).is_err()
        );
    }

    #[test]
    fn manifest_uses_official_schema_and_all_lifecycle_events() {
        let manifest = hook_manifest(Path::new(r"C:\Apps\IHATECODING.exe")).unwrap();
        let bytes = serde_json::to_vec(&manifest).unwrap();
        assert!(is_owned_manifest(&bytes));
        let hooks = manifest["hooks"].as_object().unwrap();
        for event in ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure"] {
            let command = hooks[event][0]["hooks"][0]["command"].as_str().unwrap();
            assert!(command.ends_with(" --grok-notify"));
            assert_eq!(hooks[event][0]["hooks"][0]["type"], "command");
            assert_eq!(hooks[event][0]["hooks"][0]["timeout"], 5);
        }
    }

    #[test]
    fn installation_preserves_siblings_and_refuses_foreign_target() {
        let directory = tempfile::tempdir().unwrap();
        let sibling = directory.path().join("existing-user-hook.json");
        let sibling_bytes = br#"{"hooks":{"PreToolUse":[]}}"#;
        fs::write(&sibling, sibling_bytes).unwrap();

        ensure_configured_at(directory.path(), Path::new(r"C:\Apps\IHATECODING.exe")).unwrap();
        assert_eq!(fs::read(&sibling).unwrap(), sibling_bytes);
        let target = directory.path().join(HOOK_FILE_NAME);
        let installed = fs::read(&target).unwrap();
        assert!(is_owned_manifest(&installed));

        let foreign = br#"{"hooks":{"SessionStart":[]}}"#;
        fs::write(&target, foreign).unwrap();
        let error =
            ensure_configured_at(directory.path(), Path::new(r"C:\Elsewhere\IHATECODING.exe"))
                .unwrap_err();
        assert!(error.contains("left unchanged"));
        assert_eq!(fs::read(target).unwrap(), foreign);
        assert_eq!(fs::read(sibling).unwrap(), sibling_bytes);
    }

    #[test]
    fn owned_manifest_updates_atomically_without_temp_files() {
        let directory = tempfile::tempdir().unwrap();
        ensure_configured_at(directory.path(), Path::new(r"C:\Old\IHATECODING.exe")).unwrap();
        ensure_configured_at(directory.path(), Path::new(r"C:\New\IHATECODING.exe")).unwrap();
        let target = directory.path().join(HOOK_FILE_NAME);
        let installed = fs::read_to_string(target).unwrap();
        assert!(installed.contains("New"));
        assert!(!installed.contains("Old"));
        assert_eq!(
            fs::read_dir(directory.path())
                .unwrap()
                .flatten()
                .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
                .count(),
            0
        );
    }

    #[test]
    fn event_reads_are_repeatable_and_exact_acknowledgement_preserves_others() {
        let directory = tempfile::tempdir().unwrap();
        let first_runtime = Uuid::new_v4().simple().to_string();
        let second_runtime = Uuid::new_v4().simple().to_string();
        let first_route = route_path_at(directory.path(), &first_runtime).unwrap();
        let second_route = route_path_at(directory.path(), &second_runtime).unwrap();
        let first_session = Uuid::new_v4();
        let second_session = Uuid::new_v4();

        let prompt = GrokHookEventRecord {
            session_id: first_session.to_string(),
            event: GrokHookEvent::UserPromptSubmit,
            observed_at_unix_ms: 20,
        };
        let started = GrokHookEventRecord {
            session_id: first_session.to_string(),
            event: GrokHookEvent::SessionStart,
            observed_at_unix_ms: 10,
        };
        let failed_at_same_time = GrokHookEventRecord {
            session_id: first_session.to_string(),
            event: GrokHookEvent::StopFailure,
            observed_at_unix_ms: 20,
        };
        let second_stop = GrokHookEventRecord {
            session_id: second_session.to_string(),
            event: GrokHookEvent::Stop,
            observed_at_unix_ms: 15,
        };
        for record in [&prompt, &started, &failed_at_same_time] {
            write_event(&first_route, record).unwrap();
        }
        write_event(&second_route, &second_stop).unwrap();

        let first_read = read_events_at(directory.path(), &first_runtime).unwrap();
        assert_eq!(first_read.len(), 3);
        assert_eq!(first_read[0], started);
        assert!(first_read.contains(&prompt));
        assert!(first_read.contains(&failed_at_same_time));
        assert_eq!(
            read_events_at(directory.path(), &first_runtime).unwrap(),
            first_read,
            "reading must not consume an event before state is saved"
        );
        assert_eq!(
            read_events_at(directory.path(), &second_runtime).unwrap(),
            vec![second_stop.clone()]
        );

        let absent = GrokHookEventRecord {
            event: GrokHookEvent::Stop,
            ..prompt.clone()
        };
        assert!(!acknowledge_event_at(directory.path(), &first_runtime, &absent).unwrap());
        assert_eq!(
            read_events_at(directory.path(), &first_runtime)
                .unwrap()
                .len(),
            3
        );

        assert!(acknowledge_event_at(directory.path(), &first_runtime, &prompt).unwrap());
        let remaining = read_events_at(directory.path(), &first_runtime).unwrap();
        assert_eq!(remaining.len(), 2);
        assert!(remaining.contains(&started));
        assert!(remaining.contains(&failed_at_same_time));
        assert!(!remaining.contains(&prompt));
        assert!(!acknowledge_event_at(directory.path(), &first_runtime, &prompt).unwrap());
        assert_eq!(
            read_events_at(directory.path(), &second_runtime).unwrap(),
            vec![second_stop]
        );
    }

    #[test]
    fn malformed_owned_event_is_cleaned_without_consuming_valid_events() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = Uuid::new_v4().simple().to_string();
        let route = route_path_at(directory.path(), &runtime).unwrap();
        let valid = GrokHookEventRecord {
            session_id: Uuid::new_v4().to_string(),
            event: GrokHookEvent::SessionStart,
            observed_at_unix_ms: 100,
        };
        write_event(&route, &valid).unwrap();
        let malformed = route.join(event_file_name(101, "0123456789abcdef0123456789abcdef"));
        fs::write(&malformed, b"not json").unwrap();

        assert_eq!(
            read_events_at(directory.path(), &runtime).unwrap(),
            vec![valid.clone()]
        );
        assert!(!malformed.exists());
        assert_eq!(
            read_events_at(directory.path(), &runtime).unwrap(),
            vec![valid]
        );
    }

    #[test]
    fn stale_cleanup_removes_only_owned_old_events() {
        let directory = tempfile::tempdir().unwrap();
        let stale_runtime = Uuid::new_v4().simple().to_string();
        let fresh_runtime = Uuid::new_v4().simple().to_string();
        let stale_route = route_path_at(directory.path(), &stale_runtime).unwrap();
        let fresh_route = route_path_at(directory.path(), &fresh_runtime).unwrap();
        let session_id = Uuid::new_v4().to_string();
        let now = ROUTE_TTL_MILLIS + 1_000;

        write_event(
            &stale_route,
            &GrokHookEventRecord {
                session_id: session_id.clone(),
                event: GrokHookEvent::Stop,
                observed_at_unix_ms: 999,
            },
        )
        .unwrap();
        write_event(
            &fresh_route,
            &GrokHookEventRecord {
                session_id,
                event: GrokHookEvent::UserPromptSubmit,
                observed_at_unix_ms: now,
            },
        )
        .unwrap();
        let unrelated = directory.path().join("not-owned");
        fs::create_dir(&unrelated).unwrap();
        fs::write(unrelated.join("keep.txt"), b"keep").unwrap();

        cleanup_stale_routes_at(directory.path(), now);

        assert!(!stale_route.exists());
        assert!(fresh_route.exists());
        assert!(unrelated.join("keep.txt").exists());
    }

    #[test]
    fn event_file_names_are_strict() {
        let valid = event_file_name(42, "0123456789abcdef0123456789abcdef");
        assert_eq!(event_file_timestamp(&valid), Some(42));
        assert_eq!(event_file_timestamp("42-bad.event.json"), None);
        assert_eq!(event_file_timestamp("../../secret"), None);
        let claim = format!(".{valid}.0123456789abcdef0123456789abcdef.claim");
        assert_eq!(claimed_event_timestamp(&claim), Some(42));
    }

    #[test]
    fn event_names_round_trip_exactly() {
        for event in [
            GrokHookEvent::SessionStart,
            GrokHookEvent::UserPromptSubmit,
            GrokHookEvent::Stop,
            GrokHookEvent::StopFailure,
        ] {
            assert_eq!(GrokHookEvent::parse(event.as_str()), Some(event));
        }
    }
}
