use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fmt,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

#[cfg(windows)]
use std::os::windows::{ffi::OsStrExt, fs::MetadataExt, fs::OpenOptionsExt};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_SHARE_READ, MOVEFILE_REPLACE_EXISTING,
    MOVEFILE_WRITE_THROUGH, MoveFileExW, REPLACEFILE_WRITE_THROUGH, ReplaceFileW,
};

pub(crate) const WORKSPACE_SCHEMA_VERSION: u32 = 1;

const STATE_DIRECTORY_NAME: &str = "state";
const WORKSPACE_FILE_NAME: &str = "workspace-v1.json";
const LOCK_FILE_NAME: &str = "write.lock";
const MAX_WORKSPACE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_PROJECTS: usize = 256;
const MAX_TABS: usize = 128;
const MAX_TERMINALS_PER_PROJECT: usize = 20;
const MAX_ID_BYTES: usize = 256;
const MAX_NAME_BYTES: usize = 4 * 1024;
const MAX_PATH_BYTES: usize = 32 * 1024;
const MAX_URL_BYTES: usize = 16 * 1024;
const MAX_EXTENSION_DEPTH: usize = 32;
const MAX_EXTENSION_STRING_BYTES: usize = 64 * 1024;
const BACKUP_COUNT: usize = 3;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum StorageErrorCode {
    Busy,
    Io,
    InvalidSource,
    SourceChanged,
    TooLarge,
    InvalidState,
    UnsupportedVersion,
    RevisionConflict,
    ReadOnly,
    RecoveryRequired,
    PathDenied,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageError {
    pub(crate) code: StorageErrorCode,
    pub(crate) message: String,
    pub(crate) retryable: bool,
    pub(crate) json_pointer: Option<String>,
}

impl StorageError {
    fn new(code: StorageErrorCode, message: &str, retryable: bool) -> Self {
        Self {
            code,
            message: message.to_owned(),
            retryable,
            json_pointer: None,
        }
    }

    fn at(mut self, pointer: impl Into<String>) -> Self {
        self.json_pointer = Some(pointer.into());
        self
    }

    fn io(message: &str) -> Self {
        Self::new(StorageErrorCode::Io, message, true)
    }

    fn invalid(message: &str, pointer: impl Into<String>) -> Self {
        Self::new(StorageErrorCode::InvalidState, message, false).at(pointer)
    }

    fn recovery(message: &str) -> Self {
        Self::new(StorageErrorCode::RecoveryRequired, message, false)
    }
}

impl fmt::Display for StorageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for StorageError {}

pub(crate) type StorageResult<T> = Result<T, StorageError>;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum StorageMode {
    Absent,
    Ready,
    ReadOnly,
    RecoveryRequired,
    UnsupportedVersion,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceStateV1 {
    pub(crate) selected_project_id: Option<String>,
    pub(crate) projects: Vec<WorkspaceProjectV1>,
    pub(crate) tabs: Vec<WorkspaceTabV1>,
    pub(crate) active_tab_id: Option<String>,
    #[serde(default)]
    pub(crate) extensions: BTreeMap<String, Value>,
    #[serde(default)]
    pub(crate) legacy_extensions: BTreeMap<String, Value>,
}

impl WorkspaceStateV1 {
    pub(crate) fn empty() -> Self {
        Self {
            selected_project_id: None,
            projects: Vec::new(),
            tabs: vec![WorkspaceTabV1 {
                id: "initial-empty".to_owned(),
                kind: "empty".to_owned(),
                title: "Empty".to_owned(),
                project_id: None,
                browser: None,
                output: None,
                extensions: BTreeMap::new(),
            }],
            active_tab_id: Some("initial-empty".to_owned()),
            extensions: BTreeMap::new(),
            legacy_extensions: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceProjectV1 {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) folder_path: String,
    pub(crate) terminals: Vec<WorkspaceTerminalV1>,
    pub(crate) pane_width_ratios: BTreeMap<String, Vec<f64>>,
    #[serde(default)]
    pub(crate) legacy_extensions: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceTerminalV1 {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) start_directory: String,
    pub(crate) codex_thread_id: Option<String>,
    pub(crate) grok_session_id: Option<String>,
    pub(crate) created_at_utc: Option<String>,
    pub(crate) completion_pending: bool,
    #[serde(default)]
    pub(crate) legacy_extensions: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceTabV1 {
    pub(crate) id: String,
    pub(crate) kind: String,
    pub(crate) title: String,
    pub(crate) project_id: Option<String>,
    pub(crate) browser: Option<BrowserTabV1>,
    pub(crate) output: Option<OutputTabV1>,
    #[serde(default)]
    pub(crate) extensions: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserTabV1 {
    pub(crate) url: String,
    #[serde(default)]
    pub(crate) extensions: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OutputTabV1 {
    pub(crate) mode: String,
    pub(crate) relative_entry: Option<String>,
    #[serde(default)]
    pub(crate) extensions: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportProvenanceV1 {
    pub(crate) source_format: String,
    pub(crate) source_sha256: String,
    pub(crate) snapshot_file: String,
    pub(crate) imported_at_utc: String,
}

impl ImportProvenanceV1 {
    pub(crate) fn from_import(
        source_format: String,
        source_sha256: String,
        snapshot_file: String,
    ) -> StorageResult<Self> {
        let provenance = Self {
            source_format,
            source_sha256,
            snapshot_file,
            imported_at_utc: current_utc_timestamp()?,
        };
        validate_provenance(&provenance)?;
        Ok(provenance)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceDocumentV1 {
    schema_version: u32,
    revision: u64,
    written_at_utc: String,
    #[serde(flatten)]
    state: WorkspaceStateV1,
    import_provenance: Option<ImportProvenanceV1>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceSnapshot {
    pub(crate) schema_version: u32,
    pub(crate) revision: u64,
    pub(crate) written_at_utc: Option<String>,
    pub(crate) state: WorkspaceStateV1,
    pub(crate) import_provenance: Option<ImportProvenanceV1>,
    pub(crate) resume_conflicts: Vec<ResumeConflict>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResumeConflict {
    pub(crate) agent: String,
    pub(crate) terminal_pointers: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RecoveryReason {
    PrimaryMissing,
    PrimaryInvalid,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryPreview {
    pub(crate) required: bool,
    pub(crate) reason: RecoveryReason,
    pub(crate) candidate_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceLoad {
    pub(crate) mode: StorageMode,
    pub(crate) snapshot: Option<WorkspaceSnapshot>,
    pub(crate) recovery: Option<RecoveryPreview>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveWorkspaceRequest {
    pub(crate) expected_revision: u64,
    pub(crate) state: WorkspaceStateV1,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveWorkspaceResponse {
    pub(crate) revision: u64,
    pub(crate) written_at_utc: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryCandidateSummary {
    pub(crate) candidate_id: String,
    pub(crate) revision: Option<u64>,
    pub(crate) written_at_utc: Option<String>,
    pub(crate) byte_length: u64,
    pub(crate) valid: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FaultPoint {
    TempCreated,
    TempWritten,
    TempFlushed,
    TempValidated,
    BackupWrite1,
    BackupWrite2,
    BackupWrite3,
    BeforeReplace,
}

trait FaultInjector: Send + Sync {
    fn fail(&self, point: FaultPoint) -> bool;
}

struct NoFaults;

impl FaultInjector for NoFaults {
    fn fail(&self, _point: FaultPoint) -> bool {
        false
    }
}

struct StoreLock {
    _file: File,
    #[cfg(not(windows))]
    path: PathBuf,
}

impl StoreLock {
    fn try_acquire(path: &Path) -> StorageResult<Option<Self>> {
        #[cfg(windows)]
        {
            let result = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .share_mode(FILE_SHARE_READ)
                .open(path);
            match result {
                Ok(file) => Ok(Some(Self { _file: file })),
                Err(error) if matches!(error.raw_os_error(), Some(32 | 33)) => Ok(None),
                Err(_) => Err(StorageError::io(
                    "Could not acquire the workspace writer lock.",
                )),
            }
        }
        #[cfg(not(windows))]
        {
            match OpenOptions::new().write(true).create_new(true).open(path) {
                Ok(file) => Ok(Some(Self {
                    _file: file,
                    path: path.to_path_buf(),
                })),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(None),
                Err(_) => Err(StorageError::io(
                    "Could not acquire the workspace writer lock.",
                )),
            }
        }
    }
}

#[cfg(not(windows))]
impl Drop for StoreLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

struct WorkspaceStoreInner {
    root: PathBuf,
    _writer_lock: Option<StoreLock>,
    operation_lock: Mutex<()>,
    faults: Arc<dyn FaultInjector>,
}

#[derive(Clone)]
pub(crate) struct WorkspaceStore {
    inner: Arc<WorkspaceStoreInner>,
}

impl WorkspaceStore {
    pub(crate) fn open(app_local_data_dir: &Path) -> StorageResult<Self> {
        if !app_local_data_dir.is_absolute() {
            return Err(StorageError::new(
                StorageErrorCode::PathDenied,
                "The application-local data directory must be absolute.",
                false,
            ));
        }
        Self::open_state_root_with_faults(
            app_local_data_dir.join(STATE_DIRECTORY_NAME),
            Arc::new(NoFaults),
        )
    }

    fn open_state_root_with_faults(
        root: PathBuf,
        faults: Arc<dyn FaultInjector>,
    ) -> StorageResult<Self> {
        if !root.is_absolute() {
            return Err(StorageError::new(
                StorageErrorCode::PathDenied,
                "The workspace state directory must be absolute.",
                false,
            ));
        }
        reject_reparse_components(&root)?;
        fs::create_dir_all(&root)
            .map_err(|_| StorageError::io("Could not create the workspace state directory."))?;
        reject_reparse_components(&root)?;
        let writer_lock = StoreLock::try_acquire(&root.join(LOCK_FILE_NAME))?;
        Ok(Self {
            inner: Arc::new(WorkspaceStoreInner {
                root,
                _writer_lock: writer_lock,
                operation_lock: Mutex::new(()),
                faults,
            }),
        })
    }

    pub(crate) fn is_writable(&self) -> bool {
        self.inner._writer_lock.is_some()
    }

    pub(crate) fn state_root(&self) -> &Path {
        &self.inner.root
    }

    pub(crate) fn load(&self) -> StorageResult<WorkspaceLoad> {
        let _operation = self.lock()?;
        self.load_locked()
    }

    pub(crate) fn save(
        &self,
        mut request: SaveWorkspaceRequest,
    ) -> StorageResult<SaveWorkspaceResponse> {
        let _operation = self.lock()?;
        if !self.is_writable() {
            return Err(StorageError::new(
                StorageErrorCode::ReadOnly,
                "Another application instance owns the workspace writer lock.",
                true,
            ));
        }

        normalize_and_validate_state(&mut request.state)?;
        let primary = self.primary_path();
        let (current_revision, current_document, current_bytes) =
            if path_exists(&primary, "workspace state")? {
                let bytes = read_limited(&primary, "workspace state").map_err(|error| {
                if matches!(
                    error.code,
                    StorageErrorCode::InvalidState | StorageErrorCode::TooLarge
                ) {
                    StorageError::recovery(
                        "The current workspace state is invalid; explicit recovery is required.",
                    )
                } else {
                    error
                }
            })?;
                let document = parse_document(&bytes).map_err(|error| match error.code {
                    StorageErrorCode::UnsupportedVersion => error,
                    _ => StorageError::recovery(
                        "The current workspace state is invalid; explicit recovery is required.",
                    ),
                })?;
                (document.revision, Some(document), Some(bytes))
            } else {
                if self.any_backup_exists()? || self.any_uncommitted_temp_exists()? {
                    return Err(StorageError::recovery(
                        "The workspace state is missing while recovery evidence exists.",
                    ));
                }
                (0, None, None)
            };

        if request.expected_revision != current_revision {
            return Err(StorageError::new(
                StorageErrorCode::RevisionConflict,
                "The workspace changed after this edit began; reload before saving.",
                true,
            )
            .at("/expectedRevision"));
        }
        let revision = current_revision.checked_add(1).ok_or_else(|| {
            StorageError::new(
                StorageErrorCode::ReadOnly,
                "The workspace revision cannot advance further.",
                false,
            )
        })?;

        let provenance = current_document
            .as_ref()
            .and_then(|document| document.import_provenance.clone());
        if let Some(current) = &current_document {
            merge_preserved_extensions(&mut request.state, &current.state);
        }
        normalize_and_validate_state(&mut request.state)?;
        let written_at_utc = current_utc_timestamp()?;
        let document = WorkspaceDocumentV1 {
            schema_version: WORKSPACE_SCHEMA_VERSION,
            revision,
            written_at_utc: written_at_utc.clone(),
            state: request.state,
            import_provenance: provenance,
        };
        validate_document(&document)?;
        let bytes = serialize_document(&document)?;
        self.commit(&bytes, current_bytes.as_deref())?;

        Ok(SaveWorkspaceResponse {
            revision,
            written_at_utc,
        })
    }

    pub(crate) fn list_recovery_candidates(&self) -> StorageResult<Vec<RecoveryCandidateSummary>> {
        let _operation = self.lock()?;
        self.list_recovery_candidates_locked()
    }

    pub(crate) fn replace_from_import(
        &self,
        mut state: WorkspaceStateV1,
        provenance: ImportProvenanceV1,
    ) -> StorageResult<WorkspaceSnapshot> {
        let _operation = self.lock()?;
        self.require_writable()?;
        normalize_and_validate_state(&mut state)?;
        validate_provenance(&provenance)?;

        let primary = self.primary_path();
        let (current, current_bytes) = if path_exists(&primary, "workspace state")? {
            let bytes = read_limited(&primary, "workspace state").map_err(|error| {
                if matches!(
                    error.code,
                    StorageErrorCode::InvalidState | StorageErrorCode::TooLarge
                ) {
                    StorageError::recovery(
                        "The current workspace state is invalid; explicit recovery is required.",
                    )
                } else {
                    error
                }
            })?;
            let document = parse_document(&bytes).map_err(|error| match error.code {
                StorageErrorCode::UnsupportedVersion => error,
                _ => StorageError::recovery(
                    "The current workspace state is invalid; explicit recovery is required.",
                ),
            })?;
            (Some(document), Some(bytes))
        } else {
            if self.any_backup_exists()? || self.any_uncommitted_temp_exists()? {
                return Err(StorageError::recovery(
                    "The workspace state is missing while recovery evidence exists.",
                ));
            }
            (None, None)
        };

        if let Some(document) = current.as_ref()
            && document.import_provenance.as_ref().is_some_and(|existing| {
                existing.source_format == provenance.source_format
                    && existing.source_sha256 == provenance.source_sha256
            })
        {
            return Ok(snapshot_from_document(document.clone()));
        }

        let revision = current.as_ref().map_or(Ok(1), |document| {
            document.revision.checked_add(1).ok_or_else(|| {
                StorageError::new(
                    StorageErrorCode::ReadOnly,
                    "The workspace revision cannot advance further.",
                    false,
                )
            })
        })?;
        let document = WorkspaceDocumentV1 {
            schema_version: WORKSPACE_SCHEMA_VERSION,
            revision,
            written_at_utc: current_utc_timestamp()?,
            state,
            import_provenance: Some(provenance),
        };
        validate_document(&document)?;
        let bytes = serialize_document(&document)?;
        self.commit(&bytes, current_bytes.as_deref())?;
        Ok(snapshot_from_document(document))
    }

    pub(crate) fn recover(&self, candidate_id: &str) -> StorageResult<WorkspaceSnapshot> {
        let _operation = self.lock()?;
        self.require_writable()?;

        let primary = self.primary_path();
        let corrupt_primary_exists = path_exists(&primary, "workspace state")?;
        if corrupt_primary_exists {
            match read_limited(&primary, "workspace state").and_then(|bytes| parse_document(&bytes))
            {
                Ok(_) => {
                    return Err(StorageError::invalid(
                        "The current workspace state is valid and does not require recovery.",
                        "/candidateId",
                    ));
                }
                Err(error) if error.code == StorageErrorCode::UnsupportedVersion => {
                    return Err(error);
                }
                Err(_) => {}
            }
        } else if !self.any_backup_exists()? && !self.any_uncommitted_temp_exists()? {
            return Err(StorageError::recovery(
                "No recovery evidence exists for the missing workspace state.",
            ));
        }

        let candidate_path = self.resolve_candidate_path(candidate_id)?;
        let candidate_bytes = read_limited(&candidate_path, "workspace recovery candidate")?;
        let candidate = parse_document(&candidate_bytes).map_err(|_| {
            StorageError::invalid(
                "The selected recovery candidate is not a verified workspace generation.",
                "/candidateId",
            )
        })?;
        let highest_verified_revision = self
            .valid_backup_candidates()?
            .into_iter()
            .map(|(_, document)| document.revision)
            .chain(std::iter::once(candidate.revision))
            .max()
            .unwrap_or(candidate.revision);
        let revision = highest_verified_revision.checked_add(1).ok_or_else(|| {
            StorageError::new(
                StorageErrorCode::ReadOnly,
                "The workspace revision cannot advance further.",
                false,
            )
        })?;
        let recovered = WorkspaceDocumentV1 {
            schema_version: WORKSPACE_SCHEMA_VERSION,
            revision,
            written_at_utc: current_utc_timestamp()?,
            state: candidate.state,
            import_provenance: candidate.import_provenance,
        };
        validate_document(&recovered)?;
        let bytes = serialize_document(&recovered)?;

        if corrupt_primary_exists {
            self.quarantine_primary()?;
        }
        self.commit(&bytes, None)?;
        Ok(snapshot_from_document(recovered))
    }

    fn load_locked(&self) -> StorageResult<WorkspaceLoad> {
        let primary = self.primary_path();
        if !path_exists(&primary, "workspace state")? {
            let candidates = self.valid_backup_candidates()?;
            if let Some((candidate_id, document)) = candidates.into_iter().next() {
                return Ok(self.recovery_load(
                    RecoveryReason::PrimaryMissing,
                    Some(candidate_id),
                    Some(document),
                ));
            }
            if self.any_backup_exists()? || self.any_uncommitted_temp_exists()? {
                return Ok(self.recovery_load(RecoveryReason::PrimaryMissing, None, None));
            }
            return Ok(WorkspaceLoad {
                mode: if self.is_writable() {
                    StorageMode::Absent
                } else {
                    StorageMode::ReadOnly
                },
                snapshot: Some(snapshot_from_absent()),
                recovery: None,
            });
        }

        let bytes = match read_limited(&primary, "workspace state") {
            Ok(bytes) => bytes,
            Err(error)
                if matches!(
                    error.code,
                    StorageErrorCode::InvalidState | StorageErrorCode::TooLarge
                ) =>
            {
                return self.invalid_primary_load(RecoveryReason::PrimaryInvalid);
            }
            Err(error) => return Err(error),
        };
        match parse_document(&bytes) {
            Ok(document) => Ok(WorkspaceLoad {
                mode: if self.is_writable() {
                    StorageMode::Ready
                } else {
                    StorageMode::ReadOnly
                },
                snapshot: Some(snapshot_from_document(document)),
                recovery: None,
            }),
            Err(error) if error.code == StorageErrorCode::UnsupportedVersion => Ok(WorkspaceLoad {
                mode: StorageMode::UnsupportedVersion,
                snapshot: None,
                recovery: None,
            }),
            Err(_) => self.invalid_primary_load(RecoveryReason::PrimaryInvalid),
        }
    }

    fn invalid_primary_load(&self, reason: RecoveryReason) -> StorageResult<WorkspaceLoad> {
        let candidates = self.valid_backup_candidates()?;
        Ok(match candidates.into_iter().next() {
            Some((candidate_id, document)) => {
                self.recovery_load(reason, Some(candidate_id), Some(document))
            }
            None => self.recovery_load(reason, None, None),
        })
    }

    fn recovery_load(
        &self,
        reason: RecoveryReason,
        candidate_id: Option<String>,
        document: Option<WorkspaceDocumentV1>,
    ) -> WorkspaceLoad {
        WorkspaceLoad {
            mode: StorageMode::RecoveryRequired,
            snapshot: document.map(snapshot_from_document),
            recovery: Some(RecoveryPreview {
                required: true,
                reason,
                candidate_id,
            }),
        }
    }

    fn valid_backup_candidates(&self) -> StorageResult<Vec<(String, WorkspaceDocumentV1)>> {
        let mut candidates = Vec::new();
        for index in 1..=BACKUP_COUNT {
            let path = self.backup_path(index);
            if !path_exists(&path, "workspace backup")? {
                continue;
            }
            let bytes = match read_limited(&path, "workspace backup") {
                Ok(bytes) => bytes,
                Err(error)
                    if matches!(
                        error.code,
                        StorageErrorCode::InvalidState | StorageErrorCode::TooLarge
                    ) =>
                {
                    continue;
                }
                Err(error) => return Err(error),
            };
            if let Ok(document) = parse_document(&bytes) {
                candidates.push((format!("backup-{index}"), document));
            }
        }
        Ok(candidates)
    }

    fn list_recovery_candidates_locked(&self) -> StorageResult<Vec<RecoveryCandidateSummary>> {
        let mut candidates = Vec::new();
        for index in 1..=BACKUP_COUNT {
            let path = self.backup_path(index);
            if !path_exists(&path, "workspace backup")? {
                continue;
            }
            candidates.push(summarize_candidate(
                &path,
                format!("backup-{index}"),
                "workspace backup",
            )?);
        }
        for (index, path) in self.uncommitted_temp_paths()?.into_iter().enumerate() {
            candidates.push(summarize_candidate(
                &path,
                format!("temp-{}", index + 1),
                "workspace temporary state",
            )?);
        }
        Ok(candidates)
    }

    fn any_backup_exists(&self) -> StorageResult<bool> {
        for index in 1..=BACKUP_COUNT {
            if path_exists(&self.backup_path(index), "workspace backup")? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn any_uncommitted_temp_exists(&self) -> StorageResult<bool> {
        Ok(!self.uncommitted_temp_paths()?.is_empty())
    }

    fn uncommitted_temp_paths(&self) -> StorageResult<Vec<PathBuf>> {
        let prefix = format!(".{WORKSPACE_FILE_NAME}.");
        let mut paths = Vec::new();
        let entries = fs::read_dir(&self.inner.root)
            .map_err(|_| StorageError::io("Could not inspect workspace temporary files."))?;
        for entry in entries {
            let entry = entry
                .map_err(|_| StorageError::io("Could not inspect a workspace temporary file."))?;
            let file_type = entry
                .file_type()
                .map_err(|_| StorageError::io("Could not inspect a workspace temporary file."))?;
            if !file_type.is_file() {
                continue;
            }
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if name.starts_with(&prefix) && name.ends_with(".tmp") && !name.ends_with(".backup.tmp")
            {
                paths.push(entry.path());
            }
        }
        paths.sort();
        Ok(paths)
    }

    fn cleanup_uncommitted_temps(&self) {
        if let Ok(paths) = self.uncommitted_temp_paths() {
            for path in paths {
                let _ = fs::remove_file(path);
            }
        }
    }

    fn commit(&self, bytes: &[u8], previous_main: Option<&[u8]>) -> StorageResult<()> {
        reject_reparse_components(&self.inner.root)?;
        let temporary = self.inner.root.join(format!(
            ".{WORKSPACE_FILE_NAME}.{}.tmp",
            Uuid::new_v4().simple()
        ));
        let mut guard = TemporaryFileGuard(Some(temporary.clone()));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| StorageError::io("Could not create a workspace temporary file."))?;
        self.inject(FaultPoint::TempCreated)?;
        file.write_all(bytes)
            .map_err(|_| StorageError::io("Could not write workspace state."))?;
        self.inject(FaultPoint::TempWritten)?;
        file.sync_all()
            .map_err(|_| StorageError::io("Could not flush workspace state."))?;
        self.inject(FaultPoint::TempFlushed)?;
        drop(file);
        let verified = read_limited(&temporary, "workspace temporary state")?;
        parse_document(&verified).map_err(|_| {
            StorageError::new(
                StorageErrorCode::InvalidState,
                "The serialized workspace failed verification.",
                false,
            )
        })?;
        self.inject(FaultPoint::TempValidated)?;

        if let Some(previous_main) = previous_main {
            self.rotate_backups(previous_main)?;
        }
        self.inject(FaultPoint::BeforeReplace)?;
        reject_reparse_components(&self.inner.root)?;
        atomic_move(&temporary, &self.primary_path(), "workspace state")?;
        guard.disarm();
        sync_parent_directory(&self.inner.root, "workspace state")?;
        self.cleanup_uncommitted_temps();
        Ok(())
    }

    fn rotate_backups(&self, previous_main: &[u8]) -> StorageResult<()> {
        let mut generations = vec![previous_main.to_vec()];
        for index in 1..BACKUP_COUNT {
            let path = self.backup_path(index);
            if !path_exists(&path, "workspace backup")? {
                continue;
            }
            let bytes = read_limited(&path, "workspace backup")?;
            if parse_document(&bytes).is_ok() {
                generations.push(bytes);
            }
        }
        generations.truncate(BACKUP_COUNT);
        for index in (1..=generations.len()).rev() {
            self.inject(match index {
                1 => FaultPoint::BackupWrite1,
                2 => FaultPoint::BackupWrite2,
                _ => FaultPoint::BackupWrite3,
            })?;
            durable_atomic_copy(&self.backup_path(index), &generations[index - 1])?;
        }
        Ok(())
    }

    fn inject(&self, point: FaultPoint) -> StorageResult<()> {
        if self.inner.faults.fail(point) {
            Err(StorageError::io(
                "The workspace write was interrupted at a durability boundary.",
            ))
        } else {
            Ok(())
        }
    }

    fn primary_path(&self) -> PathBuf {
        self.inner.root.join(WORKSPACE_FILE_NAME)
    }

    fn backup_path(&self, index: usize) -> PathBuf {
        self.inner
            .root
            .join(format!("{WORKSPACE_FILE_NAME}.bak.{index}"))
    }

    fn require_writable(&self) -> StorageResult<()> {
        if self.is_writable() {
            Ok(())
        } else {
            Err(StorageError::new(
                StorageErrorCode::ReadOnly,
                "Another application instance owns the workspace writer lock.",
                true,
            ))
        }
    }

    fn resolve_candidate_path(&self, candidate_id: &str) -> StorageResult<PathBuf> {
        if let Some(index) = candidate_id.strip_prefix("backup-") {
            let index = index.parse::<usize>().ok();
            if index.is_some_and(|value| (1..=BACKUP_COUNT).contains(&value)) {
                return Ok(self.backup_path(index.expect("checked backup index")));
            }
        }
        if let Some(index) = candidate_id.strip_prefix("temp-") {
            let index = index.parse::<usize>().ok();
            if let Some(index) = index.filter(|value| *value > 0)
                && let Some(path) = self.uncommitted_temp_paths()?.get(index - 1)
            {
                return Ok(path.clone());
            }
        }
        Err(StorageError::invalid(
            "The recovery candidate identifier is invalid.",
            "/candidateId",
        ))
    }

    fn quarantine_primary(&self) -> StorageResult<()> {
        let source = self.primary_path();
        let bytes = read_limited(&source, "corrupt workspace state")?;
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let timestamp = current_utc_timestamp()?
            .bytes()
            .filter(u8::is_ascii_digit)
            .map(char::from)
            .collect::<String>();
        let directory = self.inner.root.join("quarantine");
        fs::create_dir_all(&directory).map_err(|_| {
            StorageError::io("Could not create the workspace quarantine directory.")
        })?;
        let destination = directory.join(format!("{timestamp}-{digest}.json"));
        if path_exists(&destination, "workspace quarantine")? {
            let existing = read_limited(&destination, "workspace quarantine")?;
            if existing == bytes {
                return Ok(());
            }
            return Err(StorageError::io(
                "A workspace quarantine identifier collision was detected.",
            ));
        }
        durable_atomic_raw_copy(&destination, &bytes, "workspace quarantine")
    }

    fn lock(&self) -> StorageResult<MutexGuard<'_, ()>> {
        let guard = self.inner.operation_lock.lock().map_err(|_| {
            StorageError::new(
                StorageErrorCode::Busy,
                "The workspace storage actor is unavailable.",
                true,
            )
        })?;
        reject_reparse_components(&self.inner.root)?;
        Ok(guard)
    }
}

fn reject_reparse_components(path: &Path) -> StorageResult<()> {
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(StorageError::new(
            StorageErrorCode::PathDenied,
            "The workspace state path contains a parent traversal.",
            false,
        ));
    }
    for ancestor in path.ancestors().collect::<Vec<_>>().into_iter().rev() {
        let metadata = match fs::symlink_metadata(ancestor) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                return Err(StorageError::io(
                    "Could not validate the workspace state path.",
                ));
            }
        };
        #[cfg(windows)]
        let is_reparse = metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
        #[cfg(not(windows))]
        let is_reparse = metadata.file_type().is_symlink();
        if is_reparse {
            return Err(StorageError::new(
                StorageErrorCode::PathDenied,
                "The workspace state path crosses a reparse point.",
                false,
            ));
        }
    }
    Ok(())
}

fn snapshot_from_absent() -> WorkspaceSnapshot {
    let state = WorkspaceStateV1::empty();
    WorkspaceSnapshot {
        schema_version: WORKSPACE_SCHEMA_VERSION,
        revision: 0,
        written_at_utc: None,
        resume_conflicts: derive_resume_conflicts(&state),
        state,
        import_provenance: None,
    }
}

fn snapshot_from_document(document: WorkspaceDocumentV1) -> WorkspaceSnapshot {
    let conflicts = derive_resume_conflicts(&document.state);
    WorkspaceSnapshot {
        schema_version: document.schema_version,
        revision: document.revision,
        written_at_utc: Some(document.written_at_utc),
        state: document.state,
        import_provenance: document.import_provenance,
        resume_conflicts: conflicts,
    }
}

fn merge_preserved_extensions(incoming: &mut WorkspaceStateV1, current: &WorkspaceStateV1) {
    incoming.extensions.extend(current.extensions.clone());
    incoming
        .legacy_extensions
        .extend(current.legacy_extensions.clone());
    for project in &mut incoming.projects {
        let Some(current_project) = current.projects.iter().find(|item| item.id == project.id)
        else {
            continue;
        };
        project
            .legacy_extensions
            .extend(current_project.legacy_extensions.clone());
        for terminal in &mut project.terminals {
            if let Some(current_terminal) = current_project
                .terminals
                .iter()
                .find(|item| item.id == terminal.id)
            {
                terminal
                    .legacy_extensions
                    .extend(current_terminal.legacy_extensions.clone());
            }
        }
    }
    for tab in &mut incoming.tabs {
        let Some(current_tab) = current.tabs.iter().find(|item| item.id == tab.id) else {
            continue;
        };
        tab.extensions.extend(current_tab.extensions.clone());
        if let (Some(browser), Some(current_browser)) = (&mut tab.browser, &current_tab.browser) {
            browser
                .extensions
                .extend(current_browser.extensions.clone());
        }
        if let (Some(output), Some(current_output)) = (&mut tab.output, &current_tab.output) {
            output.extensions.extend(current_output.extensions.clone());
        }
    }
}

fn normalize_and_validate_state(state: &mut WorkspaceStateV1) -> StorageResult<()> {
    for project in &mut state.projects {
        for (key, ratios) in &mut project.pane_width_ratios {
            if active_layout_columns(key).is_some() {
                let sum = ratios.iter().sum::<f64>();
                if sum.is_finite() && sum > 0.0 {
                    for ratio in ratios {
                        *ratio /= sum;
                    }
                }
            }
        }
    }
    validate_state(state)
}

fn validate_document(document: &WorkspaceDocumentV1) -> StorageResult<()> {
    if document.schema_version != WORKSPACE_SCHEMA_VERSION {
        return Err(StorageError::new(
            StorageErrorCode::UnsupportedVersion,
            "This workspace schema version is not supported.",
            false,
        )
        .at("/schemaVersion"));
    }
    if document.revision == 0 {
        return Err(StorageError::invalid(
            "A committed workspace revision must be positive.",
            "/revision",
        ));
    }
    if !is_rfc3339(&document.written_at_utc) {
        return Err(StorageError::invalid(
            "The workspace write timestamp is invalid.",
            "/writtenAtUtc",
        ));
    }
    validate_state(&document.state)?;
    if let Some(provenance) = &document.import_provenance {
        validate_provenance(provenance)?;
    }
    Ok(())
}

fn validate_state(state: &WorkspaceStateV1) -> StorageResult<()> {
    if state.projects.len() > MAX_PROJECTS {
        return Err(StorageError::invalid(
            "The workspace contains too many projects.",
            "/projects",
        ));
    }
    if state.tabs.len() > MAX_TABS {
        return Err(StorageError::invalid(
            "The workspace contains too many tabs.",
            "/tabs",
        ));
    }

    validate_extensions(&state.extensions, "/extensions")?;
    validate_extensions(&state.legacy_extensions, "/legacyExtensions")?;
    let mut project_ids = HashSet::new();
    for (project_index, project) in state.projects.iter().enumerate() {
        let prefix = format!("/projects/{project_index}");
        validate_text(&project.id, MAX_ID_BYTES, false, &format!("{prefix}/id"))?;
        if !project_ids.insert(project.id.as_str()) {
            return Err(StorageError::invalid(
                "Project identifiers must be unique.",
                format!("{prefix}/id"),
            ));
        }
        validate_text(
            &project.name,
            MAX_NAME_BYTES,
            false,
            &format!("{prefix}/name"),
        )?;
        validate_windows_path(&project.folder_path, &format!("{prefix}/folderPath"))?;
        if project.terminals.len() > MAX_TERMINALS_PER_PROJECT {
            return Err(StorageError::invalid(
                "A project contains too many terminals.",
                format!("{prefix}/terminals"),
            ));
        }
        validate_extensions(
            &project.legacy_extensions,
            &format!("{prefix}/legacyExtensions"),
        )?;
        let mut terminal_ids = HashSet::new();
        for (terminal_index, terminal) in project.terminals.iter().enumerate() {
            let terminal_prefix = format!("{prefix}/terminals/{terminal_index}");
            validate_text(
                &terminal.id,
                MAX_ID_BYTES,
                false,
                &format!("{terminal_prefix}/id"),
            )?;
            if !terminal_ids.insert(terminal.id.as_str()) {
                return Err(StorageError::invalid(
                    "Terminal identifiers must be unique within a project.",
                    format!("{terminal_prefix}/id"),
                ));
            }
            validate_text(
                &terminal.name,
                MAX_NAME_BYTES,
                false,
                &format!("{terminal_prefix}/name"),
            )?;
            validate_windows_path(
                &terminal.start_directory,
                &format!("{terminal_prefix}/startDirectory"),
            )?;
            validate_optional_uuid(
                terminal.codex_thread_id.as_deref(),
                &format!("{terminal_prefix}/codexThreadId"),
            )?;
            validate_optional_uuid(
                terminal.grok_session_id.as_deref(),
                &format!("{terminal_prefix}/grokSessionId"),
            )?;
            if let Some(created_at) = &terminal.created_at_utc
                && !is_rfc3339(created_at)
            {
                return Err(StorageError::invalid(
                    "The terminal creation timestamp is invalid.",
                    format!("{terminal_prefix}/createdAtUtc"),
                ));
            }
            validate_extensions(
                &terminal.legacy_extensions,
                &format!("{terminal_prefix}/legacyExtensions"),
            )?;
        }
        for (key, ratios) in &project.pane_width_ratios {
            if key.len() > MAX_ID_BYTES || ratios.is_empty() || ratios.len() > 5 {
                return Err(StorageError::invalid(
                    "A pane ratio entry has an invalid size.",
                    format!("{prefix}/paneWidthRatios"),
                ));
            }
            if ratios
                .iter()
                .any(|ratio| !ratio.is_finite() || *ratio <= 0.0)
            {
                return Err(StorageError::invalid(
                    "Pane ratios must be finite positive numbers.",
                    format!("{prefix}/paneWidthRatios"),
                ));
            }
            if let Some(columns) = active_layout_columns(key)
                && ratios.len() != columns
            {
                return Err(StorageError::invalid(
                    "An active pane ratio vector does not match its column count.",
                    format!("{prefix}/paneWidthRatios"),
                ));
            }
        }
    }

    if let Some(selected) = state.selected_project_id.as_deref()
        && !project_ids.contains(selected)
    {
        return Err(StorageError::invalid(
            "The selected project does not exist.",
            "/selectedProjectId",
        ));
    }

    let mut tab_ids = HashSet::new();
    for (tab_index, tab) in state.tabs.iter().enumerate() {
        let prefix = format!("/tabs/{tab_index}");
        validate_text(&tab.id, MAX_ID_BYTES, false, &format!("{prefix}/id"))?;
        if !tab_ids.insert(tab.id.as_str()) {
            return Err(StorageError::invalid(
                "Tab identifiers must be unique.",
                format!("{prefix}/id"),
            ));
        }
        validate_text(
            &tab.title,
            MAX_NAME_BYTES,
            false,
            &format!("{prefix}/title"),
        )?;
        validate_extensions(&tab.extensions, &format!("{prefix}/extensions"))?;
        if let Some(project_id) = tab.project_id.as_deref()
            && !project_ids.contains(project_id)
        {
            return Err(StorageError::invalid(
                "A tab references an unknown project.",
                format!("{prefix}/projectId"),
            ));
        }
        match tab.kind.as_str() {
            "empty" => {
                if tab.project_id.is_some() || tab.browser.is_some() || tab.output.is_some() {
                    return Err(StorageError::invalid(
                        "An empty tab contains unsupported state.",
                        prefix,
                    ));
                }
            }
            "project" => {
                if tab.project_id.is_none() || tab.browser.is_some() || tab.output.is_some() {
                    return Err(StorageError::invalid(
                        "A project tab has an invalid payload.",
                        prefix,
                    ));
                }
            }
            "browser" => {
                if tab.output.is_some() || tab.browser.is_none() {
                    return Err(StorageError::invalid(
                        "A browser tab has an invalid payload.",
                        prefix,
                    ));
                }
                let browser = tab.browser.as_ref().expect("checked above");
                validate_browser_url(&browser.url, &format!("{prefix}/browser/url"))?;
                validate_extensions(&browser.extensions, &format!("{prefix}/browser/extensions"))?;
            }
            "output" => {
                if tab.project_id.is_none() || tab.browser.is_some() || tab.output.is_none() {
                    return Err(StorageError::invalid(
                        "An output tab has an invalid payload.",
                        prefix,
                    ));
                }
                let output = tab.output.as_ref().expect("checked above");
                if output.mode != "auto" {
                    return Err(StorageError::invalid(
                        "The output tab mode is unsupported.",
                        format!("{prefix}/output/mode"),
                    ));
                }
                if let Some(entry) = &output.relative_entry {
                    validate_relative_entry(entry, &format!("{prefix}/output/relativeEntry"))?;
                }
                validate_extensions(&output.extensions, &format!("{prefix}/output/extensions"))?;
            }
            _ => {
                validate_text(&tab.kind, MAX_ID_BYTES, false, &format!("{prefix}/kind"))?;
            }
        }
    }
    if state.tabs.is_empty() {
        if state.active_tab_id.is_some() {
            return Err(StorageError::invalid(
                "An empty tab list cannot have an active tab.",
                "/activeTabId",
            ));
        }
    } else if state
        .active_tab_id
        .as_deref()
        .is_none_or(|active| !tab_ids.contains(active))
    {
        return Err(StorageError::invalid(
            "The active tab does not exist.",
            "/activeTabId",
        ));
    }
    Ok(())
}

fn validate_provenance(provenance: &ImportProvenanceV1) -> StorageResult<()> {
    validate_text(
        &provenance.source_format,
        MAX_ID_BYTES,
        false,
        "/importProvenance/sourceFormat",
    )?;
    if provenance.source_sha256.len() != 64
        || !provenance
            .source_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(StorageError::invalid(
            "The import source digest is invalid.",
            "/importProvenance/sourceSha256",
        ));
    }
    if provenance.snapshot_file != format!("{}.projects.json", provenance.source_sha256) {
        return Err(StorageError::invalid(
            "The import snapshot identifier is invalid.",
            "/importProvenance/snapshotFile",
        ));
    }
    if !is_rfc3339(&provenance.imported_at_utc) {
        return Err(StorageError::invalid(
            "The import timestamp is invalid.",
            "/importProvenance/importedAtUtc",
        ));
    }
    Ok(())
}

fn validate_text(
    value: &str,
    max_bytes: usize,
    allow_empty: bool,
    pointer: &str,
) -> StorageResult<()> {
    if value.as_bytes().contains(&0)
        || value.len() > max_bytes
        || (!allow_empty && value.trim().is_empty())
    {
        return Err(StorageError::invalid(
            "A workspace text field is invalid or too large.",
            pointer,
        ));
    }
    Ok(())
}

fn validate_windows_path(value: &str, pointer: &str) -> StorageResult<()> {
    validate_text(value, MAX_PATH_BYTES, false, pointer)?;
    let normalized = value.replace('/', "\\");
    if normalized.starts_with(r"\\.\")
        || normalized
            .to_ascii_lowercase()
            .starts_with(r"\\?\globalroot")
        || !(is_drive_absolute(&normalized) || is_unc_absolute(&normalized))
        || has_alternate_data_stream(&normalized)
    {
        return Err(StorageError::invalid(
            "A workspace path is not an allowed absolute Windows path.",
            pointer,
        ));
    }
    Ok(())
}

fn is_drive_absolute(path: &str) -> bool {
    let path = path.strip_prefix(r"\\?\").unwrap_or(path);
    let bytes = path.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\'
}

fn is_unc_absolute(path: &str) -> bool {
    let extended_prefix = r"\\?\UNC\";
    let path = if path
        .get(..extended_prefix.len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(extended_prefix))
    {
        &path[extended_prefix.len()..]
    } else if let Some(path) = path.strip_prefix(r"\\") {
        path
    } else {
        return false;
    };
    let mut components = path.split('\\').filter(|part| !part.is_empty());
    components.next().is_some() && components.next().is_some()
}

fn has_alternate_data_stream(path: &str) -> bool {
    let path = path.strip_prefix(r"\\?\").unwrap_or(path);
    path.char_indices()
        .any(|(index, character)| character == ':' && index != 1)
}

fn validate_optional_uuid(value: Option<&str>, pointer: &str) -> StorageResult<()> {
    if let Some(value) = value
        && Uuid::parse_str(value).is_err()
    {
        return Err(StorageError::invalid(
            "An agent resume identifier is invalid.",
            pointer,
        ));
    }
    Ok(())
}

fn validate_browser_url(url: &str, pointer: &str) -> StorageResult<()> {
    validate_text(url, MAX_URL_BYTES, false, pointer)?;
    if url.eq_ignore_ascii_case("about:blank") {
        return Ok(());
    }
    let lower = url.to_ascii_lowercase();
    let authority = if lower.starts_with("https://") {
        &url[8..]
    } else if lower.starts_with("http://") {
        &url[7..]
    } else {
        return Err(StorageError::invalid(
            "A browser tab URL uses an unsafe scheme.",
            pointer,
        ));
    };
    let authority = authority.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.is_empty()
        || authority.contains('@')
        || url.chars().any(char::is_whitespace)
        || url.chars().any(char::is_control)
    {
        return Err(StorageError::invalid(
            "A browser tab URL is invalid or contains user information.",
            pointer,
        ));
    }
    Ok(())
}

fn validate_relative_entry(entry: &str, pointer: &str) -> StorageResult<()> {
    validate_text(entry, MAX_PATH_BYTES, false, pointer)?;
    let path = Path::new(entry);
    if path.is_absolute()
        || entry.contains(':')
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(StorageError::invalid(
            "An output entry must be a bounded relative path.",
            pointer,
        ));
    }
    Ok(())
}

fn validate_extensions(extensions: &BTreeMap<String, Value>, pointer: &str) -> StorageResult<()> {
    for (key, value) in extensions {
        if key.is_empty() || key.len() > MAX_ID_BYTES {
            return Err(StorageError::invalid(
                "An extension key is invalid or too large.",
                pointer,
            ));
        }
        validate_extension_value(value, 1, pointer)?;
    }
    Ok(())
}

fn validate_extension_value(value: &Value, depth: usize, pointer: &str) -> StorageResult<()> {
    if depth > MAX_EXTENSION_DEPTH {
        return Err(StorageError::invalid(
            "An extension value is nested too deeply.",
            pointer,
        ));
    }
    match value {
        Value::String(value) if value.len() > MAX_EXTENSION_STRING_BYTES => Err(
            StorageError::invalid("An extension string is too large.", pointer),
        ),
        Value::Array(values) => {
            for value in values {
                validate_extension_value(value, depth + 1, pointer)?;
            }
            Ok(())
        }
        Value::Object(values) => {
            for (key, value) in values {
                if key.len() > MAX_ID_BYTES {
                    return Err(StorageError::invalid(
                        "An extension key is too large.",
                        pointer,
                    ));
                }
                validate_extension_value(value, depth + 1, pointer)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn active_layout_columns(key: &str) -> Option<usize> {
    let (grid, row) = key.split_once(':')?;
    let (columns, rows) = grid.split_once('x')?;
    let columns = columns.parse::<usize>().ok()?;
    let rows = rows.parse::<usize>().ok()?;
    let row = row.strip_prefix("row-")?.parse::<usize>().ok()?;
    if (1..=5).contains(&columns) && (1..=4).contains(&rows) && row < rows && row <= 3 {
        Some(columns)
    } else {
        None
    }
}

fn derive_resume_conflicts(state: &WorkspaceStateV1) -> Vec<ResumeConflict> {
    let mut codex: HashMap<&str, Vec<String>> = HashMap::new();
    let mut grok: HashMap<&str, Vec<String>> = HashMap::new();
    for (project_index, project) in state.projects.iter().enumerate() {
        for (terminal_index, terminal) in project.terminals.iter().enumerate() {
            let pointer = format!("/projects/{project_index}/terminals/{terminal_index}");
            if let Some(id) = terminal.codex_thread_id.as_deref() {
                codex.entry(id).or_default().push(pointer.clone());
            }
            if let Some(id) = terminal.grok_session_id.as_deref() {
                grok.entry(id).or_default().push(pointer);
            }
        }
    }
    let mut conflicts = Vec::new();
    for (agent, entries) in [("codex", codex), ("grok", grok)] {
        for pointers in entries.into_values().filter(|pointers| pointers.len() > 1) {
            conflicts.push(ResumeConflict {
                agent: agent.to_owned(),
                terminal_pointers: pointers,
            });
        }
    }
    conflicts.sort_by(|left, right| {
        left.agent
            .cmp(&right.agent)
            .then(left.terminal_pointers.cmp(&right.terminal_pointers))
    });
    conflicts
}

fn serialize_document(document: &WorkspaceDocumentV1) -> StorageResult<Vec<u8>> {
    let mut bytes = serde_json::to_vec_pretty(document).map_err(|_| {
        StorageError::new(
            StorageErrorCode::InvalidState,
            "The workspace could not be serialized.",
            false,
        )
    })?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_WORKSPACE_BYTES {
        return Err(StorageError::new(
            StorageErrorCode::TooLarge,
            "The workspace exceeds the 8 MiB safety limit.",
            false,
        ));
    }
    Ok(bytes)
}

fn parse_document(bytes: &[u8]) -> StorageResult<WorkspaceDocumentV1> {
    if bytes.len() as u64 > MAX_WORKSPACE_BYTES {
        return Err(StorageError::new(
            StorageErrorCode::TooLarge,
            "The workspace exceeds the 8 MiB safety limit.",
            false,
        ));
    }
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let unique = UniqueJson::deserialize(&mut deserializer).map_err(|_| {
        StorageError::new(
            StorageErrorCode::InvalidState,
            "The workspace JSON is invalid or contains duplicate members.",
            false,
        )
    })?;
    deserializer.end().map_err(|_| {
        StorageError::new(
            StorageErrorCode::InvalidState,
            "The workspace contains trailing or invalid JSON data.",
            false,
        )
    })?;
    let schema_version = unique
        .0
        .as_object()
        .and_then(|object| object.get("schemaVersion"))
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            StorageError::invalid("The workspace schema version is missing.", "/schemaVersion")
        })?;
    if schema_version != u64::from(WORKSPACE_SCHEMA_VERSION) {
        return Err(StorageError::new(
            StorageErrorCode::UnsupportedVersion,
            "This workspace schema version is not supported.",
            false,
        )
        .at("/schemaVersion"));
    }
    let document: WorkspaceDocumentV1 = serde_json::from_value(unique.0).map_err(|_| {
        StorageError::new(
            StorageErrorCode::InvalidState,
            "The workspace does not match the v1 schema.",
            false,
        )
    })?;
    validate_document(&document)?;
    Ok(document)
}

struct UniqueJson(Value);

impl<'de> Deserialize<'de> for UniqueJson {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_any(UniqueJsonVisitor)
    }
}

struct UniqueJsonVisitor;

impl<'de> serde::de::Visitor<'de> for UniqueJsonVisitor {
    type Value = UniqueJson;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value without duplicate object members")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(UniqueJson(Value::Bool(value)))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
        Ok(UniqueJson(Value::from(value)))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(UniqueJson(Value::from(value)))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        serde_json::Number::from_f64(value)
            .map(Value::Number)
            .map(UniqueJson)
            .ok_or_else(|| E::custom("non-finite JSON number"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
        Ok(UniqueJson(Value::String(value.to_owned())))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(UniqueJson(Value::String(value)))
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(UniqueJson(Value::Null))
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(UniqueJson(Value::Null))
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: serde::de::SeqAccess<'de>,
    {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element::<UniqueJson>()? {
            values.push(value.0);
        }
        Ok(UniqueJson(Value::Array(values)))
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: serde::de::MapAccess<'de>,
    {
        let mut values = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if values.contains_key(&key) {
                return Err(serde::de::Error::custom("duplicate JSON member"));
            }
            let value = map.next_value::<UniqueJson>()?;
            values.insert(key, value.0);
        }
        Ok(UniqueJson(Value::Object(values)))
    }
}

fn read_limited(path: &Path, context: &str) -> StorageResult<Vec<u8>> {
    let file =
        File::open(path).map_err(|_| StorageError::io(&format!("Could not read {context}.")))?;
    ensure_single_link(&file, context)?;
    let mut bytes = Vec::new();
    file.take(MAX_WORKSPACE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| StorageError::io(&format!("Could not read {context}.")))?;
    if bytes.len() as u64 > MAX_WORKSPACE_BYTES {
        return Err(StorageError::new(
            StorageErrorCode::TooLarge,
            "A workspace storage candidate exceeds the 8 MiB safety limit.",
            false,
        ));
    }
    Ok(bytes)
}

#[cfg(windows)]
fn ensure_single_link(file: &File, context: &str) -> StorageResult<()> {
    use std::mem::MaybeUninit;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };

    let mut information = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) };
    if ok == 0 {
        return Err(StorageError::io(&format!("Could not inspect {context}.")));
    }
    if unsafe { information.assume_init() }.nNumberOfLinks != 1 {
        return Err(StorageError::new(
            StorageErrorCode::PathDenied,
            "A workspace storage file has an unexpected hard-link alias.",
            false,
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn ensure_single_link(file: &File, _context: &str) -> StorageResult<()> {
    use std::os::unix::fs::MetadataExt;
    if file
        .metadata()
        .map_err(|_| StorageError::io("Could not inspect workspace storage."))?
        .nlink()
        != 1
    {
        return Err(StorageError::new(
            StorageErrorCode::PathDenied,
            "A workspace storage file has an unexpected hard-link alias.",
            false,
        ));
    }
    Ok(())
}

#[cfg(not(any(windows, unix)))]
fn ensure_single_link(_file: &File, _context: &str) -> StorageResult<()> {
    Ok(())
}

fn summarize_candidate(
    path: &Path,
    candidate_id: String,
    context: &str,
) -> StorageResult<RecoveryCandidateSummary> {
    let byte_length = fs::metadata(path)
        .map_err(|_| StorageError::io(&format!("Could not inspect {context}.")))?
        .len();
    let parsed = if byte_length > MAX_WORKSPACE_BYTES {
        None
    } else {
        match read_limited(path, context) {
            Ok(bytes) => parse_document(&bytes).ok(),
            Err(error)
                if matches!(
                    error.code,
                    StorageErrorCode::InvalidState | StorageErrorCode::TooLarge
                ) =>
            {
                None
            }
            Err(error) => return Err(error),
        }
    };
    Ok(RecoveryCandidateSummary {
        candidate_id,
        revision: parsed.as_ref().map(|document| document.revision),
        written_at_utc: parsed
            .as_ref()
            .map(|document| document.written_at_utc.clone()),
        byte_length,
        valid: parsed.is_some(),
    })
}

fn path_exists(path: &Path, context: &str) -> StorageResult<bool> {
    path.try_exists()
        .map_err(|_| StorageError::io(&format!("Could not inspect {context}.")))
}

fn durable_atomic_copy(path: &Path, bytes: &[u8]) -> StorageResult<()> {
    let parent = path.parent().ok_or_else(|| {
        StorageError::new(
            StorageErrorCode::PathDenied,
            "A workspace backup has no parent directory.",
            false,
        )
    })?;
    let temporary = parent.join(format!(
        ".{WORKSPACE_FILE_NAME}.{}.backup.tmp",
        Uuid::new_v4().simple()
    ));
    let mut guard = TemporaryFileGuard(Some(temporary.clone()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| StorageError::io("Could not create a workspace backup temporary file."))?;
    file.write_all(bytes)
        .map_err(|_| StorageError::io("Could not write a workspace backup."))?;
    file.sync_all()
        .map_err(|_| StorageError::io("Could not flush a workspace backup."))?;
    drop(file);
    let verified = read_limited(&temporary, "workspace backup temporary state")?;
    parse_document(&verified).map_err(|_| {
        StorageError::new(
            StorageErrorCode::InvalidState,
            "A workspace backup failed verification.",
            false,
        )
    })?;
    atomic_move(&temporary, path, "workspace backup")?;
    guard.disarm();
    sync_parent_directory(parent, "workspace backup")
}

fn durable_atomic_raw_copy(path: &Path, bytes: &[u8], context: &str) -> StorageResult<()> {
    let parent = path.parent().ok_or_else(|| {
        StorageError::new(
            StorageErrorCode::PathDenied,
            "A workspace storage artifact has no parent directory.",
            false,
        )
    })?;
    let temporary = parent.join(format!(".quarantine.{}.tmp", Uuid::new_v4().simple()));
    let mut guard = TemporaryFileGuard(Some(temporary.clone()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| StorageError::io(&format!("Could not create {context}.")))?;
    file.write_all(bytes)
        .map_err(|_| StorageError::io(&format!("Could not write {context}.")))?;
    file.sync_all()
        .map_err(|_| StorageError::io(&format!("Could not flush {context}.")))?;
    drop(file);
    let verified = read_limited(&temporary, context)?;
    if verified != bytes {
        return Err(StorageError::io(&format!("Could not verify {context}.")));
    }
    atomic_move(&temporary, path, context)?;
    guard.disarm();
    sync_parent_directory(parent, context)
}

struct TemporaryFileGuard(Option<PathBuf>);

impl TemporaryFileGuard {
    fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for TemporaryFileGuard {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(windows)]
fn atomic_move(source: &Path, destination: &Path, context: &str) -> StorageResult<()> {
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
    let destination_exists = destination
        .try_exists()
        .map_err(|_| StorageError::io(&format!("Could not inspect {context}.")))?;
    let result = if destination_exists {
        unsafe {
            ReplaceFileW(
                destination_wide.as_ptr(),
                source_wide.as_ptr(),
                std::ptr::null(),
                REPLACEFILE_WRITE_THROUGH,
                std::ptr::null(),
                std::ptr::null(),
            )
        }
    } else {
        unsafe {
            MoveFileExW(
                source_wide.as_ptr(),
                destination_wide.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
    };
    if result == 0 {
        Err(StorageError::io(&format!(
            "Could not atomically replace {context}."
        )))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn atomic_move(source: &Path, destination: &Path, context: &str) -> StorageResult<()> {
    fs::rename(source, destination)
        .map_err(|_| StorageError::io(&format!("Could not atomically replace {context}.")))
}

#[cfg(windows)]
fn sync_parent_directory(_directory: &Path, _context: &str) -> StorageResult<()> {
    Ok(())
}

#[cfg(not(windows))]
fn sync_parent_directory(directory: &Path, context: &str) -> StorageResult<()> {
    File::open(directory)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| StorageError::io(&format!("Could not flush the {context} directory.")))
}

fn current_utc_timestamp() -> StorageResult<String> {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| StorageError::io("The system clock cannot timestamp workspace state."))?
        .as_secs();
    let days = (seconds / 86_400) as i64;
    let seconds_of_day = seconds % 86_400;
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;
    let (year, month, day) = civil_from_days(days);
    Ok(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z"
    ))
}

fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let days = days_since_epoch + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
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
        let start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == start {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "ihc-workspace-store-test-{}",
                Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn state_root(&self) -> PathBuf {
            self.0.join(STATE_DIRECTORY_NAME)
        }

        fn open(&self) -> WorkspaceStore {
            WorkspaceStore::open(&self.0).unwrap()
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    struct FailAt {
        point: FaultPoint,
        fired: AtomicBool,
    }

    impl FaultInjector for FailAt {
        fn fail(&self, point: FaultPoint) -> bool {
            point == self.point && !self.fired.swap(true, Ordering::AcqRel)
        }
    }

    fn sample_state() -> WorkspaceStateV1 {
        let project_id = "project-1".to_owned();
        WorkspaceStateV1 {
            selected_project_id: Some(project_id.clone()),
            projects: vec![WorkspaceProjectV1 {
                id: project_id.clone(),
                name: "Example".to_owned(),
                folder_path: r"C:\Preview\Example".to_owned(),
                terminals: vec![WorkspaceTerminalV1 {
                    id: "terminal-1".to_owned(),
                    name: "MAIN".to_owned(),
                    start_directory: r"C:\Preview\Example".to_owned(),
                    codex_thread_id: Some("33333333-3333-4333-8333-333333333333".to_owned()),
                    grok_session_id: None,
                    created_at_utc: Some("2026-01-01T00:00:00Z".to_owned()),
                    completion_pending: true,
                    legacy_extensions: BTreeMap::new(),
                }],
                pane_width_ratios: BTreeMap::from([("2x1:row-0".to_owned(), vec![2.0, 2.0])]),
                legacy_extensions: BTreeMap::new(),
            }],
            tabs: vec![WorkspaceTabV1 {
                id: "tab-1".to_owned(),
                kind: "project".to_owned(),
                title: "Example".to_owned(),
                project_id: Some(project_id),
                browser: None,
                output: None,
                extensions: BTreeMap::new(),
            }],
            active_tab_id: Some("tab-1".to_owned()),
            extensions: BTreeMap::new(),
            legacy_extensions: BTreeMap::new(),
        }
    }

    fn save(store: &WorkspaceStore, expected_revision: u64, state: WorkspaceStateV1) -> u64 {
        store
            .save(SaveWorkspaceRequest {
                expected_revision,
                state,
            })
            .unwrap()
            .revision
    }

    #[test]
    fn canonical_workspace_round_trips_and_normalizes_layout() {
        let test = TestDirectory::new();
        let store = test.open();
        let absent = store.load().unwrap();
        assert_eq!(absent.mode, StorageMode::Absent);
        assert_eq!(absent.snapshot.unwrap().revision, 0);

        assert_eq!(save(&store, 0, sample_state()), 1);
        let loaded = store.load().unwrap();
        assert_eq!(loaded.mode, StorageMode::Ready);
        let snapshot = loaded.snapshot.unwrap();
        assert_eq!(snapshot.schema_version, 1);
        assert_eq!(snapshot.revision, 1);
        assert_eq!(
            snapshot.state.projects[0].pane_width_ratios["2x1:row-0"],
            vec![0.5, 0.5]
        );
        assert!(snapshot.written_at_utc.as_deref().is_some_and(is_rfc3339));
    }

    #[test]
    fn duplicate_json_members_and_future_versions_are_not_normal_state() {
        let duplicate = br#"{"schemaVersion":1,"schemaVersion":1}"#;
        assert_eq!(
            parse_document(duplicate).unwrap_err().code,
            StorageErrorCode::InvalidState
        );

        let document = WorkspaceDocumentV1 {
            schema_version: 1,
            revision: 1,
            written_at_utc: "2026-01-01T00:00:00Z".to_owned(),
            state: sample_state(),
            import_provenance: None,
        };
        let mut value = serde_json::to_value(&document).unwrap();
        value["schemaVersion"] = Value::from(2);
        assert_eq!(
            parse_document(&serde_json::to_vec(&value).unwrap())
                .unwrap_err()
                .code,
            StorageErrorCode::UnsupportedVersion
        );
    }

    #[test]
    fn phase3_unsupported_future_version_is_read_only() {
        let test = TestDirectory::new();
        let store = test.open();
        let document = WorkspaceDocumentV1 {
            schema_version: WORKSPACE_SCHEMA_VERSION,
            revision: 7,
            written_at_utc: "2026-01-01T00:00:00Z".to_owned(),
            state: sample_state(),
            import_provenance: None,
        };
        let mut value = serde_json::to_value(document).unwrap();
        value["schemaVersion"] = Value::from(WORKSPACE_SCHEMA_VERSION + 1);
        fs::write(store.primary_path(), serde_json::to_vec(&value).unwrap()).unwrap();

        let load = store.load().unwrap();
        assert_eq!(load.mode, StorageMode::UnsupportedVersion);
        assert!(load.snapshot.is_none());
        let error = store
            .save(SaveWorkspaceRequest {
                expected_revision: 7,
                state: sample_state(),
            })
            .unwrap_err();
        assert_eq!(error.code, StorageErrorCode::UnsupportedVersion);
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(store.primary_path()).unwrap()).unwrap(),
            value
        );
    }

    #[test]
    fn phase3_revision_conflict_prevents_lost_update() {
        let test = TestDirectory::new();
        let store = test.open();
        assert_eq!(save(&store, 0, sample_state()), 1);
        let before = fs::read(store.primary_path()).unwrap();

        let mut stale = sample_state();
        stale.projects[0].name = "Stale".to_owned();
        let error = store
            .save(SaveWorkspaceRequest {
                expected_revision: 0,
                state: stale,
            })
            .unwrap_err();
        assert_eq!(error.code, StorageErrorCode::RevisionConflict);
        assert_eq!(fs::read(store.primary_path()).unwrap(), before);
    }

    #[test]
    fn backend_owned_extensions_preserve_integers_above_javascript_precision() {
        let test = TestDirectory::new();
        let store = test.open();
        let sentinel = 9_007_199_254_740_993_u64;
        let mut initial = sample_state();
        initial
            .extensions
            .insert("futureInteger".to_owned(), Value::from(sentinel));
        initial.projects[0].terminals[0]
            .legacy_extensions
            .insert("nestedFutureInteger".to_owned(), Value::from(sentinel));
        save(&store, 0, initial);

        let mut lossy_frontend = sample_state();
        lossy_frontend
            .extensions
            .insert("futureInteger".to_owned(), Value::from(sentinel - 1));
        lossy_frontend.projects[0].terminals[0]
            .legacy_extensions
            .insert("nestedFutureInteger".to_owned(), Value::from(sentinel - 1));
        save(&store, 1, lossy_frontend);

        let state = store.load().unwrap().snapshot.unwrap().state;
        assert_eq!(state.extensions["futureInteger"].as_u64(), Some(sentinel));
        assert_eq!(
            state.projects[0].terminals[0].legacy_extensions["nestedFutureInteger"].as_u64(),
            Some(sentinel)
        );
    }

    #[test]
    fn phase3_second_instance_is_read_only_or_serialized() {
        let test = TestDirectory::new();
        let first = test.open();
        assert_eq!(save(&first, 0, sample_state()), 1);
        let second = test.open();
        assert!(!second.is_writable());
        assert_eq!(second.load().unwrap().mode, StorageMode::ReadOnly);
        assert_eq!(
            second
                .save(SaveWorkspaceRequest {
                    expected_revision: 1,
                    state: sample_state(),
                })
                .unwrap_err()
                .code,
            StorageErrorCode::ReadOnly
        );

        let mut changed = sample_state();
        changed.projects[0].name = "First writer".to_owned();
        assert_eq!(save(&first, 1, changed), 2);
        drop(first);
        drop(second);

        let reopened = test.open();
        assert!(reopened.is_writable());
        let error = reopened
            .save(SaveWorkspaceRequest {
                expected_revision: 1,
                state: sample_state(),
            })
            .unwrap_err();
        assert_eq!(error.code, StorageErrorCode::RevisionConflict);
        assert_eq!(reopened.load().unwrap().snapshot.unwrap().revision, 2);
    }

    #[test]
    fn phase3_workspace_target_rejects_hardlink_alias() {
        let test = TestDirectory::new();
        let store = test.open();
        save(&store, 0, sample_state());
        let alias = test.0.join("workspace-alias.json");
        fs::hard_link(store.primary_path(), &alias).unwrap();

        let error = store.load().unwrap_err();
        assert_eq!(error.code, StorageErrorCode::PathDenied);
        assert!(alias.exists());
    }

    #[test]
    fn backup_rotation_keeps_three_verified_generations() {
        let test = TestDirectory::new();
        let store = test.open();
        let mut state = sample_state();
        for expected in 0..4 {
            state.projects[0].name = format!("Revision {}", expected + 1);
            assert_eq!(save(&store, expected, state.clone()), expected + 1);
        }
        assert_eq!(
            parse_document(&fs::read(store.primary_path()).unwrap())
                .unwrap()
                .revision,
            4
        );
        assert_eq!(
            parse_document(&fs::read(store.backup_path(1)).unwrap())
                .unwrap()
                .revision,
            3
        );
        assert_eq!(
            parse_document(&fs::read(store.backup_path(2)).unwrap())
                .unwrap()
                .revision,
            2
        );
        assert_eq!(
            parse_document(&fs::read(store.backup_path(3)).unwrap())
                .unwrap()
                .revision,
            1
        );
    }

    #[test]
    fn phase3_fault_at_every_write_boundary_keeps_one_valid_generation() {
        let points = [
            FaultPoint::TempCreated,
            FaultPoint::TempWritten,
            FaultPoint::TempFlushed,
            FaultPoint::TempValidated,
            FaultPoint::BackupWrite1,
            FaultPoint::BackupWrite2,
            FaultPoint::BackupWrite3,
            FaultPoint::BeforeReplace,
        ];
        for point in points {
            let test = TestDirectory::new();
            {
                let seed = test.open();
                let mut state = sample_state();
                for expected in 0..3 {
                    state.projects[0].name = format!("Seed {}", expected + 1);
                    save(&seed, expected, state.clone());
                }
            }
            let store = WorkspaceStore::open_state_root_with_faults(
                test.state_root(),
                Arc::new(FailAt {
                    point,
                    fired: AtomicBool::new(false),
                }),
            )
            .unwrap();
            let error = store
                .save(SaveWorkspaceRequest {
                    expected_revision: 3,
                    state: sample_state(),
                })
                .unwrap_err();
            assert_eq!(error.code, StorageErrorCode::Io, "fault {point:?}");
            let load = store.load().unwrap();
            assert_eq!(load.mode, StorageMode::Ready, "fault {point:?}");
            assert_eq!(load.snapshot.unwrap().revision, 3, "fault {point:?}");
        }
    }

    #[test]
    fn phase3_truncated_main_recovers_verified_backup() {
        let test = TestDirectory::new();
        let store = test.open();
        let state = sample_state();
        save(&store, 0, state.clone());
        save(&store, 1, state);
        let corrupt = b"truncated private state".to_vec();
        fs::write(store.primary_path(), &corrupt).unwrap();

        let recovery = store.load().unwrap();
        assert_eq!(recovery.mode, StorageMode::RecoveryRequired);
        assert_eq!(recovery.snapshot.unwrap().revision, 1);
        assert_eq!(
            recovery.recovery.unwrap().candidate_id.as_deref(),
            Some("backup-1")
        );
        assert_eq!(fs::read(store.primary_path()).unwrap(), corrupt);
        assert_eq!(
            store
                .save(SaveWorkspaceRequest {
                    expected_revision: 1,
                    state: sample_state(),
                })
                .unwrap_err()
                .code,
            StorageErrorCode::RecoveryRequired
        );

        fs::remove_file(store.primary_path()).unwrap();
        let missing = store.load().unwrap();
        assert_eq!(missing.mode, StorageMode::RecoveryRequired);
        assert_eq!(
            missing.recovery.unwrap().reason,
            RecoveryReason::PrimaryMissing
        );
    }

    #[test]
    fn oversized_primary_and_backup_candidates_fail_closed() {
        let test = TestDirectory::new();
        let store = test.open();
        save(&store, 0, sample_state());
        save(&store, 1, sample_state());
        save(&store, 2, sample_state());

        fs::write(
            store.backup_path(1),
            vec![b'x'; MAX_WORKSPACE_BYTES as usize + 1],
        )
        .unwrap();
        fs::write(
            store.primary_path(),
            vec![b'x'; MAX_WORKSPACE_BYTES as usize + 1],
        )
        .unwrap();

        let recovery = store.load().unwrap();
        assert_eq!(recovery.mode, StorageMode::RecoveryRequired);
        assert_eq!(
            recovery.recovery.unwrap().candidate_id.as_deref(),
            Some("backup-2")
        );
        assert_eq!(recovery.snapshot.unwrap().revision, 1);
        let candidates = store.list_recovery_candidates().unwrap();
        assert_eq!(candidates[0].candidate_id, "backup-1");
        assert!(!candidates[0].valid);
        assert_eq!(candidates[0].byte_length, MAX_WORKSPACE_BYTES + 1);
        assert_eq!(
            store
                .save(SaveWorkspaceRequest {
                    expected_revision: 3,
                    state: sample_state(),
                })
                .unwrap_err()
                .code,
            StorageErrorCode::RecoveryRequired
        );
    }

    #[test]
    fn missing_main_with_uncommitted_temp_is_never_treated_as_empty() {
        let test = TestDirectory::new();
        let store = test.open();
        let document = WorkspaceDocumentV1 {
            schema_version: WORKSPACE_SCHEMA_VERSION,
            revision: 7,
            written_at_utc: "2026-01-02T00:00:00Z".to_owned(),
            state: sample_state(),
            import_provenance: None,
        };
        fs::write(
            test.state_root().join(".workspace-v1.json.abandoned.tmp"),
            serialize_document(&document).unwrap(),
        )
        .unwrap();

        let recovery = store.load().unwrap();
        assert_eq!(recovery.mode, StorageMode::RecoveryRequired);
        assert!(recovery.snapshot.is_none());
        assert_eq!(
            store
                .save(SaveWorkspaceRequest {
                    expected_revision: 0,
                    state: WorkspaceStateV1::empty(),
                })
                .unwrap_err()
                .code,
            StorageErrorCode::RecoveryRequired
        );
        let candidates = store.list_recovery_candidates().unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].candidate_id, "temp-1");
        assert_eq!(candidates[0].revision, Some(7));
        assert!(candidates[0].valid);
    }

    #[test]
    fn phase3_all_candidates_invalid_never_autosaves_empty_state() {
        let test = TestDirectory::new();
        let store = test.open();
        fs::write(store.primary_path(), b"invalid-main").unwrap();
        fs::write(store.backup_path(1), b"invalid-backup").unwrap();

        let load = store.load().unwrap();
        assert_eq!(load.mode, StorageMode::RecoveryRequired);
        assert!(load.snapshot.is_none());
        assert_eq!(
            store
                .save(SaveWorkspaceRequest {
                    expected_revision: 0,
                    state: WorkspaceStateV1::empty(),
                })
                .unwrap_err()
                .code,
            StorageErrorCode::RecoveryRequired
        );
        assert_eq!(fs::read(store.primary_path()).unwrap(), b"invalid-main");
    }

    #[test]
    fn phase3_valid_main_ignores_uncommitted_temp() {
        let test = TestDirectory::new();
        let store = test.open();
        save(&store, 0, sample_state());
        let mut document = parse_document(&fs::read(store.primary_path()).unwrap()).unwrap();
        document.revision = 99;
        document.written_at_utc = "2026-01-02T00:00:00Z".to_owned();
        let leftover = test.state_root().join(".workspace-v1.json.leftover.tmp");
        fs::write(&leftover, serialize_document(&document).unwrap()).unwrap();
        assert_eq!(store.load().unwrap().snapshot.unwrap().revision, 1);

        save(&store, 1, sample_state());
        assert!(!leftover.exists());
        let candidates = store.list_recovery_candidates().unwrap();
        assert_eq!(candidates[0].candidate_id, "backup-1");
        assert!(!candidates[0].candidate_id.contains('\\'));
        assert!(!candidates[0].candidate_id.contains('/'));
    }

    #[test]
    fn structured_errors_are_camel_case_and_redacted() {
        let error = StorageError::new(
            StorageErrorCode::RevisionConflict,
            "Reload before saving.",
            true,
        )
        .at("/expectedRevision");
        let value = serde_json::to_value(error).unwrap();
        assert_eq!(value["code"], "revisionConflict");
        assert_eq!(value["retryable"], true);
        assert_eq!(value["jsonPointer"], "/expectedRevision");
        assert!(value.get("json_pointer").is_none());
    }

    #[test]
    fn model_bounds_urls_extensions_and_resume_conflicts() {
        let mut state = sample_state();
        let duplicate = state.projects[0].terminals[0].clone();
        let mut second = duplicate.clone();
        second.id = "terminal-2".to_owned();
        state.projects[0].terminals.push(second);
        normalize_and_validate_state(&mut state).unwrap();
        let conflicts = derive_resume_conflicts(&state);
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].agent, "codex");

        state.tabs.push(WorkspaceTabV1 {
            id: "unsafe-browser".to_owned(),
            kind: "browser".to_owned(),
            title: "Unsafe".to_owned(),
            project_id: None,
            browser: Some(BrowserTabV1 {
                url: "file:///private".to_owned(),
                extensions: BTreeMap::new(),
            }),
            output: None,
            extensions: BTreeMap::new(),
        });
        assert_eq!(
            normalize_and_validate_state(&mut state).unwrap_err().code,
            StorageErrorCode::InvalidState
        );

        assert!(validate_windows_path(r"\\?\unc\server\share\folder", "/path").is_ok());
    }

    #[test]
    fn import_replace_is_atomic_and_same_digest_is_idempotent() {
        let test = TestDirectory::new();
        let store = test.open();
        let digest = "a".repeat(64);
        let provenance = ImportProvenanceV1 {
            source_format: "powerWorkspace.projects/1".to_owned(),
            source_sha256: digest.clone(),
            snapshot_file: format!("{digest}.projects.json"),
            imported_at_utc: "2026-01-01T00:00:00Z".to_owned(),
        };

        let first = store
            .replace_from_import(sample_state(), provenance.clone())
            .unwrap();
        assert_eq!(first.revision, 1);
        assert_eq!(
            first.import_provenance.as_ref().unwrap().source_sha256,
            digest
        );
        let before = fs::read(store.primary_path()).unwrap();
        let second = store
            .replace_from_import(sample_state(), provenance)
            .unwrap();
        assert_eq!(second.revision, 1);
        assert_eq!(fs::read(store.primary_path()).unwrap(), before);
    }

    #[test]
    fn phase3_recovery_quarantines_exact_corrupt_bytes() {
        let test = TestDirectory::new();
        let store = test.open();
        save(&store, 0, sample_state());
        let mut second = sample_state();
        second.projects[0].name = "Second generation".to_owned();
        save(&store, 1, second);
        let corrupt = b"truncated private state";
        fs::write(store.primary_path(), corrupt).unwrap();

        let recovered = store.recover("backup-1").unwrap();
        assert_eq!(recovered.revision, 2);
        assert_eq!(recovered.state.projects[0].name, "Example");
        assert_eq!(store.load().unwrap().mode, StorageMode::Ready);
        let quarantined = fs::read_dir(test.state_root().join("quarantine"))
            .unwrap()
            .map(|entry| fs::read(entry.unwrap().path()).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(quarantined, vec![corrupt.to_vec()]);
    }

    #[test]
    fn utc_formatter_matches_epoch_boundaries() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_454), (2026, 1, 1));
    }
}
