use serde::Serialize;
use std::{
    cmp::Ordering,
    collections::{HashMap, hash_map::Entry},
    ffi::OsStr,
    fs, io,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};
use tauri::{Manager, State, Webview};
use uuid::Uuid;

const MAX_GRANTS: usize = 64;
const MAX_GRANT_ID_BYTES: usize = 128;
const MAX_PATH_DEPTH: usize = 64;
const MAX_PATH_SEGMENT_UTF16_UNITS: usize = 255;
const MAX_RELATIVE_PATH_UTF16_UNITS: usize = 4_096;
const MAX_DIRECTORY_ENTRIES: usize = 240;
const MAX_DIRECTORY_SCAN_ENTRIES: usize = 4_096;
const MAX_CONTENT_SELECTIONS: usize = 20;
const MAX_SAFE_JS_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_IMAGE_PREVIEW_BYTES: u64 = 64 * 1024 * 1024;
const MAX_VIDEO_PREVIEW_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum MediaBrowserErrorCode {
    InvalidRoot,
    InvalidGrant,
    InvalidPath,
    PathDenied,
    RootUnavailable,
    NotFound,
    NotDirectory,
    NotFile,
    UnsafeFileType,
    OpenFailed,
    TooManySelections,
    TooManyGrants,
    Io,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaBrowserError {
    code: MediaBrowserErrorCode,
    message: String,
}

impl MediaBrowserError {
    fn new(code: MediaBrowserErrorCode, message: &str) -> Self {
        Self {
            code,
            message: message.to_owned(),
        }
    }

    fn invalid_root() -> Self {
        Self::new(
            MediaBrowserErrorCode::InvalidRoot,
            "Select an absolute local media folder.",
        )
    }

    fn invalid_grant() -> Self {
        Self::new(
            MediaBrowserErrorCode::InvalidGrant,
            "The media folder permission is no longer available.",
        )
    }

    fn invalid_path() -> Self {
        Self::new(
            MediaBrowserErrorCode::InvalidPath,
            "The media-relative path is invalid.",
        )
    }

    fn path_denied() -> Self {
        Self::new(
            MediaBrowserErrorCode::PathDenied,
            "The requested path is not a safe regular media path.",
        )
    }

    fn root_unavailable() -> Self {
        Self::new(
            MediaBrowserErrorCode::RootUnavailable,
            "The selected media folder is unavailable.",
        )
    }

    fn io(message: &str) -> Self {
        Self::new(MediaBrowserErrorCode::Io, message)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum MediaEntryKind {
    Directory,
    Image,
    Video,
    File,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaRootGrantResponse {
    grant_id: String,
    root_name: String,
    root_path: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaLocationResponse {
    grant_id: String,
    root_name: String,
    root_path: String,
    initial_path_segments: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    focus_file_name: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaDirectoryEntry {
    name: String,
    path_segments: Vec<String>,
    kind: MediaEntryKind,
    size_bytes: Option<u64>,
    preview_path: Option<String>,
    openable: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaDirectoryResponse {
    grant_id: String,
    root_name: String,
    path_segments: Vec<String>,
    entries: Vec<MediaDirectoryEntry>,
    truncated: bool,
}

#[derive(Clone, Debug)]
struct MediaGrant {
    root: PathBuf,
    root_name: String,
}

/// Process-local media folder grants. The service deliberately has no storage
/// serialization, so every grant disappears when the application exits.
#[derive(Clone, Default)]
pub(crate) struct MediaBrowserService {
    grants: Arc<Mutex<HashMap<String, MediaGrant>>>,
}

impl MediaBrowserService {
    fn grants(&self) -> Result<MutexGuard<'_, HashMap<String, MediaGrant>>, MediaBrowserError> {
        self.grants
            .lock()
            .map_err(|_| MediaBrowserError::io("The media permission store is unavailable."))
    }

    fn grant_root(&self, root_path: String) -> Result<MediaRootGrantResponse, MediaBrowserError> {
        let canonical_root = canonical_media_root(Path::new(&root_path))?;
        let root_path = normal_absolute_path(&canonical_root)?;
        let root_name = canonical_root
            .file_name()
            .and_then(OsStr::to_str)
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| root_path.clone());

        let mut grants = self.grants()?;
        if let Some((grant_id, _)) = grants
            .iter()
            .find(|(_, grant)| grant.root == canonical_root)
        {
            return Ok(MediaRootGrantResponse {
                grant_id: grant_id.clone(),
                root_name,
                root_path,
            });
        }
        if grants.len() >= MAX_GRANTS {
            return Err(MediaBrowserError::new(
                MediaBrowserErrorCode::TooManyGrants,
                "Too many media folders are open. Restart the application to clear old permissions.",
            ));
        }

        let grant = MediaGrant {
            root: canonical_root,
            root_name: root_name.clone(),
        };
        let grant_id = loop {
            let candidate = Uuid::new_v4().hyphenated().to_string();
            if let Entry::Vacant(entry) = grants.entry(candidate.clone()) {
                entry.insert(grant.clone());
                break candidate;
            }
        };
        Ok(MediaRootGrantResponse {
            grant_id,
            root_name,
            root_path,
        })
    }

    fn grant(&self, grant_id: &str) -> Result<MediaGrant, MediaBrowserError> {
        validate_grant_id(grant_id)?;
        self.grants()?
            .get(grant_id)
            .cloned()
            .ok_or_else(MediaBrowserError::invalid_grant)
    }

    fn open_location(
        &self,
        start_path: String,
    ) -> Result<MediaLocationResponse, MediaBrowserError> {
        let location = canonical_media_location(Path::new(&start_path))?;
        let requested_directory = location.directory;
        let boundary = filesystem_root_for(&requested_directory)?;
        let boundary_path = normal_absolute_path(&boundary)?;
        let root_response = self.grant_root(boundary_path)?;
        let grant = self.grant(&root_response.grant_id)?;
        let verified_root = verify_granted_root(&grant.root)?;
        let initial_path_segments = relative_path_segments(&verified_root, &requested_directory)?;

        // Re-resolve the requested location through the same grant path used by
        // subsequent listings. This fails closed if a path component became a
        // reparse point or escaped the filesystem boundary during setup.
        let rechecked = resolve_existing_media_path(
            &verified_root,
            &initial_path_segments,
            ExpectedMediaPathKind::Directory,
        )?;
        if rechecked != requested_directory {
            return Err(MediaBrowserError::path_denied());
        }

        if let Some(file_path) = location.focus_file_path {
            let mut file_segments = initial_path_segments.clone();
            let focus_file_name = location
                .focus_file_name
                .as_deref()
                .ok_or_else(MediaBrowserError::invalid_path)?;
            file_segments.push(focus_file_name.to_owned());
            let rechecked_file = resolve_verified_regular_file(&verified_root, &file_segments)?;
            if rechecked_file != file_path {
                return Err(MediaBrowserError::path_denied());
            }
        }

        Ok(MediaLocationResponse {
            grant_id: root_response.grant_id,
            root_name: root_response.root_name,
            root_path: root_response.root_path,
            initial_path_segments,
            focus_file_name: location.focus_file_name,
        })
    }

    fn list_volumes(&self) -> Result<Vec<MediaRootGrantResponse>, MediaBrowserError> {
        let mut candidates = system_media_volume_paths()?;

        // GetLogicalDriveStringsW includes mapped network drives. UNC shares
        // entered explicitly do not have a global enumerable catalog, so keep
        // already-open share boundaries discoverable for this process too.
        let granted_roots = self
            .grants()?
            .values()
            .map(|grant| grant.root.clone())
            .collect::<Vec<_>>();
        for granted_root in granted_roots {
            let Ok(boundary) = filesystem_root_for(&granted_root) else {
                continue;
            };
            if !candidates.contains(&boundary) {
                candidates.push(boundary);
            }
        }

        let mut canonical_roots = Vec::new();
        let mut volumes = Vec::new();
        for candidate in candidates {
            let Ok(canonical) = canonical_media_root(&candidate) else {
                // Removable or disconnected mapped drives may be advertised by
                // Windows while unavailable. They are not accessible volumes.
                continue;
            };
            if canonical_roots.contains(&canonical) {
                continue;
            }
            let root_path = normal_absolute_path(&canonical)?;
            match self.grant_root(root_path) {
                Ok(volume) => {
                    canonical_roots.push(canonical);
                    volumes.push(volume);
                }
                Err(error) if error.code == MediaBrowserErrorCode::TooManyGrants => break,
                Err(error) => return Err(error),
            }
        }
        volumes.sort_by(|left, right| {
            left.root_path
                .to_lowercase()
                .cmp(&right.root_path.to_lowercase())
                .then_with(|| left.root_path.cmp(&right.root_path))
        });
        Ok(volumes)
    }

    fn list_directory(
        &self,
        grant_id: String,
        path_segments: Vec<String>,
    ) -> Result<MediaDirectoryResponse, MediaBrowserError> {
        validate_path_segments(&path_segments)?;
        let grant = self.grant(&grant_id)?;
        let root = verify_granted_root(&grant.root)?;
        let directory =
            resolve_existing_media_path(&root, &path_segments, ExpectedMediaPathKind::Directory)?;
        let read_directory = fs::read_dir(directory).map_err(|error| match error.kind() {
            io::ErrorKind::NotFound => MediaBrowserError::new(
                MediaBrowserErrorCode::NotFound,
                "The media directory no longer exists.",
            ),
            io::ErrorKind::PermissionDenied => MediaBrowserError::path_denied(),
            _ => MediaBrowserError::io("The media directory could not be read."),
        })?;

        let mut entries = Vec::new();
        let mut truncated = false;
        for (scanned, item) in read_directory.enumerate() {
            if scanned >= MAX_DIRECTORY_SCAN_ENTRIES {
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
            let mut segments = path_segments.clone();
            segments.push(name.clone());
            if validate_path_segments(&segments).is_err() {
                continue;
            }
            let metadata = match fs::symlink_metadata(item.path()) {
                Ok(metadata) => metadata,
                Err(_) => {
                    truncated = true;
                    continue;
                }
            };
            if is_reparse(&metadata) {
                continue;
            }

            let (kind, size_bytes, preview_path, openable) = if metadata.is_dir() {
                (MediaEntryKind::Directory, None, None, true)
            } else if metadata.is_file() {
                let kind = content_entry_kind(Path::new(&name));
                let verified = match resolve_verified_regular_file(&root, &segments) {
                    Ok(path) => path,
                    Err(_) => {
                        truncated = true;
                        continue;
                    }
                };
                let verified_metadata = match fs::symlink_metadata(&verified) {
                    Ok(metadata) if metadata.is_file() && !is_reparse(&metadata) => metadata,
                    _ => {
                        truncated = true;
                        continue;
                    }
                };
                let file_size = verified_metadata.len();
                let preview_path = if can_preview_file(kind, file_size) {
                    match normal_absolute_path(&verified) {
                        Ok(path) => Some(path),
                        Err(_) => {
                            truncated = true;
                            continue;
                        }
                    }
                } else {
                    None
                };
                (
                    kind,
                    safe_js_file_size(file_size),
                    preview_path,
                    !is_unsafe_open_path(&verified),
                )
            } else {
                continue;
            };

            entries.push(MediaDirectoryEntry {
                name,
                path_segments: segments,
                kind,
                size_bytes,
                preview_path,
                openable,
            });
        }
        entries.sort_by(compare_entries);
        if entries.len() > MAX_DIRECTORY_ENTRIES {
            entries.truncate(MAX_DIRECTORY_ENTRIES);
            truncated = true;
        }

        Ok(MediaDirectoryResponse {
            grant_id,
            root_name: grant.root_name,
            path_segments,
            entries,
            truncated,
        })
    }

    fn resolve_files(
        &self,
        grant_id: String,
        selections: Vec<Vec<String>>,
    ) -> Result<Vec<String>, MediaBrowserError> {
        if selections.len() > MAX_CONTENT_SELECTIONS {
            return Err(MediaBrowserError::new(
                MediaBrowserErrorCode::TooManySelections,
                "Select no more than 20 files at once.",
            ));
        }
        let grant = self.grant(&grant_id)?;
        let root = verify_granted_root(&grant.root)?;
        let mut first_pass = Vec::with_capacity(selections.len());
        for segments in &selections {
            validate_path_segments(segments)?;
            first_pass.push(resolve_verified_regular_file(&root, segments)?);
        }

        // Shells and asset protocols reopen a path after this command returns.
        // Resolve every entry for a second time immediately before disclosure,
        // failing closed if an entry was exchanged during the batch.
        let mut resolved = Vec::with_capacity(first_pass.len());
        for (segments, expected) in selections.iter().zip(&first_pass) {
            let rechecked = resolve_verified_regular_file(&root, segments)?;
            if &rechecked != expected {
                return Err(MediaBrowserError::path_denied());
            }
            resolved.push(normal_absolute_path(&rechecked)?);
        }
        Ok(resolved)
    }

    fn resolve_entry_path(
        &self,
        grant_id: String,
        path_segments: Vec<String>,
    ) -> Result<String, MediaBrowserError> {
        let resolved = self.resolve_entry(&grant_id, &path_segments, ExpectedMediaPathKind::Any)?;
        normal_absolute_path(&resolved)
    }

    fn open_entry(
        &self,
        grant_id: String,
        path_segments: Vec<String>,
    ) -> Result<(), MediaBrowserError> {
        self.open_entry_with(grant_id, path_segments, open_with_default_application)
    }

    fn open_entry_with<F>(
        &self,
        grant_id: String,
        path_segments: Vec<String>,
        opener: F,
    ) -> Result<(), MediaBrowserError>
    where
        F: FnOnce(&Path) -> Result<(), MediaBrowserError>,
    {
        let resolved = self.resolve_entry(&grant_id, &path_segments, ExpectedMediaPathKind::Any)?;
        let metadata =
            fs::symlink_metadata(&resolved).map_err(|_| MediaBrowserError::path_denied())?;
        if metadata.is_file() && is_unsafe_open_path(&resolved) {
            return Err(MediaBrowserError::new(
                MediaBrowserErrorCode::UnsafeFileType,
                "This file type can execute commands and cannot be opened from the content browser.",
            ));
        }

        // Shell APIs reopen paths by name. Resolve once more immediately before
        // handing the path to the operating system, and fail closed on change.
        let rechecked =
            self.resolve_entry(&grant_id, &path_segments, ExpectedMediaPathKind::Any)?;
        if rechecked != resolved {
            return Err(MediaBrowserError::path_denied());
        }
        let rechecked_metadata =
            fs::symlink_metadata(&rechecked).map_err(|_| MediaBrowserError::path_denied())?;
        if is_reparse(&rechecked_metadata)
            || (rechecked_metadata.is_file() && is_unsafe_open_path(&rechecked))
        {
            return Err(MediaBrowserError::new(
                MediaBrowserErrorCode::UnsafeFileType,
                "This file type can execute commands and cannot be opened from the content browser.",
            ));
        }
        opener(&rechecked)
    }

    fn reveal_entry(
        &self,
        grant_id: String,
        path_segments: Vec<String>,
    ) -> Result<(), MediaBrowserError> {
        let resolved = self.resolve_entry(&grant_id, &path_segments, ExpectedMediaPathKind::Any)?;
        let rechecked =
            self.resolve_entry(&grant_id, &path_segments, ExpectedMediaPathKind::Any)?;
        if rechecked != resolved {
            return Err(MediaBrowserError::path_denied());
        }
        reveal_in_file_manager(&rechecked)
    }

    fn delete_file(
        &self,
        grant_id: String,
        path_segments: Vec<String>,
    ) -> Result<(), MediaBrowserError> {
        let resolved =
            self.resolve_entry(&grant_id, &path_segments, ExpectedMediaPathKind::File)?;

        // Deletion is intentionally limited to regular files. Directories are
        // never removed by this command, recursively or otherwise.
        let rechecked =
            self.resolve_entry(&grant_id, &path_segments, ExpectedMediaPathKind::File)?;
        if rechecked != resolved {
            return Err(MediaBrowserError::path_denied());
        }
        delete_verified_regular_file(&rechecked)
    }

    fn resolve_entry(
        &self,
        grant_id: &str,
        path_segments: &[String],
        expected: ExpectedMediaPathKind,
    ) -> Result<PathBuf, MediaBrowserError> {
        validate_path_segments(path_segments)?;
        let grant = self.grant(grant_id)?;
        let root = verify_granted_root(&grant.root)?;
        let first = resolve_existing_media_path(&root, path_segments, expected)?;
        let second = resolve_existing_media_path(&root, path_segments, expected)?;
        if second != first {
            return Err(MediaBrowserError::path_denied());
        }
        Ok(second)
    }
}

#[tauri::command]
pub(crate) async fn open_media_location(
    webview: Webview,
    service: State<'_, MediaBrowserService>,
    start_path: String,
) -> Result<MediaLocationResponse, MediaBrowserError> {
    crate::ensure_agent_main_webview(&webview).map_err(|_| MediaBrowserError::path_denied())?;
    drop(webview);
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.open_location(start_path))
        .await
        .map_err(|_| MediaBrowserError::io("The media location opener did not complete."))?
}

#[tauri::command]
pub(crate) async fn list_media_volumes(
    webview: Webview,
    service: State<'_, MediaBrowserService>,
) -> Result<Vec<MediaRootGrantResponse>, MediaBrowserError> {
    crate::ensure_agent_main_webview(&webview).map_err(|_| MediaBrowserError::path_denied())?;
    drop(webview);
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.list_volumes())
        .await
        .map_err(|_| MediaBrowserError::io("The media volume reader did not complete."))?
}

#[tauri::command]
pub(crate) async fn list_media_directory(
    webview: Webview,
    service: State<'_, MediaBrowserService>,
    grant_id: String,
    path_segments: Vec<String>,
) -> Result<MediaDirectoryResponse, MediaBrowserError> {
    crate::ensure_agent_main_webview(&webview).map_err(|_| MediaBrowserError::path_denied())?;
    let service = service.inner().clone();
    let response = tauri::async_runtime::spawn_blocking(move || {
        service.list_directory(grant_id, path_segments)
    })
    .await
    .map_err(|_| MediaBrowserError::io("The media directory reader did not complete."))??;

    // The asset protocol starts with an empty scope. Grant only the verified
    // files disclosed by this directory response, never the whole folder.
    let asset_scope = webview.app_handle().asset_protocol_scope();
    for preview_path in response
        .entries
        .iter()
        .filter_map(|entry| entry.preview_path.as_deref())
    {
        asset_scope
            .allow_file(preview_path)
            .map_err(|_| MediaBrowserError::io("The media preview could not be authorized."))?;
    }
    Ok(response)
}

#[tauri::command]
pub(crate) async fn resolve_media_files(
    webview: Webview,
    service: State<'_, MediaBrowserService>,
    grant_id: String,
    selections: Vec<Vec<String>>,
) -> Result<Vec<String>, MediaBrowserError> {
    crate::ensure_agent_main_webview(&webview).map_err(|_| MediaBrowserError::path_denied())?;
    drop(webview);
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.resolve_files(grant_id, selections))
        .await
        .map_err(|_| MediaBrowserError::io("The content selection resolver did not complete."))?
}

#[tauri::command]
pub(crate) async fn open_content_entry(
    webview: Webview,
    service: State<'_, MediaBrowserService>,
    grant_id: String,
    path_segments: Vec<String>,
) -> Result<(), MediaBrowserError> {
    crate::ensure_agent_main_webview(&webview).map_err(|_| MediaBrowserError::path_denied())?;
    drop(webview);
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.open_entry(grant_id, path_segments))
        .await
        .map_err(|_| MediaBrowserError::io("The content entry opener did not complete."))?
}

#[tauri::command]
pub(crate) async fn reveal_content_entry(
    webview: Webview,
    service: State<'_, MediaBrowserService>,
    grant_id: String,
    path_segments: Vec<String>,
) -> Result<(), MediaBrowserError> {
    crate::ensure_agent_main_webview(&webview).map_err(|_| MediaBrowserError::path_denied())?;
    drop(webview);
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.reveal_entry(grant_id, path_segments))
        .await
        .map_err(|_| MediaBrowserError::io("The file manager opener did not complete."))?
}

#[tauri::command]
pub(crate) async fn resolve_content_entry_path(
    webview: Webview,
    service: State<'_, MediaBrowserService>,
    grant_id: String,
    path_segments: Vec<String>,
) -> Result<String, MediaBrowserError> {
    crate::ensure_agent_main_webview(&webview).map_err(|_| MediaBrowserError::path_denied())?;
    drop(webview);
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.resolve_entry_path(grant_id, path_segments)
    })
    .await
    .map_err(|_| MediaBrowserError::io("The content path resolver did not complete."))?
}

#[tauri::command]
pub(crate) async fn delete_content_file(
    webview: Webview,
    service: State<'_, MediaBrowserService>,
    grant_id: String,
    path_segments: Vec<String>,
) -> Result<(), MediaBrowserError> {
    crate::ensure_agent_main_webview(&webview).map_err(|_| MediaBrowserError::path_denied())?;
    drop(webview);
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.delete_file(grant_id, path_segments))
        .await
        .map_err(|_| MediaBrowserError::io("The content file deleter did not complete."))?
}

fn validate_grant_id(grant_id: &str) -> Result<(), MediaBrowserError> {
    if grant_id.is_empty()
        || grant_id.len() > MAX_GRANT_ID_BYTES
        || Uuid::parse_str(grant_id).is_err()
    {
        return Err(MediaBrowserError::invalid_grant());
    }
    Ok(())
}

fn validate_path_segments(segments: &[String]) -> Result<(), MediaBrowserError> {
    if segments.len() > MAX_PATH_DEPTH {
        return Err(MediaBrowserError::invalid_path());
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
            return Err(MediaBrowserError::invalid_path());
        }
        let mut components = Path::new(segment).components();
        let Some(Component::Normal(component)) = components.next() else {
            return Err(MediaBrowserError::invalid_path());
        };
        if components.next().is_some() || component != OsStr::new(segment) {
            return Err(MediaBrowserError::invalid_path());
        }
    }
    Ok(())
}

fn filesystem_root_for(path: &Path) -> Result<PathBuf, MediaBrowserError> {
    if !path.is_absolute() {
        return Err(MediaBrowserError::invalid_root());
    }
    let root = path
        .ancestors()
        .last()
        .filter(|ancestor| ancestor.is_absolute())
        .ok_or_else(MediaBrowserError::invalid_root)?;
    Ok(root.to_path_buf())
}

fn relative_path_segments(root: &Path, directory: &Path) -> Result<Vec<String>, MediaBrowserError> {
    if !is_within_root(root, directory) {
        return Err(MediaBrowserError::path_denied());
    }
    let relative = directory
        .strip_prefix(root)
        .map_err(|_| MediaBrowserError::path_denied())?;
    let mut segments = Vec::new();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(MediaBrowserError::invalid_path());
        };
        segments.push(
            name.to_str()
                .ok_or_else(MediaBrowserError::invalid_path)?
                .to_owned(),
        );
    }
    validate_path_segments(&segments)?;
    Ok(segments)
}

struct CanonicalMediaLocation {
    directory: PathBuf,
    focus_file_name: Option<String>,
    focus_file_path: Option<PathBuf>,
}

fn canonical_media_location(path: &Path) -> Result<CanonicalMediaLocation, MediaBrowserError> {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(MediaBrowserError::invalid_root());
    }
    reject_reparse_components(path)?;
    let canonical = fs::canonicalize(path).map_err(|_| MediaBrowserError::root_unavailable())?;
    reject_reparse_components(&canonical)?;
    let metadata =
        fs::symlink_metadata(&canonical).map_err(|_| MediaBrowserError::root_unavailable())?;
    if is_reparse(&metadata) {
        return Err(MediaBrowserError::path_denied());
    }
    if metadata.is_dir() {
        return Ok(CanonicalMediaLocation {
            directory: canonical,
            focus_file_name: None,
            focus_file_path: None,
        });
    }
    if !metadata.is_file() {
        return Err(MediaBrowserError::new(
            MediaBrowserErrorCode::NotFile,
            "The requested media location is not a regular file or directory.",
        ));
    }
    let focus_file_name = canonical
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(MediaBrowserError::invalid_path)?
        .to_owned();
    validate_path_segments(std::slice::from_ref(&focus_file_name))?;
    let directory = canonical
        .parent()
        .filter(|parent| parent.is_absolute())
        .ok_or_else(MediaBrowserError::invalid_root)?
        .to_path_buf();
    Ok(CanonicalMediaLocation {
        directory,
        focus_file_name: Some(focus_file_name),
        focus_file_path: Some(canonical),
    })
}

#[cfg(windows)]
fn system_media_volume_paths() -> Result<Vec<PathBuf>, MediaBrowserError> {
    use std::ptr::null_mut;
    use windows_sys::Win32::Storage::FileSystem::GetLogicalDriveStringsW;

    let required = unsafe { GetLogicalDriveStringsW(0, null_mut()) };
    if required == 0 {
        return Err(MediaBrowserError::io(
            "The available Windows storage volumes could not be read.",
        ));
    }
    let mut buffer = vec![0_u16; required as usize];
    let written = unsafe { GetLogicalDriveStringsW(required, buffer.as_mut_ptr()) };
    if written == 0 || written >= required {
        return Err(MediaBrowserError::io(
            "The available Windows storage volumes changed while being read.",
        ));
    }
    Ok(parse_windows_volume_multisz(&buffer[..written as usize]))
}

#[cfg(windows)]
fn parse_windows_volume_multisz(buffer: &[u16]) -> Vec<PathBuf> {
    buffer
        .split(|unit| *unit == 0)
        .filter(|volume| !volume.is_empty())
        .filter_map(|volume| String::from_utf16(volume).ok())
        .map(PathBuf::from)
        .filter(|volume| volume.is_absolute())
        .collect()
}

#[cfg(not(windows))]
fn system_media_volume_paths() -> Result<Vec<PathBuf>, MediaBrowserError> {
    Ok(vec![PathBuf::from("/")])
}

fn canonical_media_root(path: &Path) -> Result<PathBuf, MediaBrowserError> {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(MediaBrowserError::invalid_root());
    }
    reject_reparse_components(path)?;
    let canonical = fs::canonicalize(path).map_err(|_| MediaBrowserError::root_unavailable())?;
    reject_reparse_components(&canonical)?;
    let metadata =
        fs::symlink_metadata(&canonical).map_err(|_| MediaBrowserError::root_unavailable())?;
    if !metadata.is_dir() || is_reparse(&metadata) {
        return Err(MediaBrowserError::root_unavailable());
    }
    Ok(canonical)
}

fn verify_granted_root(root: &Path) -> Result<PathBuf, MediaBrowserError> {
    reject_reparse_components(root)?;
    let current = fs::canonicalize(root).map_err(|_| MediaBrowserError::root_unavailable())?;
    if current != root {
        return Err(MediaBrowserError::path_denied());
    }
    let metadata =
        fs::symlink_metadata(&current).map_err(|_| MediaBrowserError::root_unavailable())?;
    if !metadata.is_dir() || is_reparse(&metadata) {
        return Err(MediaBrowserError::root_unavailable());
    }
    Ok(current)
}

#[derive(Clone, Copy)]
enum ExpectedMediaPathKind {
    Any,
    Directory,
    File,
}

fn resolve_existing_media_path(
    canonical_root: &Path,
    path_segments: &[String],
    expected: ExpectedMediaPathKind,
) -> Result<PathBuf, MediaBrowserError> {
    validate_path_segments(path_segments)?;
    if matches!(expected, ExpectedMediaPathKind::File) && path_segments.is_empty() {
        return Err(MediaBrowserError::new(
            MediaBrowserErrorCode::NotFile,
            "Select a regular media file.",
        ));
    }

    let mut current = canonical_root.to_path_buf();
    for (index, segment) in path_segments.iter().enumerate() {
        current.push(segment);
        let metadata = fs::symlink_metadata(&current).map_err(|error| match error.kind() {
            io::ErrorKind::NotFound => MediaBrowserError::new(
                MediaBrowserErrorCode::NotFound,
                "The requested media entry no longer exists.",
            ),
            io::ErrorKind::PermissionDenied => MediaBrowserError::path_denied(),
            _ => MediaBrowserError::io("The requested media entry could not be inspected."),
        })?;
        if is_reparse(&metadata) {
            return Err(MediaBrowserError::path_denied());
        }
        if index + 1 < path_segments.len() && !metadata.is_dir() {
            return Err(MediaBrowserError::new(
                MediaBrowserErrorCode::NotDirectory,
                "A media path component is not a directory.",
            ));
        }
    }

    let canonical = fs::canonicalize(&current).map_err(|_| MediaBrowserError::path_denied())?;
    if !is_within_root(canonical_root, &canonical) {
        return Err(MediaBrowserError::path_denied());
    }
    let metadata =
        fs::symlink_metadata(&canonical).map_err(|_| MediaBrowserError::path_denied())?;
    if is_reparse(&metadata) {
        return Err(MediaBrowserError::path_denied());
    }
    match expected {
        ExpectedMediaPathKind::Any if !metadata.is_dir() && !metadata.is_file() => {
            Err(MediaBrowserError::path_denied())
        }
        ExpectedMediaPathKind::Directory if !metadata.is_dir() => Err(MediaBrowserError::new(
            MediaBrowserErrorCode::NotDirectory,
            "The requested media entry is not a directory.",
        )),
        ExpectedMediaPathKind::File if !metadata.is_file() => Err(MediaBrowserError::new(
            MediaBrowserErrorCode::NotFile,
            "The requested media entry is not a regular file.",
        )),
        _ => {
            let rechecked =
                fs::canonicalize(&canonical).map_err(|_| MediaBrowserError::path_denied())?;
            if rechecked != canonical || !is_within_root(canonical_root, &rechecked) {
                return Err(MediaBrowserError::path_denied());
            }
            Ok(rechecked)
        }
    }
}

fn resolve_verified_regular_file(
    canonical_root: &Path,
    path_segments: &[String],
) -> Result<PathBuf, MediaBrowserError> {
    let path =
        resolve_existing_media_path(canonical_root, path_segments, ExpectedMediaPathKind::File)?;
    let metadata = fs::symlink_metadata(&path).map_err(|_| MediaBrowserError::path_denied())?;
    if !metadata.is_file() || is_reparse(&metadata) {
        return Err(MediaBrowserError::path_denied());
    }
    let rechecked = fs::canonicalize(&path).map_err(|_| MediaBrowserError::path_denied())?;
    if rechecked != path || !is_within_root(canonical_root, &rechecked) {
        return Err(MediaBrowserError::path_denied());
    }
    Ok(rechecked)
}

fn content_entry_kind(path: &Path) -> MediaEntryKind {
    let extension = path
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "avif" => MediaEntryKind::Image,
        "mp4" | "webm" | "mov" | "m4v" => MediaEntryKind::Video,
        _ => MediaEntryKind::File,
    }
}

fn safe_js_file_size(size: u64) -> Option<u64> {
    (size <= MAX_SAFE_JS_INTEGER).then_some(size)
}

fn can_preview_file(kind: MediaEntryKind, size: u64) -> bool {
    match kind {
        MediaEntryKind::Directory => false,
        MediaEntryKind::Image => size <= MAX_IMAGE_PREVIEW_BYTES,
        MediaEntryKind::Video => size <= MAX_VIDEO_PREVIEW_BYTES,
        MediaEntryKind::File => false,
    }
}

fn compare_entries(left: &MediaDirectoryEntry, right: &MediaDirectoryEntry) -> Ordering {
    entry_sort_rank(left.kind)
        .cmp(&entry_sort_rank(right.kind))
        .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        .then_with(|| left.name.cmp(&right.name))
}

fn entry_sort_rank(kind: MediaEntryKind) -> u8 {
    match kind {
        MediaEntryKind::Directory => 0,
        MediaEntryKind::Image => 1,
        MediaEntryKind::Video => 2,
        MediaEntryKind::File => 3,
    }
}

fn is_within_root(root: &Path, candidate: &Path) -> bool {
    candidate == root || candidate.starts_with(root)
}

fn reject_reparse_components(path: &Path) -> Result<(), MediaBrowserError> {
    for ancestor in path.ancestors().collect::<Vec<_>>().into_iter().rev() {
        let metadata = match fs::symlink_metadata(ancestor) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(_) => return Err(MediaBrowserError::root_unavailable()),
        };
        if is_reparse(&metadata) {
            return Err(MediaBrowserError::new(
                MediaBrowserErrorCode::RootUnavailable,
                "The selected media folder crosses a symbolic link or reparse point.",
            ));
        }
    }
    Ok(())
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

fn normal_absolute_path(path: &Path) -> Result<String, MediaBrowserError> {
    let path = path.to_str().ok_or_else(MediaBrowserError::path_denied)?;
    #[cfg(windows)]
    {
        if let Some(path) = path.strip_prefix(r"\\?\UNC\") {
            return Ok(format!(r"\\{path}"));
        }
        if let Some(path) = path.strip_prefix(r"\\?\") {
            return Ok(path.to_owned());
        }
    }
    Ok(path.to_owned())
}

fn is_unsafe_open_path(path: &Path) -> bool {
    let Some(extension) = path.extension().and_then(OsStr::to_str) else {
        return false;
    };
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "ahk"
            | "appinstaller"
            | "application"
            | "appx"
            | "appxbundle"
            | "appref-ms"
            | "bat"
            | "chm"
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
            | "msix"
            | "msixbundle"
            | "pif"
            | "ps1"
            | "ps1xml"
            | "psd1"
            | "psm1"
            | "py"
            | "pyw"
            | "reg"
            | "scf"
            | "scr"
            | "sct"
            | "settingcontent-ms"
            | "sh"
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
fn delete_verified_regular_file(path: &Path) -> Result<(), MediaBrowserError> {
    use std::fs::OpenOptions;
    use std::mem::size_of;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_DISPOSITION_INFO, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FileDispositionInfo,
        SetFileInformationByHandle,
    };

    const DELETE_ACCESS: u32 = 0x0001_0000;
    let file = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES | DELETE_ACCESS)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(delete_file_error)?;
    let metadata = file
        .metadata()
        .map_err(|_| MediaBrowserError::path_denied())?;
    if !metadata.is_file() || is_reparse(&metadata) {
        return Err(MediaBrowserError::path_denied());
    }

    // Mark the exact opened file handle for deletion. A same-name replacement
    // after this point cannot redirect the operation to a different file.
    let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    let ok = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfo,
            (&raw const disposition).cast(),
            size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    };
    if ok == 0 {
        return Err(MediaBrowserError::io(
            "The selected file could not be deleted.",
        ));
    }
    drop(file);
    Ok(())
}

#[cfg(not(windows))]
fn delete_verified_regular_file(path: &Path) -> Result<(), MediaBrowserError> {
    fs::remove_file(path).map_err(delete_file_error)
}

fn delete_file_error(error: io::Error) -> MediaBrowserError {
    match error.kind() {
        io::ErrorKind::NotFound => MediaBrowserError::new(
            MediaBrowserErrorCode::NotFound,
            "The selected file no longer exists.",
        ),
        io::ErrorKind::PermissionDenied => MediaBrowserError::path_denied(),
        _ => MediaBrowserError::io("The selected file could not be deleted."),
    }
}

#[cfg(windows)]
fn open_with_default_application(path: &Path) -> Result<(), MediaBrowserError> {
    shell_execute(path, None).map_err(|_| {
        MediaBrowserError::new(
            MediaBrowserErrorCode::OpenFailed,
            "Windows could not open the selected content with its default application.",
        )
    })
}

#[cfg(windows)]
fn reveal_in_file_manager(path: &Path) -> Result<(), MediaBrowserError> {
    if path.is_dir() {
        return open_with_default_application(path);
    }
    let normalized = normal_absolute_path(path)?;
    if normalized.contains('"') {
        return Err(MediaBrowserError::path_denied());
    }
    let parameters = format!(r#"/select,"{normalized}""#);
    shell_execute(Path::new("explorer.exe"), Some(&parameters)).map_err(|_| {
        MediaBrowserError::new(
            MediaBrowserErrorCode::OpenFailed,
            "Windows Explorer could not reveal the selected content.",
        )
    })
}

#[cfg(windows)]
fn shell_execute(path: &Path, parameters: Option<&str>) -> Result<(), ()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};

    let path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let parameters = parameters.map(|value| {
        value
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>()
    });
    let verb = "open\0".encode_utf16().collect::<Vec<_>>();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            path.as_ptr(),
            parameters
                .as_ref()
                .map_or(std::ptr::null(), |value| value.as_ptr()),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize <= 32 {
        Err(())
    } else {
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn open_with_default_application(path: &Path) -> Result<(), MediaBrowserError> {
    spawn_file_manager_command(
        "/usr/bin/open",
        &[],
        path,
        "The selected content could not be opened.",
    )
}

#[cfg(target_os = "macos")]
fn reveal_in_file_manager(path: &Path) -> Result<(), MediaBrowserError> {
    spawn_file_manager_command(
        "/usr/bin/open",
        &["-R"],
        path,
        "Finder could not reveal the selected content.",
    )
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_with_default_application(path: &Path) -> Result<(), MediaBrowserError> {
    spawn_file_manager_command(
        "xdg-open",
        &[],
        path,
        "The selected content could not be opened.",
    )
}

#[cfg(all(unix, not(target_os = "macos")))]
fn reveal_in_file_manager(path: &Path) -> Result<(), MediaBrowserError> {
    let target = if path.is_dir() {
        path
    } else {
        path.parent().ok_or_else(MediaBrowserError::path_denied)?
    };
    spawn_file_manager_command(
        "xdg-open",
        &[],
        target,
        "The file manager could not reveal the selected content.",
    )
}

#[cfg(unix)]
fn spawn_file_manager_command(
    program: &str,
    arguments: &[&str],
    path: &Path,
    message: &str,
) -> Result<(), MediaBrowserError> {
    std::process::Command::new(program)
        .args(arguments)
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|_| MediaBrowserError::new(MediaBrowserErrorCode::OpenFailed, message))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant(service: &MediaBrowserService, root: &Path) -> MediaRootGrantResponse {
        service
            .grant_root(root.to_string_lossy().into_owned())
            .unwrap()
    }

    #[test]
    fn grants_are_opaque_session_local_and_deduplicated() {
        let temp = tempfile::tempdir().unwrap();
        let service = MediaBrowserService::default();
        let first = grant(&service, temp.path());
        let second = grant(&service, temp.path());
        assert_eq!(first.grant_id, second.grant_id);
        assert!(Uuid::parse_str(&first.grant_id).is_ok());
        assert_eq!(service.grants().unwrap().len(), 1);
        assert!(Path::new(&first.root_path).is_absolute());
    }

    #[test]
    fn open_location_grants_the_filesystem_root_and_returns_initial_segments() {
        let temp = tempfile::tempdir().unwrap();
        let requested = temp.path().join("media").join("images");
        fs::create_dir_all(&requested).unwrap();
        let requested = fs::canonicalize(requested).unwrap();
        let expected_root = filesystem_root_for(&requested).unwrap();
        let service = MediaBrowserService::default();

        let location = service
            .open_location(normal_absolute_path(&requested).unwrap())
            .unwrap();
        let grant = service.grant(&location.grant_id).unwrap();
        assert_eq!(grant.root, fs::canonicalize(expected_root).unwrap());
        assert_eq!(
            location.root_path,
            normal_absolute_path(&grant.root).unwrap()
        );
        assert!(!location.root_name.is_empty());
        assert_eq!(location.focus_file_name, None);

        let reconstructed = location
            .initial_path_segments
            .iter()
            .fold(grant.root.clone(), |path, segment| path.join(segment));
        assert_eq!(fs::canonicalize(reconstructed).unwrap(), requested);
        assert!(!location.initial_path_segments.is_empty());
    }

    #[test]
    fn open_location_accepts_a_regular_file_and_focuses_it_in_its_parent() {
        let temp = tempfile::tempdir().unwrap();
        let requested_directory = temp.path().join("media").join("images");
        fs::create_dir_all(&requested_directory).unwrap();
        let requested_file = requested_directory.join("selected.JPEG");
        fs::write(&requested_file, b"jpeg").unwrap();
        let requested_file = fs::canonicalize(requested_file).unwrap();
        let service = MediaBrowserService::default();

        let location = service
            .open_location(normal_absolute_path(&requested_file).unwrap())
            .unwrap();
        assert_eq!(location.focus_file_name.as_deref(), Some("selected.JPEG"));
        let grant = service.grant(&location.grant_id).unwrap();
        let reconstructed_directory = location
            .initial_path_segments
            .iter()
            .fold(grant.root.clone(), |path, segment| path.join(segment));
        assert_eq!(
            fs::canonicalize(&reconstructed_directory).unwrap(),
            requested_file.parent().unwrap()
        );

        let mut file_segments = location.initial_path_segments;
        file_segments.push(location.focus_file_name.unwrap());
        assert_eq!(
            resolve_verified_regular_file(&grant.root, &file_segments).unwrap(),
            requested_file
        );
    }

    #[test]
    fn open_location_accepts_a_non_media_regular_file() {
        let temp = tempfile::tempdir().unwrap();
        let requested_file = temp.path().join("notes.txt");
        fs::write(&requested_file, b"text").unwrap();
        let service = MediaBrowserService::default();
        let location = service
            .open_location(normal_absolute_path(&requested_file).unwrap())
            .unwrap();
        assert_eq!(
            location.focus_file_name.as_deref(),
            requested_file.file_name().and_then(OsStr::to_str)
        );
    }

    #[test]
    fn opening_a_filesystem_root_has_no_initial_segments() {
        let temp = tempfile::tempdir().unwrap();
        let canonical_temp = fs::canonicalize(temp.path()).unwrap();
        let root = filesystem_root_for(&canonical_temp).unwrap();
        let service = MediaBrowserService::default();
        let location = service
            .open_location(normal_absolute_path(&root).unwrap())
            .unwrap();
        assert!(location.initial_path_segments.is_empty());
        assert_eq!(location.focus_file_name, None);
    }

    #[test]
    fn volume_listing_returns_granted_accessible_filesystem_roots() {
        let temp = tempfile::tempdir().unwrap();
        let canonical_temp = fs::canonicalize(temp.path()).unwrap();
        let expected_root =
            fs::canonicalize(filesystem_root_for(&canonical_temp).unwrap()).unwrap();
        let service = MediaBrowserService::default();
        service
            .open_location(normal_absolute_path(&canonical_temp).unwrap())
            .unwrap();

        let volumes = service.list_volumes().unwrap();
        assert!(!volumes.is_empty());
        assert!(volumes.iter().any(|volume| {
            let Ok(grant) = service.grant(&volume.grant_id) else {
                return false;
            };
            grant.root == expected_root
                && volume.root_path == normal_absolute_path(&expected_root).unwrap()
                && !volume.root_name.is_empty()
        }));
    }

    #[cfg(windows)]
    #[test]
    fn parses_windows_logical_drive_multisz_without_empty_tail_entries() {
        let buffer = "C:\\\0D:\\\0Z:\\\0\0".encode_utf16().collect::<Vec<_>>();
        assert_eq!(
            parse_windows_volume_multisz(&buffer),
            vec![
                PathBuf::from(r"C:\"),
                PathBuf::from(r"D:\"),
                PathBuf::from(r"Z:\")
            ]
        );
    }

    #[cfg(windows)]
    #[test]
    fn filesystem_roots_preserve_windows_volume_and_share_boundaries() {
        assert_eq!(
            filesystem_root_for(Path::new(r"C:\Users\person\Pictures")).unwrap(),
            PathBuf::from(r"C:\")
        );
        assert_eq!(
            filesystem_root_for(Path::new(r"\\server\share\media\images")).unwrap(),
            PathBuf::from(r"\\server\share\")
        );
        assert_eq!(
            filesystem_root_for(Path::new(r"\\?\C:\Users\person\Pictures")).unwrap(),
            PathBuf::from(r"\\?\C:\")
        );
        assert_eq!(
            filesystem_root_for(Path::new(r"\\?\UNC\server\share\media")).unwrap(),
            PathBuf::from(r"\\?\UNC\server\share\")
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn filesystem_root_is_the_unix_root() {
        assert_eq!(
            filesystem_root_for(Path::new("/home/person/Pictures")).unwrap(),
            PathBuf::from("/")
        );
    }

    #[test]
    fn rejects_relative_roots_and_unknown_grants_without_path_disclosure() {
        let service = MediaBrowserService::default();
        let relative = service.grant_root("relative-media".to_owned()).unwrap_err();
        assert_eq!(relative.code, MediaBrowserErrorCode::InvalidRoot);

        let secret = tempfile::tempdir().unwrap();
        let missing = service
            .list_directory(
                Uuid::new_v4().hyphenated().to_string(),
                vec!["missing".to_owned()],
            )
            .unwrap_err();
        assert_eq!(missing.code, MediaBrowserErrorCode::InvalidGrant);
        assert!(
            !missing
                .message
                .contains(secret.path().to_string_lossy().as_ref())
        );
    }

    #[test]
    fn validates_relative_segments_and_rejects_traversal() {
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
                MediaBrowserErrorCode::InvalidPath
            );
        }
        assert!(validate_path_segments(&vec!["a".to_owned(); MAX_PATH_DEPTH + 1]).is_err());
        assert!(validate_path_segments(&["🚀".repeat(128)]).is_err());
    }

    #[test]
    fn preview_and_javascript_size_boundaries_are_explicit() {
        assert!(can_preview_file(
            MediaEntryKind::Image,
            MAX_IMAGE_PREVIEW_BYTES
        ));
        assert!(!can_preview_file(
            MediaEntryKind::Image,
            MAX_IMAGE_PREVIEW_BYTES + 1
        ));
        assert!(can_preview_file(
            MediaEntryKind::Video,
            MAX_VIDEO_PREVIEW_BYTES
        ));
        assert!(!can_preview_file(
            MediaEntryKind::Video,
            MAX_VIDEO_PREVIEW_BYTES + 1
        ));
        assert!(!can_preview_file(MediaEntryKind::File, 0));
        assert_eq!(
            safe_js_file_size(MAX_SAFE_JS_INTEGER),
            Some(MAX_SAFE_JS_INTEGER)
        );
        assert_eq!(safe_js_file_size(MAX_SAFE_JS_INTEGER + 1), None);
    }

    #[test]
    fn lists_directories_media_and_general_files_with_verified_paths() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("Zeta")).unwrap();
        fs::write(temp.path().join("photo.JPEG"), b"jpeg").unwrap();
        fs::write(temp.path().join("clip.mp4"), b"video").unwrap();
        fs::write(temp.path().join("notes.txt"), b"text").unwrap();
        fs::write(temp.path().join("vector.svg"), b"svg").unwrap();
        let service = MediaBrowserService::default();
        let root = grant(&service, temp.path());

        let response = service.list_directory(root.grant_id, Vec::new()).unwrap();
        assert!(!response.truncated);
        assert_eq!(
            response
                .entries
                .iter()
                .map(|entry| (entry.name.as_str(), entry.kind))
                .collect::<Vec<_>>(),
            vec![
                ("Zeta", MediaEntryKind::Directory),
                ("photo.JPEG", MediaEntryKind::Image),
                ("clip.mp4", MediaEntryKind::Video),
                ("notes.txt", MediaEntryKind::File),
                ("vector.svg", MediaEntryKind::File),
            ]
        );
        assert!(response.entries[0].preview_path.is_none());
        assert!(
            response.entries[1]
                .preview_path
                .as_deref()
                .is_some_and(|path| {
                    Path::new(path).is_absolute() && path.ends_with("photo.JPEG")
                })
        );
        assert!(response.entries[3].preview_path.is_none());
        assert!(response.entries.iter().all(|entry| entry.openable));
    }

    #[test]
    fn listing_is_nonrecursive_and_capped_at_240_entries() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("child")).unwrap();
        fs::write(temp.path().join("child").join("nested.png"), b"nested").unwrap();
        for index in 0..=MAX_DIRECTORY_ENTRIES {
            fs::write(temp.path().join(format!("image-{index:03}.png")), b"image").unwrap();
        }
        let service = MediaBrowserService::default();
        let root = grant(&service, temp.path());
        let response = service
            .list_directory(root.grant_id.clone(), Vec::new())
            .unwrap();
        assert_eq!(response.entries.len(), MAX_DIRECTORY_ENTRIES);
        assert!(response.truncated);
        assert_eq!(
            response.entries.first().map(|entry| entry.name.as_str()),
            Some("child")
        );
        assert_eq!(
            response.entries.last().map(|entry| entry.name.as_str()),
            Some("image-238.png")
        );
        assert!(
            response
                .entries
                .iter()
                .all(|entry| entry.name != "nested.png")
        );

        let child = service
            .list_directory(root.grant_id, vec!["child".to_owned()])
            .unwrap();
        assert_eq!(child.entries.len(), 1);
        assert_eq!(child.entries[0].name, "nested.png");
    }

    #[test]
    fn resolves_at_most_20_regular_files_and_rechecks_each_path() {
        let temp = tempfile::tempdir().unwrap();
        let service = MediaBrowserService::default();
        let root = grant(&service, temp.path());
        let mut selections = Vec::new();
        for index in 0..MAX_CONTENT_SELECTIONS {
            let name = format!("image-{index}.png");
            fs::write(temp.path().join(&name), b"image").unwrap();
            selections.push(vec![name]);
        }
        let paths = service
            .resolve_files(root.grant_id.clone(), selections.clone())
            .unwrap();
        assert_eq!(paths.len(), MAX_CONTENT_SELECTIONS);
        assert!(paths.iter().all(|path| Path::new(path).is_absolute()));

        selections.push(vec!["one-too-many.png".to_owned()]);
        assert_eq!(
            service
                .resolve_files(root.grant_id, selections)
                .unwrap_err()
                .code,
            MediaBrowserErrorCode::TooManySelections
        );
    }

    #[test]
    fn resolution_accepts_non_media_and_rejects_directories() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("notes.txt"), b"text").unwrap();
        fs::create_dir(temp.path().join("folder.png")).unwrap();
        let service = MediaBrowserService::default();
        let root = grant(&service, temp.path());
        let resolved = service
            .resolve_files(root.grant_id.clone(), vec![vec!["notes.txt".to_owned()]])
            .unwrap();
        assert_eq!(resolved.len(), 1);
        assert!(resolved[0].ends_with("notes.txt"));
        assert_eq!(
            service
                .resolve_files(root.grant_id, vec![vec!["folder.png".to_owned()]])
                .unwrap_err()
                .code,
            MediaBrowserErrorCode::NotFile
        );
    }

    #[test]
    fn content_entry_actions_resolve_files_and_directories_without_disclosing_unverified_paths() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("folder")).unwrap();
        fs::write(temp.path().join("notes.txt"), b"text").unwrap();
        let service = MediaBrowserService::default();
        let root = grant(&service, temp.path());

        let root_path = service
            .resolve_entry_path(root.grant_id.clone(), Vec::new())
            .unwrap();
        assert_eq!(
            fs::canonicalize(root_path).unwrap(),
            fs::canonicalize(temp.path()).unwrap()
        );

        let mut opened = None;
        service
            .open_entry_with(
                root.grant_id.clone(),
                vec!["notes.txt".to_owned()],
                |path| {
                    opened = Some(path.to_path_buf());
                    Ok(())
                },
            )
            .unwrap();
        assert_eq!(
            opened.unwrap(),
            fs::canonicalize(temp.path().join("notes.txt")).unwrap()
        );

        assert_eq!(
            service
                .delete_file(root.grant_id, vec!["folder".to_owned()])
                .unwrap_err()
                .code,
            MediaBrowserErrorCode::NotFile
        );
        assert!(temp.path().join("folder").is_dir());
    }

    #[test]
    fn deletion_removes_only_the_verified_regular_file() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("delete-me.bin");
        fs::write(&file, b"content").unwrap();
        let service = MediaBrowserService::default();
        let root = grant(&service, temp.path());

        service
            .delete_file(root.grant_id, vec!["delete-me.bin".to_owned()])
            .unwrap();
        assert!(!file.exists());
    }

    #[test]
    fn executable_content_is_listed_but_cannot_be_opened() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("script.cmd"), b"exit /b 0").unwrap();
        fs::write(temp.path().join("script.PYW"), b"print('unsafe')").unwrap();
        let service = MediaBrowserService::default();
        let root = grant(&service, temp.path());
        let response = service
            .list_directory(root.grant_id.clone(), Vec::new())
            .unwrap();
        let script = response
            .entries
            .iter()
            .find(|entry| entry.name == "script.cmd")
            .unwrap();
        assert_eq!(script.kind, MediaEntryKind::File);
        assert!(!script.openable);

        let mut opener_called = false;
        let error = service
            .open_entry_with(root.grant_id.clone(), vec!["script.cmd".to_owned()], |_| {
                opener_called = true;
                Ok(())
            })
            .unwrap_err();
        assert_eq!(error.code, MediaBrowserErrorCode::UnsafeFileType);
        assert!(!opener_called);

        let error = service
            .open_entry_with(root.grant_id, vec!["script.PYW".to_owned()], |_| Ok(()))
            .unwrap_err();
        assert_eq!(error.code, MediaBrowserErrorCode::UnsafeFileType);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_entries_are_hidden_and_cannot_escape_the_granted_root() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.png"), b"secret").unwrap();
        symlink(outside.path(), temp.path().join("linked")).unwrap();
        symlink(
            outside.path().join("secret.png"),
            temp.path().join("linked.png"),
        )
        .unwrap();
        let service = MediaBrowserService::default();
        let root = grant(&service, temp.path());
        let response = service
            .list_directory(root.grant_id.clone(), Vec::new())
            .unwrap();
        assert!(response.entries.is_empty());
        assert_eq!(
            service
                .resolve_files(root.grant_id, vec![vec!["linked.png".to_owned()]])
                .unwrap_err()
                .code,
            MediaBrowserErrorCode::PathDenied
        );
    }

    #[cfg(windows)]
    #[test]
    fn reparse_entries_are_hidden_and_cannot_escape_the_granted_root() {
        use std::os::windows::fs::{symlink_dir, symlink_file};
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.png"), b"secret").unwrap();
        if symlink_dir(outside.path(), temp.path().join("linked")).is_err()
            || symlink_file(
                outside.path().join("secret.png"),
                temp.path().join("linked.png"),
            )
            .is_err()
        {
            // Windows may require Developer Mode to create test symlinks.
            return;
        }
        let service = MediaBrowserService::default();
        let root = grant(&service, temp.path());
        let response = service
            .list_directory(root.grant_id.clone(), Vec::new())
            .unwrap();
        assert!(response.entries.is_empty());
        assert_eq!(
            service
                .resolve_files(root.grant_id, vec![vec!["linked.png".to_owned()]])
                .unwrap_err()
                .code,
            MediaBrowserErrorCode::PathDenied
        );
    }
}
