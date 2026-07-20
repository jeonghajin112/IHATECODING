use crate::workspace_store::WorkspaceStore;
use serde::Serialize;
use std::{
    cmp::Ordering,
    ffi::OsStr,
    fs, io,
    path::{Component, Path, PathBuf},
};
use tauri::{State, Webview};

const MAX_PROJECT_ID_BYTES: usize = 256;
const MAX_PATH_DEPTH: usize = 64;
const MAX_PATH_SEGMENT_UTF16_UNITS: usize = 255;
const MAX_RELATIVE_PATH_UTF16_UNITS: usize = 4_096;
const MAX_DIRECTORY_ENTRIES: usize = 4_096;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProjectFilesErrorCode {
    InvalidPath,
    PathDenied,
    ProjectNotFound,
    RootUnavailable,
    NotFound,
    NotDirectory,
    NotFile,
    UnsafeFileType,
    Io,
    OpenFailed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectFilesError {
    code: ProjectFilesErrorCode,
    message: String,
}

impl ProjectFilesError {
    fn new(code: ProjectFilesErrorCode, message: &str) -> Self {
        Self {
            code,
            message: message.to_owned(),
        }
    }

    fn invalid_path() -> Self {
        Self::new(
            ProjectFilesErrorCode::InvalidPath,
            "The project-relative path is invalid.",
        )
    }

    fn path_denied() -> Self {
        Self::new(
            ProjectFilesErrorCode::PathDenied,
            "The requested path is not a safe regular project path.",
        )
    }

    fn io(message: &str) -> Self {
        Self::new(ProjectFilesErrorCode::Io, message)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProjectFileKind {
    Directory,
    File,
    Symlink,
    Other,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectFileEntry {
    name: String,
    segments: Vec<String>,
    kind: ProjectFileKind,
    hidden: bool,
    openable: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectDirectoryResponse {
    entries: Vec<ProjectFileEntry>,
    truncated: bool,
}

#[tauri::command]
pub(crate) async fn list_project_directory(
    webview: Webview,
    store: State<'_, WorkspaceStore>,
    project_id: String,
    path_segments: Vec<String>,
) -> Result<ProjectDirectoryResponse, ProjectFilesError> {
    crate::ensure_agent_main_webview(&webview).map_err(|_| ProjectFilesError::path_denied())?;
    drop(webview);
    validate_project_id(&project_id)?;
    validate_path_segments(&path_segments)?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let project_root = project_root_for_id(&store, &project_id)?;
        list_project_directory_in(&project_root, &path_segments)
    })
    .await
    .map_err(|_| ProjectFilesError::io("The project directory reader did not complete."))?
}

#[tauri::command]
pub(crate) async fn open_project_file(
    webview: Webview,
    store: State<'_, WorkspaceStore>,
    project_id: String,
    path_segments: Vec<String>,
) -> Result<(), ProjectFilesError> {
    crate::ensure_agent_main_webview(&webview).map_err(|_| ProjectFilesError::path_denied())?;
    drop(webview);
    validate_project_id(&project_id)?;
    validate_path_segments(&path_segments)?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let project_root = project_root_for_id(&store, &project_id)?;
        open_project_file_in(&project_root, &path_segments)
    })
    .await
    .map_err(|_| ProjectFilesError::io("The project file opener did not complete."))?
}

fn project_root_for_id(
    store: &WorkspaceStore,
    project_id: &str,
) -> Result<PathBuf, ProjectFilesError> {
    let load = store.load().map_err(|_| {
        ProjectFilesError::new(
            ProjectFilesErrorCode::RootUnavailable,
            "The workspace project catalog is unavailable.",
        )
    })?;
    let snapshot = load.snapshot.ok_or_else(|| {
        ProjectFilesError::new(
            ProjectFilesErrorCode::RootUnavailable,
            "The workspace project catalog is unavailable.",
        )
    })?;
    let project = snapshot
        .state
        .projects
        .iter()
        .find(|project| project.id == project_id)
        .ok_or_else(|| {
            ProjectFilesError::new(
                ProjectFilesErrorCode::ProjectNotFound,
                "The project no longer exists.",
            )
        })?;
    Ok(PathBuf::from(&project.folder_path))
}

fn validate_project_id(project_id: &str) -> Result<(), ProjectFilesError> {
    if project_id.is_empty() || project_id.len() > MAX_PROJECT_ID_BYTES {
        return Err(ProjectFilesError::new(
            ProjectFilesErrorCode::ProjectNotFound,
            "The project identifier is invalid.",
        ));
    }
    Ok(())
}

fn validate_path_segments(segments: &[String]) -> Result<(), ProjectFilesError> {
    if segments.len() > MAX_PATH_DEPTH {
        return Err(ProjectFilesError::invalid_path());
    }
    let mut total_utf16_units = segments.len().saturating_sub(1);
    for segment in segments {
        let segment_utf16_units = segment.encode_utf16().count();
        total_utf16_units = total_utf16_units.saturating_add(segment_utf16_units);
        if segment.is_empty()
            || segment_utf16_units > MAX_PATH_SEGMENT_UTF16_UNITS
            || total_utf16_units > MAX_RELATIVE_PATH_UTF16_UNITS
            || segment.ends_with([' ', '.'])
            || segment.chars().any(|character| {
                character <= '\u{1f}'
                    || character == '\u{7f}'
                    || matches!(
                        character,
                        '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                    )
            })
        {
            return Err(ProjectFilesError::invalid_path());
        }
        let mut components = Path::new(segment).components();
        let Some(Component::Normal(component)) = components.next() else {
            return Err(ProjectFilesError::invalid_path());
        };
        if components.next().is_some() || component != OsStr::new(segment) {
            return Err(ProjectFilesError::invalid_path());
        }
    }
    Ok(())
}

fn list_project_directory_in(
    project_root: &Path,
    path_segments: &[String],
) -> Result<ProjectDirectoryResponse, ProjectFilesError> {
    list_project_directory_with_limit(project_root, path_segments, MAX_DIRECTORY_ENTRIES)
}

fn list_project_directory_with_limit(
    project_root: &Path,
    path_segments: &[String],
    limit: usize,
) -> Result<ProjectDirectoryResponse, ProjectFilesError> {
    validate_path_segments(path_segments)?;
    let canonical_root = canonical_project_root(project_root)?;
    let directory =
        resolve_existing_project_path(&canonical_root, path_segments, ExpectedPathKind::Directory)?;
    let read_directory = fs::read_dir(&directory).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => ProjectFilesError::new(
            ProjectFilesErrorCode::NotFound,
            "The project directory no longer exists.",
        ),
        io::ErrorKind::PermissionDenied => ProjectFilesError::path_denied(),
        _ => ProjectFilesError::io("The project directory could not be read."),
    })?;

    let mut entries = Vec::new();
    let mut truncated = false;
    for item in read_directory {
        if entries.len() >= limit {
            truncated = true;
            break;
        }
        let item = match item {
            Ok(item) => item,
            Err(_) => {
                truncated = true;
                continue;
            }
        };
        let Some(name) = item.file_name().to_str().map(str::to_owned) else {
            truncated = true;
            continue;
        };
        let metadata = match fs::symlink_metadata(item.path()) {
            Ok(metadata) => metadata,
            Err(_) => {
                truncated = true;
                continue;
            }
        };
        let kind = classify_entry(&metadata);
        let mut segments = path_segments.to_vec();
        segments.push(name.clone());
        entries.push(ProjectFileEntry {
            hidden: is_hidden_entry(&name, &metadata),
            openable: kind == ProjectFileKind::File && !is_unsafe_open_path(Path::new(&name)),
            name,
            segments,
            kind,
        });
    }
    entries.sort_by(compare_entries);
    Ok(ProjectDirectoryResponse { entries, truncated })
}

fn open_project_file_in(
    project_root: &Path,
    path_segments: &[String],
) -> Result<(), ProjectFilesError> {
    open_project_file_with(project_root, path_segments, open_with_default_application)
}

fn open_project_file_with<F>(
    project_root: &Path,
    path_segments: &[String],
    opener: F,
) -> Result<(), ProjectFilesError>
where
    F: FnOnce(&Path) -> Result<(), ProjectFilesError>,
{
    validate_path_segments(path_segments)?;
    if path_segments.is_empty() {
        return Err(ProjectFilesError::new(
            ProjectFilesErrorCode::NotFile,
            "Select a regular project file to open.",
        ));
    }
    let canonical_root = canonical_project_root(project_root)?;
    let file =
        resolve_existing_project_path(&canonical_root, path_segments, ExpectedPathKind::File)?;
    if is_unsafe_open_path(&file) {
        return Err(ProjectFilesError::new(
            ProjectFilesErrorCode::UnsafeFileType,
            "This file type can execute commands and cannot be opened from the project tree.",
        ));
    }

    // Shell APIs reopen a path rather than accepting our validated handle. Keep
    // the validation and launch adjacent, and fail closed if the entry changed.
    let metadata = fs::symlink_metadata(&file).map_err(|_| {
        ProjectFilesError::new(
            ProjectFilesErrorCode::NotFound,
            "The project file no longer exists.",
        )
    })?;
    if classify_entry(&metadata) != ProjectFileKind::File {
        return Err(ProjectFilesError::path_denied());
    }
    let rechecked = fs::canonicalize(&file).map_err(|_| ProjectFilesError::path_denied())?;
    if rechecked != file || !is_within_root(&canonical_root, &rechecked) {
        return Err(ProjectFilesError::path_denied());
    }
    opener(&rechecked)
}

#[derive(Clone, Copy)]
enum ExpectedPathKind {
    Directory,
    File,
}

fn canonical_project_root(project_root: &Path) -> Result<PathBuf, ProjectFilesError> {
    if !project_root.is_absolute() {
        return Err(ProjectFilesError::new(
            ProjectFilesErrorCode::RootUnavailable,
            "The project folder is unavailable.",
        ));
    }
    reject_reparse_components(project_root)?;
    let canonical_root = fs::canonicalize(project_root).map_err(|_| {
        ProjectFilesError::new(
            ProjectFilesErrorCode::RootUnavailable,
            "The project folder is unavailable.",
        )
    })?;
    let metadata = fs::symlink_metadata(&canonical_root).map_err(|_| {
        ProjectFilesError::new(
            ProjectFilesErrorCode::RootUnavailable,
            "The project folder is unavailable.",
        )
    })?;
    if !metadata.is_dir() || is_reparse(&metadata) {
        return Err(ProjectFilesError::new(
            ProjectFilesErrorCode::RootUnavailable,
            "The project folder is not a safe regular directory.",
        ));
    }
    Ok(canonical_root)
}

fn resolve_existing_project_path(
    canonical_root: &Path,
    path_segments: &[String],
    expected: ExpectedPathKind,
) -> Result<PathBuf, ProjectFilesError> {
    let mut current = canonical_root.to_path_buf();
    for (index, segment) in path_segments.iter().enumerate() {
        current.push(segment);
        let metadata = fs::symlink_metadata(&current).map_err(|error| match error.kind() {
            io::ErrorKind::NotFound => ProjectFilesError::new(
                ProjectFilesErrorCode::NotFound,
                "The requested project entry no longer exists.",
            ),
            io::ErrorKind::PermissionDenied => ProjectFilesError::path_denied(),
            _ => ProjectFilesError::io("The requested project entry could not be inspected."),
        })?;
        if is_reparse(&metadata) {
            return Err(ProjectFilesError::path_denied());
        }
        if index + 1 < path_segments.len() && !metadata.is_dir() {
            return Err(ProjectFilesError::new(
                ProjectFilesErrorCode::NotDirectory,
                "A project path component is not a directory.",
            ));
        }
    }
    let canonical = fs::canonicalize(&current).map_err(|_| ProjectFilesError::path_denied())?;
    if !is_within_root(canonical_root, &canonical) {
        return Err(ProjectFilesError::path_denied());
    }
    let metadata =
        fs::symlink_metadata(&canonical).map_err(|_| ProjectFilesError::path_denied())?;
    if is_reparse(&metadata) {
        return Err(ProjectFilesError::path_denied());
    }
    match expected {
        ExpectedPathKind::Directory if !metadata.is_dir() => Err(ProjectFilesError::new(
            ProjectFilesErrorCode::NotDirectory,
            "The requested project entry is not a directory.",
        )),
        ExpectedPathKind::File if !metadata.is_file() => Err(ProjectFilesError::new(
            ProjectFilesErrorCode::NotFile,
            "The requested project entry is not a regular file.",
        )),
        _ => Ok(canonical),
    }
}

fn is_within_root(root: &Path, candidate: &Path) -> bool {
    candidate == root || candidate.starts_with(root)
}

fn reject_reparse_components(path: &Path) -> Result<(), ProjectFilesError> {
    for ancestor in path.ancestors().collect::<Vec<_>>().into_iter().rev() {
        let metadata = match fs::symlink_metadata(ancestor) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(_) => {
                return Err(ProjectFilesError::new(
                    ProjectFilesErrorCode::RootUnavailable,
                    "The project folder could not be validated safely.",
                ));
            }
        };
        if is_reparse(&metadata) {
            return Err(ProjectFilesError::new(
                ProjectFilesErrorCode::RootUnavailable,
                "The project folder crosses a symbolic link or reparse point.",
            ));
        }
    }
    Ok(())
}

fn classify_entry(metadata: &fs::Metadata) -> ProjectFileKind {
    if is_reparse(metadata) {
        ProjectFileKind::Symlink
    } else if metadata.is_dir() {
        ProjectFileKind::Directory
    } else if metadata.is_file() {
        ProjectFileKind::File
    } else {
        ProjectFileKind::Other
    }
}

#[cfg(windows)]
fn is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn is_hidden_entry(name: &str, metadata: &fs::Metadata) -> bool {
    if name.starts_with('.') {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_HIDDEN;
        metadata.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
    }
    #[cfg(not(windows))]
    {
        let _ = metadata;
        false
    }
}

fn compare_entries(left: &ProjectFileEntry, right: &ProjectFileEntry) -> Ordering {
    entry_sort_rank(left.kind)
        .cmp(&entry_sort_rank(right.kind))
        .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        .then_with(|| left.name.cmp(&right.name))
}

fn entry_sort_rank(kind: ProjectFileKind) -> u8 {
    match kind {
        ProjectFileKind::Directory => 0,
        ProjectFileKind::File => 1,
        ProjectFileKind::Symlink => 2,
        ProjectFileKind::Other => 3,
    }
}

fn is_unsafe_open_path(path: &Path) -> bool {
    let Some(file_name) = path.file_name().and_then(OsStr::to_str) else {
        return true;
    };
    let normalized_name = file_name.trim_end_matches([' ', '.']);
    let Some(extension) = Path::new(normalized_name)
        .extension()
        .and_then(OsStr::to_str)
        .map(str::to_ascii_lowercase)
    else {
        return false;
    };
    matches!(
        extension.as_str(),
        "application"
            | "appref-ms"
            | "bat"
            | "cmd"
            | "com"
            | "cpl"
            | "diagcab"
            | "exe"
            | "gadget"
            | "hta"
            | "inf"
            | "ins"
            | "isp"
            | "jar"
            | "js"
            | "jse"
            | "lnk"
            | "msc"
            | "msi"
            | "msp"
            | "mst"
            | "pif"
            | "ps1"
            | "reg"
            | "scr"
            | "settingcontent-ms"
            | "url"
            | "vb"
            | "vbe"
            | "vbs"
            | "ws"
            | "wsc"
            | "wsf"
            | "wsh"
    )
}

#[cfg(windows)]
fn open_with_default_application(path: &Path) -> Result<(), ProjectFilesError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};

    let path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let verb = "open\0".encode_utf16().collect::<Vec<_>>();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            path.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize <= 32 {
        Err(ProjectFilesError::new(
            ProjectFilesErrorCode::OpenFailed,
            "Windows could not open the project file with its default application.",
        ))
    } else {
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn open_with_default_application(path: &Path) -> Result<(), ProjectFilesError> {
    std::process::Command::new("/usr/bin/open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|_| {
            ProjectFilesError::new(
                ProjectFilesErrorCode::OpenFailed,
                "The project file could not be opened with its default application.",
            )
        })
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_with_default_application(path: &Path) -> Result<(), ProjectFilesError> {
    std::process::Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|_| {
            ProjectFilesError::new(
                ProjectFilesErrorCode::OpenFailed,
                "The project file could not be opened with its default application.",
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn rejects_traversal_absolute_separators_and_oversized_paths() {
        for segments in [
            vec!["..".to_owned()],
            vec![".".to_owned()],
            vec![r"C:\outside".to_owned()],
            vec!["nested/file".to_owned()],
            vec![r"nested\file".to_owned()],
            vec!["stream:secret".to_owned()],
            vec!["trailing.".to_owned()],
        ] {
            assert_eq!(
                validate_path_segments(&segments).unwrap_err().code,
                ProjectFilesErrorCode::InvalidPath
            );
        }
        assert!(validate_path_segments(&vec!["a".to_owned(); MAX_PATH_DEPTH + 1]).is_err());
        assert!(validate_path_segments(&["🚀".repeat(128)]).is_err());
    }

    #[test]
    fn lists_one_level_with_directories_first_and_hidden_entries_visible() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("zeta")).unwrap();
        fs::create_dir(temp.path().join("Alpha")).unwrap();
        fs::write(temp.path().join("beta.txt"), b"beta").unwrap();
        fs::write(temp.path().join(".gitignore"), b"target").unwrap();

        let response = list_project_directory_in(temp.path(), &[]).unwrap();
        assert!(!response.truncated);
        assert_eq!(
            response
                .entries
                .iter()
                .map(|entry| (entry.name.as_str(), entry.kind))
                .collect::<Vec<_>>(),
            vec![
                ("Alpha", ProjectFileKind::Directory),
                ("zeta", ProjectFileKind::Directory),
                (".gitignore", ProjectFileKind::File),
                ("beta.txt", ProjectFileKind::File),
            ]
        );
        let hidden = response
            .entries
            .iter()
            .find(|entry| entry.name == ".gitignore")
            .unwrap();
        assert!(hidden.hidden);
        assert_eq!(hidden.segments, vec![".gitignore"]);
    }

    #[test]
    fn lists_only_the_requested_child_directory() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("src")).unwrap();
        fs::write(temp.path().join("root.txt"), b"root").unwrap();
        fs::write(temp.path().join("src").join("lib.rs"), b"lib").unwrap();

        let response = list_project_directory_in(temp.path(), &["src".to_owned()]).unwrap();
        assert_eq!(response.entries.len(), 1);
        assert_eq!(response.entries[0].name, "lib.rs");
        assert_eq!(response.entries[0].segments, vec!["src", "lib.rs"]);
    }

    #[test]
    fn caps_each_directory_and_reports_truncation() {
        let temp = tempfile::tempdir().unwrap();
        for name in ["a.txt", "b.txt", "c.txt"] {
            fs::write(temp.path().join(name), name.as_bytes()).unwrap();
        }
        let response = list_project_directory_with_limit(temp.path(), &[], 2).unwrap();
        assert_eq!(response.entries.len(), 2);
        assert!(response.truncated);
    }

    #[test]
    fn unsafe_types_are_not_openable_and_are_refused_by_opener() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("run.CMD"), b"echo no").unwrap();
        let response = list_project_directory_in(temp.path(), &[]).unwrap();
        assert!(!response.entries[0].openable);
        let error = open_project_file_with(temp.path(), &["run.CMD".to_owned()], |_| {
            panic!("unsafe files must not reach the opener")
        })
        .unwrap_err();
        assert_eq!(error.code, ProjectFilesErrorCode::UnsafeFileType);
    }

    #[test]
    fn safe_regular_file_reaches_injected_opener_once_with_canonical_path() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("README.md");
        fs::write(&source, b"read me").unwrap();
        let opened = Arc::new(Mutex::new(Vec::<PathBuf>::new()));
        let captured = Arc::clone(&opened);

        open_project_file_with(temp.path(), &["README.md".to_owned()], move |path| {
            captured.lock().unwrap().push(path.to_path_buf());
            Ok(())
        })
        .unwrap();

        assert_eq!(
            opened.lock().unwrap().as_slice(),
            &[fs::canonicalize(source).unwrap()]
        );
    }

    #[test]
    fn directories_cannot_be_opened_as_files() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("src")).unwrap();
        let error = open_project_file_with(temp.path(), &["src".to_owned()], |_| {
            panic!("directories must not reach the opener")
        })
        .unwrap_err();
        assert_eq!(error.code, ProjectFilesErrorCode::NotFile);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_entries_are_visible_but_cannot_be_traversed_or_opened() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), b"secret").unwrap();
        symlink(outside.path(), temp.path().join("linked")).unwrap();

        let response = list_project_directory_in(temp.path(), &[]).unwrap();
        assert_eq!(response.entries[0].kind, ProjectFileKind::Symlink);
        assert!(!response.entries[0].openable);
        assert_eq!(
            list_project_directory_in(temp.path(), &["linked".to_owned()])
                .unwrap_err()
                .code,
            ProjectFilesErrorCode::PathDenied
        );
    }

    #[cfg(windows)]
    #[test]
    fn reparse_entries_are_visible_but_cannot_be_traversed() {
        use std::os::windows::fs::symlink_dir;
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        if symlink_dir(outside.path(), temp.path().join("linked")).is_err() {
            // Creating a Windows symlink may require Developer Mode. The same
            // policy is covered unconditionally by metadata classification.
            return;
        }
        let response = list_project_directory_in(temp.path(), &[]).unwrap();
        assert_eq!(response.entries[0].kind, ProjectFileKind::Symlink);
        assert_eq!(
            list_project_directory_in(temp.path(), &["linked".to_owned()])
                .unwrap_err()
                .code,
            ProjectFilesErrorCode::PathDenied
        );
    }

    #[test]
    fn errors_do_not_disclose_absolute_project_paths() {
        let temp = tempfile::tempdir().unwrap();
        let error = list_project_directory_in(temp.path(), &["missing".to_owned()]).unwrap_err();
        assert!(
            !error
                .message
                .contains(temp.path().to_string_lossy().as_ref())
        );
        assert!(!error.message.contains("missing"));
    }
}
