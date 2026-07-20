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
        ],
    }
}

fn discover_cli(command: &str, path: Option<&OsStr>) -> CliInstallation {
    let mut result = CliInstallation::default();
    let Some(path) = path else {
        return result;
    };

    for directory in env::split_paths(path).filter(|directory| directory.is_absolute()) {
        for extension in COMMAND_EXTENSIONS {
            let candidate = directory.join(format!("{command}.{extension}"));
            if !is_regular_non_reparse_file(&candidate) {
                continue;
            }
            result.installed = true;
            if extension == "exe" && result.direct_exe.is_none() {
                result.direct_exe = Some(candidate);
            }
        }
    }
    result
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
