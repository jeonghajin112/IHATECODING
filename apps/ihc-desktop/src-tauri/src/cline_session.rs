use serde::Deserialize;
use std::{
    collections::HashSet,
    env, fs,
    io::Read,
    path::{Path, PathBuf},
};

#[cfg(windows)]
use std::os::windows::fs::MetadataExt;
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

const MAX_SESSION_ID_BYTES: usize = 128;
const MAX_PROVIDER_ID_BYTES: usize = 256;
const MAX_SESSION_DIRECTORIES: usize = 4_096;
const MAX_SESSION_METADATA_BYTES: u64 = 64 * 1024;
const MAX_SESSION_MESSAGES_BYTES: u64 = 64 * 1024 * 1024;
const MAX_EXCLUDED_SESSION_IDS: usize = 4_096;
const MAX_TURN_SCAN_MESSAGES: usize = 4_096;
const MAX_TURN_TEXT_BYTES: usize = 32 * 1024;
const MAX_MESSAGE_ID_BYTES: usize = 512;

#[derive(Debug, Deserialize)]
struct SessionMetadata {
    session_id: String,
    pid: u32,
    cwd: String,
    #[serde(default)]
    workspace_root: Option<String>,
    started_at: String,
    #[serde(default)]
    ended_at: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    interactive: bool,
}

#[derive(Debug, Deserialize)]
struct SessionMessages {
    messages: Vec<SessionMessage>,
}

#[derive(Debug, Deserialize)]
struct SessionMessage {
    #[serde(default)]
    id: Option<String>,
    role: String,
    content: serde_json::Value,
    #[serde(default)]
    ts: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ClineMessageSnapshot {
    pub(crate) key: String,
    pub(crate) observed_at_unix_ms: u64,
    pub(crate) text: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ClineTurnSnapshot {
    pub(crate) prompt: ClineMessageSnapshot,
    pub(crate) response: Option<ClineMessageSnapshot>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ClineMessagesStamp {
    length: u64,
    modified: std::time::SystemTime,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ClineTurnSnapshotRead {
    Missing,
    Unchanged,
    Changed {
        stamp: ClineMessagesStamp,
        snapshot: Option<ClineTurnSnapshot>,
    },
}

#[derive(Debug)]
struct SessionDirectory {
    path: PathBuf,
    modified: std::time::SystemTime,
}

pub(crate) fn is_valid_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_SESSION_ID_BYTES
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

pub(crate) fn validate_session_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if !is_valid_session_id(value) {
        return Err("The Cline session identifier is invalid.".to_owned());
    }
    Ok(value.to_owned())
}

pub(crate) fn discover_session_with_preferred(
    process_tree_ids: &HashSet<u32>,
    cwd: &str,
    not_before_utc: &str,
    preferred_session_id: Option<&str>,
) -> Result<Option<String>, String> {
    let root = cline_session_root()
        .ok_or_else(|| "The Cline session directory is unavailable.".to_owned())?;
    discover_session_with_preferred_in(
        &root,
        process_tree_ids,
        cwd,
        not_before_utc,
        preferred_session_id,
    )
}

pub(crate) fn session_exists(session_id: &str) -> Result<bool, String> {
    let session_id = validate_session_id(session_id)?;
    let root = cline_session_root()
        .ok_or_else(|| "The Cline session directory is unavailable.".to_owned())?;
    session_exists_in(&root, &session_id)
}

/// Find a stopped, non-empty Cline CLI session for a legacy pane that was
/// created before durable Cline bindings were available.
///
/// The caller must pass every session already owned by another pane and call
/// this serially while persisting each returned claim. Active sessions are
/// deliberately ineligible so a just-launched empty TUI cannot replace the
/// conversation that the pane is meant to recover.
pub(crate) fn recover_recent_session(
    cwd: &str,
    not_before_utc: &str,
    not_after_utc: &str,
    excluded_session_ids: &[String],
) -> Result<Option<String>, String> {
    let root = cline_session_root()
        .ok_or_else(|| "The Cline session directory is unavailable.".to_owned())?;
    recover_recent_session_in(
        &root,
        cwd,
        not_before_utc,
        not_after_utc,
        excluded_session_ids,
    )
}

/// Read the latest user-visible Cline turn only when its messages file has
/// changed. Cline rewrites this JSON while a response is streaming, so an
/// incomplete document is reported as an error and the caller must retain its
/// previous stamp and retry on the next poll.
pub(crate) fn read_turn_snapshot_if_changed(
    session_id: &str,
    previous: Option<&ClineMessagesStamp>,
) -> Result<ClineTurnSnapshotRead, String> {
    let session_id = validate_session_id(session_id)?;
    let root = cline_session_root()
        .ok_or_else(|| "The Cline session directory is unavailable.".to_owned())?;
    read_turn_snapshot_if_changed_in(&root, &session_id, previous)
}

fn cline_session_root() -> Option<PathBuf> {
    if let Some(override_root) = env::var_os("CLINE_SESSION_DATA_DIR")
        && !override_root.is_empty()
    {
        return Some(PathBuf::from(override_root));
    }
    let data_root = if let Some(override_root) = env::var_os("CLINE_DATA_DIR")
        && !override_root.is_empty()
    {
        PathBuf::from(override_root)
    } else if let Some(override_root) = env::var_os("CLINE_DIR")
        && !override_root.is_empty()
    {
        PathBuf::from(override_root).join("data")
    } else {
        dirs::home_dir()?.join(".cline").join("data")
    };
    Some(data_root.join("sessions"))
}

#[cfg(test)]
fn discover_session_in(
    root: &Path,
    process_tree_ids: &HashSet<u32>,
    cwd: &str,
    not_before_utc: &str,
) -> Result<Option<String>, String> {
    discover_session_with_preferred_in(root, process_tree_ids, cwd, not_before_utc, None)
}

fn discover_session_with_preferred_in(
    root: &Path,
    process_tree_ids: &HashSet<u32>,
    cwd: &str,
    not_before_utc: &str,
    preferred_session_id: Option<&str>,
) -> Result<Option<String>, String> {
    if !is_fixed_utc_timestamp(not_before_utc) {
        return Err("The Cline discovery timestamp is invalid.".to_owned());
    }
    let expected_cwd = normalized_path(cwd)
        .ok_or_else(|| "The Cline discovery working directory is invalid.".to_owned())?;
    if !validate_session_root(root)? {
        return Ok(None);
    }

    if let Some(preferred_session_id) = preferred_session_id.filter(|id| is_valid_session_id(id))
        && let Ok(Some(record)) = load_session_metadata(root, preferred_session_id)
        && is_trusted_session_metadata(
            &record,
            preferred_session_id,
            process_tree_ids,
            &expected_cwd,
            None,
        )
    {
        return Ok(Some(record.session_id));
    }

    let mut directories = Vec::new();
    let entries = fs::read_dir(root)
        .map_err(|_| "The Cline session directory could not be read.".to_owned())?;
    for (index, entry) in entries.enumerate() {
        if index >= MAX_SESSION_DIRECTORIES {
            break;
        }
        let Ok(entry) = entry else { continue };
        let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if !metadata.is_dir() || is_reparse_point(&metadata) {
            continue;
        }
        directories.push(SessionDirectory {
            path: entry.path(),
            modified: metadata.modified().unwrap_or(std::time::UNIX_EPOCH),
        });
    }
    directories.sort_unstable_by_key(|entry| std::cmp::Reverse(entry.modified));

    let mut candidates = Vec::new();
    for directory in directories {
        let Some(directory_name) = directory.path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !is_valid_session_id(directory_name) {
            continue;
        }
        let Ok(Some(record)) = load_session_metadata(root, directory_name) else {
            continue;
        };
        if !is_trusted_session_metadata(
            &record,
            directory_name,
            process_tree_ids,
            &expected_cwd,
            Some(not_before_utc),
        ) {
            continue;
        }
        candidates.push(record.session_id);
    }

    if candidates.len() == 1 {
        return Ok(candidates.pop());
    }
    Ok(None)
}

fn recover_recent_session_in(
    root: &Path,
    cwd: &str,
    not_before_utc: &str,
    not_after_utc: &str,
    excluded_session_ids: &[String],
) -> Result<Option<String>, String> {
    if !is_fixed_utc_timestamp(not_before_utc)
        || !is_fixed_utc_timestamp(not_after_utc)
        || not_before_utc > not_after_utc
    {
        return Err("The Cline recovery time range is invalid.".to_owned());
    }
    if excluded_session_ids.len() > MAX_EXCLUDED_SESSION_IDS
        || excluded_session_ids
            .iter()
            .any(|session_id| !is_valid_session_id(session_id))
    {
        return Err("The Cline recovery exclusion list is invalid.".to_owned());
    }
    let excluded = excluded_session_ids
        .iter()
        .map(|session_id| session_id.to_ascii_lowercase())
        .collect::<HashSet<_>>();
    let expected_cwd = normalized_path(cwd)
        .ok_or_else(|| "The Cline recovery working directory is invalid.".to_owned())?;
    if !validate_session_root(root)? {
        return Ok(None);
    }

    let mut directories = Vec::new();
    let entries = fs::read_dir(root)
        .map_err(|_| "The Cline session directory could not be read.".to_owned())?;
    for (index, entry) in entries.enumerate() {
        if index >= MAX_SESSION_DIRECTORIES {
            break;
        }
        let Ok(entry) = entry else { continue };
        let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if !metadata.is_dir() || is_reparse_point(&metadata) {
            continue;
        }
        directories.push(SessionDirectory {
            path: entry.path(),
            modified: metadata.modified().unwrap_or(std::time::UNIX_EPOCH),
        });
    }
    directories.sort_unstable_by_key(|entry| std::cmp::Reverse(entry.modified));

    let mut candidates = Vec::new();
    for directory in directories {
        let Some(directory_name) = directory.path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !is_valid_session_id(directory_name)
            || excluded.contains(&directory_name.to_ascii_lowercase())
        {
            continue;
        }
        let Ok(Some(record)) = load_session_metadata(root, directory_name) else {
            continue;
        };
        let Some(ended_at) = record.ended_at.as_deref() else {
            // A running session, including a newly opened empty home screen,
            // is never a legacy recovery candidate.
            continue;
        };
        if !is_fixed_utc_timestamp(ended_at)
            || record.started_at.as_str() < not_before_utc
            || ended_at > not_after_utc
            || ended_at < record.started_at.as_str()
            || !is_recoverable_session_metadata(&record, directory_name, &expected_cwd)
            || !matches!(session_has_user_message(root, directory_name), Ok(true))
        {
            continue;
        }
        candidates.push((ended_at.to_owned(), record.session_id));
    }

    // This heuristic is used only by the one-time legacy migration after the
    // frontend has established that exactly one unbound pane owns this cwd.
    // Sequential app restarts can leave several stopped records for that one
    // pane, so retain the last completed conversation. Newly launched panes
    // use descendant-PID discovery and never rely on this heuristic.
    candidates.sort_unstable_by(|left, right| right.0.cmp(&left.0));
    Ok(candidates
        .into_iter()
        .next()
        .map(|(_, session_id)| session_id))
}

fn session_exists_in(root: &Path, session_id: &str) -> Result<bool, String> {
    if !is_valid_session_id(session_id) {
        return Err("The Cline session identifier is invalid.".to_owned());
    }

    if !validate_session_root(root)? {
        return Ok(false);
    }
    Ok(load_session_metadata(root, session_id)?.is_some())
}

fn read_turn_snapshot_if_changed_in(
    root: &Path,
    session_id: &str,
    previous: Option<&ClineMessagesStamp>,
) -> Result<ClineTurnSnapshotRead, String> {
    if !is_valid_session_id(session_id) {
        return Err("The Cline session identifier is invalid.".to_owned());
    }
    if !validate_session_root(root)? {
        return Ok(ClineTurnSnapshotRead::Missing);
    }

    let session_directory = root.join(session_id);
    let directory_metadata = match fs::symlink_metadata(&session_directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ClineTurnSnapshotRead::Missing);
        }
        Err(_) => return Err("The Cline session could not be read.".to_owned()),
    };
    if !directory_metadata.is_dir() || is_reparse_point(&directory_metadata) {
        return Err("The Cline session directory is unsafe.".to_owned());
    }

    let path = session_directory.join(format!("{session_id}.messages.json"));
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ClineTurnSnapshotRead::Missing);
        }
        Err(_) => return Err("The Cline session messages could not be read.".to_owned()),
    };
    if !metadata.is_file() || is_reparse_point(&metadata) {
        return Err("The Cline session messages file is unsafe.".to_owned());
    }
    if metadata.len() > MAX_SESSION_MESSAGES_BYTES {
        return Err("The Cline session messages file is too large.".to_owned());
    }
    let stamp = ClineMessagesStamp {
        length: metadata.len(),
        modified: metadata.modified().unwrap_or(std::time::UNIX_EPOCH),
    };
    if previous == Some(&stamp) {
        return Ok(ClineTurnSnapshotRead::Unchanged);
    }

    let raw = read_bounded_file(&path, MAX_SESSION_MESSAGES_BYTES)
        .map_err(|_| "The Cline session messages could not be read.".to_owned())?
        .ok_or_else(|| "The Cline session messages file is too large.".to_owned())?;
    let messages = serde_json::from_slice::<SessionMessages>(&raw)
        .map_err(|_| "The Cline session messages are still being updated.".to_owned())?;
    Ok(ClineTurnSnapshotRead::Changed {
        stamp,
        snapshot: latest_turn_snapshot(&messages.messages),
    })
}

fn latest_turn_snapshot(messages: &[SessionMessage]) -> Option<ClineTurnSnapshot> {
    let scan_start = messages.len().saturating_sub(MAX_TURN_SCAN_MESSAGES);
    let (prompt_index, prompt, prompt_text) = messages
        .iter()
        .enumerate()
        .skip(scan_start)
        .rev()
        .find_map(|(index, message)| {
            message
                .role
                .eq_ignore_ascii_case("user")
                .then(|| actual_user_text(&message.content))
                .flatten()
                .map(|text| (index, message, text))
        })?;

    // A completed Cline response is the last assistant message for this user
    // prompt and contains only user-visible text plus optional thinking blocks.
    // Any tool_use block means the turn is still active, including when one or
    // more tool_result messages follow it.
    let last_assistant = messages
        .iter()
        .enumerate()
        .skip(prompt_index.saturating_add(1))
        .rfind(|(_, message)| message.role.eq_ignore_ascii_case("assistant"));
    let response = last_assistant.and_then(|(index, message)| {
        assistant_final_text(&message.content).map(|text| message_snapshot(index, message, text))
    });

    Some(ClineTurnSnapshot {
        prompt: message_snapshot(prompt_index, prompt, prompt_text),
        response,
    })
}

fn message_snapshot(index: usize, message: &SessionMessage, text: String) -> ClineMessageSnapshot {
    let key = message
        .id
        .as_deref()
        .filter(|id| {
            !id.is_empty() && id.len() <= MAX_MESSAGE_ID_BYTES && !id.chars().any(char::is_control)
        })
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("message:{index}:{}", message.ts.unwrap_or_default()));
    ClineMessageSnapshot {
        key,
        observed_at_unix_ms: message.ts.unwrap_or_default(),
        text,
    }
}

fn actual_user_text(content: &serde_json::Value) -> Option<String> {
    match content {
        serde_json::Value::String(value) => bounded_nonempty_text([value.as_str()]),
        serde_json::Value::Object(block) => {
            if block.get("type").and_then(serde_json::Value::as_str) != Some("text") {
                return None;
            }
            bounded_nonempty_text(block.get("text").and_then(serde_json::Value::as_str))
        }
        serde_json::Value::Array(blocks) => {
            if blocks.iter().any(|block| {
                block.get("type").and_then(serde_json::Value::as_str) == Some("tool_result")
            }) {
                return None;
            }
            bounded_nonempty_text(blocks.iter().filter_map(|block| {
                (block.get("type").and_then(serde_json::Value::as_str) == Some("text"))
                    .then(|| block.get("text").and_then(serde_json::Value::as_str))
                    .flatten()
            }))
        }
        _ => None,
    }
}

fn assistant_final_text(content: &serde_json::Value) -> Option<String> {
    match content {
        serde_json::Value::String(value) => bounded_nonempty_text([value.as_str()]),
        serde_json::Value::Object(block) => {
            if block.get("type").and_then(serde_json::Value::as_str) != Some("text") {
                return None;
            }
            bounded_nonempty_text(block.get("text").and_then(serde_json::Value::as_str))
        }
        serde_json::Value::Array(blocks) => {
            if blocks.iter().any(|block| {
                !matches!(
                    block.get("type").and_then(serde_json::Value::as_str),
                    Some("text" | "thinking" | "redacted_thinking")
                )
            }) {
                return None;
            }
            bounded_nonempty_text(blocks.iter().filter_map(|block| {
                (block.get("type").and_then(serde_json::Value::as_str) == Some("text"))
                    .then(|| block.get("text").and_then(serde_json::Value::as_str))
                    .flatten()
            }))
        }
        _ => None,
    }
}

fn bounded_nonempty_text<'a>(parts: impl IntoIterator<Item = &'a str>) -> Option<String> {
    let mut output = String::new();
    for part in parts {
        let part = part.trim();
        if part.is_empty() || output.len() >= MAX_TURN_TEXT_BYTES {
            continue;
        }
        if !output.is_empty() {
            output.push('\n');
        }
        let available = MAX_TURN_TEXT_BYTES.saturating_sub(output.len());
        if part.len() <= available {
            output.push_str(part);
        } else {
            let boundary = part
                .char_indices()
                .map(|(index, _)| index)
                .take_while(|index| *index <= available)
                .last()
                .unwrap_or(0);
            output.push_str(&part[..boundary]);
        }
    }
    (!output.trim().is_empty()).then_some(output)
}

fn validate_session_root(root: &Path) -> Result<bool, String> {
    let root_metadata = match fs::symlink_metadata(root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err("The Cline session directory could not be read.".to_owned()),
    };
    if !root_metadata.is_dir() || is_reparse_point(&root_metadata) {
        return Err("The Cline session directory is unsafe.".to_owned());
    }
    Ok(true)
}

fn load_session_metadata(root: &Path, session_id: &str) -> Result<Option<SessionMetadata>, String> {
    if !is_valid_session_id(session_id) {
        return Err("The Cline session identifier is invalid.".to_owned());
    }
    let session_directory = root.join(session_id);
    let directory_metadata = match fs::symlink_metadata(&session_directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("The Cline session could not be read.".to_owned()),
    };
    if !directory_metadata.is_dir() || is_reparse_point(&directory_metadata) {
        return Err("The Cline session directory is unsafe.".to_owned());
    }

    let metadata_path = session_directory.join(format!("{session_id}.json"));
    let file_metadata = match fs::symlink_metadata(&metadata_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("The Cline session metadata could not be read.".to_owned()),
    };
    if !file_metadata.is_file() || is_reparse_point(&file_metadata) {
        return Err("The Cline session metadata is unsafe.".to_owned());
    }
    if file_metadata.len() > MAX_SESSION_METADATA_BYTES {
        return Ok(None);
    }

    let raw = read_bounded_file(&metadata_path, MAX_SESSION_METADATA_BYTES)
        .map_err(|_| "The Cline session metadata could not be read.".to_owned())?;
    let Some(raw) = raw else { return Ok(None) };
    let Ok(record) = serde_json::from_slice::<SessionMetadata>(&raw) else {
        return Ok(None);
    };
    if record.session_id != session_id || !is_valid_session_id(&record.session_id) {
        return Ok(None);
    }
    Ok(Some(record))
}

fn is_trusted_session_metadata(
    record: &SessionMetadata,
    expected_session_id: &str,
    process_tree_ids: &HashSet<u32>,
    expected_cwd: &str,
    not_before_utc: Option<&str>,
) -> bool {
    record.session_id == expected_session_id
        && is_valid_session_id(&record.session_id)
        && record.interactive
        && is_fixed_utc_timestamp(&record.started_at)
        && not_before_utc.is_none_or(|not_before| record.started_at.as_str() >= not_before)
        && record
            .source
            .as_deref()
            .is_some_and(|source| source.eq_ignore_ascii_case("cli"))
        && record
            .provider
            .as_deref()
            // This is the selected model provider, not the identity of the
            // process that wrote the manifest. Cline legitimately writes
            // values such as `cline-pass`, `openrouter`, or `anthropic` here.
            // The CLI source flag, descendant PID, working directory, and
            // session-root checks above establish ownership instead.
            .is_some_and(is_valid_provider_id)
        && process_tree_ids.contains(&record.pid)
        && (normalized_path(&record.cwd).as_deref() == Some(expected_cwd)
            || record
                .workspace_root
                .as_deref()
                .and_then(normalized_path)
                .as_deref()
                == Some(expected_cwd))
}

fn is_recoverable_session_metadata(
    record: &SessionMetadata,
    expected_session_id: &str,
    expected_cwd: &str,
) -> bool {
    record.session_id == expected_session_id
        && is_valid_session_id(&record.session_id)
        && record.interactive
        && is_fixed_utc_timestamp(&record.started_at)
        && record
            .source
            .as_deref()
            .is_some_and(|source| source.eq_ignore_ascii_case("cli"))
        && record.provider.as_deref().is_some_and(is_valid_provider_id)
        && (normalized_path(&record.cwd).as_deref() == Some(expected_cwd)
            || record
                .workspace_root
                .as_deref()
                .and_then(normalized_path)
                .as_deref()
                == Some(expected_cwd))
}

fn is_valid_provider_id(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= MAX_PROVIDER_ID_BYTES
        && !value.chars().any(char::is_control)
}

fn read_bounded_file(path: &Path, max_bytes: u64) -> std::io::Result<Option<Vec<u8>>> {
    let file = fs::File::open(path)?;
    let mut reader = file.take(max_bytes.saturating_add(1));
    let mut raw = Vec::new();
    reader.read_to_end(&mut raw)?;
    if raw.len() as u64 > max_bytes {
        return Ok(None);
    }
    Ok(Some(raw))
}

fn session_has_user_message(root: &Path, session_id: &str) -> Result<bool, String> {
    let path = root
        .join(session_id)
        .join(format!("{session_id}.messages.json"));
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err("The Cline session messages could not be read.".to_owned()),
    };
    if !metadata.is_file()
        || is_reparse_point(&metadata)
        || metadata.len() > MAX_SESSION_MESSAGES_BYTES
    {
        return Ok(false);
    }
    let raw = read_bounded_file(&path, MAX_SESSION_MESSAGES_BYTES)
        .map_err(|_| "The Cline session messages could not be read.".to_owned())?;
    let Some(raw) = raw else { return Ok(false) };
    let Ok(messages) = serde_json::from_slice::<SessionMessages>(&raw) else {
        return Ok(false);
    };
    Ok(messages.messages.iter().any(|message| {
        message.role.eq_ignore_ascii_case("user") && json_contains_nonempty_text(&message.content)
    }))
}

fn json_contains_nonempty_text(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::String(value) => !value.trim().is_empty(),
        serde_json::Value::Array(values) => values.iter().any(json_contains_nonempty_text),
        serde_json::Value::Object(values) => {
            values.get("text").is_some_and(json_contains_nonempty_text)
        }
        _ => false,
    }
}

fn normalized_path(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 32 * 1024 || trimmed.chars().any(char::is_control) {
        return None;
    }
    let mut normalized = trimmed.replace('/', "\\");
    while normalized.len() > 3 && normalized.ends_with('\\') {
        normalized.pop();
    }
    Some(normalized.to_ascii_lowercase())
}

fn is_fixed_utc_timestamp(value: &str) -> bool {
    if value.len() != 24 || !value.ends_with('Z') {
        return false;
    }
    for (index, expected) in [
        (4, b'-'),
        (7, b'-'),
        (10, b'T'),
        (13, b':'),
        (16, b':'),
        (19, b'.'),
        (23, b'Z'),
    ] {
        if value.as_bytes().get(index) != Some(&expected) {
            return false;
        }
    }
    value.bytes().enumerate().all(|(index, byte)| {
        matches!(index, 4 | 7 | 10 | 13 | 16 | 19 | 23) || byte.is_ascii_digit()
    })
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    fn session_message(
        id: &str,
        role: &str,
        ts: u64,
        content: serde_json::Value,
    ) -> SessionMessage {
        SessionMessage {
            id: Some(id.to_owned()),
            role: role.to_owned(),
            content,
            ts: Some(ts),
        }
    }

    #[test]
    fn turn_snapshot_ignores_tool_results_and_requires_a_final_text_only_assistant() {
        let mut messages = vec![
            session_message(
                "prompt-1",
                "user",
                10,
                serde_json::json!([{"type":"text","text":"build it"}]),
            ),
            session_message(
                "assistant-tool",
                "assistant",
                11,
                serde_json::json!([
                    {"type":"thinking","thinking":"checking"},
                    {"type":"text","text":"I will inspect it."},
                    {"type":"tool_use","id":"tool-1","name":"read_files","input":{}}
                ]),
            ),
            session_message(
                "tool-result",
                "user",
                12,
                serde_json::json!([{
                    "type":"tool_result",
                    "tool_use_id":"tool-1",
                    "content":[{"type":"text","text":"this is not a prompt"}]
                }]),
            ),
        ];
        let active = latest_turn_snapshot(&messages).unwrap();
        assert_eq!(active.prompt.key, "prompt-1");
        assert_eq!(active.prompt.text, "build it");
        assert!(active.response.is_none());

        messages.push(session_message(
            "assistant-final",
            "assistant",
            13,
            serde_json::json!([
                {"type":"thinking","thinking":"done"},
                {"type":"text","text":"The work is complete."}
            ]),
        ));
        let finished = latest_turn_snapshot(&messages).unwrap();
        assert_eq!(
            finished
                .response
                .as_ref()
                .map(|response| response.key.as_str()),
            Some("assistant-final")
        );
        assert_eq!(finished.response.unwrap().text, "The work is complete.");

        messages.push(session_message(
            "prompt-2",
            "user",
            14,
            serde_json::json!([{"type":"text","text":"next task"}]),
        ));
        let next = latest_turn_snapshot(&messages).unwrap();
        assert_eq!(next.prompt.key, "prompt-2");
        assert!(next.response.is_none());
    }

    #[test]
    fn turn_snapshot_text_and_scan_work_are_bounded() {
        let oversized = "한".repeat(MAX_TURN_TEXT_BYTES);
        let mut messages = (0..(MAX_TURN_SCAN_MESSAGES + 2))
            .map(|index| {
                session_message(
                    &format!("tool-{index}"),
                    "user",
                    index as u64,
                    serde_json::json!([{
                        "type":"tool_result",
                        "tool_use_id":"tool",
                        "content": oversized
                    }]),
                )
            })
            .collect::<Vec<_>>();
        messages.push(session_message(
            "latest-prompt",
            "user",
            99_999,
            serde_json::json!([{"type":"text","text":oversized}]),
        ));
        let snapshot = latest_turn_snapshot(&messages).unwrap();
        assert_eq!(snapshot.prompt.key, "latest-prompt");
        assert!(snapshot.prompt.text.len() <= MAX_TURN_TEXT_BYTES);
        assert!(std::str::from_utf8(snapshot.prompt.text.as_bytes()).is_ok());
    }

    #[test]
    fn changed_reader_retries_partial_json_without_advancing_the_stamp() {
        let temp = TempDir::new().unwrap();
        let id = "1784625220378_watch";
        let directory = temp.path().join(id);
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join(format!("{id}.messages.json"));
        fs::write(&path, br#"{"messages":[]}"#).unwrap();
        let first = read_turn_snapshot_if_changed_in(temp.path(), id, None).unwrap();
        let ClineTurnSnapshotRead::Changed { stamp, snapshot } = first else {
            panic!("expected the initial messages document");
        };
        assert!(snapshot.is_none());
        assert_eq!(
            read_turn_snapshot_if_changed_in(temp.path(), id, Some(&stamp)).unwrap(),
            ClineTurnSnapshotRead::Unchanged
        );

        fs::write(&path, br#"{"messages":["#).unwrap();
        assert!(read_turn_snapshot_if_changed_in(temp.path(), id, Some(&stamp)).is_err());
        fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({
                "messages": [{
                    "id":"prompt",
                    "role":"user",
                    "ts":20,
                    "content":[{"type":"text","text":"hello"}]
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        let recovered = read_turn_snapshot_if_changed_in(temp.path(), id, Some(&stamp)).unwrap();
        assert!(matches!(
            recovered,
            ClineTurnSnapshotRead::Changed {
                snapshot: Some(ClineTurnSnapshot { response: None, .. }),
                ..
            }
        ));
    }

    fn write_record(
        root: &Path,
        id: &str,
        pid: u32,
        cwd: &str,
        started_at: &str,
        interactive: bool,
    ) {
        write_record_with_provider(root, id, pid, cwd, started_at, interactive, "cline");
    }

    fn write_record_with_provider(
        root: &Path,
        id: &str,
        pid: u32,
        cwd: &str,
        started_at: &str,
        interactive: bool,
        provider: &str,
    ) {
        let directory = root.join(id);
        fs::create_dir_all(&directory).unwrap();
        let mut file = fs::File::create(directory.join(format!("{id}.json"))).unwrap();
        write!(
            file,
            "{}",
            serde_json::json!({
                "session_id": id,
                "pid": pid,
                "cwd": cwd,
                "workspace_root": cwd,
                "started_at": started_at,
                "source": "cli",
                "provider": provider,
                "interactive": interactive
            })
        )
        .unwrap();
    }

    fn write_recovery_record(
        root: &Path,
        id: &str,
        pid: u32,
        cwd: &str,
        started_at: &str,
        ended_at: Option<&str>,
        user_text: Option<&str>,
    ) {
        write_record_with_provider(root, id, pid, cwd, started_at, true, "cline-pass");
        let metadata_path = root.join(id).join(format!("{id}.json"));
        let mut metadata =
            serde_json::from_slice::<serde_json::Value>(&fs::read(&metadata_path).unwrap())
                .unwrap();
        if let Some(ended_at) = ended_at {
            metadata["ended_at"] = serde_json::Value::String(ended_at.to_owned());
        }
        fs::write(&metadata_path, serde_json::to_vec(&metadata).unwrap()).unwrap();

        let messages = user_text.map_or_else(Vec::new, |text| {
            vec![serde_json::json!({
                "role": "user",
                "content": [{ "type": "text", "text": text }]
            })]
        });
        fs::write(
            root.join(id).join(format!("{id}.messages.json")),
            serde_json::to_vec(&serde_json::json!({ "messages": messages })).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn discovery_accepts_the_model_provider_ids_written_by_cline() {
        for provider in ["cline-pass", "openrouter", "anthropic"] {
            let temp = TempDir::new().unwrap();
            write_record_with_provider(
                temp.path(),
                "1784625220378_provider",
                41,
                "C:\\Work\\Same",
                "2026-07-21T09:13:40.381Z",
                true,
                provider,
            );
            assert_eq!(
                discover_session_in(
                    temp.path(),
                    &HashSet::from([41]),
                    "C:\\Work\\Same",
                    "2026-07-21T09:00:00.000Z",
                )
                .unwrap(),
                Some("1784625220378_provider".to_owned()),
                "provider {provider} should remain resumable",
            );
        }
    }

    #[test]
    fn discovery_rejects_missing_or_control_character_provider_ids() {
        for provider in ["", "cline\npass"] {
            let temp = TempDir::new().unwrap();
            write_record_with_provider(
                temp.path(),
                "1784625220378_provider",
                41,
                "C:\\Work\\Same",
                "2026-07-21T09:13:40.381Z",
                true,
                provider,
            );
            assert_eq!(
                discover_session_in(
                    temp.path(),
                    &HashSet::from([41]),
                    "C:\\Work\\Same",
                    "2026-07-21T09:00:00.000Z",
                )
                .unwrap(),
                None,
            );
        }
    }

    #[test]
    fn recovery_selects_the_latest_stopped_nonempty_unowned_session() {
        let temp = TempDir::new().unwrap();
        write_recovery_record(
            temp.path(),
            "1784624743253_vmz14",
            41,
            "C:\\Work\\Same",
            "2026-07-21T09:05:43.258Z",
            Some("2026-07-21T09:13:40.117Z"),
            Some("first request"),
        );
        write_recovery_record(
            temp.path(),
            "1784625220378_6nsma",
            42,
            "C:\\Work\\Same",
            "2026-07-21T09:13:40.381Z",
            Some("2026-07-21T09:55:04.171Z"),
            Some("continued request"),
        );
        // A newly launched home screen is active and must never replace the
        // stopped conversation, even if it has already written a message file.
        write_recovery_record(
            temp.path(),
            "1784625600000_active",
            43,
            "C:\\Work\\Same",
            "2026-07-21T10:00:00.000Z",
            None,
            Some("not yet stopped"),
        );
        // A stopped session without a real user message is not a conversation.
        write_recovery_record(
            temp.path(),
            "1784625650000_blank",
            44,
            "C:\\Work\\Same",
            "2026-07-21T10:01:00.000Z",
            Some("2026-07-21T10:02:00.000Z"),
            None,
        );

        assert_eq!(
            recover_recent_session_in(
                temp.path(),
                "c:/work/same/",
                "2026-07-21T09:00:00.000Z",
                "2026-07-21T10:05:00.000Z",
                &[],
            )
            .unwrap(),
            Some("1784625220378_6nsma".to_owned()),
        );
        assert_eq!(
            recover_recent_session_in(
                temp.path(),
                "C:\\Work\\Same",
                "2026-07-21T09:00:00.000Z",
                "2026-07-21T10:05:00.000Z",
                &["1784625220378_6NSMA".to_owned()],
            )
            .unwrap(),
            Some("1784624743253_vmz14".to_owned()),
        );
        assert_eq!(
            recover_recent_session_in(
                temp.path(),
                "C:\\Work\\Same",
                "2026-07-21T09:00:00.000Z",
                "2026-07-21T10:05:00.000Z",
                &["1784624743253_VMZ14".to_owned()],
            )
            .unwrap(),
            Some("1784625220378_6nsma".to_owned()),
        );
    }

    #[test]
    fn recovery_scans_beyond_the_old_recent_directory_cutoff() {
        let temp = TempDir::new().unwrap();
        write_recovery_record(
            temp.path(),
            "1784625220378_target",
            41,
            "C:\\Work\\Same",
            "2026-07-21T09:13:40.381Z",
            Some("2026-07-21T09:55:04.171Z"),
            Some("request"),
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
        // These newer directories are irrelevant to this cwd, but previously
        // displaced the valid record before metadata filtering at 512 entries.
        for index in 0..512 {
            fs::create_dir(temp.path().join(format!("noise_{index:04}"))).unwrap();
        }

        assert_eq!(
            recover_recent_session_in(
                temp.path(),
                "C:\\Work\\Same",
                "2026-07-21T09:00:00.000Z",
                "2026-07-21T10:05:00.000Z",
                &[],
            )
            .unwrap(),
            Some("1784625220378_target".to_owned()),
        );
    }

    #[test]
    fn recovery_fails_closed_for_wrong_workspace_time_range_and_exclusions() {
        let temp = TempDir::new().unwrap();
        write_recovery_record(
            temp.path(),
            "1784625220378_candidate",
            41,
            "C:\\Work\\Same",
            "2026-07-21T09:13:40.381Z",
            Some("2026-07-21T09:55:04.171Z"),
            Some("request"),
        );

        assert_eq!(
            recover_recent_session_in(
                temp.path(),
                "C:\\Work\\Other",
                "2026-07-21T09:00:00.000Z",
                "2026-07-21T10:00:00.000Z",
                &[],
            )
            .unwrap(),
            None,
        );
        assert_eq!(
            recover_recent_session_in(
                temp.path(),
                "C:\\Work\\Same",
                "2026-07-21T09:56:00.000Z",
                "2026-07-21T10:00:00.000Z",
                &[],
            )
            .unwrap(),
            None,
        );
        assert!(
            recover_recent_session_in(
                temp.path(),
                "C:\\Work\\Same",
                "2026-07-21T10:00:00.000Z",
                "2026-07-21T09:00:00.000Z",
                &[],
            )
            .is_err()
        );
        assert!(
            recover_recent_session_in(
                temp.path(),
                "C:\\Work\\Same",
                "2026-07-21T09:00:00.000Z",
                "2026-07-21T10:00:00.000Z",
                &["../escape".to_owned()],
            )
            .is_err()
        );
    }

    #[test]
    fn session_identifier_is_opaque_but_shell_neutral() {
        assert!(is_valid_session_id("1784623042844_ugwq9"));
        assert!(is_valid_session_id("legacy.session-01"));
        assert!(!is_valid_session_id(""));
        assert!(!is_valid_session_id("' ; Remove-Item C:\\"));
        assert!(!is_valid_session_id(&"x".repeat(129)));
    }

    #[test]
    fn discovery_prefers_the_unique_descendant_pid() {
        let temp = TempDir::new().unwrap();
        write_record(
            temp.path(),
            "1784623042844_ugwq9",
            41,
            "C:\\Work\\Same",
            "2026-07-21T08:29:10.870Z",
            true,
        );
        write_record(
            temp.path(),
            "1784623042845_other",
            42,
            "C:\\Work\\Same",
            "2026-07-21T08:29:11.870Z",
            true,
        );
        let process_ids = HashSet::from([42]);
        assert_eq!(
            discover_session_in(
                temp.path(),
                &process_ids,
                "c:/work/same/",
                "2026-07-21T08:29:00.000Z"
            )
            .unwrap(),
            Some("1784623042845_other".to_owned())
        );
    }

    #[test]
    fn discovery_fails_closed_for_ambiguous_or_untrusted_records() {
        let temp = TempDir::new().unwrap();
        write_record(
            temp.path(),
            "1784623042844_first",
            41,
            "C:\\Work\\Same",
            "2026-07-21T08:29:10.870Z",
            true,
        );
        write_record(
            temp.path(),
            "1784623042845_second",
            42,
            "C:\\Work\\Same",
            "2026-07-21T08:29:11.870Z",
            true,
        );
        assert_eq!(
            discover_session_in(
                temp.path(),
                &HashSet::new(),
                "C:\\Work\\Same",
                "2026-07-21T08:29:00.000Z"
            )
            .unwrap(),
            None
        );
        assert_eq!(
            discover_session_in(
                temp.path(),
                &HashSet::from([41, 42]),
                "C:\\Work\\Same",
                "2026-07-21T08:29:00.000Z"
            )
            .unwrap(),
            None
        );
        assert_eq!(
            discover_session_in(
                temp.path(),
                &HashSet::from([41]),
                "C:\\Work\\Elsewhere",
                "2026-07-21T08:29:00.000Z"
            )
            .unwrap(),
            None
        );
        assert_eq!(
            discover_session_in(
                temp.path(),
                &HashSet::from([41]),
                "C:\\Work\\Same",
                "2026-07-21T09:00:00.000Z"
            )
            .unwrap(),
            None
        );
    }

    #[test]
    fn discovery_rejects_one_cwd_and_time_candidate_when_pid_is_external() {
        let temp = TempDir::new().unwrap();
        write_record(
            temp.path(),
            "1784623042844_unique",
            9_999,
            "C:\\Work\\Only",
            "2026-07-21T08:29:10.870Z",
            true,
        );
        assert_eq!(
            discover_session_in(
                temp.path(),
                &HashSet::from([41]),
                "C:\\Work\\Only",
                "2026-07-21T08:29:00.000Z"
            )
            .unwrap(),
            None
        );
    }

    #[test]
    fn discovery_returns_an_active_preferred_session_even_when_it_started_earlier() {
        let temp = TempDir::new().unwrap();
        write_record(
            temp.path(),
            "1784623042844_preferred",
            41,
            "C:\\Work\\Same",
            "2026-07-20T08:29:10.870Z",
            true,
        );
        write_record(
            temp.path(),
            "1784623042845_recent",
            42,
            "C:\\Work\\Same",
            "2026-07-21T08:29:11.870Z",
            true,
        );

        assert_eq!(
            discover_session_with_preferred_in(
                temp.path(),
                &HashSet::from([41, 42]),
                "C:\\Work\\Same",
                "2026-07-21T08:29:00.000Z",
                Some("1784623042844_preferred"),
            )
            .unwrap(),
            Some("1784623042844_preferred".to_owned())
        );
    }

    #[test]
    fn discovery_rejects_a_preferred_session_with_the_wrong_pid_then_falls_back() {
        let temp = TempDir::new().unwrap();
        write_record(
            temp.path(),
            "1784623042844_preferred",
            9_999,
            "C:\\Work\\Same",
            "2026-07-20T08:29:10.870Z",
            true,
        );
        write_record(
            temp.path(),
            "1784623042845_recent",
            42,
            "C:\\Work\\Same",
            "2026-07-21T08:29:11.870Z",
            true,
        );

        assert_eq!(
            discover_session_with_preferred_in(
                temp.path(),
                &HashSet::from([42]),
                "C:\\Work\\Same",
                "2026-07-21T08:29:00.000Z",
                Some("1784623042844_preferred"),
            )
            .unwrap(),
            Some("1784623042845_recent".to_owned())
        );

        assert_eq!(
            discover_session_with_preferred_in(
                temp.path(),
                &HashSet::from([43]),
                "C:\\Work\\Same",
                "2026-07-21T08:29:00.000Z",
                Some("1784623042844_preferred"),
            )
            .unwrap(),
            None
        );
    }

    #[test]
    fn session_exists_requires_matching_bounded_metadata() {
        let temp = TempDir::new().unwrap();
        write_record(
            temp.path(),
            "1784623042844_exists",
            41,
            "C:\\Work\\Same",
            "2026-07-21T08:29:10.870Z",
            true,
        );
        assert!(session_exists_in(temp.path(), "1784623042844_exists").unwrap());

        write_record(
            temp.path(),
            "1784623042845_mismatch",
            42,
            "C:\\Work\\Same",
            "2026-07-21T08:29:10.870Z",
            true,
        );
        let mismatch_path = temp
            .path()
            .join("1784623042845_mismatch")
            .join("1784623042845_mismatch.json");
        fs::write(&mismatch_path, br#"{"session_id":"another_session"}"#).unwrap();
        assert!(!session_exists_in(temp.path(), "1784623042845_mismatch").unwrap());

        let oversized_id = "1784623042846_oversized";
        let oversized_directory = temp.path().join(oversized_id);
        fs::create_dir_all(&oversized_directory).unwrap();
        fs::write(
            oversized_directory.join(format!("{oversized_id}.json")),
            vec![b'x'; MAX_SESSION_METADATA_BYTES as usize + 1],
        )
        .unwrap();
        assert!(!session_exists_in(temp.path(), oversized_id).unwrap());
    }

    #[test]
    fn session_exists_fails_closed_for_missing_or_invalid_sessions() {
        let temp = TempDir::new().unwrap();
        assert!(!session_exists_in(temp.path(), "1784623042844_missing").unwrap());
        assert!(session_exists_in(temp.path(), "../escape").is_err());
        assert!(validate_session_id("../escape").is_err());
    }
}
