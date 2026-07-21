use serde::{Deserialize, Serialize, de::IgnoredAny};
use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    ffi::OsStr,
    fs::{self, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

#[cfg(windows)]
use std::os::windows::{fs::MetadataExt, process::CommandExt};
#[cfg(windows)]
use windows_sys::Win32::{
    Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT, System::Threading::CREATE_NO_WINDOW,
};

const AUTH_FILE_MAX_BYTES: usize = 128 * 1024;
const CLAUDE_STDOUT_MAX_BYTES: usize = 64 * 1024;
const CLAUDE_AUTH_TIMEOUT: Duration = Duration::from_secs(3);
const CLAUDE_POLL_INTERVAL: Duration = Duration::from_millis(20);
const CURSOR_STDOUT_MAX_BYTES: usize = 64 * 1024;
const CURSOR_STATUS_TIMEOUT: Duration = Duration::from_secs(3);
const CURSOR_POLL_INTERVAL: Duration = Duration::from_millis(20);
const EMAIL_MAX_BYTES: usize = 254;
const COMMAND_EXTENSIONS: [&str; 4] = ["exe", "cmd", "ps1", "bat"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub(crate) enum AgentCliProvider {
    #[serde(rename = "codex")]
    Codex,
    #[serde(rename = "grok")]
    Grok,
    #[serde(rename = "claudeCode")]
    ClaudeCode,
    #[serde(rename = "openCode")]
    OpenCode,
    #[serde(rename = "cursor")]
    Cursor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub(crate) enum AgentCliConnectionStatus {
    #[serde(rename = "connected")]
    Connected,
    #[serde(rename = "credentialsPresent")]
    CredentialsPresent,
    #[serde(rename = "notAuthenticated")]
    NotAuthenticated,
    #[serde(rename = "unknown")]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentCliStatus {
    pub(crate) provider: AgentCliProvider,
    pub(crate) installed: bool,
    pub(crate) status: AgentCliConnectionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) credential_count: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct AgentCliStatusesResponse {
    pub(crate) agents: Vec<AgentCliStatus>,
}

#[derive(Debug, Default)]
struct CliInstallation {
    installed: bool,
    direct_exe: Option<PathBuf>,
}

#[derive(Debug, PartialEq, Eq)]
enum ClaudeAuthProbe {
    Known {
        logged_in: bool,
        email: Option<String>,
    },
    Unknown,
}

#[derive(Debug, PartialEq, Eq)]
enum CursorAuthProbe {
    Known {
        logged_in: bool,
        email: Option<String>,
    },
    Unknown,
}

#[derive(Debug)]
enum AuthFileRead {
    Missing,
    Valid(BTreeSet<String>),
    Invalid,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeAuthOutput {
    #[serde(default)]
    logged_in: bool,
    #[serde(default)]
    email: Option<String>,
}

pub(crate) fn read_agent_cli_statuses() -> AgentCliStatusesResponse {
    let path = env::var_os("PATH");
    let codex_installation = discover_cli("codex", path.as_deref());
    let grok_installation = discover_cli("grok", path.as_deref());
    let claude_installation = discover_cli("claude", path.as_deref());
    let opencode_installation = discover_cli("opencode", path.as_deref());
    let cursor_installation = discover_cursor_cli(path.as_deref());

    let codex_authenticated = crate::provider_usage::read_provider_account("codex")
        .ok()
        .flatten()
        .is_some();
    let grok_authenticated = crate::provider_usage::read_provider_account("grok")
        .ok()
        .flatten()
        .is_some();

    let claude_auth = claude_installation
        .direct_exe
        .as_deref()
        .map(run_claude_auth_status)
        .unwrap_or(ClaudeAuthProbe::Unknown);
    let (claude_status, claude_email) = claude_status_from_probe(claude_auth);

    let (opencode_status, credential_count) =
        read_opencode_auth_status(&default_opencode_auth_paths());
    let cursor_auth = cursor_installation
        .direct_exe
        .as_deref()
        .map(run_cursor_auth_status)
        .unwrap_or(CursorAuthProbe::Unknown);
    let (cursor_status, cursor_email) = cursor_status_from_probe(cursor_auth);

    AgentCliStatusesResponse {
        agents: vec![
            AgentCliStatus {
                provider: AgentCliProvider::Codex,
                installed: codex_installation.installed,
                status: if codex_authenticated {
                    AgentCliConnectionStatus::Connected
                } else {
                    AgentCliConnectionStatus::NotAuthenticated
                },
                email: None,
                credential_count: None,
            },
            AgentCliStatus {
                provider: AgentCliProvider::Grok,
                installed: grok_installation.installed,
                status: if grok_authenticated {
                    AgentCliConnectionStatus::CredentialsPresent
                } else {
                    AgentCliConnectionStatus::NotAuthenticated
                },
                email: None,
                credential_count: None,
            },
            AgentCliStatus {
                provider: AgentCliProvider::ClaudeCode,
                installed: claude_installation.installed,
                status: claude_status,
                email: claude_email,
                credential_count: None,
            },
            AgentCliStatus {
                provider: AgentCliProvider::OpenCode,
                installed: opencode_installation.installed,
                status: opencode_status,
                email: None,
                credential_count,
            },
            AgentCliStatus {
                provider: AgentCliProvider::Cursor,
                installed: cursor_installation.installed,
                status: cursor_status,
                email: cursor_email,
                credential_count: None,
            },
        ],
    }
}

/// Cursor renamed its CLI entrypoint to `agent` in January 2026 while keeping
/// `cursor-agent` as a compatibility alias. Never probe the `cursor` command:
/// that belongs to the desktop editor rather than Cursor Agent CLI.
fn discover_cursor_cli(path: Option<&OsStr>) -> CliInstallation {
    let mut primary = discover_cli("agent", path);
    if primary.installed {
        // A PATH shim can make the primary entrypoint discoverable without a
        // directly executable .exe. In that case an installed compatibility
        // alias may still be used for the bounded, non-interactive status probe.
        if primary.direct_exe.is_none() {
            primary.direct_exe = discover_cli("cursor-agent", path).direct_exe;
        }
        return primary;
    }
    discover_cli("cursor-agent", path)
}

fn discover_cli(command: &str, path: Option<&OsStr>) -> CliInstallation {
    let Some(path) = path else {
        return CliInstallation::default();
    };

    for directory in env::split_paths(path).filter(|directory| directory.is_absolute()) {
        for extension in COMMAND_EXTENSIONS {
            let candidate = directory.join(format!("{command}.{extension}"));
            if !is_regular_non_reparse_file(&candidate) {
                continue;
            }
            // Match normal PATH resolution: once a command is found in an
            // earlier directory, never substitute a same-named executable
            // from a later directory for a privileged status probe.
            return CliInstallation {
                installed: true,
                direct_exe: (extension == "exe").then_some(candidate),
            };
        }
    }
    CliInstallation::default()
}

fn is_regular_non_reparse_file(path: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    metadata.is_file() && !metadata.file_type().is_symlink() && !metadata_is_reparse(&metadata)
}

#[cfg(windows)]
fn metadata_is_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse(_metadata: &fs::Metadata) -> bool {
    false
}

fn run_claude_auth_status(executable: &Path) -> ClaudeAuthProbe {
    if !is_regular_non_reparse_file(executable)
        || !executable
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
    {
        return ClaudeAuthProbe::Unknown;
    }

    let mut command = Command::new(executable);
    command
        .args(["auth", "status", "--json"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let Ok(mut child) = command.spawn() else {
        return ClaudeAuthProbe::Unknown;
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return ClaudeAuthProbe::Unknown;
    };
    let (output_sender, output_receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout
            .take((CLAUDE_STDOUT_MAX_BYTES + 1) as u64)
            .read_to_end(&mut bytes);
        let parsed =
            if result.is_ok() && !bytes.is_empty() && bytes.len() <= CLAUDE_STDOUT_MAX_BYTES {
                parse_claude_auth_output(&bytes)
            } else {
                ClaudeAuthProbe::Unknown
            };
        bytes.fill(0);
        let _ = output_sender.send(parsed);
    });

    let started = Instant::now();
    let exit_status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() < CLAUDE_AUTH_TIMEOUT => {
                thread::sleep(CLAUDE_POLL_INTERVAL);
            }
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };

    let Some(exit_status) = exit_status else {
        return ClaudeAuthProbe::Unknown;
    };
    let remaining = CLAUDE_AUTH_TIMEOUT.saturating_sub(started.elapsed());
    let Ok(parsed) = output_receiver.recv_timeout(remaining) else {
        return ClaudeAuthProbe::Unknown;
    };
    match (exit_status, parsed) {
        (
            status,
            ClaudeAuthProbe::Known {
                logged_in: true,
                email,
            },
        ) if status.success() => ClaudeAuthProbe::Known {
            logged_in: true,
            email,
        },
        (
            _,
            ClaudeAuthProbe::Known {
                logged_in: false, ..
            },
        ) => ClaudeAuthProbe::Known {
            logged_in: false,
            email: None,
        },
        _ => ClaudeAuthProbe::Unknown,
    }
}

fn run_cursor_auth_status(executable: &Path) -> CursorAuthProbe {
    if !is_regular_non_reparse_file(executable)
        || !executable
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
    {
        return CursorAuthProbe::Unknown;
    }

    let mut command = Command::new(executable);
    command
        .arg("status")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let Ok(mut child) = command.spawn() else {
        return CursorAuthProbe::Unknown;
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return CursorAuthProbe::Unknown;
    };
    let (output_sender, output_receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout
            .take((CURSOR_STDOUT_MAX_BYTES + 1) as u64)
            .read_to_end(&mut bytes);
        let parsed =
            if result.is_ok() && !bytes.is_empty() && bytes.len() <= CURSOR_STDOUT_MAX_BYTES {
                parse_cursor_auth_output(&bytes)
            } else {
                CursorAuthProbe::Unknown
            };
        bytes.fill(0);
        let _ = output_sender.send(parsed);
    });

    let started = Instant::now();
    let exit_status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() < CURSOR_STATUS_TIMEOUT => {
                thread::sleep(CURSOR_POLL_INTERVAL);
            }
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };

    let Some(exit_status) = exit_status else {
        return CursorAuthProbe::Unknown;
    };
    let remaining = CURSOR_STATUS_TIMEOUT.saturating_sub(started.elapsed());
    let Ok(parsed) = output_receiver.recv_timeout(remaining) else {
        return CursorAuthProbe::Unknown;
    };
    match (exit_status, parsed) {
        (
            status,
            CursorAuthProbe::Known {
                logged_in: true,
                email,
            },
        ) if status.success() => CursorAuthProbe::Known {
            logged_in: true,
            email,
        },
        (
            _,
            CursorAuthProbe::Known {
                logged_in: false, ..
            },
        ) => CursorAuthProbe::Known {
            logged_in: false,
            email: None,
        },
        _ => CursorAuthProbe::Unknown,
    }
}

fn parse_cursor_auth_output(bytes: &[u8]) -> CursorAuthProbe {
    let Ok(output) = std::str::from_utf8(bytes) else {
        return CursorAuthProbe::Unknown;
    };
    let normalized = output.to_ascii_lowercase();
    if [
        "not logged in",
        "not authenticated",
        "unauthenticated",
        "authentication required",
        "sign-in required",
        "signin required",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
    {
        return CursorAuthProbe::Known {
            logged_in: false,
            email: None,
        };
    }
    if ["login successful", "logged in", "authenticated"]
        .iter()
        .any(|marker| normalized.contains(marker))
    {
        return CursorAuthProbe::Known {
            logged_in: true,
            email: cursor_status_email(output),
        };
    }
    CursorAuthProbe::Unknown
}

fn cursor_status_email(output: &str) -> Option<String> {
    let without_ansi = strip_ansi_csi_sequences(output);
    without_ansi.split_whitespace().find_map(|token| {
        let candidate = token.trim_matches(|character: char| !character.is_ascii_alphanumeric());
        candidate
            .contains('@')
            .then(|| sanitize_email(candidate))
            .flatten()
    })
}

fn strip_ansi_csi_sequences(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut characters = value.chars().peekable();
    while let Some(character) = characters.next() {
        if character != '\u{1b}' || characters.peek() != Some(&'[') {
            result.push(character);
            continue;
        }
        let _ = characters.next();
        for sequence_character in characters.by_ref() {
            if ('@'..='~').contains(&sequence_character) {
                break;
            }
        }
    }
    result
}

fn cursor_status_from_probe(probe: CursorAuthProbe) -> (AgentCliConnectionStatus, Option<String>) {
    match probe {
        CursorAuthProbe::Known {
            logged_in: true,
            email,
        } => (AgentCliConnectionStatus::Connected, email),
        CursorAuthProbe::Known {
            logged_in: false, ..
        } => (AgentCliConnectionStatus::NotAuthenticated, None),
        CursorAuthProbe::Unknown => (AgentCliConnectionStatus::Unknown, None),
    }
}

fn parse_claude_auth_output(bytes: &[u8]) -> ClaudeAuthProbe {
    let Ok(output) = serde_json::from_slice::<ClaudeAuthOutput>(bytes) else {
        return ClaudeAuthProbe::Unknown;
    };
    ClaudeAuthProbe::Known {
        logged_in: output.logged_in,
        email: output.email.as_deref().and_then(sanitize_email),
    }
}

fn sanitize_email(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > EMAIL_MAX_BYTES
        || trimmed.chars().any(|character| {
            character.is_control()
                || character.is_whitespace()
                || character == '<'
                || character == '>'
        })
    {
        return None;
    }
    let (local, domain) = trimmed.split_once('@')?;
    if local.is_empty() || domain.is_empty() || domain.contains('@') {
        return None;
    }
    Some(trimmed.to_owned())
}

fn claude_status_from_probe(probe: ClaudeAuthProbe) -> (AgentCliConnectionStatus, Option<String>) {
    match probe {
        ClaudeAuthProbe::Known {
            logged_in: true,
            email,
        } => (AgentCliConnectionStatus::Connected, email),
        ClaudeAuthProbe::Known {
            logged_in: false, ..
        } => (AgentCliConnectionStatus::NotAuthenticated, None),
        ClaudeAuthProbe::Unknown => (AgentCliConnectionStatus::Unknown, None),
    }
}

fn default_opencode_auth_paths() -> Vec<PathBuf> {
    let mut paths = Vec::with_capacity(2);
    push_absolute_env_path(&mut paths, "LOCALAPPDATA", &["opencode", "auth.json"]);
    push_absolute_env_path(
        &mut paths,
        "USERPROFILE",
        &[".local", "share", "opencode", "auth.json"],
    );
    paths.sort();
    paths.dedup();
    paths
}

fn push_absolute_env_path(paths: &mut Vec<PathBuf>, variable: &str, suffix: &[&str]) {
    let Some(root) = env::var_os(variable).filter(|value| !value.is_empty()) else {
        return;
    };
    let mut path = PathBuf::from(root);
    if !path.is_absolute() {
        return;
    }
    for component in suffix {
        path.push(component);
    }
    paths.push(path);
}

fn read_opencode_auth_status(paths: &[PathBuf]) -> (AgentCliConnectionStatus, Option<u32>) {
    let mut providers = BTreeSet::new();
    let mut invalid = false;
    for path in paths {
        match read_auth_provider_names(path) {
            AuthFileRead::Missing => {}
            AuthFileRead::Valid(names) => providers.extend(names),
            AuthFileRead::Invalid => invalid = true,
        }
    }

    if !providers.is_empty() {
        let count = u32::try_from(providers.len()).unwrap_or(u32::MAX);
        return (AgentCliConnectionStatus::CredentialsPresent, Some(count));
    }
    if invalid {
        (AgentCliConnectionStatus::Unknown, None)
    } else {
        (AgentCliConnectionStatus::NotAuthenticated, Some(0))
    }
}

fn read_auth_provider_names(path: &Path) -> AuthFileRead {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return AuthFileRead::Missing;
        }
        Err(_) => return AuthFileRead::Invalid,
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata_is_reparse(&metadata)
        || metadata.len() > AUTH_FILE_MAX_BYTES as u64
    {
        return AuthFileRead::Invalid;
    }

    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x0000_0001;
        const FILE_SHARE_WRITE: u32 = 0x0000_0002;
        const FILE_SHARE_DELETE: u32 = 0x0000_0004;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }

    let Ok(mut file) = options.open(path) else {
        return AuthFileRead::Invalid;
    };
    let Ok(opened_metadata) = file.metadata() else {
        return AuthFileRead::Invalid;
    };
    if !opened_metadata.is_file()
        || metadata_is_reparse(&opened_metadata)
        || opened_metadata.len() > AUTH_FILE_MAX_BYTES as u64
    {
        return AuthFileRead::Invalid;
    }

    let mut bytes = Vec::with_capacity(opened_metadata.len() as usize);
    if (&mut file)
        .take((AUTH_FILE_MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.is_empty()
        || bytes.len() > AUTH_FILE_MAX_BYTES
    {
        bytes.fill(0);
        return AuthFileRead::Invalid;
    }
    let Ok(final_metadata) = file.metadata() else {
        bytes.fill(0);
        return AuthFileRead::Invalid;
    };
    if !final_metadata.is_file()
        || metadata_is_reparse(&final_metadata)
        || final_metadata.len() > AUTH_FILE_MAX_BYTES as u64
    {
        bytes.fill(0);
        return AuthFileRead::Invalid;
    }

    let parsed = serde_json::from_slice::<BTreeMap<String, IgnoredAny>>(&bytes)
        .map(|providers| providers.into_keys().collect());
    bytes.fill(0);
    match parsed {
        Ok(providers) => AuthFileRead::Valid(providers),
        Err(_) => AuthFileRead::Invalid,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{ffi::OsString, fs};

    #[test]
    fn response_serializes_only_the_closed_public_contract() {
        let response = AgentCliStatusesResponse {
            agents: vec![
                AgentCliStatus {
                    provider: AgentCliProvider::Codex,
                    installed: true,
                    status: AgentCliConnectionStatus::Connected,
                    email: None,
                    credential_count: None,
                },
                AgentCliStatus {
                    provider: AgentCliProvider::Grok,
                    installed: true,
                    status: AgentCliConnectionStatus::CredentialsPresent,
                    email: None,
                    credential_count: None,
                },
                AgentCliStatus {
                    provider: AgentCliProvider::ClaudeCode,
                    installed: true,
                    status: AgentCliConnectionStatus::NotAuthenticated,
                    email: None,
                    credential_count: None,
                },
                AgentCliStatus {
                    provider: AgentCliProvider::OpenCode,
                    installed: false,
                    status: AgentCliConnectionStatus::Unknown,
                    email: None,
                    credential_count: Some(2),
                },
                AgentCliStatus {
                    provider: AgentCliProvider::Cursor,
                    installed: true,
                    status: AgentCliConnectionStatus::Connected,
                    email: Some("cursor@example.com".to_owned()),
                    credential_count: None,
                },
            ],
        };
        let value = serde_json::to_value(response).unwrap();
        assert_eq!(value["agents"][0]["provider"], "codex");
        assert_eq!(value["agents"][0]["status"], "connected");
        assert_eq!(value["agents"][1]["status"], "credentialsPresent");
        assert_eq!(value["agents"][2]["status"], "notAuthenticated");
        assert_eq!(value["agents"][3]["provider"], "openCode");
        assert_eq!(value["agents"][3]["status"], "unknown");
        assert_eq!(value["agents"][3]["credentialCount"], 2);
        assert_eq!(value["agents"][4]["provider"], "cursor");
        assert_eq!(value["agents"][4]["status"], "connected");
        assert_eq!(value["agents"][4]["email"], "cursor@example.com");
        assert!(value["agents"][0].get("email").is_none());
    }

    #[test]
    fn discovers_only_allowed_regular_path_files() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("claude.cmd"), b"wrapper").unwrap();
        fs::write(directory.path().join("claude.txt"), b"not a command").unwrap();
        fs::create_dir(directory.path().join("claude.exe")).unwrap();
        let joined = env::join_paths([directory.path()]).unwrap();

        let installation = discover_cli("claude", Some(&joined));
        assert!(installation.installed);
        assert!(installation.direct_exe.is_none());
    }

    #[test]
    fn remembers_a_direct_exe_without_exposing_it_in_the_response() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("claude.exe");
        fs::write(&executable, b"not executed by this test").unwrap();
        let joined = env::join_paths([directory.path()]).unwrap();

        let installation = discover_cli("claude", Some(&joined));
        assert!(installation.installed);
        assert_eq!(
            installation.direct_exe.as_deref(),
            Some(executable.as_path())
        );
    }

    #[test]
    fn relative_path_entries_are_not_trusted() {
        let installation = discover_cli("claude", Some(OsStr::new("relative-bin")));
        assert!(!installation.installed);
        assert!(installation.direct_exe.is_none());
    }

    #[test]
    fn cursor_prefers_agent_then_falls_back_to_cursor_agent_without_using_cursor() {
        let primary_directory = tempfile::tempdir().unwrap();
        let alias_directory = tempfile::tempdir().unwrap();
        let primary = primary_directory.path().join("agent.exe");
        let alias = alias_directory.path().join("cursor-agent.exe");
        fs::write(&primary, b"not executed by this test").unwrap();
        fs::write(&alias, b"not executed by this test").unwrap();
        let joined = env::join_paths([alias_directory.path(), primary_directory.path()]).unwrap();

        let installation = discover_cursor_cli(Some(&joined));
        assert!(installation.installed);
        assert_eq!(installation.direct_exe.as_deref(), Some(primary.as_path()));

        fs::remove_file(&primary).unwrap();
        let fallback = discover_cursor_cli(Some(&joined));
        assert!(fallback.installed);
        assert_eq!(fallback.direct_exe.as_deref(), Some(alias.as_path()));

        fs::remove_file(&alias).unwrap();
        fs::write(
            primary_directory.path().join("cursor.exe"),
            b"desktop editor",
        )
        .unwrap();
        let desktop_only = discover_cursor_cli(Some(&joined));
        assert!(!desktop_only.installed);
        assert!(desktop_only.direct_exe.is_none());
    }

    #[test]
    fn cursor_primary_shim_can_use_alias_exe_for_the_bounded_status_probe() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("agent.cmd"), b"primary shim").unwrap();
        let alias = directory.path().join("cursor-agent.exe");
        fs::write(&alias, b"not executed by this test").unwrap();
        let joined = env::join_paths([directory.path()]).unwrap();

        let installation = discover_cursor_cli(Some(&joined));
        assert!(installation.installed);
        assert_eq!(installation.direct_exe.as_deref(), Some(alias.as_path()));
    }

    #[test]
    fn cursor_primary_shim_never_substitutes_a_later_agent_exe() {
        let shim_directory = tempfile::tempdir().unwrap();
        let later_directory = tempfile::tempdir().unwrap();
        fs::write(shim_directory.path().join("agent.cmd"), b"primary shim").unwrap();
        let unrelated_agent = later_directory.path().join("agent.exe");
        let alias = later_directory.path().join("cursor-agent.exe");
        fs::write(&unrelated_agent, b"must never execute").unwrap();
        fs::write(&alias, b"safe compatibility alias").unwrap();
        let joined = env::join_paths([shim_directory.path(), later_directory.path()]).unwrap();

        let installation = discover_cursor_cli(Some(&joined));
        assert!(installation.installed);
        assert_eq!(installation.direct_exe.as_deref(), Some(alias.as_path()));
        assert_ne!(
            installation.direct_exe.as_deref(),
            Some(unrelated_agent.as_path())
        );
    }

    #[test]
    fn claude_auth_parser_keeps_only_logged_in_and_a_sanitized_email() {
        let parsed = parse_claude_auth_output(
            br#"{"loggedIn":true,"email":"  user@example.com  ","token":"secret","other":{"raw":true}}"#,
        );
        assert_eq!(
            parsed,
            ClaudeAuthProbe::Known {
                logged_in: true,
                email: Some("user@example.com".to_owned())
            }
        );
        assert_eq!(
            parse_claude_auth_output(br#"{"loggedIn":true,"email":"bad\n@example.com"}"#),
            ClaudeAuthProbe::Known {
                logged_in: true,
                email: None
            }
        );
        assert_eq!(
            parse_claude_auth_output(b"not-json"),
            ClaudeAuthProbe::Unknown
        );
    }

    #[test]
    fn claude_probe_maps_to_the_expected_connection_states() {
        assert_eq!(
            claude_status_from_probe(ClaudeAuthProbe::Known {
                logged_in: true,
                email: Some("user@example.com".to_owned())
            }),
            (
                AgentCliConnectionStatus::Connected,
                Some("user@example.com".to_owned())
            )
        );
        assert_eq!(
            claude_status_from_probe(ClaudeAuthProbe::Known {
                logged_in: false,
                email: Some("ignored@example.com".to_owned())
            }),
            (AgentCliConnectionStatus::NotAuthenticated, None)
        );
        assert_eq!(
            claude_status_from_probe(ClaudeAuthProbe::Unknown),
            (AgentCliConnectionStatus::Unknown, None)
        );
    }

    #[test]
    fn cursor_status_parser_distinguishes_login_and_keeps_only_a_sanitized_email() {
        assert_eq!(
            parse_cursor_auth_output(
                b"\xe2\x9c\x93 Login successful!\nLogged in as user@example.com\n"
            ),
            CursorAuthProbe::Known {
                logged_in: true,
                email: Some("user@example.com".to_owned())
            }
        );
        assert_eq!(
            parse_cursor_auth_output(
                b"Login successful!\nLogged in as \x1b[32muser@example.com\x1b[0m\n"
            ),
            CursorAuthProbe::Known {
                logged_in: true,
                email: Some("user@example.com".to_owned())
            }
        );
        assert_eq!(
            parse_cursor_auth_output(b"Not logged in\nRun agent login to continue."),
            CursorAuthProbe::Known {
                logged_in: false,
                email: None
            }
        );
        assert_eq!(
            parse_cursor_auth_output(b"Unauthenticated. Run agent login to continue."),
            CursorAuthProbe::Known {
                logged_in: false,
                email: None
            }
        );
        assert_eq!(
            parse_cursor_auth_output(b"status endpoint: https://api.cursor.sh"),
            CursorAuthProbe::Unknown
        );
    }

    #[test]
    fn cursor_probe_maps_to_the_expected_connection_states() {
        assert_eq!(
            cursor_status_from_probe(CursorAuthProbe::Known {
                logged_in: true,
                email: Some("user@example.com".to_owned())
            }),
            (
                AgentCliConnectionStatus::Connected,
                Some("user@example.com".to_owned())
            )
        );
        assert_eq!(
            cursor_status_from_probe(CursorAuthProbe::Known {
                logged_in: false,
                email: Some("ignored@example.com".to_owned())
            }),
            (AgentCliConnectionStatus::NotAuthenticated, None)
        );
        assert_eq!(
            cursor_status_from_probe(CursorAuthProbe::Unknown),
            (AgentCliConnectionStatus::Unknown, None)
        );
    }

    #[test]
    fn opencode_counts_provider_keys_without_reading_credential_values() {
        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("first.json");
        let second = directory.path().join("second.json");
        fs::write(
            &first,
            br#"{"anthropic":{"token":"secret-a"},"openai":{"token":"secret-b"}}"#,
        )
        .unwrap();
        fs::write(
            &second,
            br#"{"anthropic":{"different":"secret-c"},"google":"secret-d"}"#,
        )
        .unwrap();

        assert_eq!(
            read_opencode_auth_status(&[first, second]),
            (AgentCliConnectionStatus::CredentialsPresent, Some(3))
        );
    }

    #[test]
    fn opencode_distinguishes_absent_empty_and_invalid_auth() {
        let directory = tempfile::tempdir().unwrap();
        let absent = directory.path().join("absent.json");
        assert_eq!(
            read_opencode_auth_status(&[absent]),
            (AgentCliConnectionStatus::NotAuthenticated, Some(0))
        );

        let empty = directory.path().join("empty.json");
        fs::write(&empty, b"{}").unwrap();
        assert_eq!(
            read_opencode_auth_status(std::slice::from_ref(&empty)),
            (AgentCliConnectionStatus::NotAuthenticated, Some(0))
        );

        fs::write(&empty, b"[]").unwrap();
        assert_eq!(
            read_opencode_auth_status(&[empty]),
            (AgentCliConnectionStatus::Unknown, None)
        );
    }

    #[test]
    fn opencode_rejects_oversized_and_non_file_auth_sources() {
        let directory = tempfile::tempdir().unwrap();
        let oversized = directory.path().join("oversized.json");
        fs::write(&oversized, vec![b'x'; AUTH_FILE_MAX_BYTES + 1]).unwrap();
        let folder = directory.path().join("folder.json");
        fs::create_dir(&folder).unwrap();

        assert!(matches!(
            read_auth_provider_names(&oversized),
            AuthFileRead::Invalid
        ));
        assert!(matches!(
            read_auth_provider_names(&folder),
            AuthFileRead::Invalid
        ));
    }

    #[cfg(unix)]
    #[test]
    fn opencode_rejects_symlinked_auth_sources() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target.json");
        let link = directory.path().join("link.json");
        fs::write(&target, b"{}").unwrap();
        symlink(target, &link).unwrap();
        assert!(matches!(
            read_auth_provider_names(&link),
            AuthFileRead::Invalid
        ));
    }

    #[test]
    fn default_opencode_paths_require_absolute_environment_roots() {
        let mut paths = Vec::new();
        push_absolute_env_path(
            &mut paths,
            "THIS_ENVIRONMENT_VARIABLE_SHOULD_NOT_EXIST",
            &["x"],
        );
        assert!(paths.is_empty());

        let mut manual = Vec::new();
        let root = tempfile::tempdir().unwrap();
        let value: OsString = root.path().as_os_str().to_owned();
        let variable = "IHATECODING_TEST_AGENT_STATUS_HOME";
        // SAFETY: this test is the only code that reads this test-only variable.
        unsafe { env::set_var(variable, &value) };
        push_absolute_env_path(&mut manual, variable, &["auth.json"]);
        // SAFETY: see the set_var call above.
        unsafe { env::remove_var(variable) };
        assert_eq!(manual, vec![root.path().join("auth.json")]);
    }
}
