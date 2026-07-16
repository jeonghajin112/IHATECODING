use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    env,
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};
use uuid::Uuid;

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
};

pub(crate) const PROJECT_CATALOG_SCHEMA_VERSION: u32 = 1;
pub(crate) const PREVIEW_PROJECTS_DIR_ENV: &str = "IHATECODING_RUST_PREVIEW_PROJECTS_DIR";

const CATALOG_FILE_NAME: &str = "projects-v1.json";
const CSHARP_PROJECTS_PATH_ENV: &str = "POWERWORKSPACE_PROJECTS_PATH";
const MAX_CATALOG_BYTES: u64 = 16 * 1024 * 1024;
const BACKUP_COUNT: usize = 3;

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct RequiredNullableString {
    value: Option<String>,
    present: bool,
}

impl RequiredNullableString {
    fn present(value: Option<String>) -> Self {
        Self {
            value,
            present: true,
        }
    }

    fn require_present(&self, field: &str) -> Result<(), String> {
        if self.present {
            Ok(())
        } else {
            Err(format!("{field} is required."))
        }
    }

    fn as_deref(&self) -> Option<&str> {
        self.value.as_deref()
    }
}

impl Serialize for RequiredNullableString {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        self.value.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for RequiredNullableString {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Ok(Self {
            value: Option::<String>::deserialize(deserializer)?,
            present: true,
        })
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct ProjectCatalogV1 {
    #[serde(rename = "Projects")]
    pub(crate) projects: Vec<WorkspaceProjectV1>,
    #[serde(rename = "SelectedProjectId", default)]
    pub(crate) selected_project_id: RequiredNullableString,
    #[serde(flatten)]
    pub(crate) extra: BTreeMap<String, Value>,
}

impl ProjectCatalogV1 {
    fn empty() -> Self {
        Self {
            projects: Vec::new(),
            selected_project_id: RequiredNullableString::present(None),
            extra: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoadProjectCatalogResponse {
    pub(crate) catalog: ProjectCatalogV1,
    pub(crate) recovery_required: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct WorkspaceProjectV1 {
    #[serde(rename = "Id")]
    pub(crate) id: String,
    #[serde(rename = "Name")]
    pub(crate) name: String,
    #[serde(rename = "FolderPath")]
    pub(crate) folder_path: String,
    #[serde(rename = "Terminals")]
    pub(crate) terminals: Vec<SavedTerminalStateV1>,
    #[serde(rename = "PaneWidthRatios")]
    pub(crate) pane_width_ratios: BTreeMap<String, Vec<f64>>,
    #[serde(flatten)]
    pub(crate) extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct SavedTerminalStateV1 {
    #[serde(rename = "Id")]
    pub(crate) id: String,
    #[serde(rename = "Name")]
    pub(crate) name: String,
    #[serde(rename = "StartDirectory")]
    pub(crate) start_directory: String,
    #[serde(rename = "CodexThreadId", default)]
    pub(crate) codex_thread_id: RequiredNullableString,
    #[serde(rename = "GrokSessionId", default)]
    pub(crate) grok_session_id: RequiredNullableString,
    #[serde(rename = "CreatedAtUtc", default)]
    pub(crate) created_at_utc: RequiredNullableString,
    #[serde(rename = "CompletionPending")]
    pub(crate) completion_pending: bool,
    #[serde(flatten)]
    pub(crate) extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InspectProjectCatalogCopyRequest {
    pub(crate) source_path: String,
    pub(crate) source_is_detached_copy: bool,
}

struct ProjectStoreInner {
    directory: PathBuf,
    blocked_import_paths: Vec<PathBuf>,
    path_probe: Arc<dyn PathProbe>,
    operation_lock: Mutex<()>,
}

trait PathProbe: Send + Sync {
    fn try_exists(&self, path: &Path) -> io::Result<bool>;
}

struct FilesystemPathProbe;

impl PathProbe for FilesystemPathProbe {
    fn try_exists(&self, path: &Path) -> io::Result<bool> {
        path.try_exists()
    }
}

#[derive(Clone)]
pub(crate) struct ProjectStore {
    inner: Arc<ProjectStoreInner>,
}

impl ProjectStore {
    pub(crate) fn preview_default() -> Result<Self, String> {
        let override_directory = env::var_os(PREVIEW_PROJECTS_DIR_ENV).map(PathBuf::from);
        let local_app_data = env::var_os("LOCALAPPDATA").map(PathBuf::from);
        let directory =
            preview_directory(local_app_data.as_deref(), override_directory.as_deref())?;
        let mut blocked_import_paths = Vec::new();
        if let Some(local_app_data) = local_app_data {
            blocked_import_paths.push(local_app_data.join("PowerWorkspace").join("projects.json"));
        }
        if let Some(configured_path) = env::var_os(CSHARP_PROJECTS_PATH_ENV) {
            let configured_path = PathBuf::from(configured_path);
            let absolute_path = if configured_path.is_absolute() {
                configured_path
            } else {
                env::current_dir()
                    .map_err(|_| {
                        "Could not resolve the configured C# production catalog path.".to_owned()
                    })?
                    .join(configured_path)
            };
            blocked_import_paths.push(absolute_path);
        }
        validate_preview_path_isolation(&directory, &blocked_import_paths)?;
        Ok(Self::new_with_blocked_paths(
            directory,
            blocked_import_paths,
        ))
    }

    #[cfg(test)]
    fn new(directory: PathBuf) -> Self {
        Self::new_with_blocked_paths(directory, Vec::new())
    }

    fn new_with_blocked_paths(directory: PathBuf, blocked_import_paths: Vec<PathBuf>) -> Self {
        Self::new_with_probe(
            directory,
            blocked_import_paths,
            Arc::new(FilesystemPathProbe),
        )
    }

    fn new_with_probe(
        directory: PathBuf,
        blocked_import_paths: Vec<PathBuf>,
        path_probe: Arc<dyn PathProbe>,
    ) -> Self {
        Self {
            inner: Arc::new(ProjectStoreInner {
                directory,
                blocked_import_paths,
                path_probe,
                operation_lock: Mutex::new(()),
            }),
        }
    }

    pub(crate) fn load(&self) -> Result<LoadProjectCatalogResponse, String> {
        let _operation = self.lock()?;
        let primary = self.catalog_path();
        if !self.path_exists(&primary, "the preview catalog")? {
            if let Some((_, catalog)) = self.first_verified_backup()? {
                return Ok(LoadProjectCatalogResponse {
                    catalog,
                    recovery_required: true,
                });
            }
            if self.has_backup_files()? {
                return Err(
                    "The preview catalog is missing and no verified backup is available. Existing backup bytes were preserved."
                        .to_owned(),
                );
            }
            return Ok(LoadProjectCatalogResponse {
                catalog: ProjectCatalogV1::empty(),
                recovery_required: false,
            });
        }

        match read_and_parse_catalog(&primary, "preview catalog") {
            Ok(catalog) => Ok(LoadProjectCatalogResponse {
                catalog,
                recovery_required: false,
            }),
            Err(primary_error) => {
                if let Some((_, catalog)) = self.first_verified_backup()? {
                    return Ok(LoadProjectCatalogResponse {
                        catalog,
                        recovery_required: true,
                    });
                }
                Err(format!(
                    "The preview catalog is corrupt and no verified backup is available. The original file was preserved. {primary_error}"
                ))
            }
        }
    }

    pub(crate) fn save(&self, mut catalog: ProjectCatalogV1) -> Result<(), String> {
        validate_catalog(&catalog)?;
        let _operation = self.lock()?;
        fs::create_dir_all(&self.inner.directory)
            .map_err(|error| format!("Could not create the preview catalog directory: {error}"))?;

        let primary = self.catalog_path();
        if self.path_exists(&primary, "the preview catalog")? {
            let current_bytes = read_file_limited(&primary, "preview catalog")?;
            let current_catalog = parse_catalog_bytes(&current_bytes).map_err(|_| {
                "The preview catalog is corrupt. Save was refused so the original bytes cannot be lost; explicitly recover or reset it first."
                    .to_owned()
            })?;
            merge_preserved_extras(&mut catalog, &current_catalog);
            validate_catalog(&catalog)?;
            let serialized = serialize_catalog(&catalog)?;
            self.rotate_backups(&current_bytes)?;
            return durable_atomic_write(&primary, &serialized, "preview catalog");
        }
        if self.has_backup_files()? {
            return Err(
                "The preview catalog is missing while backup files exist. Save was refused; explicitly recover a verified backup or reset the store first."
                    .to_owned(),
            );
        }

        let serialized = serialize_catalog(&catalog)?;
        durable_atomic_write(&primary, &serialized, "preview catalog")
    }

    pub(crate) fn inspect_copy(
        &self,
        request: InspectProjectCatalogCopyRequest,
    ) -> Result<ProjectCatalogV1, String> {
        if !request.source_is_detached_copy {
            return Err(
                "Import inspection requires an explicitly confirmed detached copy.".to_owned(),
            );
        }
        let source = PathBuf::from(request.source_path);
        if !source.is_absolute() {
            return Err("Import inspection requires an absolute copied-file path.".to_owned());
        }
        let canonical_source = fs::canonicalize(&source)
            .map_err(|error| format!("Could not open the supplied catalog copy: {error}"))?;
        if paths_equal(&canonical_source, &self.catalog_path())? {
            return Err("The preview catalog itself cannot be used as an import copy.".to_owned());
        }
        for blocked_path in &self.inner.blocked_import_paths {
            if paths_equal(&canonical_source, blocked_path)? {
                return Err(
                    "The C# production catalog cannot be inspected directly; supply a detached copy."
                        .to_owned(),
                );
            }
        }

        // This path is opened read-only and this method never creates or modifies a file.
        read_and_parse_catalog(&canonical_source, "supplied catalog copy")
    }

    pub(crate) fn recover_verified_backup(&self) -> Result<ProjectCatalogV1, String> {
        let _operation = self.lock()?;
        let primary = self.catalog_path();
        let primary_exists = self.path_exists(&primary, "the preview catalog")?;
        if primary_exists && read_and_parse_catalog(&primary, "preview catalog").is_ok() {
            return Err("Recovery was refused because the preview catalog is valid.".to_owned());
        }
        if !primary_exists && !self.has_backup_files()? {
            return Err("There is no missing or corrupt preview catalog to recover.".to_owned());
        }

        let Some((backup, _)) = self.first_verified_backup()? else {
            return Err(
                "No verified preview backup is available; the corrupt catalog was preserved."
                    .to_owned(),
            );
        };
        let backup_bytes = read_file_limited(&backup, "preview backup")?;
        let catalog = parse_catalog_bytes(&backup_bytes).map_err(|_| {
            "The selected preview backup changed before recovery; no replacement was written."
                .to_owned()
        })?;

        fs::create_dir_all(&self.inner.directory)
            .map_err(|error| format!("Could not access the preview catalog directory: {error}"))?;
        if primary_exists {
            self.quarantine_primary()?;
        }
        durable_atomic_write(&primary, &backup_bytes, "recovered preview catalog")?;
        Ok(catalog)
    }

    pub(crate) fn reset_corrupt(&self, confirmed: bool) -> Result<ProjectCatalogV1, String> {
        if !confirmed {
            return Err("Corrupt catalog reset requires explicit confirmation.".to_owned());
        }
        let _operation = self.lock()?;
        let primary = self.catalog_path();
        let primary_exists = self.path_exists(&primary, "the preview catalog")?;
        if primary_exists && read_and_parse_catalog(&primary, "preview catalog").is_ok() {
            return Err("Reset was refused because the preview catalog is valid.".to_owned());
        }
        if !primary_exists && !self.has_backup_files()? {
            return Err("There is no missing or corrupt preview catalog to reset.".to_owned());
        }

        fs::create_dir_all(&self.inner.directory)
            .map_err(|error| format!("Could not access the preview catalog directory: {error}"))?;
        if primary_exists {
            self.quarantine_primary()?;
        }
        let empty = ProjectCatalogV1::empty();
        let bytes = serialize_catalog(&empty)?;
        durable_atomic_write(&primary, &bytes, "reset preview catalog")?;
        Ok(empty)
    }

    fn lock(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.inner
            .operation_lock
            .lock()
            .map_err(|_| "The preview project store lock was poisoned.".to_owned())
    }

    fn catalog_path(&self) -> PathBuf {
        self.inner.directory.join(CATALOG_FILE_NAME)
    }

    fn backup_path(&self, index: usize) -> PathBuf {
        self.inner
            .directory
            .join(format!("{CATALOG_FILE_NAME}.bak{index}"))
    }

    fn path_exists(&self, path: &Path, context: &str) -> Result<bool, String> {
        self.inner.path_probe.try_exists(path).map_err(|_| {
            format!(
                "Could not safely inspect {context}; the preview project store remains read-only."
            )
        })
    }

    fn has_backup_files(&self) -> Result<bool, String> {
        for index in 1..=BACKUP_COUNT {
            if self.path_exists(&self.backup_path(index), "a preview backup")? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn first_verified_backup(&self) -> Result<Option<(PathBuf, ProjectCatalogV1)>, String> {
        for index in 1..=BACKUP_COUNT {
            let backup = self.backup_path(index);
            if !self.path_exists(&backup, "a preview backup")? {
                continue;
            }
            if let Ok(catalog) = read_and_parse_catalog(&backup, "preview backup") {
                return Ok(Some((backup, catalog)));
            }
        }
        Ok(None)
    }

    fn rotate_backups(&self, current_bytes: &[u8]) -> Result<(), String> {
        let oldest = self.backup_path(BACKUP_COUNT);
        if self.path_exists(&oldest, "the oldest preview backup")? {
            fs::remove_file(&oldest)
                .map_err(|error| format!("Could not rotate the oldest preview backup: {error}"))?;
        }
        for index in (1..BACKUP_COUNT).rev() {
            let source = self.backup_path(index);
            if self.path_exists(&source, "a preview backup")? {
                atomic_move(&source, &self.backup_path(index + 1), "preview backup")?;
            }
        }
        durable_atomic_write(&self.backup_path(1), current_bytes, "preview backup")
    }

    fn quarantine_primary(&self) -> Result<(), String> {
        let quarantine = self.inner.directory.join(format!(
            "projects-v1.corrupt-{}.json",
            Uuid::new_v4().simple()
        ));
        durable_copy_create_new(&self.catalog_path(), &quarantine)
    }
}

fn preview_directory(
    local_app_data: Option<&Path>,
    override_directory: Option<&Path>,
) -> Result<PathBuf, String> {
    if let Some(directory) = override_directory {
        if !directory.is_absolute() {
            return Err(format!(
                "{PREVIEW_PROJECTS_DIR_ENV} must contain an absolute directory."
            ));
        }
        let directory = resolve_path_for_compare(directory)?;
        if let Some(local_app_data) = local_app_data {
            let production_directory = local_app_data.join("PowerWorkspace");
            if paths_equal(&directory, &production_directory)? {
                return Err(
                    "The Rust preview catalog directory cannot be the C# production directory."
                        .to_owned(),
                );
            }
        }
        return Ok(directory);
    }

    let local_app_data = local_app_data.ok_or_else(|| {
        "LOCALAPPDATA is unavailable; the isolated Rust preview store cannot be created.".to_owned()
    })?;
    resolve_path_for_compare(
        &local_app_data
            .join("IHATECODING")
            .join("RustPreview")
            .join("Projects"),
    )
}

fn validate_preview_path_isolation(
    preview_directory: &Path,
    production_catalogs: &[PathBuf],
) -> Result<(), String> {
    let preview_catalog = preview_directory.join(CATALOG_FILE_NAME);
    for production_catalog in production_catalogs {
        let same_catalog = paths_equal(&preview_catalog, production_catalog)?;
        let same_directory = match production_catalog.parent() {
            Some(parent) => paths_equal(preview_directory, parent)?,
            None => false,
        };
        if same_catalog || same_directory {
            return Err(
                "The Rust preview store cannot share the C# production catalog path or directory."
                    .to_owned(),
            );
        }
    }
    Ok(())
}

fn merge_preserved_extras(incoming: &mut ProjectCatalogV1, existing: &ProjectCatalogV1) {
    incoming.extra.extend(existing.extra.clone());
    for incoming_project in &mut incoming.projects {
        let Some(existing_project) = existing
            .projects
            .iter()
            .find(|project| project.id == incoming_project.id)
        else {
            continue;
        };
        incoming_project
            .extra
            .extend(existing_project.extra.clone());
        for incoming_terminal in &mut incoming_project.terminals {
            let Some(existing_terminal) = existing_project
                .terminals
                .iter()
                .find(|terminal| terminal.id == incoming_terminal.id)
            else {
                continue;
            };
            incoming_terminal
                .extra
                .extend(existing_terminal.extra.clone());
        }
    }
}

fn validate_catalog(catalog: &ProjectCatalogV1) -> Result<(), String> {
    validate_schema_version(&catalog.extra)?;
    catalog
        .selected_project_id
        .require_present("SelectedProjectId")?;
    let mut project_ids = HashSet::new();
    for (project_index, project) in catalog.projects.iter().enumerate() {
        require_nonempty(&project.id, &format!("Projects[{project_index}].Id"))?;
        if !project_ids.insert(project.id.as_str()) {
            return Err(format!(
                "Projects[{project_index}].Id duplicates another project identifier."
            ));
        }
        require_nonempty(&project.name, &format!("Projects[{project_index}].Name"))?;
        require_nonempty(
            &project.folder_path,
            &format!("Projects[{project_index}].FolderPath"),
        )?;
        if project.terminals.len() > 20 {
            return Err(format!(
                "Projects[{project_index}].Terminals exceeds the v1 limit of 20."
            ));
        }
        for ratios in project.pane_width_ratios.values() {
            if ratios.is_empty() {
                return Err(format!(
                    "Projects[{project_index}].PaneWidthRatios contains an empty ratio list."
                ));
            }
            if ratios
                .iter()
                .any(|value| !value.is_finite() || *value <= 0.0)
            {
                return Err(format!(
                    "Projects[{project_index}].PaneWidthRatios contains a non-positive value."
                ));
            }
        }
        let mut terminal_ids = HashSet::new();
        for (terminal_index, terminal) in project.terminals.iter().enumerate() {
            let prefix = format!("Projects[{project_index}].Terminals[{terminal_index}]");
            require_nonempty(&terminal.id, &format!("{prefix}.Id"))?;
            if !terminal_ids.insert(terminal.id.as_str()) {
                return Err(format!(
                    "{prefix}.Id duplicates another terminal identifier in this project."
                ));
            }
            require_nonempty(&terminal.name, &format!("{prefix}.Name"))?;
            require_nonempty(
                &terminal.start_directory,
                &format!("{prefix}.StartDirectory"),
            )?;
            terminal
                .codex_thread_id
                .require_present(&format!("{prefix}.CodexThreadId"))?;
            terminal
                .grok_session_id
                .require_present(&format!("{prefix}.GrokSessionId"))?;
            terminal
                .created_at_utc
                .require_present(&format!("{prefix}.CreatedAtUtc"))?;
            if let Some(created_at) = terminal.created_at_utc.as_deref()
                && !is_rfc3339(created_at)
            {
                return Err(format!("{prefix}.CreatedAtUtc is not RFC 3339."));
            }
        }
    }
    if let Some(selected_project_id) = catalog.selected_project_id.as_deref()
        && !project_ids.contains(selected_project_id)
    {
        return Err("SelectedProjectId does not reference a project in this catalog.".to_owned());
    }
    Ok(())
}

fn validate_schema_version(extra: &BTreeMap<String, Value>) -> Result<(), String> {
    let Some(version) = extra.get("SchemaVersion") else {
        return Ok(());
    };
    if version.as_u64() == Some(PROJECT_CATALOG_SCHEMA_VERSION as u64) {
        Ok(())
    } else {
        Err(format!(
            "Unsupported project catalog schema version; this build supports v{PROJECT_CATALOG_SCHEMA_VERSION}."
        ))
    }
}

fn require_nonempty(value: &str, field: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{field} must not be empty."))
    } else {
        Ok(())
    }
}

fn is_rfc3339(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || !digits(bytes, 0, 4)
        || bytes.get(4) != Some(&b'-')
        || !digits(bytes, 5, 2)
        || bytes.get(7) != Some(&b'-')
        || !digits(bytes, 8, 2)
        || !matches!(bytes.get(10), Some(b'T' | b't'))
        || !digits(bytes, 11, 2)
        || bytes.get(13) != Some(&b':')
        || !digits(bytes, 14, 2)
        || bytes.get(16) != Some(&b':')
        || !digits(bytes, 17, 2)
    {
        return false;
    }
    let year = number(bytes, 0, 4);
    let month = number(bytes, 5, 2);
    let day = number(bytes, 8, 2);
    let hour = number(bytes, 11, 2);
    let minute = number(bytes, 14, 2);
    let second = number(bytes, 17, 2);
    if year == 0
        || !(1..=12).contains(&month)
        || day == 0
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return false;
    }

    let mut index = 19;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let fraction_start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == fraction_start {
            return false;
        }
    }
    match bytes.get(index) {
        Some(b'Z' | b'z') => index + 1 == bytes.len(),
        Some(b'+' | b'-') => {
            index + 6 == bytes.len()
                && digits(bytes, index + 1, 2)
                && bytes.get(index + 3) == Some(&b':')
                && digits(bytes, index + 4, 2)
                && number(bytes, index + 1, 2) <= 23
                && number(bytes, index + 4, 2) <= 59
        }
        _ => false,
    }
}

fn digits(bytes: &[u8], start: usize, length: usize) -> bool {
    bytes
        .get(start..start + length)
        .is_some_and(|part| part.iter().all(u8::is_ascii_digit))
}

fn number(bytes: &[u8], start: usize, length: usize) -> u32 {
    bytes[start..start + length]
        .iter()
        .fold(0, |value, byte| value * 10 + u32::from(byte - b'0'))
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        4 | 6 | 9 | 11 => 30,
        2 if year.is_multiple_of(400) || (year.is_multiple_of(4) && !year.is_multiple_of(100)) => {
            29
        }
        2 => 28,
        _ => 31,
    }
}

fn serialize_catalog(catalog: &ProjectCatalogV1) -> Result<Vec<u8>, String> {
    validate_catalog(catalog)?;
    let mut bytes = serde_json::to_vec_pretty(catalog)
        .map_err(|error| format!("Could not serialize the v1 project catalog: {error}"))?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_CATALOG_BYTES {
        return Err("The v1 project catalog exceeds the 16 MiB safety limit.".to_owned());
    }
    Ok(bytes)
}

fn parse_catalog_bytes(bytes: &[u8]) -> Result<ProjectCatalogV1, String> {
    let catalog: ProjectCatalogV1 = serde_json::from_slice(bytes)
        .map_err(|error| format!("The v1 project catalog is not valid JSON: {error}"))?;
    validate_catalog(&catalog)?;
    Ok(catalog)
}

fn read_and_parse_catalog(path: &Path, context: &str) -> Result<ProjectCatalogV1, String> {
    let bytes = read_file_limited(path, context)?;
    parse_catalog_bytes(&bytes)
}

fn read_file_limited(path: &Path, context: &str) -> Result<Vec<u8>, String> {
    let file = File::open(path).map_err(|error| format!("Could not read {context}: {error}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_CATALOG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read {context}: {error}"))?;
    if bytes.len() as u64 > MAX_CATALOG_BYTES {
        return Err(format!("The {context} exceeds the 16 MiB safety limit."));
    }
    Ok(bytes)
}

fn durable_atomic_write(path: &Path, bytes: &[u8], context: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("The {context} has no parent directory."))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create the {context} directory: {error}"))?;
    let temporary = parent.join(format!(
        ".{CATALOG_FILE_NAME}.{}.tmp",
        Uuid::new_v4().simple()
    ));
    let guard = TemporaryFileGuard(temporary.clone());
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("Could not create a temporary {context}: {error}"))?;
    file.write_all(bytes)
        .map_err(|error| format!("Could not write the temporary {context}: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Could not flush the temporary {context}: {error}"))?;
    drop(file);
    atomic_move(&temporary, path, context)?;
    guard.disarm();
    sync_parent_directory(parent, context)
}

struct TemporaryFileGuard(PathBuf);

impl TemporaryFileGuard {
    fn disarm(mut self) {
        self.0.clear();
    }
}

impl Drop for TemporaryFileGuard {
    fn drop(&mut self) {
        if !self.0.as_os_str().is_empty() {
            let _ = fs::remove_file(&self.0);
        }
    }
}

fn durable_copy_create_new(source: &Path, destination: &Path) -> Result<(), String> {
    let mut source_file = File::open(source)
        .map_err(|error| format!("Could not read the corrupt preview catalog: {error}"))?;
    let mut destination_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| format!("Could not create the corrupt catalog quarantine: {error}"))?;
    std::io::copy(&mut source_file, &mut destination_file)
        .map_err(|error| format!("Could not preserve the corrupt preview catalog: {error}"))?;
    destination_file
        .sync_all()
        .map_err(|error| format!("Could not flush the corrupt catalog quarantine: {error}"))
}

#[cfg(windows)]
fn atomic_move(source: &Path, destination: &Path, context: &str) -> Result<(), String> {
    let source_wide = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
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
fn atomic_move(source: &Path, destination: &Path, context: &str) -> Result<(), String> {
    fs::rename(source, destination)
        .map_err(|error| format!("Could not atomically replace the {context}: {error}"))
}

#[cfg(windows)]
fn sync_parent_directory(_directory: &Path, _context: &str) -> Result<(), String> {
    // MOVEFILE_WRITE_THROUGH provides the Windows durability barrier for the rename.
    Ok(())
}

#[cfg(not(windows))]
fn sync_parent_directory(directory: &Path, context: &str) -> Result<(), String> {
    File::open(directory)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Could not flush the {context} directory: {error}"))
}

fn lexical_normalize_absolute(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("Path isolation requires an absolute path.".to_owned());
    }

    let mut normalized = PathBuf::new();
    let mut normal_components = 0usize;
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if normal_components > 0 {
                    normalized.pop();
                    normal_components -= 1;
                }
            }
            Component::Normal(segment) => {
                normalized.push(segment);
                normal_components += 1;
            }
        }
    }
    Ok(normalized)
}

fn resolve_path_for_compare(path: &Path) -> Result<PathBuf, String> {
    let normalized = lexical_normalize_absolute(path)?;
    let mut ancestor = normalized.clone();
    let mut suffix: Vec<OsString> = Vec::new();
    loop {
        let ancestor_exists = ancestor.try_exists().map_err(|_| {
            "Could not safely inspect a configured storage path; the preview store remains read-only."
                .to_owned()
        })?;
        if ancestor_exists {
            let canonical_ancestor = fs::canonicalize(&ancestor).map_err(|_| {
                "Could not safely resolve a configured storage path; the preview store remains read-only."
                    .to_owned()
            })?;
            let mut resolved = lexical_normalize_absolute(&canonical_ancestor)?;
            for component in suffix.iter().rev() {
                resolved.push(component);
            }
            return lexical_normalize_absolute(&resolved);
        }
        let Some(file_name) = ancestor.file_name() else {
            break;
        };
        suffix.push(file_name.to_os_string());
        if !ancestor.pop() {
            break;
        }
    }
    Ok(normalized)
}

fn path_comparison_key(path: &Path) -> Result<String, String> {
    let resolved = resolve_path_for_compare(path)?;
    let key = resolved.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        let mut key = key.replace('/', "\\");
        if let Some(without_prefix) = key.strip_prefix(r"\\?\UNC\") {
            key = format!(r"\\{without_prefix}");
        } else if let Some(without_prefix) = key.strip_prefix(r"\\?\") {
            key = without_prefix.to_owned();
        }
        Ok(key.to_ascii_lowercase())
    }
    #[cfg(not(windows))]
    {
        Ok(key)
    }
}

fn paths_equal(left: &Path, right: &Path) -> Result<bool, String> {
    Ok(path_comparison_key(left)? == path_comparison_key(right)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../../../fixtures/projects-v1.json");

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = env::temp_dir().join(format!(
                "ihc-project-store-test-{}",
                Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn store(&self) -> ProjectStore {
            ProjectStore::new(self.0.clone())
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn fixture() -> ProjectCatalogV1 {
        parse_catalog_bytes(FIXTURE.as_bytes()).expect("fixture should satisfy v1")
    }

    #[test]
    fn frozen_fixture_round_trips_semantically() {
        let catalog = fixture();
        assert_eq!(catalog.projects.len(), 1);
        assert_eq!(catalog.projects[0].terminals.len(), 1);
        let serialized = serialize_catalog(&catalog).unwrap();
        let round_trip = parse_catalog_bytes(&serialized).unwrap();
        assert_eq!(round_trip, catalog);
    }

    #[test]
    fn empty_load_response_is_not_recovery_and_serializes_camel_case() {
        let test = TestDirectory::new();
        let response = test.store().load().unwrap();
        assert_eq!(response.catalog, ProjectCatalogV1::empty());
        assert!(!response.recovery_required);

        let json = serde_json::to_value(response).unwrap();
        assert!(json.get("catalog").is_some());
        assert_eq!(json["recoveryRequired"], serde_json::json!(false));
        assert!(json.get("recovery_required").is_none());
    }

    #[test]
    fn existing_state_probe_failure_never_becomes_empty_or_writable() {
        struct FailingPathProbe;

        impl PathProbe for FailingPathProbe {
            fn try_exists(&self, _path: &Path) -> io::Result<bool> {
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "SECRET_METADATA_FAILURE",
                ))
            }
        }

        let test = TestDirectory::new();
        let catalog = fixture();
        let real_store = test.store();
        real_store.save(catalog.clone()).unwrap();
        let original_bytes = fs::read(real_store.catalog_path()).unwrap();
        let failing_store =
            ProjectStore::new_with_probe(test.0.clone(), Vec::new(), Arc::new(FailingPathProbe));

        let load_error = failing_store.load().unwrap_err();
        assert!(load_error.contains("remains read-only"));
        assert!(!load_error.contains("SECRET_METADATA_FAILURE"));

        let mut changed = catalog;
        changed.projects[0].name = "Must not be saved".to_owned();
        let save_error = failing_store.save(changed).unwrap_err();
        assert!(save_error.contains("remains read-only"));
        assert!(!save_error.contains("SECRET_METADATA_FAILURE"));
        assert_eq!(fs::read(real_store.catalog_path()).unwrap(), original_bytes);

        assert!(failing_store.recover_verified_backup().is_err());
        assert!(failing_store.reset_corrupt(true).is_err());
        assert!(failing_store.has_backup_files().is_err());
        assert!(failing_store.first_verified_backup().is_err());
        assert_eq!(fs::read(real_store.catalog_path()).unwrap(), original_bytes);
    }

    #[test]
    fn unknown_future_fields_survive_parse_save_and_load() {
        let test = TestDirectory::new();
        let store = test.store();
        let mut value: Value = serde_json::from_str(FIXTURE).unwrap();
        value["SchemaVersion"] = serde_json::json!(1);
        value["FutureRoot"] = serde_json::json!({ "opaque": [1, 2, 3] });
        value["Projects"][0]["FutureProject"] = serde_json::json!("keep-project");
        value["Projects"][0]["Terminals"][0]["FutureTerminal"] =
            serde_json::json!({ "keep": true });
        let catalog = parse_catalog_bytes(&serde_json::to_vec(&value).unwrap()).unwrap();
        store.save(catalog.clone()).unwrap();
        let response = store.load().unwrap();
        assert!(!response.recovery_required);
        let loaded = response.catalog;
        assert_eq!(loaded, catalog);
        assert_eq!(loaded.extra["FutureRoot"], value["FutureRoot"]);
        assert_eq!(
            loaded.projects[0].extra["FutureProject"],
            value["Projects"][0]["FutureProject"]
        );
        assert_eq!(
            loaded.projects[0].terminals[0].extra["FutureTerminal"],
            value["Projects"][0]["Terminals"][0]["FutureTerminal"]
        );
    }

    #[test]
    fn existing_unknown_fields_override_lossy_frontend_round_trip_by_id() {
        let test = TestDirectory::new();
        let store = test.store();
        let sentinel = Value::from(9_007_199_254_740_993u64);
        let rounded = Value::from(9_007_199_254_740_992u64);
        let mut existing = fixture();
        existing
            .extra
            .insert("FutureLargeRoot".to_owned(), sentinel.clone());
        existing.projects[0]
            .extra
            .insert("FutureLargeProject".to_owned(), sentinel.clone());
        existing.projects[0].terminals[0]
            .extra
            .insert("FutureLargeTerminal".to_owned(), sentinel.clone());
        store.save(existing).unwrap();

        let mut frontend_round_trip = store.load().unwrap().catalog;
        frontend_round_trip.extra.remove("FutureLargeRoot");
        frontend_round_trip.projects[0]
            .extra
            .insert("FutureLargeProject".to_owned(), rounded.clone());
        frontend_round_trip.projects[0].terminals[0]
            .extra
            .insert("FutureLargeTerminal".to_owned(), rounded);
        frontend_round_trip
            .extra
            .insert("NewFrontendField".to_owned(), serde_json::json!(true));
        store.save(frontend_round_trip).unwrap();

        let saved = store.load().unwrap().catalog;
        assert_eq!(saved.extra["FutureLargeRoot"], sentinel);
        assert_eq!(saved.projects[0].extra["FutureLargeProject"], sentinel);
        assert_eq!(
            saved.projects[0].terminals[0].extra["FutureLargeTerminal"],
            sentinel
        );
        assert_eq!(saved.extra["NewFrontendField"], serde_json::json!(true));
    }

    #[test]
    fn rejects_missing_required_fields_constraints_and_future_versions() {
        let missing: Value = serde_json::json!({ "Projects": [] });
        assert!(parse_catalog_bytes(&serde_json::to_vec(&missing).unwrap()).is_err());

        let mut too_many: Value = serde_json::from_str(FIXTURE).unwrap();
        let terminal = too_many["Projects"][0]["Terminals"][0].clone();
        too_many["Projects"][0]["Terminals"] = Value::Array(vec![terminal; 21]);
        assert!(parse_catalog_bytes(&serde_json::to_vec(&too_many).unwrap()).is_err());

        let mut invalid_ratio: Value = serde_json::from_str(FIXTURE).unwrap();
        invalid_ratio["Projects"][0]["PaneWidthRatios"]["2x1:row-0"] = serde_json::json!([0.0]);
        assert!(parse_catalog_bytes(&serde_json::to_vec(&invalid_ratio).unwrap()).is_err());

        let mut invalid_date: Value = serde_json::from_str(FIXTURE).unwrap();
        invalid_date["Projects"][0]["Terminals"][0]["CreatedAtUtc"] =
            serde_json::json!("not-a-date");
        assert!(parse_catalog_bytes(&serde_json::to_vec(&invalid_date).unwrap()).is_err());

        let mut future_version: Value = serde_json::from_str(FIXTURE).unwrap();
        future_version["SchemaVersion"] = serde_json::json!(2);
        assert!(parse_catalog_bytes(&serde_json::to_vec(&future_version).unwrap()).is_err());
    }

    #[test]
    fn rejects_duplicate_ids_and_unresolvable_selection() {
        let mut duplicate_projects = fixture();
        duplicate_projects
            .projects
            .push(duplicate_projects.projects[0].clone());
        let project_error = validate_catalog(&duplicate_projects).unwrap_err();
        assert!(project_error.contains("duplicates another project"));
        assert!(!project_error.contains("11111111111111111111111111111111"));

        let mut duplicate_terminals = fixture();
        let terminal = duplicate_terminals.projects[0].terminals[0].clone();
        duplicate_terminals.projects[0].terminals.push(terminal);
        let terminal_error = validate_catalog(&duplicate_terminals).unwrap_err();
        assert!(terminal_error.contains("duplicates another terminal"));
        assert!(!terminal_error.contains("22222222222222222222222222222222"));

        let mut stale_selection = fixture();
        stale_selection.selected_project_id =
            RequiredNullableString::present(Some("not-a-project".to_owned()));
        let selection_error = validate_catalog(&stale_selection).unwrap_err();
        assert!(selection_error.contains("does not reference a project"));
        assert!(!selection_error.contains("not-a-project"));
    }

    #[test]
    fn read_only_copy_inspection_requires_explicit_detached_absolute_path() {
        let test = TestDirectory::new();
        let store = test.store();
        let copy = test.0.join("detached-copy.json");
        fs::write(&copy, FIXTURE).unwrap();
        let original = fs::read(&copy).unwrap();

        let error = store
            .inspect_copy(InspectProjectCatalogCopyRequest {
                source_path: copy.to_string_lossy().into_owned(),
                source_is_detached_copy: false,
            })
            .unwrap_err();
        assert!(error.contains("detached copy"));
        let inspected = store
            .inspect_copy(InspectProjectCatalogCopyRequest {
                source_path: copy.to_string_lossy().into_owned(),
                source_is_detached_copy: true,
            })
            .unwrap();
        assert_eq!(inspected, fixture());
        assert_eq!(fs::read(&copy).unwrap(), original);
        assert!(!store.catalog_path().try_exists().unwrap());

        let path_text = copy.to_string_lossy();
        assert!(!error.contains(path_text.as_ref()));
        assert!(!error.contains("22222222222222222222222222222222"));
    }

    #[test]
    fn production_catalog_path_is_rejected_before_parse_or_mutation() {
        let test = TestDirectory::new();
        let production_directory = test.0.join("PowerWorkspace");
        fs::create_dir_all(&production_directory).unwrap();
        let production_catalog = production_directory.join("projects.json");
        let sensitive_invalid_bytes = b"SECRET_SESSION_ID: not a catalog".to_vec();
        fs::write(&production_catalog, &sensitive_invalid_bytes).unwrap();
        let alias_anchor = test.0.join("alias-anchor");
        fs::create_dir_all(&alias_anchor).unwrap();
        let aliased_source = alias_anchor
            .join("..")
            .join("PowerWorkspace")
            .join("projects.json");
        let preview_directory = test.0.join("preview");
        let store = ProjectStore::new_with_blocked_paths(
            preview_directory,
            vec![production_catalog.clone()],
        );

        let error = store
            .inspect_copy(InspectProjectCatalogCopyRequest {
                source_path: aliased_source.to_string_lossy().into_owned(),
                source_is_detached_copy: true,
            })
            .unwrap_err();

        assert!(error.contains("production catalog"));
        assert!(!error.contains("SECRET_SESSION_ID"));
        assert!(!error.contains(production_catalog.to_string_lossy().as_ref()));
        assert_eq!(
            fs::read(&production_catalog).unwrap(),
            sensitive_invalid_bytes
        );
        assert!(!store.catalog_path().try_exists().unwrap());
    }

    #[test]
    fn save_is_atomic_and_rotates_verified_backups() {
        let test = TestDirectory::new();
        let store = test.store();
        let first = fixture();
        store.save(first.clone()).unwrap();

        let mut second = first.clone();
        second.projects[0].name = "Second".to_owned();
        store.save(second.clone()).unwrap();
        let response = store.load().unwrap();
        assert_eq!(response.catalog, second);
        assert!(!response.recovery_required);
        assert_eq!(
            read_and_parse_catalog(&store.backup_path(1), "test").unwrap(),
            first
        );
        assert!(fs::read_dir(&test.0).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")
        }));
    }

    #[test]
    fn corrupt_primary_recovers_backup_without_mutating_or_silent_overwrite() {
        let test = TestDirectory::new();
        let store = test.store();
        let first = fixture();
        store.save(first.clone()).unwrap();
        let mut second = first.clone();
        second.projects[0].name = "Second".to_owned();
        store.save(second).unwrap();

        let corrupt = b"{ definitely not valid JSON".to_vec();
        fs::write(store.catalog_path(), &corrupt).unwrap();
        let fallback = store.load().unwrap();
        assert_eq!(fallback.catalog, first);
        assert!(fallback.recovery_required);
        assert_eq!(fs::read(store.catalog_path()).unwrap(), corrupt);

        let save_error = store.save(first.clone()).unwrap_err();
        assert!(save_error.contains("Save was refused"));
        assert_eq!(fs::read(store.catalog_path()).unwrap(), corrupt);

        let recovered = store.recover_verified_backup().unwrap();
        assert_eq!(recovered, first);
        let recovered_load = store.load().unwrap();
        assert_eq!(recovered_load.catalog, first);
        assert!(!recovered_load.recovery_required);
        let quarantines = fs::read_dir(&test.0)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("projects-v1.corrupt-")
            })
            .collect::<Vec<_>>();
        assert_eq!(quarantines.len(), 1);
        assert_eq!(fs::read(quarantines[0].path()).unwrap(), corrupt);
    }

    #[test]
    fn corrupt_primary_without_backup_never_becomes_empty_implicitly() {
        let test = TestDirectory::new();
        let store = test.store();
        let corrupt = b"broken catalog bytes".to_vec();
        fs::write(store.catalog_path(), &corrupt).unwrap();

        assert!(store.load().is_err());
        assert!(store.save(ProjectCatalogV1::empty()).is_err());
        assert_eq!(fs::read(store.catalog_path()).unwrap(), corrupt);
        assert!(store.reset_corrupt(false).is_err());
        assert_eq!(fs::read(store.catalog_path()).unwrap(), corrupt);

        let reset = store.reset_corrupt(true).unwrap();
        assert_eq!(reset, ProjectCatalogV1::empty());
        let reset_load = store.load().unwrap();
        assert_eq!(reset_load.catalog, ProjectCatalogV1::empty());
        assert!(!reset_load.recovery_required);
        let quarantined = fs::read_dir(&test.0)
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("projects-v1.corrupt-")
            })
            .unwrap();
        assert_eq!(fs::read(quarantined.path()).unwrap(), corrupt);
    }

    #[test]
    fn missing_primary_with_backup_requires_explicit_recovery() {
        let test = TestDirectory::new();
        let store = test.store();
        let catalog = fixture();
        let backup_bytes = serialize_catalog(&catalog).unwrap();
        fs::write(store.backup_path(1), &backup_bytes).unwrap();

        let fallback = store.load().unwrap();
        assert_eq!(fallback.catalog, catalog);
        assert!(fallback.recovery_required);
        let mut changed = catalog.clone();
        changed.projects[0].name = "Changed in frontend".to_owned();
        let save_error = store.save(changed).unwrap_err();
        assert!(save_error.contains("missing while backup files exist"));
        assert!(!store.catalog_path().try_exists().unwrap());
        assert_eq!(fs::read(store.backup_path(1)).unwrap(), backup_bytes);

        assert_eq!(store.recover_verified_backup().unwrap(), catalog);
        let recovered_load = store.load().unwrap();
        assert_eq!(recovered_load.catalog, catalog);
        assert!(!recovered_load.recovery_required);
        assert_eq!(fs::read(store.backup_path(1)).unwrap(), backup_bytes);
    }

    #[test]
    fn missing_primary_with_invalid_backup_never_silently_resets() {
        let test = TestDirectory::new();
        let store = test.store();
        let invalid_backup = b"invalid backup with SECRET_SESSION_ID".to_vec();
        fs::write(store.backup_path(1), &invalid_backup).unwrap();

        let load_error = store.load().unwrap_err();
        assert!(load_error.contains("catalog is missing"));
        assert!(!load_error.contains("SECRET_SESSION_ID"));
        assert!(store.save(ProjectCatalogV1::empty()).is_err());
        assert!(store.recover_verified_backup().is_err());
        assert!(!store.catalog_path().try_exists().unwrap());
        assert_eq!(fs::read(store.backup_path(1)).unwrap(), invalid_backup);

        assert!(store.reset_corrupt(false).is_err());
        assert_eq!(
            store.reset_corrupt(true).unwrap(),
            ProjectCatalogV1::empty()
        );
        let reset_load = store.load().unwrap();
        assert_eq!(reset_load.catalog, ProjectCatalogV1::empty());
        assert!(!reset_load.recovery_required);
        assert_eq!(fs::read(store.backup_path(1)).unwrap(), invalid_backup);
    }

    #[test]
    fn preview_path_is_isolated_and_override_is_absolute_and_not_production() {
        let local = if cfg!(windows) {
            PathBuf::from(r"C:\Users\Example\AppData\Local")
        } else {
            PathBuf::from("/tmp/local")
        };
        let default = preview_directory(Some(&local), None).unwrap();
        assert_ne!(default, local.join("PowerWorkspace"));
        assert!(default.ends_with(Path::new("IHATECODING/RustPreview/Projects")));

        assert!(preview_directory(Some(&local), Some(Path::new("relative"))).is_err());
        assert!(preview_directory(Some(&local), Some(&local.join("PowerWorkspace"))).is_err());
        let aliased_production = local.join("unrelated").join("..").join("PowerWorkspace");
        assert!(preview_directory(Some(&local), Some(&aliased_production)).is_err());

        let configured_production = local.join("legacy-state").join("custom-projects.json");
        let aliased_preview = local.join("unused").join("..").join("legacy-state");
        assert!(
            validate_preview_path_isolation(&aliased_preview, &[configured_production]).is_err()
        );
    }

    #[test]
    fn validation_errors_do_not_disclose_ids_or_paths() {
        let mut value: Value = serde_json::from_str(FIXTURE).unwrap();
        value["Projects"][0]["Terminals"][0]["StartDirectory"] = Value::String(String::new());
        let error = parse_catalog_bytes(&serde_json::to_vec(&value).unwrap()).unwrap_err();
        assert!(!error.contains("C:\\Example\\Alpha"));
        assert!(!error.contains("22222222222222222222222222222222"));

        let mut ratio_value: Value = serde_json::from_str(FIXTURE).unwrap();
        ratio_value["Projects"][0]["PaneWidthRatios"] =
            serde_json::json!({ "SECRET_LAYOUT_KEY": [] });
        let ratio_error =
            parse_catalog_bytes(&serde_json::to_vec(&ratio_value).unwrap()).unwrap_err();
        assert!(!ratio_error.contains("SECRET_LAYOUT_KEY"));
    }
}
