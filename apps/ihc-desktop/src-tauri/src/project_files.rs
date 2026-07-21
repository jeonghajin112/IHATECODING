use crate::workspace_store::WorkspaceStore;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    cmp::Ordering,
    ffi::OsStr,
    fs,
    fs::OpenOptions,
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
};
use tauri::{State, Webview};
use uuid::Uuid;

const MAX_PROJECT_ID_BYTES: usize = 256;
const MAX_PATH_DEPTH: usize = 64;
const MAX_PATH_SEGMENT_UTF16_UNITS: usize = 255;
const MAX_RELATIVE_PATH_UTF16_UNITS: usize = 4_096;
const MAX_ABSOLUTE_PATH_UTF16_UNITS: usize = 32_767;
const MAX_DIRECTORY_ENTRIES: usize = 4_096;
const MAX_EDITABLE_FILE_BYTES: usize = 2 * 1_024 * 1_024;
const MAX_REVISION_BYTES: usize = 80;

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
    FileTooLarge,
    NotUtf8,
    NotText,
    InvalidRevision,
    Conflict,
    WriteFailed,
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

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectTextFileResponse {
    content: String,
    revision: String,
    byte_length: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveProjectTextFileResponse {
    revision: String,
    byte_length: usize,
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

#[tauri::command]
pub(crate) async fn resolve_project_file_path(
    webview: Webview,
    store: State<'_, WorkspaceStore>,
    project_id: String,
    absolute_path: String,
) -> Result<Option<Vec<String>>, ProjectFilesError> {
    crate::ensure_agent_main_webview(&webview).map_err(|_| ProjectFilesError::path_denied())?;
    drop(webview);
    validate_project_id(&project_id)?;
    validate_absolute_file_path(Path::new(&absolute_path))?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let project_root = project_root_for_id(&store, &project_id)?;
        resolve_project_file_path_in(&project_root, Path::new(&absolute_path))
    })
    .await
    .map_err(|_| ProjectFilesError::io("The project file resolver did not complete."))?
}

#[tauri::command]
pub(crate) async fn read_project_text_file(
    webview: Webview,
    store: State<'_, WorkspaceStore>,
    project_id: String,
    path_segments: Vec<String>,
) -> Result<ProjectTextFileResponse, ProjectFilesError> {
    crate::ensure_agent_main_webview(&webview).map_err(|_| ProjectFilesError::path_denied())?;
    drop(webview);
    validate_project_id(&project_id)?;
    validate_path_segments(&path_segments)?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let project_root = project_root_for_id(&store, &project_id)?;
        read_project_text_file_in(&project_root, &path_segments)
    })
    .await
    .map_err(|_| ProjectFilesError::io("The project file reader did not complete."))?
}

#[tauri::command]
pub(crate) async fn save_project_text_file(
    webview: Webview,
    store: State<'_, WorkspaceStore>,
    project_id: String,
    path_segments: Vec<String>,
    content: String,
    expected_revision: String,
) -> Result<SaveProjectTextFileResponse, ProjectFilesError> {
    crate::ensure_agent_main_webview(&webview).map_err(|_| ProjectFilesError::path_denied())?;
    drop(webview);
    validate_project_id(&project_id)?;
    validate_path_segments(&path_segments)?;
    validate_revision(&expected_revision)?;
    validate_editable_content(content.as_bytes())?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let project_root = project_root_for_id(&store, &project_id)?;
        save_project_text_file_in(
            &project_root,
            &path_segments,
            content.as_bytes(),
            &expected_revision,
        )
    })
    .await
    .map_err(|_| ProjectFilesError::io("The project file writer did not complete."))?
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

fn validate_absolute_file_path(path: &Path) -> Result<(), ProjectFilesError> {
    let Some(path_text) = path.to_str() else {
        return Err(ProjectFilesError::invalid_path());
    };
    if path_text.is_empty()
        || path_text.contains('\0')
        || path_text.encode_utf16().count() > MAX_ABSOLUTE_PATH_UTF16_UNITS
        || !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(ProjectFilesError::invalid_path());
    }
    Ok(())
}

fn resolve_project_file_path_in(
    project_root: &Path,
    absolute_path: &Path,
) -> Result<Option<Vec<String>>, ProjectFilesError> {
    validate_absolute_file_path(absolute_path)?;
    let canonical_root = canonical_project_root(project_root)?;

    // The content browser hands us an absolute path rather than project-relative
    // segments. Reject aliases before canonicalizing so a symlink/junction cannot
    // silently turn into an otherwise valid path below the project root.
    reject_reparse_components(absolute_path).map_err(|_| ProjectFilesError::path_denied())?;
    let metadata = fs::symlink_metadata(absolute_path).map_err(map_file_resolve_error)?;
    if classify_entry(&metadata) != ProjectFileKind::File {
        return Err(ProjectFilesError::new(
            ProjectFilesErrorCode::NotFile,
            "The requested project entry is not a regular file.",
        ));
    }

    let canonical_file = fs::canonicalize(absolute_path).map_err(map_file_resolve_error)?;
    let canonical_metadata =
        fs::symlink_metadata(&canonical_file).map_err(map_file_resolve_error)?;
    if classify_entry(&canonical_metadata) != ProjectFileKind::File {
        return Err(ProjectFilesError::path_denied());
    }
    if !is_within_root(&canonical_root, &canonical_file) {
        return Ok(None);
    }

    let relative = canonical_file
        .strip_prefix(&canonical_root)
        .map_err(|_| ProjectFilesError::path_denied())?;
    let mut path_segments = Vec::new();
    for component in relative.components() {
        let Component::Normal(segment) = component else {
            return Err(ProjectFilesError::invalid_path());
        };
        let segment = segment
            .to_str()
            .ok_or_else(ProjectFilesError::invalid_path)?;
        path_segments.push(segment.to_owned());
    }
    validate_path_segments(&path_segments)?;
    if path_segments.is_empty() {
        return Err(ProjectFilesError::new(
            ProjectFilesErrorCode::NotFile,
            "The requested project entry is not a regular file.",
        ));
    }

    // Re-resolve through the existing project-relative path policy. Besides
    // sharing its containment rules, this closes races where an entry changes
    // between canonicalization and returning the segments to the frontend.
    let rechecked =
        resolve_existing_project_path(&canonical_root, &path_segments, ExpectedPathKind::File)?;
    if rechecked != canonical_file {
        return Err(ProjectFilesError::path_denied());
    }
    Ok(Some(path_segments))
}

fn map_file_resolve_error(error: io::Error) -> ProjectFilesError {
    match error.kind() {
        io::ErrorKind::NotFound => ProjectFilesError::new(
            ProjectFilesErrorCode::NotFound,
            "The requested project entry no longer exists.",
        ),
        io::ErrorKind::PermissionDenied => ProjectFilesError::path_denied(),
        _ => ProjectFilesError::io("The requested project entry could not be inspected."),
    }
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

fn validate_revision(revision: &str) -> Result<(), ProjectFilesError> {
    let digest = revision.strip_prefix("sha256:").ok_or_else(|| {
        ProjectFilesError::new(
            ProjectFilesErrorCode::InvalidRevision,
            "The project file revision is invalid.",
        )
    })?;
    if revision.len() > MAX_REVISION_BYTES
        || digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ProjectFilesError::new(
            ProjectFilesErrorCode::InvalidRevision,
            "The project file revision is invalid.",
        ));
    }
    Ok(())
}

fn validate_editable_content(bytes: &[u8]) -> Result<(), ProjectFilesError> {
    if bytes.len() > MAX_EDITABLE_FILE_BYTES {
        return Err(ProjectFilesError::new(
            ProjectFilesErrorCode::FileTooLarge,
            "The project file is too large for the lightweight editor.",
        ));
    }
    if bytes.contains(&0) {
        return Err(ProjectFilesError::new(
            ProjectFilesErrorCode::NotText,
            "The project file is not a supported text file.",
        ));
    }
    Ok(())
}

fn read_project_text_file_in(
    project_root: &Path,
    path_segments: &[String],
) -> Result<ProjectTextFileResponse, ProjectFilesError> {
    validate_path_segments(path_segments)?;
    if path_segments.is_empty() {
        return Err(ProjectFilesError::new(
            ProjectFilesErrorCode::NotFile,
            "Select a regular project file to edit.",
        ));
    }
    let canonical_root = canonical_project_root(project_root)?;
    let file =
        resolve_existing_project_path(&canonical_root, path_segments, ExpectedPathKind::File)?;
    let bytes = read_regular_file_bytes(&canonical_root, &file)?;
    let content = String::from_utf8(bytes).map_err(|_| {
        ProjectFilesError::new(
            ProjectFilesErrorCode::NotUtf8,
            "The project file is not UTF-8 text.",
        )
    })?;
    let byte_length = content.len();
    let revision = revision_for(content.as_bytes());
    Ok(ProjectTextFileResponse {
        content,
        revision,
        byte_length,
    })
}

fn save_project_text_file_in(
    project_root: &Path,
    path_segments: &[String],
    content: &[u8],
    expected_revision: &str,
) -> Result<SaveProjectTextFileResponse, ProjectFilesError> {
    validate_path_segments(path_segments)?;
    validate_revision(expected_revision)?;
    validate_editable_content(content)?;
    if path_segments.is_empty() {
        return Err(ProjectFilesError::new(
            ProjectFilesErrorCode::NotFile,
            "Select a regular project file to edit.",
        ));
    }

    let canonical_root = canonical_project_root(project_root)?;
    let file =
        resolve_existing_project_path(&canonical_root, path_segments, ExpectedPathKind::File)?;
    ensure_expected_revision(&canonical_root, &file, expected_revision)?;

    let parent = file.parent().ok_or_else(ProjectFilesError::path_denied)?;
    if !is_within_root(&canonical_root, parent) {
        return Err(ProjectFilesError::path_denied());
    }
    let temporary = parent.join(format!(".ihc-save-{}.tmp", Uuid::new_v4().hyphenated()));
    let write_result = write_temporary_file(&canonical_root, &temporary, content);
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }

    // Re-resolve the destination and compare the exact bytes immediately
    // before replacement. This closes the common edit-between-read-and-save
    // window and keeps a stale editor from silently overwriting newer work.
    let latest_file =
        match resolve_existing_project_path(&canonical_root, path_segments, ExpectedPathKind::File)
        {
            Ok(file) => file,
            Err(error) => {
                let _ = fs::remove_file(&temporary);
                return Err(error);
            }
        };
    if latest_file != file {
        let _ = fs::remove_file(&temporary);
        return Err(ProjectFilesError::path_denied());
    }
    if let Err(error) = ensure_expected_revision(&canonical_root, &latest_file, expected_revision) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }

    if let Err(error) = atomic_replace_file(&latest_file, &temporary) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    sync_parent_directory(parent)?;

    let revision = revision_for(content);
    Ok(SaveProjectTextFileResponse {
        revision,
        byte_length: content.len(),
    })
}

fn read_regular_file_bytes(
    canonical_root: &Path,
    file: &Path,
) -> Result<Vec<u8>, ProjectFilesError> {
    let metadata = fs::symlink_metadata(file).map_err(map_file_read_error)?;
    if classify_entry(&metadata) != ProjectFileKind::File {
        return Err(ProjectFilesError::path_denied());
    }
    if metadata.len() > MAX_EDITABLE_FILE_BYTES as u64 {
        return Err(ProjectFilesError::new(
            ProjectFilesErrorCode::FileTooLarge,
            "The project file is too large for the lightweight editor.",
        ));
    }

    let mut handle = OpenOptions::new()
        .read(true)
        .open(file)
        .map_err(map_file_read_error)?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    (&mut handle)
        .take(MAX_EDITABLE_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(map_file_read_error)?;
    validate_editable_content(&bytes)?;

    let rechecked = fs::canonicalize(file).map_err(|_| ProjectFilesError::path_denied())?;
    let rechecked_metadata =
        fs::symlink_metadata(&rechecked).map_err(|_| ProjectFilesError::path_denied())?;
    if rechecked != file
        || !is_within_root(canonical_root, &rechecked)
        || classify_entry(&rechecked_metadata) != ProjectFileKind::File
    {
        return Err(ProjectFilesError::path_denied());
    }
    Ok(bytes)
}

fn ensure_expected_revision(
    canonical_root: &Path,
    file: &Path,
    expected_revision: &str,
) -> Result<(), ProjectFilesError> {
    let current = read_regular_file_bytes(canonical_root, file)?;
    if revision_for(&current) != expected_revision {
        return Err(ProjectFilesError::new(
            ProjectFilesErrorCode::Conflict,
            "The project file changed on disk. Reload it before saving.",
        ));
    }
    Ok(())
}

fn revision_for(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut revision = String::with_capacity(7 + digest.len() * 2);
    revision.push_str("sha256:");
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(revision, "{byte:02x}");
    }
    revision
}

fn write_temporary_file(
    canonical_root: &Path,
    temporary: &Path,
    content: &[u8],
) -> Result<(), ProjectFilesError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temporary)
        .map_err(map_file_write_error)?;
    file.write_all(content).map_err(map_file_write_error)?;
    file.sync_all().map_err(map_file_write_error)?;
    drop(file);

    let canonical_temporary =
        fs::canonicalize(temporary).map_err(|_| ProjectFilesError::path_denied())?;
    let metadata =
        fs::symlink_metadata(&canonical_temporary).map_err(|_| ProjectFilesError::path_denied())?;
    if canonical_temporary != temporary
        || !is_within_root(canonical_root, &canonical_temporary)
        || classify_entry(&metadata) != ProjectFileKind::File
    {
        return Err(ProjectFilesError::path_denied());
    }
    Ok(())
}

fn map_file_read_error(error: io::Error) -> ProjectFilesError {
    match error.kind() {
        io::ErrorKind::NotFound => ProjectFilesError::new(
            ProjectFilesErrorCode::NotFound,
            "The project file no longer exists.",
        ),
        io::ErrorKind::PermissionDenied => ProjectFilesError::path_denied(),
        _ => ProjectFilesError::io("The project file could not be read."),
    }
}

fn map_file_write_error(error: io::Error) -> ProjectFilesError {
    match error.kind() {
        io::ErrorKind::PermissionDenied => ProjectFilesError::new(
            ProjectFilesErrorCode::WriteFailed,
            "The project file is not writable.",
        ),
        _ => ProjectFilesError::new(
            ProjectFilesErrorCode::WriteFailed,
            "The project file could not be saved.",
        ),
    }
}

#[cfg(windows)]
fn atomic_replace_file(destination: &Path, replacement: &Path) -> Result<(), ProjectFilesError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{REPLACEFILE_WRITE_THROUGH, ReplaceFileW};

    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let replacement = replacement
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let replaced = unsafe {
        ReplaceFileW(
            destination.as_ptr(),
            replacement.as_ptr(),
            std::ptr::null(),
            REPLACEFILE_WRITE_THROUGH,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if replaced == 0 {
        Err(ProjectFilesError::new(
            ProjectFilesErrorCode::WriteFailed,
            "Windows could not atomically save the project file.",
        ))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn atomic_replace_file(destination: &Path, replacement: &Path) -> Result<(), ProjectFilesError> {
    let permissions = fs::metadata(destination)
        .map_err(map_file_write_error)?
        .permissions();
    fs::set_permissions(replacement, permissions).map_err(map_file_write_error)?;
    fs::rename(replacement, destination).map_err(map_file_write_error)
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> Result<(), ProjectFilesError> {
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(map_file_write_error)
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> Result<(), ProjectFilesError> {
    Ok(())
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

    #[test]
    fn resolves_an_absolute_regular_file_to_project_relative_segments() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("docs")).unwrap();
        let source = temp.path().join("docs").join("안내.md");
        fs::write(&source, b"# guide").unwrap();

        assert_eq!(
            resolve_project_file_path_in(temp.path(), &source).unwrap(),
            Some(vec!["docs".to_owned(), "안내.md".to_owned()])
        );
    }

    #[test]
    fn absolute_file_resolver_returns_none_for_outside_and_sibling_prefix_files() {
        let container = tempfile::tempdir().unwrap();
        let project_root = container.path().join("project");
        let sibling_root = container.path().join("project-copy");
        fs::create_dir(&project_root).unwrap();
        fs::create_dir(&sibling_root).unwrap();
        let sibling_file = sibling_root.join("README.md");
        fs::write(&sibling_file, b"outside").unwrap();
        let outside = tempfile::tempdir().unwrap();
        let outside_file = outside.path().join("README.md");
        fs::write(&outside_file, b"outside").unwrap();

        assert_eq!(
            resolve_project_file_path_in(&project_root, &sibling_file).unwrap(),
            None
        );
        assert_eq!(
            resolve_project_file_path_in(&project_root, &outside_file).unwrap(),
            None
        );
    }

    #[test]
    fn absolute_file_resolver_rejects_relative_missing_and_directory_paths() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("docs")).unwrap();

        let relative =
            resolve_project_file_path_in(temp.path(), Path::new("README.md")).unwrap_err();
        assert_eq!(relative.code, ProjectFilesErrorCode::InvalidPath);

        let missing =
            resolve_project_file_path_in(temp.path(), &temp.path().join("missing.md")).unwrap_err();
        assert_eq!(missing.code, ProjectFilesErrorCode::NotFound);

        let directory =
            resolve_project_file_path_in(temp.path(), &temp.path().join("docs")).unwrap_err();
        assert_eq!(directory.code, ProjectFilesErrorCode::NotFile);
    }

    #[cfg(unix)]
    #[test]
    fn absolute_file_resolver_rejects_symlink_aliases_even_when_target_is_inside() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target.md");
        let alias = temp.path().join("alias.md");
        fs::write(&target, b"target").unwrap();
        symlink(&target, &alias).unwrap();

        let error = resolve_project_file_path_in(temp.path(), &alias).unwrap_err();
        assert_eq!(error.code, ProjectFilesErrorCode::PathDenied);
    }

    #[cfg(windows)]
    #[test]
    fn absolute_file_resolver_rejects_reparse_aliases_even_when_target_is_inside() {
        use std::os::windows::fs::symlink_file;

        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target.md");
        let alias = temp.path().join("alias.md");
        fs::write(&target, b"target").unwrap();
        if symlink_file(&target, &alias).is_err() {
            // Creating a Windows symlink may require Developer Mode.
            return;
        }

        let error = resolve_project_file_path_in(temp.path(), &alias).unwrap_err();
        assert_eq!(error.code, ProjectFilesErrorCode::PathDenied);
    }

    #[test]
    fn reads_utf8_text_with_a_stable_content_revision() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("README.md"), "# 제목\r\n본문").unwrap();

        let response = read_project_text_file_in(temp.path(), &["README.md".to_owned()]).unwrap();

        assert_eq!(response.content, "# 제목\r\n본문");
        assert_eq!(response.byte_length, response.content.len());
        assert_eq!(response.revision, revision_for(response.content.as_bytes()));
        assert!(response.revision.starts_with("sha256:"));
        assert_eq!(response.revision.len(), 71);
    }

    #[test]
    fn rejects_non_utf8_nul_and_oversized_editor_files() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("binary.dat"), [0xff, 0xfe, 0xfd]).unwrap();
        let error = read_project_text_file_in(temp.path(), &["binary.dat".to_owned()]).unwrap_err();
        assert_eq!(error.code, ProjectFilesErrorCode::NotUtf8);

        fs::write(temp.path().join("nul.txt"), b"hello\0world").unwrap();
        let error = read_project_text_file_in(temp.path(), &["nul.txt".to_owned()]).unwrap_err();
        assert_eq!(error.code, ProjectFilesErrorCode::NotText);

        fs::write(
            temp.path().join("large.txt"),
            vec![b'a'; MAX_EDITABLE_FILE_BYTES + 1],
        )
        .unwrap();
        let error = read_project_text_file_in(temp.path(), &["large.txt".to_owned()]).unwrap_err();
        assert_eq!(error.code, ProjectFilesErrorCode::FileTooLarge);
    }

    #[test]
    fn saves_text_atomically_and_returns_the_new_revision() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("notes.md");
        fs::write(&path, b"before").unwrap();
        let expected_revision = revision_for(b"before");

        let response = save_project_text_file_in(
            temp.path(),
            &["notes.md".to_owned()],
            "수정됨\n".as_bytes(),
            &expected_revision,
        )
        .unwrap();

        assert_eq!(fs::read_to_string(path).unwrap(), "수정됨\n");
        assert_eq!(response.byte_length, "수정됨\n".len());
        assert_eq!(response.revision, revision_for("수정됨\n".as_bytes()));
        assert_eq!(
            fs::read_dir(temp.path())
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".ihc-save-"))
                .count(),
            0
        );
    }

    #[test]
    fn stale_revision_refuses_overwrite_and_leaves_no_temporary_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("notes.md");
        fs::write(&path, b"newer disk content").unwrap();

        let error = save_project_text_file_in(
            temp.path(),
            &["notes.md".to_owned()],
            b"stale editor content",
            &revision_for(b"older content"),
        )
        .unwrap_err();

        assert_eq!(error.code, ProjectFilesErrorCode::Conflict);
        assert_eq!(fs::read(&path).unwrap(), b"newer disk content");
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[test]
    fn save_rejects_invalid_revisions_and_content_before_writing() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("notes.md");
        fs::write(&path, b"unchanged").unwrap();

        let error = save_project_text_file_in(
            temp.path(),
            &["notes.md".to_owned()],
            b"replacement",
            "not-a-revision",
        )
        .unwrap_err();
        assert_eq!(error.code, ProjectFilesErrorCode::InvalidRevision);

        let error = save_project_text_file_in(
            temp.path(),
            &["notes.md".to_owned()],
            b"replacement\0",
            &revision_for(b"unchanged"),
        )
        .unwrap_err();
        assert_eq!(error.code, ProjectFilesErrorCode::NotText);
        assert_eq!(fs::read(path).unwrap(), b"unchanged");
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
