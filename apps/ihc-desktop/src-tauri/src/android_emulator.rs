use serde::Serialize;
use std::{
    collections::HashSet,
    env,
    ffi::OsString,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tauri::Webview;

const MAX_AVD_LIST_BYTES: usize = 64 * 1024;
const MAX_AVD_NAME_BYTES: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum AndroidEmulatorState {
    Ready,
    EmulatorMissing,
    NoVirtualDevices,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct AndroidVirtualDevice {
    name: String,
    running: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AndroidEmulatorStatus {
    state: AndroidEmulatorState,
    avds: Vec<AndroidVirtualDevice>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AndroidEmulatorLaunchResult {
    avd_name: String,
    already_running: bool,
    process_id: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum AndroidEmulatorErrorCode {
    AccessDenied,
    WorkerFailed,
    EmulatorMissing,
    AvdListFailed,
    NoVirtualDevices,
    InvalidAvdName,
    LaunchFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AndroidEmulatorCommandError {
    code: AndroidEmulatorErrorCode,
    message: String,
    retryable: bool,
}

impl AndroidEmulatorCommandError {
    fn new(code: AndroidEmulatorErrorCode, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
        }
    }

    fn access_denied() -> Self {
        Self::new(
            AndroidEmulatorErrorCode::AccessDenied,
            "This command is available only to the local main view.",
            false,
        )
    }

    fn worker_failed() -> Self {
        Self::new(
            AndroidEmulatorErrorCode::WorkerFailed,
            "The Android Emulator worker did not complete.",
            true,
        )
    }

    fn emulator_missing() -> Self {
        Self::new(
            AndroidEmulatorErrorCode::EmulatorMissing,
            "Android Emulator is not installed in a supported SDK location.",
            true,
        )
    }

    fn avd_list_failed() -> Self {
        Self::new(
            AndroidEmulatorErrorCode::AvdListFailed,
            "Android Emulator could not list virtual devices.",
            true,
        )
    }

    fn no_virtual_devices() -> Self {
        Self::new(
            AndroidEmulatorErrorCode::NoVirtualDevices,
            "No Android virtual devices are available.",
            true,
        )
    }

    fn invalid_avd_name() -> Self {
        Self::new(
            AndroidEmulatorErrorCode::InvalidAvdName,
            "The selected Android virtual device is no longer available.",
            true,
        )
    }

    fn launch_failed() -> Self {
        Self::new(
            AndroidEmulatorErrorCode::LaunchFailed,
            "Android Emulator could not be started.",
            true,
        )
    }
}

#[tauri::command]
pub(crate) async fn get_android_emulator_status(
    webview: Webview,
) -> Result<AndroidEmulatorStatus, AndroidEmulatorCommandError> {
    crate::ensure_agent_main_webview(&webview)
        .map_err(|_| AndroidEmulatorCommandError::access_denied())?;

    tauri::async_runtime::spawn_blocking(read_android_emulator_status)
        .await
        .map_err(|_| AndroidEmulatorCommandError::worker_failed())?
}

#[tauri::command]
pub(crate) async fn launch_android_emulator(
    webview: Webview,
    avd_name: String,
) -> Result<AndroidEmulatorLaunchResult, AndroidEmulatorCommandError> {
    crate::ensure_agent_main_webview(&webview)
        .map_err(|_| AndroidEmulatorCommandError::access_denied())?;

    tauri::async_runtime::spawn_blocking(move || launch_requested_avd(avd_name))
        .await
        .map_err(|_| AndroidEmulatorCommandError::worker_failed())?
}

fn read_android_emulator_status() -> Result<AndroidEmulatorStatus, AndroidEmulatorCommandError> {
    let Some(emulator) = discover_emulator_executable() else {
        return Ok(AndroidEmulatorStatus {
            state: AndroidEmulatorState::EmulatorMissing,
            avds: Vec::new(),
        });
    };

    let avd_names = query_avds(&emulator)?;
    let state = if avd_names.is_empty() {
        AndroidEmulatorState::NoVirtualDevices
    } else {
        AndroidEmulatorState::Ready
    };
    let avds = avd_names
        .into_iter()
        .map(|name| AndroidVirtualDevice {
            name,
            running: false,
        })
        .collect();
    Ok(AndroidEmulatorStatus { state, avds })
}

fn launch_requested_avd(
    avd_name: String,
) -> Result<AndroidEmulatorLaunchResult, AndroidEmulatorCommandError> {
    let Some(emulator) = discover_emulator_executable() else {
        return Err(AndroidEmulatorCommandError::emulator_missing());
    };

    // Query immediately before launch. The UI-provided name is never trusted as
    // an emulator option and must exactly match the emulator's fresh AVD list.
    let fresh_avds = query_avds(&emulator)?;
    validate_fresh_avd_name(&avd_name, &fresh_avds)?;
    if !is_regular_non_reparse_file(&emulator) {
        return Err(AndroidEmulatorCommandError::launch_failed());
    }

    let child = build_launch_command(&emulator, &avd_name)
        .spawn()
        .map_err(|_| AndroidEmulatorCommandError::launch_failed())?;
    Ok(AndroidEmulatorLaunchResult {
        avd_name,
        already_running: false,
        process_id: child.id(),
    })
}

fn query_avds(emulator: &Path) -> Result<Vec<String>, AndroidEmulatorCommandError> {
    if !is_regular_non_reparse_file(emulator) {
        return Err(AndroidEmulatorCommandError::avd_list_failed());
    }
    let output = build_list_command(emulator)
        .output()
        .map_err(|_| AndroidEmulatorCommandError::avd_list_failed())?;
    if !output.status.success() || output.stdout.len() > MAX_AVD_LIST_BYTES {
        return Err(AndroidEmulatorCommandError::avd_list_failed());
    }
    parse_avd_list(&output.stdout).map_err(|_| AndroidEmulatorCommandError::avd_list_failed())
}

fn parse_avd_list(output: &[u8]) -> Result<Vec<String>, ()> {
    let output = std::str::from_utf8(output).map_err(|_| ())?;
    let mut seen = HashSet::new();
    let mut avds = Vec::new();
    for line in output.lines() {
        let name = line.trim();
        if name.is_empty() {
            continue;
        }
        if !is_safe_avd_name(name) {
            return Err(());
        }
        if seen.insert(name.to_owned()) {
            avds.push(name.to_owned());
        }
    }
    Ok(avds)
}

fn validate_fresh_avd_name(
    requested: &str,
    fresh_avds: &[String],
) -> Result<(), AndroidEmulatorCommandError> {
    if fresh_avds.is_empty() {
        return Err(AndroidEmulatorCommandError::no_virtual_devices());
    }
    if !is_safe_avd_name(requested) || !fresh_avds.iter().any(|name| name == requested) {
        return Err(AndroidEmulatorCommandError::invalid_avd_name());
    }
    Ok(())
}

fn is_safe_avd_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_AVD_NAME_BYTES
        && !name.starts_with(['-', '@'])
        && !name.chars().any(char::is_control)
        && name == name.trim_start()
        && name == name.trim_end()
}

fn discover_emulator_executable() -> Option<PathBuf> {
    find_emulator_executable(&sdk_root_candidates())
}

fn find_emulator_executable(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find_map(|root| {
        if !root.is_absolute() || !root.is_dir() {
            return None;
        }
        let emulator = root.join("emulator").join("emulator.exe");
        is_regular_non_reparse_file(&emulator).then_some(emulator)
    })
}

fn is_regular_non_reparse_file(path: &Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return false;
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return false;
        }
    }

    true
}

fn sdk_root_candidates() -> Vec<PathBuf> {
    sdk_root_candidates_from(|name| env::var_os(name))
}

fn sdk_root_candidates_from(mut read_env: impl FnMut(&str) -> Option<OsString>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    push_unique_env_path(&mut candidates, read_env("ANDROID_HOME"), None);
    push_unique_env_path(&mut candidates, read_env("ANDROID_SDK_ROOT"), None);
    push_unique_env_path(
        &mut candidates,
        read_env("LOCALAPPDATA"),
        Some(Path::new("Android").join("Sdk")),
    );
    push_unique_env_path(
        &mut candidates,
        read_env("ProgramFiles(x86)"),
        Some(Path::new("Android").join("android-sdk")),
    );
    push_unique_env_path(
        &mut candidates,
        read_env("ProgramFiles"),
        Some(Path::new("Android").join("android-sdk")),
    );
    candidates
}

fn push_unique_env_path(
    candidates: &mut Vec<PathBuf>,
    base: Option<OsString>,
    suffix: Option<PathBuf>,
) {
    let Some(base) = base.filter(|value| !value.is_empty()) else {
        return;
    };
    let mut candidate = PathBuf::from(base);
    if let Some(suffix) = suffix {
        candidate.push(suffix);
    }
    if !candidates.iter().any(|existing| existing == &candidate) {
        candidates.push(candidate);
    }
}

fn build_list_command(emulator: &Path) -> Command {
    let mut command = Command::new(emulator);
    command
        .arg("-list-avds")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    configure_background_command(&mut command);
    command
}

fn build_launch_command(emulator: &Path, avd_name: &str) -> Command {
    let mut command = Command::new(emulator);
    command
        .arg("-avd")
        .arg(avd_name)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_background_command(&mut command);
    command
}

fn configure_background_command(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(not(windows))]
    let _ = command;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::HashMap, ffi::OsStr};

    #[test]
    fn sdk_candidates_follow_the_required_precedence() {
        let values = HashMap::from([
            ("ANDROID_HOME", OsString::from("android-home")),
            ("ANDROID_SDK_ROOT", OsString::from("android-sdk-root")),
            ("LOCALAPPDATA", OsString::from("local-app-data")),
            ("ProgramFiles(x86)", OsString::from("program-files-x86")),
            ("ProgramFiles", OsString::from("program-files")),
        ]);
        let candidates = sdk_root_candidates_from(|name| values.get(name).cloned());

        assert_eq!(
            candidates,
            vec![
                PathBuf::from("android-home"),
                PathBuf::from("android-sdk-root"),
                PathBuf::from("local-app-data").join("Android").join("Sdk"),
                PathBuf::from("program-files-x86")
                    .join("Android")
                    .join("android-sdk"),
                PathBuf::from("program-files")
                    .join("Android")
                    .join("android-sdk"),
            ]
        );
    }

    #[test]
    fn discovery_uses_the_first_candidate_with_an_emulator_executable() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let missing = temp.path().join("missing-sdk");
        let first = temp.path().join("first-sdk");
        let second = temp.path().join("second-sdk");
        for root in [&first, &second] {
            std::fs::create_dir_all(root.join("emulator")).expect("emulator directory");
            std::fs::write(root.join("emulator").join("emulator.exe"), b"test")
                .expect("fake emulator executable");
        }

        assert_eq!(
            find_emulator_executable(&[missing, first.clone(), second]),
            Some(first.join("emulator").join("emulator.exe"))
        );
    }

    #[test]
    fn discovery_rejects_an_emulator_executable_that_is_a_symlink_or_reparse_point() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let sdk = temp.path().join("sdk");
        let emulator_dir = sdk.join("emulator");
        std::fs::create_dir_all(&emulator_dir).expect("emulator directory");
        let target = temp.path().join("real-emulator.exe");
        std::fs::write(&target, b"test").expect("fake emulator executable");
        let link = emulator_dir.join("emulator.exe");

        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(&target, &link).is_ok();
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&target, &link).is_ok();
        #[cfg(not(any(windows, unix)))]
        let linked = false;

        if linked {
            assert_eq!(find_emulator_executable(&[sdk]), None);
        }
    }

    #[test]
    fn avd_output_is_validated_and_deduplicated_without_reordering() {
        assert_eq!(
            parse_avd_list(b"Pixel_8\r\nTablet API 35\n\nPixel_8\n"),
            Ok(vec!["Pixel_8".to_owned(), "Tablet API 35".to_owned()])
        );
        assert!(parse_avd_list(b"Pixel_8\nunsafe\0name\n").is_err());
        assert!(parse_avd_list(&[0xff, 0xfe]).is_err());
    }

    #[test]
    fn launch_requires_an_exact_name_from_the_fresh_list() {
        let fresh = vec!["Pixel_8".to_owned(), "Tablet API 35".to_owned()];
        assert!(validate_fresh_avd_name("Pixel_8", &fresh).is_ok());
        assert!(validate_fresh_avd_name("pixel_8", &fresh).is_err());
        assert!(validate_fresh_avd_name("-wipe-data", &fresh).is_err());
        assert!(validate_fresh_avd_name("-wipe-data", &["-wipe-data".to_owned()]).is_err());
        assert!(validate_fresh_avd_name("Pixel_8\n-wipe-data", &fresh).is_err());
        assert!(validate_fresh_avd_name("Pixel_8", &[]).is_err());
    }

    #[test]
    fn emulator_commands_use_the_executable_directly_and_separate_arguments() {
        let executable = Path::new(r"C:\Android\Sdk\emulator\emulator.exe");
        let list = build_list_command(executable);
        assert_eq!(list.get_program(), executable.as_os_str());
        assert_eq!(
            list.get_args().collect::<Vec<&OsStr>>(),
            vec![OsStr::new("-list-avds")]
        );

        let launch = build_launch_command(executable, "Pixel 8 API 35");
        assert_eq!(launch.get_program(), executable.as_os_str());
        assert_eq!(
            launch.get_args().collect::<Vec<&OsStr>>(),
            vec![OsStr::new("-avd"), OsStr::new("Pixel 8 API 35")]
        );
    }

    #[test]
    fn response_shapes_match_the_frontend_contract_without_sdk_paths() {
        let status = AndroidEmulatorStatus {
            state: AndroidEmulatorState::Ready,
            avds: vec![AndroidVirtualDevice {
                name: "Pixel_8".to_owned(),
                running: false,
            }],
        };
        assert_eq!(
            serde_json::to_value(status).expect("serialize status"),
            serde_json::json!({
                "state": "ready",
                "avds": [{ "name": "Pixel_8", "running": false }]
            })
        );

        let result = AndroidEmulatorLaunchResult {
            avd_name: "Pixel_8".to_owned(),
            already_running: false,
            process_id: 42,
        };
        let serialized = serde_json::to_value(result).expect("serialize launch result");
        assert_eq!(
            serialized,
            serde_json::json!({
                "avdName": "Pixel_8",
                "alreadyRunning": false,
                "processId": 42
            })
        );
        assert!(!serialized.to_string().contains("Android\\Sdk"));
    }

    #[test]
    fn all_status_states_use_the_expected_camel_case_values() {
        for (state, expected) in [
            (AndroidEmulatorState::Ready, "ready"),
            (AndroidEmulatorState::EmulatorMissing, "emulatorMissing"),
            (AndroidEmulatorState::NoVirtualDevices, "noVirtualDevices"),
        ] {
            assert_eq!(
                serde_json::to_value(state).expect("serialize state"),
                serde_json::Value::String(expected.to_owned())
            );
        }
    }
}
