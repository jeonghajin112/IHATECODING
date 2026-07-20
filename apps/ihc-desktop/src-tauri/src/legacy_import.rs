//! Phase 3B lossless import of an explicitly selected, detached legacy catalog copy.
//!
//! This module deliberately owns no production path discovery and never writes a
//! workspace state file. `workspace_store` supplies every denied path, calls the
//! two-phase inspect/commit API, then atomically commits the returned draft.

use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;
use uuid::Uuid;

pub(crate) const LEGACY_SOURCE_FORMAT: &str = "powerWorkspace.projects/1";
pub(crate) const MAX_LEGACY_SOURCE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_STABLE_READ_ATTEMPTS: usize = 3;
const MAX_JSON_DEPTH: usize = 64;
const MAX_JSON_VALUES: usize = 200_000;
const MAX_OBJECT_MEMBERS: usize = 4_096;
const MAX_TOTAL_STRING_BYTES: usize = 4 * 1024 * 1024;
const MAX_PROJECTS: usize = 256;
const MAX_PENDING_INSPECTIONS: usize = 64;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LegacyImportErrorCode {
    Busy,
    Io,
    InvalidSource,
    SourceChanged,
    TooLarge,
    PathDenied,
    RecoveryRequired,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LegacyImportError {
    pub(crate) code: LegacyImportErrorCode,
    pub(crate) message: String,
    pub(crate) retryable: bool,
    pub(crate) json_pointer: Option<String>,
}

impl LegacyImportError {
    fn new(code: LegacyImportErrorCode, message: &'static str, retryable: bool) -> Self {
        Self {
            code,
            message: message.to_owned(),
            retryable,
            json_pointer: None,
        }
    }

    pub(crate) fn io() -> Self {
        Self::new(
            LegacyImportErrorCode::Io,
            "The detached catalog copy could not be read safely.",
            true,
        )
    }

    pub(crate) fn invalid(message: &'static str) -> Self {
        Self::new(LegacyImportErrorCode::InvalidSource, message, false)
    }

    pub(crate) fn changed() -> Self {
        Self::new(
            LegacyImportErrorCode::SourceChanged,
            "The detached catalog copy changed during import.",
            true,
        )
    }

    fn denied() -> Self {
        Self::new(
            LegacyImportErrorCode::PathDenied,
            "The selected file is not an allowed detached catalog copy.",
            false,
        )
    }

    pub(crate) fn phase3_preview_recovery_required() -> Self {
        Self::new(
            LegacyImportErrorCode::RecoveryRequired,
            "The isolated Phase 3 preview catalog requires explicit recovery before upgrade.",
            false,
        )
    }
}

impl fmt::Display for LegacyImportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for LegacyImportError {}

pub(crate) type LegacyImportResult<T> = Result<T, LegacyImportError>;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportDiagnostic {
    pub(crate) code: String,
    pub(crate) json_pointer: String,
}

impl ImportDiagnostic {
    fn new(code: &'static str, pointer: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            json_pointer: pointer.into(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InspectLegacyCatalogRequest {
    pub(crate) source_path: String,
    pub(crate) source_is_detached_copy: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LegacyInspection {
    pub(crate) inspect_token: String,
    pub(crate) source_format: String,
    pub(crate) source_sha256: String,
    pub(crate) byte_length: u64,
    pub(crate) project_count: usize,
    pub(crate) terminal_count: usize,
    pub(crate) recoverable_warnings: Vec<ImportDiagnostic>,
    pub(crate) blocking_errors: Vec<ImportDiagnostic>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LegacyImportMode {
    ReplacePreview,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommitLegacyCatalogRequest {
    pub(crate) inspect_token: String,
    pub(crate) source_path: String,
    pub(crate) source_sha256: String,
    pub(crate) mode: LegacyImportMode,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LegacyWorkspaceDraft {
    pub(crate) selected_project_id: Option<String>,
    pub(crate) projects: Vec<LegacyProjectDraft>,
    pub(crate) tabs: Vec<LegacyTabDraft>,
    pub(crate) active_tab_id: Option<String>,
    pub(crate) legacy_extensions: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LegacyProjectDraft {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) folder_path: String,
    pub(crate) terminals: Vec<LegacyTerminalDraft>,
    pub(crate) pane_width_ratios: BTreeMap<String, Vec<f64>>,
    pub(crate) legacy_extensions: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LegacyTerminalDraft {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) start_directory: String,
    pub(crate) codex_thread_id: Option<String>,
    pub(crate) grok_session_id: Option<String>,
    pub(crate) created_at_utc: Option<String>,
    pub(crate) completion_pending: bool,
    pub(crate) resume_blocked: bool,
    pub(crate) legacy_extensions: Map<String, Value>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LegacyTabKind {
    Empty,
    Project,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LegacyTabDraft {
    pub(crate) id: String,
    pub(crate) kind: LegacyTabKind,
    pub(crate) title: String,
    pub(crate) project_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparedLegacyImport {
    pub(crate) source_format: String,
    pub(crate) source_sha256: String,
    pub(crate) byte_length: u64,
    pub(crate) snapshot_file: String,
    pub(crate) snapshot_already_present: bool,
    pub(crate) draft: LegacyWorkspaceDraft,
    pub(crate) recoverable_warnings: Vec<ImportDiagnostic>,
}

/// A validated, exact-byte snapshot of the application-owned Phase 3 preview
/// catalog. The retained read handle denies write/delete sharing on Windows so
/// the source cannot be replaced while the canonical commit is in flight.
pub(crate) struct Phase3PreviewCatalogSource {
    snapshot: SourceSnapshot,
    read_guard: File,
    pub(crate) project_count: usize,
    pub(crate) terminal_count: usize,
    pub(crate) draft: LegacyWorkspaceDraft,
}

impl Phase3PreviewCatalogSource {
    pub(crate) fn source_sha256(&self) -> &str {
        &self.snapshot.sha256
    }

    pub(crate) fn bytes(&self) -> &[u8] {
        &self.snapshot.bytes
    }

    pub(crate) fn verify_unchanged(&self, path: &Path) -> LegacyImportResult<()> {
        let after = source_stamp(&self.read_guard)?;
        let canonical_after = fs::canonicalize(path).map_err(|_| LegacyImportError::changed())?;
        let path_file = open_read_only(path).map_err(|_| LegacyImportError::changed())?;
        let path_identity = file_identity(&path_file).map_err(|_| LegacyImportError::changed())?;
        let mut reader = self
            .read_guard
            .try_clone()
            .map_err(|_| LegacyImportError::io())?;
        reader
            .seek(SeekFrom::Start(0))
            .map_err(|_| LegacyImportError::io())?;
        let mut bytes = Vec::with_capacity(self.snapshot.bytes.len());
        reader
            .take(MAX_LEGACY_SOURCE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| LegacyImportError::io())?;
        if after != self.snapshot.stamp
            || canonical_after != self.snapshot.canonical_path
            || path_identity != self.snapshot.stamp.identity
            || bytes != self.snapshot.bytes
            || sha256_hex(&bytes) != self.snapshot.sha256
        {
            return Err(LegacyImportError::changed());
        }
        Ok(())
    }
}

#[cfg(test)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Phase3PreviewSourceFingerprint(SourceStamp);

#[cfg(test)]
pub(crate) fn phase3_preview_source_fingerprint(
    path: &Path,
) -> LegacyImportResult<Phase3PreviewSourceFingerprint> {
    let file = open_read_only(path).map_err(|_| LegacyImportError::io())?;
    source_stamp(&file).map(Phase3PreviewSourceFingerprint)
}

pub(crate) fn read_phase3_preview_catalog_source(
    path: &Path,
) -> LegacyImportResult<Phase3PreviewCatalogSource> {
    require_absolute(path)?;
    let snapshot = read_stable_source(path)?;
    let read_guard = open_phase3_preview_read_guard(path).map_err(|_| LegacyImportError::io())?;
    if source_stamp(&read_guard)? != snapshot.stamp
        || fs::canonicalize(path).map_err(|_| LegacyImportError::changed())?
            != snapshot.canonical_path
    {
        return Err(LegacyImportError::changed());
    }

    let analysis = analyze_phase3_preview_catalog(&snapshot.bytes, &snapshot.sha256)?;
    if !analysis.blocking_errors.is_empty() {
        return Err(LegacyImportError::invalid(
            "The isolated Phase 3 preview catalog is invalid and cannot be upgraded.",
        ));
    }
    let draft = analysis.draft.ok_or_else(|| {
        LegacyImportError::invalid("The isolated Phase 3 preview catalog could not be converted.")
    })?;
    Ok(Phase3PreviewCatalogSource {
        snapshot,
        read_guard,
        project_count: analysis.project_count,
        terminal_count: analysis.terminal_count,
        draft,
    })
}

#[derive(Clone, Debug)]
pub(crate) struct LegacyImportPolicy {
    preview_root: PathBuf,
    production_roots: Vec<PathBuf>,
    production_catalogs: Vec<PathBuf>,
    agent_session_roots: Vec<PathBuf>,
    additional_protected_files: Vec<PathBuf>,
}

impl LegacyImportPolicy {
    pub(crate) fn new(preview_root: PathBuf) -> LegacyImportResult<Self> {
        require_absolute(&preview_root)?;
        Ok(Self {
            preview_root,
            production_roots: Vec::new(),
            production_catalogs: Vec::new(),
            agent_session_roots: Vec::new(),
            additional_protected_files: Vec::new(),
        })
    }

    pub(crate) fn with_production_roots(mut self, roots: Vec<PathBuf>) -> LegacyImportResult<Self> {
        require_all_absolute(&roots)?;
        self.production_roots = roots;
        Ok(self)
    }

    pub(crate) fn with_production_catalogs(
        mut self,
        catalogs: Vec<PathBuf>,
    ) -> LegacyImportResult<Self> {
        require_all_absolute(&catalogs)?;
        self.production_catalogs = catalogs;
        Ok(self)
    }

    pub(crate) fn with_agent_session_roots(
        mut self,
        roots: Vec<PathBuf>,
    ) -> LegacyImportResult<Self> {
        require_all_absolute(&roots)?;
        self.agent_session_roots = roots;
        Ok(self)
    }

    pub(crate) fn with_additional_protected_files(
        mut self,
        files: Vec<PathBuf>,
    ) -> LegacyImportResult<Self> {
        require_all_absolute(&files)?;
        self.additional_protected_files = files;
        Ok(self)
    }

    pub(crate) fn preview_root(&self) -> &Path {
        &self.preview_root
    }
}

#[derive(Default)]
struct ImportState {
    pending: HashMap<String, InspectBinding>,
    committed: HashMap<String, PreparedLegacyImport>,
}

#[derive(Clone)]
struct InspectBinding {
    canonical_source: PathBuf,
    stamp: SourceStamp,
    source_sha256: String,
}

pub(crate) struct LegacyImportService {
    policy: LegacyImportPolicy,
    operation_lock: Mutex<()>,
    state: Mutex<ImportState>,
}

impl LegacyImportService {
    pub(crate) fn new(policy: LegacyImportPolicy) -> LegacyImportResult<Self> {
        validate_policy(&policy)?;
        Ok(Self {
            policy,
            operation_lock: Mutex::new(()),
            state: Mutex::new(ImportState::default()),
        })
    }

    pub(crate) fn inspect_detached_copy(
        &self,
        request: InspectLegacyCatalogRequest,
    ) -> LegacyImportResult<LegacyInspection> {
        if !request.source_is_detached_copy {
            return Err(LegacyImportError::denied());
        }
        let _operation = self
            .operation_lock
            .lock()
            .map_err(|_| LegacyImportError::io())?;
        let source_path = PathBuf::from(request.source_path);
        let snapshot = read_policy_checked_source(&self.policy, &source_path)?;
        let analysis = analyze_legacy_catalog(&snapshot.bytes, &snapshot.sha256)?;

        let token = Uuid::new_v4().to_string();
        let mut state = self.state.lock().map_err(|_| LegacyImportError::io())?;
        if state.pending.len() >= MAX_PENDING_INSPECTIONS {
            return Err(LegacyImportError::new(
                LegacyImportErrorCode::Busy,
                "Too many legacy import inspections are pending.",
                true,
            ));
        }
        state.pending.insert(
            token.clone(),
            InspectBinding {
                canonical_source: snapshot.canonical_path,
                stamp: snapshot.stamp,
                source_sha256: snapshot.sha256.clone(),
            },
        );

        Ok(LegacyInspection {
            inspect_token: token,
            source_format: LEGACY_SOURCE_FORMAT.to_owned(),
            source_sha256: snapshot.sha256,
            byte_length: snapshot.bytes.len() as u64,
            project_count: analysis.project_count,
            terminal_count: analysis.terminal_count,
            recoverable_warnings: analysis.warnings,
            blocking_errors: analysis.blocking_errors,
        })
    }

    pub(crate) fn commit_detached_copy(
        &self,
        request: CommitLegacyCatalogRequest,
    ) -> LegacyImportResult<PreparedLegacyImport> {
        let _operation = self
            .operation_lock
            .lock()
            .map_err(|_| LegacyImportError::io())?;
        if let Some(committed) = self
            .state
            .lock()
            .map_err(|_| LegacyImportError::io())?
            .committed
            .get(&request.inspect_token)
            .cloned()
        {
            return Ok(committed);
        }

        let binding = self
            .state
            .lock()
            .map_err(|_| LegacyImportError::io())?
            .pending
            .get(&request.inspect_token)
            .cloned()
            .ok_or_else(|| LegacyImportError::invalid("The import inspection token is invalid."))?;

        if request.mode != LegacyImportMode::ReplacePreview
            || !is_lower_hex_sha256(&request.source_sha256)
            || request.source_sha256 != binding.source_sha256
        {
            return Err(LegacyImportError::invalid(
                "The import request does not match its inspection.",
            ));
        }

        let source_path = PathBuf::from(&request.source_path);
        let snapshot = read_policy_checked_source(&self.policy, &source_path)?;
        if !paths_equal(&snapshot.canonical_path, &binding.canonical_source)
            || snapshot.stamp != binding.stamp
            || snapshot.sha256 != binding.source_sha256
        {
            return Err(LegacyImportError::changed());
        }

        let analysis = analyze_legacy_catalog(&snapshot.bytes, &snapshot.sha256)?;
        if !analysis.blocking_errors.is_empty() {
            return Err(LegacyImportError::invalid(
                "The detached catalog copy contains blocking validation errors.",
            ));
        }
        let draft = analysis.draft.ok_or_else(|| {
            LegacyImportError::invalid("The detached catalog copy could not be imported.")
        })?;

        let (snapshot_file, snapshot_already_present) =
            ensure_exact_snapshot(&self.policy, &snapshot)?;

        // Verify the source once more after writing the preview-owned snapshot.
        let after = read_policy_checked_source(&self.policy, &source_path)?;
        if after.stamp != binding.stamp
            || after.sha256 != binding.source_sha256
            || after.bytes != snapshot.bytes
        {
            if !snapshot_already_present {
                remove_created_snapshot(&self.policy, &snapshot_file);
            }
            return Err(LegacyImportError::changed());
        }

        let prepared = PreparedLegacyImport {
            source_format: LEGACY_SOURCE_FORMAT.to_owned(),
            source_sha256: snapshot.sha256,
            byte_length: snapshot.bytes.len() as u64,
            snapshot_file,
            snapshot_already_present,
            draft,
            recoverable_warnings: analysis.warnings,
        };

        let mut state = self.state.lock().map_err(|_| LegacyImportError::io())?;
        state.pending.remove(&request.inspect_token);
        state
            .committed
            .insert(request.inspect_token, prepared.clone());
        Ok(prepared)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SourceSnapshot {
    canonical_path: PathBuf,
    stamp: SourceStamp,
    bytes: Vec<u8>,
    sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SourceStamp {
    identity: FileIdentity,
    hard_link_count: u64,
    byte_length: u64,
    modified: Option<SystemTime>,
    platform_attributes: u64,
    acl_sha256: String,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
enum FileIdentity {
    #[cfg(windows)]
    Windows { volume_serial: u32, file_index: u64 },
    #[cfg(unix)]
    Unix { device: u64, inode: u64 },
    #[cfg(not(any(windows, unix)))]
    Unsupported,
}

fn require_absolute(path: &Path) -> LegacyImportResult<()> {
    if !path.is_absolute() {
        return Err(LegacyImportError::denied());
    }
    Ok(())
}

fn require_all_absolute(paths: &[PathBuf]) -> LegacyImportResult<()> {
    for path in paths {
        require_absolute(path)?;
    }
    Ok(())
}

fn validate_policy(policy: &LegacyImportPolicy) -> LegacyImportResult<()> {
    require_absolute(&policy.preview_root)?;
    require_all_absolute(&policy.production_roots)?;
    require_all_absolute(&policy.production_catalogs)?;
    require_all_absolute(&policy.agent_session_roots)?;
    require_all_absolute(&policy.additional_protected_files)?;

    let preview = resolve_for_policy(&policy.preview_root);
    for blocked_root in policy
        .production_roots
        .iter()
        .chain(policy.agent_session_roots.iter())
    {
        let blocked = resolve_for_policy(blocked_root);
        if path_is_within(&preview, &blocked) || path_is_within(&blocked, &preview) {
            return Err(LegacyImportError::denied());
        }
    }
    for catalog in &policy.production_catalogs {
        let catalog = resolve_for_policy(catalog);
        if path_is_within(&catalog, &preview) {
            return Err(LegacyImportError::denied());
        }
    }
    Ok(())
}

fn read_policy_checked_source(
    policy: &LegacyImportPolicy,
    source_path: &Path,
) -> LegacyImportResult<SourceSnapshot> {
    require_absolute(source_path)?;
    preflight_source_policy(policy, source_path)?;
    let snapshot = read_stable_source(source_path)?;
    validate_source_policy(policy, &snapshot)?;
    Ok(snapshot)
}

fn preflight_source_policy(
    policy: &LegacyImportPolicy,
    source_path: &Path,
) -> LegacyImportResult<()> {
    let canonical_source = fs::canonicalize(source_path).map_err(|_| LegacyImportError::io())?;
    validate_source_canonical_path(policy, &canonical_source)?;
    let source = open_read_only(source_path).map_err(|_| LegacyImportError::io())?;
    let identity = file_identity(&source)?;
    validate_source_identity(policy, &identity)
}

fn validate_source_policy(
    policy: &LegacyImportPolicy,
    snapshot: &SourceSnapshot,
) -> LegacyImportResult<()> {
    validate_source_canonical_path(policy, &snapshot.canonical_path)?;
    validate_source_identity(policy, &snapshot.stamp.identity)
}

fn validate_source_canonical_path(
    policy: &LegacyImportPolicy,
    source: &Path,
) -> LegacyImportResult<()> {
    let preview = resolve_for_policy(&policy.preview_root);
    if path_is_within(source, &preview) {
        return Err(LegacyImportError::denied());
    }

    for blocked_root in policy
        .production_roots
        .iter()
        .chain(policy.agent_session_roots.iter())
    {
        if path_is_within(source, &resolve_for_policy(blocked_root)) {
            return Err(LegacyImportError::denied());
        }
    }

    for protected in protected_file_paths(policy) {
        if paths_equal(source, &resolve_for_policy(&protected)) {
            return Err(LegacyImportError::denied());
        }
    }
    Ok(())
}

fn validate_source_identity(
    policy: &LegacyImportPolicy,
    source_identity: &FileIdentity,
) -> LegacyImportResult<()> {
    for protected in protected_file_paths(policy) {
        match open_read_only(&protected) {
            Ok(file) => {
                let identity = file_identity(&file).map_err(|_| LegacyImportError::denied())?;
                if &identity == source_identity {
                    return Err(LegacyImportError::denied());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(LegacyImportError::denied()),
        }
    }
    Ok(())
}

fn protected_file_paths(policy: &LegacyImportPolicy) -> Vec<PathBuf> {
    let mut paths = vec![
        policy.preview_root.join("workspace-v1.json"),
        policy.preview_root.join("workspace-v1.json.bak.1"),
        policy.preview_root.join("workspace-v1.json.bak.2"),
        policy.preview_root.join("workspace-v1.json.bak.3"),
        policy.preview_root.join("write.lock"),
    ];
    paths.extend(policy.production_catalogs.iter().cloned());
    paths.extend(policy.additional_protected_files.iter().cloned());
    paths
}

fn open_read_only(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().read(true).open(path)
}

#[cfg(windows)]
fn open_phase3_preview_read_guard(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;

    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(path)
}

#[cfg(not(windows))]
fn open_phase3_preview_read_guard(path: &Path) -> std::io::Result<File> {
    open_read_only(path)
}

fn read_stable_source(path: &Path) -> LegacyImportResult<SourceSnapshot> {
    read_stable_source_with_hook(path, |_attempt, _path| Ok(()))
}

fn read_stable_source_with_hook<F>(
    path: &Path,
    mut after_read: F,
) -> LegacyImportResult<SourceSnapshot>
where
    F: FnMut(usize, &Path) -> LegacyImportResult<()>,
{
    let mut observed_change = false;
    for attempt in 0..MAX_STABLE_READ_ATTEMPTS {
        let canonical_before = fs::canonicalize(path).map_err(|_| LegacyImportError::io())?;
        let mut file = open_read_only(path).map_err(|_| LegacyImportError::io())?;
        let before = source_stamp(&file)?;
        if before.byte_length > MAX_LEGACY_SOURCE_BYTES {
            return Err(LegacyImportError::new(
                LegacyImportErrorCode::TooLarge,
                "The detached catalog copy exceeds the import size limit.",
                false,
            ));
        }

        let capacity = usize::try_from(before.byte_length)
            .unwrap_or(0)
            .min(MAX_LEGACY_SOURCE_BYTES as usize);
        let mut bytes = Vec::with_capacity(capacity);
        Read::by_ref(&mut file)
            .take(MAX_LEGACY_SOURCE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| LegacyImportError::io())?;
        if bytes.len() as u64 > MAX_LEGACY_SOURCE_BYTES {
            return Err(LegacyImportError::new(
                LegacyImportErrorCode::TooLarge,
                "The detached catalog copy exceeds the import size limit.",
                false,
            ));
        }

        after_read(attempt, path)?;
        let after = source_stamp(&file)?;
        let canonical_after = fs::canonicalize(path).map_err(|_| LegacyImportError::changed())?;
        let path_file = open_read_only(path).map_err(|_| LegacyImportError::changed())?;
        let path_identity = file_identity(&path_file).map_err(|_| LegacyImportError::changed())?;
        if before != after
            || before.byte_length != bytes.len() as u64
            || !paths_equal(&canonical_before, &canonical_after)
            || path_identity != before.identity
        {
            observed_change = true;
            continue;
        }

        let text = strip_utf8_bom(&bytes);
        std::str::from_utf8(text).map_err(|_| {
            LegacyImportError::invalid("The detached catalog copy is not valid UTF-8.")
        })?;
        let sha256 = sha256_hex(&bytes);
        return Ok(SourceSnapshot {
            canonical_path: canonical_after,
            stamp: before,
            bytes,
            sha256,
        });
    }

    if observed_change {
        Err(LegacyImportError::changed())
    } else {
        Err(LegacyImportError::io())
    }
}

fn strip_utf8_bom(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes)
}

fn source_stamp(file: &File) -> LegacyImportResult<SourceStamp> {
    let metadata = file.metadata().map_err(|_| LegacyImportError::io())?;
    if !metadata.is_file() {
        return Err(LegacyImportError::invalid(
            "The selected detached catalog copy is not a regular file.",
        ));
    }
    let hard_link_count = hard_link_count(file)?;
    if hard_link_count != 1 {
        return Err(LegacyImportError::denied());
    }
    let acl = security_descriptor(file)?;
    Ok(SourceStamp {
        identity: file_identity(file)?,
        hard_link_count,
        byte_length: metadata.len(),
        modified: metadata.modified().ok(),
        platform_attributes: platform_attributes(&metadata),
        acl_sha256: sha256_hex(&acl),
    })
}

#[cfg(windows)]
fn hard_link_count(file: &File) -> LegacyImportResult<u64> {
    use std::mem::MaybeUninit;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };

    let mut information = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) };
    if ok == 0 {
        return Err(LegacyImportError::io());
    }
    Ok(u64::from(
        unsafe { information.assume_init() }.nNumberOfLinks,
    ))
}

#[cfg(unix)]
fn hard_link_count(file: &File) -> LegacyImportResult<u64> {
    use std::os::unix::fs::MetadataExt;
    Ok(file
        .metadata()
        .map_err(|_| LegacyImportError::io())?
        .nlink())
}

#[cfg(not(any(windows, unix)))]
fn hard_link_count(_file: &File) -> LegacyImportResult<u64> {
    Ok(1)
}

#[cfg(windows)]
fn file_identity(file: &File) -> LegacyImportResult<FileIdentity> {
    use std::mem::MaybeUninit;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };

    let mut information = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) };
    if ok == 0 {
        return Err(LegacyImportError::io());
    }
    let information = unsafe { information.assume_init() };
    let file_index =
        (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow);
    Ok(FileIdentity::Windows {
        volume_serial: information.dwVolumeSerialNumber,
        file_index,
    })
}

#[cfg(unix)]
fn file_identity(file: &File) -> LegacyImportResult<FileIdentity> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata().map_err(|_| LegacyImportError::io())?;
    Ok(FileIdentity::Unix {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[cfg(not(any(windows, unix)))]
fn file_identity(_file: &File) -> LegacyImportResult<FileIdentity> {
    Ok(FileIdentity::Unsupported)
}

#[cfg(windows)]
fn security_descriptor(file: &File) -> LegacyImportResult<Vec<u8>> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, GetLastError};
    use windows_sys::Win32::Security::{
        DACL_SECURITY_INFORMATION, GROUP_SECURITY_INFORMATION, GetKernelObjectSecurity,
        OWNER_SECURITY_INFORMATION,
    };

    let requested =
        OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
    let mut needed = 0u32;
    let first = unsafe {
        GetKernelObjectSecurity(
            file.as_raw_handle(),
            requested,
            std::ptr::null_mut(),
            0,
            &mut needed,
        )
    };
    if first == 0 && unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
        return Err(LegacyImportError::io());
    }
    if needed == 0 {
        return Err(LegacyImportError::io());
    }
    let mut descriptor = vec![0u8; needed as usize];
    let ok = unsafe {
        GetKernelObjectSecurity(
            file.as_raw_handle(),
            requested,
            descriptor.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    };
    if ok == 0 {
        return Err(LegacyImportError::io());
    }
    descriptor.truncate(needed as usize);
    Ok(descriptor)
}

#[cfg(unix)]
fn security_descriptor(file: &File) -> LegacyImportResult<Vec<u8>> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata().map_err(|_| LegacyImportError::io())?;
    let mut bytes = Vec::with_capacity(12);
    bytes.extend_from_slice(&metadata.mode().to_le_bytes());
    bytes.extend_from_slice(&metadata.uid().to_le_bytes());
    bytes.extend_from_slice(&metadata.gid().to_le_bytes());
    Ok(bytes)
}

#[cfg(not(any(windows, unix)))]
fn security_descriptor(_file: &File) -> LegacyImportResult<Vec<u8>> {
    Ok(Vec::new())
}

#[cfg(windows)]
fn platform_attributes(metadata: &fs::Metadata) -> u64 {
    use std::os::windows::fs::MetadataExt;
    u64::from(metadata.file_attributes())
}

#[cfg(unix)]
fn platform_attributes(metadata: &fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    u64::from(metadata.mode())
}

#[cfg(not(any(windows, unix)))]
fn platform_attributes(_metadata: &fs::Metadata) -> u64 {
    0
}

fn resolve_for_policy(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| normalize_lexical(path))
}

fn normalize_lexical(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    normalized.push(component.as_os_str());
                }
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn path_is_within(candidate: &Path, root: &Path) -> bool {
    let candidate_components = comparable_components(candidate);
    let root_components = comparable_components(root);
    candidate_components.len() >= root_components.len()
        && candidate_components[..root_components.len()] == root_components
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    comparable_components(left) == comparable_components(right)
}

fn comparable_components(path: &Path) -> Vec<String> {
    path.components()
        .map(|component| {
            let text = component.as_os_str().to_string_lossy().into_owned();
            if cfg!(windows) {
                text.to_lowercase()
            } else {
                text
            }
        })
        .collect()
}

fn ensure_exact_snapshot(
    policy: &LegacyImportPolicy,
    source: &SourceSnapshot,
) -> LegacyImportResult<(String, bool)> {
    let imports = policy.preview_root.join("imports");
    fs::create_dir_all(&imports).map_err(|_| LegacyImportError::io())?;
    let canonical_preview =
        fs::canonicalize(&policy.preview_root).map_err(|_| LegacyImportError::io())?;
    let canonical_imports = fs::canonicalize(&imports).map_err(|_| LegacyImportError::io())?;
    if !path_is_within(&canonical_imports, &canonical_preview)
        || path_is_within(&source.canonical_path, &canonical_preview)
    {
        return Err(LegacyImportError::denied());
    }

    let file_name = format!("{}.projects.json", source.sha256);
    let destination = imports.join(&file_name);
    if destination
        .try_exists()
        .map_err(|_| LegacyImportError::io())?
    {
        validate_existing_snapshot(&destination, source)?;
        return Ok((file_name, true));
    }

    let temporary = imports.join(format!(".{}.{}.tmp", source.sha256, Uuid::new_v4()));
    let mut cleanup = TemporarySnapshot::new(temporary.clone());
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| LegacyImportError::io())?;
    file.write_all(&source.bytes)
        .map_err(|_| LegacyImportError::io())?;
    file.sync_all().map_err(|_| LegacyImportError::io())?;
    drop(file);

    match fs::rename(&temporary, &destination) {
        Ok(()) => cleanup.persist(),
        Err(_) if destination.try_exists().unwrap_or(false) => {
            validate_existing_snapshot(&destination, source)?;
            return Ok((file_name, true));
        }
        Err(_) => return Err(LegacyImportError::io()),
    }
    validate_existing_snapshot(&destination, source)?;
    Ok((file_name, false))
}

fn validate_existing_snapshot(path: &Path, source: &SourceSnapshot) -> LegacyImportResult<()> {
    let mut file = open_read_only(path).map_err(|_| LegacyImportError::io())?;
    if file_identity(&file)? == source.stamp.identity {
        return Err(LegacyImportError::denied());
    }
    let metadata = file.metadata().map_err(|_| LegacyImportError::io())?;
    if metadata.len() != source.bytes.len() as u64 || metadata.len() > MAX_LEGACY_SOURCE_BYTES {
        return Err(LegacyImportError::invalid(
            "The existing import snapshot does not match its source hash.",
        ));
    }
    let mut bytes = Vec::with_capacity(source.bytes.len());
    file.read_to_end(&mut bytes)
        .map_err(|_| LegacyImportError::io())?;
    if bytes != source.bytes || sha256_hex(&bytes) != source.sha256 {
        return Err(LegacyImportError::invalid(
            "The existing import snapshot does not match its source hash.",
        ));
    }
    Ok(())
}

fn remove_created_snapshot(policy: &LegacyImportPolicy, file_name: &str) {
    if !file_name.ends_with(".projects.json") || file_name.contains('/') || file_name.contains('\\')
    {
        return;
    }
    let path = policy.preview_root.join("imports").join(file_name);
    let _ = fs::remove_file(path);
}

struct TemporarySnapshot {
    path: PathBuf,
    remove_on_drop: bool,
}

impl TemporarySnapshot {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            remove_on_drop: true,
        }
    }

    fn persist(&mut self) {
        self.remove_on_drop = false;
    }
}

impl Drop for TemporarySnapshot {
    fn drop(&mut self) {
        if self.remove_on_drop {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[derive(Clone, Debug)]
enum UniqueJson {
    Null,
    Bool(bool),
    Number(Number),
    String(String),
    Array(Vec<UniqueJson>),
    Object(Vec<(String, UniqueJson)>),
}

struct UniqueJsonSeed {
    depth: usize,
}

impl<'de> DeserializeSeed<'de> for UniqueJsonSeed {
    type Value = UniqueJson;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        if self.depth > MAX_JSON_DEPTH {
            return Err(de::Error::custom("JSON nesting exceeds the import limit"));
        }
        deserializer.deserialize_any(UniqueJsonVisitor { depth: self.depth })
    }
}

struct UniqueJsonVisitor {
    depth: usize,
}

impl<'de> Visitor<'de> for UniqueJsonVisitor {
    type Value = UniqueJson;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a bounded JSON value")
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(UniqueJson::Null)
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(UniqueJson::Null)
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(UniqueJson::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
        Ok(UniqueJson::Number(Number::from(value)))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(UniqueJson::Number(Number::from(value)))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Number::from_f64(value)
            .map(UniqueJson::Number)
            .ok_or_else(|| E::custom("non-finite JSON number"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
        Ok(UniqueJson::String(value.to_owned()))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(UniqueJson::String(value))
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element_seed(UniqueJsonSeed {
            depth: self.depth + 1,
        })? {
            values.push(value);
        }
        Ok(UniqueJson::Array(values))
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut values = Vec::new();
        let mut keys = HashSet::new();
        while let Some(key) = map.next_key::<String>()? {
            if !keys.insert(key.clone()) {
                return Err(de::Error::custom("duplicate JSON member"));
            }
            if values.len() >= MAX_OBJECT_MEMBERS {
                return Err(de::Error::custom("JSON object member limit exceeded"));
            }
            let value = map.next_value_seed(UniqueJsonSeed {
                depth: self.depth + 1,
            })?;
            values.push((key, value));
        }
        Ok(UniqueJson::Object(values))
    }
}

impl UniqueJson {
    fn into_value(self) -> Value {
        match self {
            Self::Null => Value::Null,
            Self::Bool(value) => Value::Bool(value),
            Self::Number(value) => Value::Number(value),
            Self::String(value) => Value::String(value),
            Self::Array(values) => {
                Value::Array(values.into_iter().map(UniqueJson::into_value).collect())
            }
            Self::Object(values) => Value::Object(
                values
                    .into_iter()
                    .map(|(key, value)| (key, value.into_value()))
                    .collect(),
            ),
        }
    }
}

#[derive(Default)]
struct JsonBounds {
    values: usize,
    string_bytes: usize,
}

fn parse_unique_bounded_json(bytes: &[u8]) -> LegacyImportResult<Value> {
    let mut deserializer = serde_json::Deserializer::from_slice(strip_utf8_bom(bytes));
    let unique = UniqueJsonSeed { depth: 0 }
        .deserialize(&mut deserializer)
        .map_err(|_| {
            LegacyImportError::invalid(
                "The detached catalog copy is not valid duplicate-free JSON.",
            )
        })?;
    deserializer.end().map_err(|_| {
        LegacyImportError::invalid("The detached catalog copy contains trailing JSON data.")
    })?;
    let value = unique.into_value();
    let mut bounds = JsonBounds::default();
    validate_json_bounds(&value, 0, &mut bounds)?;
    Ok(value)
}

fn validate_json_bounds(
    value: &Value,
    depth: usize,
    bounds: &mut JsonBounds,
) -> LegacyImportResult<()> {
    if depth > MAX_JSON_DEPTH {
        return Err(LegacyImportError::invalid(
            "The detached catalog copy exceeds the JSON nesting limit.",
        ));
    }
    bounds.values = bounds.values.saturating_add(1);
    if bounds.values > MAX_JSON_VALUES {
        return Err(LegacyImportError::invalid(
            "The detached catalog copy contains too many JSON values.",
        ));
    }
    match value {
        Value::String(text) => {
            bounds.string_bytes = bounds.string_bytes.saturating_add(text.len());
        }
        Value::Array(values) => {
            for value in values {
                validate_json_bounds(value, depth + 1, bounds)?;
            }
        }
        Value::Object(values) => {
            if values.len() > MAX_OBJECT_MEMBERS {
                return Err(LegacyImportError::invalid(
                    "A JSON object contains too many members.",
                ));
            }
            for (key, value) in values {
                bounds.string_bytes = bounds.string_bytes.saturating_add(key.len());
                validate_json_bounds(value, depth + 1, bounds)?;
            }
        }
        _ => {}
    }
    if bounds.string_bytes > MAX_TOTAL_STRING_BYTES {
        return Err(LegacyImportError::invalid(
            "The detached catalog copy contains too much string data.",
        ));
    }
    Ok(())
}

struct LegacyAnalysis {
    project_count: usize,
    terminal_count: usize,
    warnings: Vec<ImportDiagnostic>,
    blocking_errors: Vec<ImportDiagnostic>,
    draft: Option<LegacyWorkspaceDraft>,
}

type ResumeOwner = (usize, usize, String);
type ResumeOwners = HashMap<(u8, Uuid), Vec<ResumeOwner>>;

fn analyze_legacy_catalog(bytes: &[u8], source_sha256: &str) -> LegacyImportResult<LegacyAnalysis> {
    analyze_catalog(bytes, source_sha256, false)
}

fn analyze_phase3_preview_catalog(
    bytes: &[u8],
    source_sha256: &str,
) -> LegacyImportResult<LegacyAnalysis> {
    analyze_catalog(bytes, source_sha256, true)
}

fn analyze_catalog(
    bytes: &[u8],
    source_sha256: &str,
    allow_phase3_preview_schema: bool,
) -> LegacyImportResult<LegacyAnalysis> {
    let value = parse_unique_bounded_json(bytes)?;
    let Some(root) = value.as_object() else {
        return Ok(blocked_analysis("invalidLegacyShape", ""));
    };

    let mut warnings = Vec::new();
    let mut blocking = Vec::new();
    let phase3_schema_is_supported = match root.get("SchemaVersion") {
        None => true,
        Some(value) => allow_phase3_preview_schema && value.as_u64() == Some(1),
    };
    if root.contains_key("schemaVersion") || !phase3_schema_is_supported {
        blocking.push(ImportDiagnostic::new(
            "unsupportedVersion",
            "/schemaVersion",
        ));
    }
    let Some(raw_projects) = root.get("Projects").and_then(Value::as_array) else {
        blocking.push(ImportDiagnostic::new("missingProjects", "/Projects"));
        return Ok(LegacyAnalysis {
            project_count: 0,
            terminal_count: 0,
            warnings,
            blocking_errors: blocking,
            draft: None,
        });
    };
    let project_count = raw_projects.len();
    let terminal_count = raw_projects
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|project| project.get("Terminals"))
        .filter_map(Value::as_array)
        .map(Vec::len)
        .sum();
    if raw_projects.len() > MAX_PROJECTS {
        blocking.push(ImportDiagnostic::new("projectLimitExceeded", "/Projects"));
    }

    let mut projects = Vec::new();
    let mut project_ids = HashSet::new();
    let mut resume_owners = ResumeOwners::new();
    for (project_index, raw_project) in raw_projects.iter().take(MAX_PROJECTS).enumerate() {
        let pointer = format!("/Projects/{project_index}");
        let Some(project) = raw_project.as_object() else {
            blocking.push(ImportDiagnostic::new("invalidProject", pointer));
            continue;
        };
        let Some(id) = required_nonempty_string(project, "Id", &pointer, &mut blocking) else {
            continue;
        };
        if !project_ids.insert(id.clone()) {
            warnings.push(ImportDiagnostic::new("duplicateProjectId", pointer));
            continue;
        }
        let Some(name) = required_nonempty_string(project, "Name", &pointer, &mut blocking) else {
            continue;
        };
        let Some(folder_path) =
            required_nonempty_string(project, "FolderPath", &pointer, &mut blocking)
        else {
            continue;
        };

        let mut terminals = Vec::new();
        let mut terminal_ids = HashSet::new();
        let raw_terminals = match project.get("Terminals").and_then(Value::as_array) {
            Some(terminals) => terminals,
            None => {
                blocking.push(ImportDiagnostic::new(
                    "invalidTerminals",
                    format!("{pointer}/Terminals"),
                ));
                continue;
            }
        };
        for (terminal_index, raw_terminal) in raw_terminals.iter().enumerate() {
            let terminal_pointer = format!("{pointer}/Terminals/{terminal_index}");
            let Some(terminal) = raw_terminal.as_object() else {
                blocking.push(ImportDiagnostic::new("invalidTerminal", terminal_pointer));
                continue;
            };
            let Some(terminal_id) =
                required_nonempty_string(terminal, "Id", &terminal_pointer, &mut blocking)
            else {
                continue;
            };
            if !terminal_ids.insert(terminal_id.clone()) {
                warnings.push(ImportDiagnostic::new(
                    "duplicateTerminalId",
                    terminal_pointer,
                ));
                continue;
            }
            let Some(terminal_name) =
                required_nonempty_string(terminal, "Name", &terminal_pointer, &mut blocking)
            else {
                continue;
            };
            let Some(start_directory) = required_nonempty_string(
                terminal,
                "StartDirectory",
                &terminal_pointer,
                &mut blocking,
            ) else {
                continue;
            };
            let codex_thread_id =
                nullable_uuid_string(terminal, "CodexThreadId", &terminal_pointer, &mut blocking);
            let grok_session_id =
                nullable_uuid_string(terminal, "GrokSessionId", &terminal_pointer, &mut blocking);
            let created_at_utc =
                nullable_timestamp(terminal, "CreatedAtUtc", &terminal_pointer, &mut blocking);
            let completion_pending = match terminal.get("CompletionPending") {
                Some(Value::Bool(value)) => *value,
                _ => {
                    blocking.push(ImportDiagnostic::new(
                        "invalidCompletionPending",
                        format!("{terminal_pointer}/CompletionPending"),
                    ));
                    false
                }
            };
            let canonical_terminal_index = terminals.len();
            if let Some((uuid, _)) = codex_thread_id.as_ref() {
                resume_owners.entry((0, *uuid)).or_default().push((
                    projects.len(),
                    canonical_terminal_index,
                    format!("{terminal_pointer}/CodexThreadId"),
                ));
            }
            if let Some((uuid, _)) = grok_session_id.as_ref() {
                resume_owners.entry((1, *uuid)).or_default().push((
                    projects.len(),
                    canonical_terminal_index,
                    format!("{terminal_pointer}/GrokSessionId"),
                ));
            }
            terminals.push(LegacyTerminalDraft {
                id: terminal_id,
                name: terminal_name,
                start_directory,
                codex_thread_id: codex_thread_id.map(|(_, original)| original),
                grok_session_id: grok_session_id.map(|(_, original)| original),
                created_at_utc,
                completion_pending,
                resume_blocked: false,
                legacy_extensions: unknown_members(
                    terminal,
                    &[
                        "Id",
                        "Name",
                        "StartDirectory",
                        "CodexThreadId",
                        "GrokSessionId",
                        "CreatedAtUtc",
                        "CompletionPending",
                    ],
                ),
            });
        }

        let (pane_width_ratios, inactive_ratios) = parse_width_ratios(
            project.get("PaneWidthRatios"),
            &pointer,
            &mut warnings,
            &mut blocking,
        );
        let mut project_extensions = unknown_members(
            project,
            &["Id", "Name", "FolderPath", "Terminals", "PaneWidthRatios"],
        );
        if !inactive_ratios.is_empty() {
            project_extensions.insert(
                "inactivePaneWidthRatios".to_owned(),
                Value::Object(inactive_ratios),
            );
        }
        projects.push(LegacyProjectDraft {
            id,
            name,
            folder_path,
            terminals,
            pane_width_ratios,
            legacy_extensions: project_extensions,
        });
    }

    for ((kind, _), owners) in resume_owners {
        if owners.len() < 2 {
            continue;
        }
        let code = if kind == 0 {
            "duplicateCodexThreadId"
        } else {
            "duplicateGrokSessionId"
        };
        for (project_index, terminal_index, pointer) in owners {
            warnings.push(ImportDiagnostic::new(code, pointer));
            if let Some(terminal) = projects
                .get_mut(project_index)
                .and_then(|project| project.terminals.get_mut(terminal_index))
            {
                terminal.resume_blocked = true;
            }
        }
    }

    let requested_selection = match root.get("SelectedProjectId") {
        Some(Value::Null) => None,
        Some(Value::String(value)) => Some(value.clone()),
        _ => {
            blocking.push(ImportDiagnostic::new(
                "invalidSelectedProjectId",
                "/SelectedProjectId",
            ));
            None
        }
    };
    let selected_project_id = requested_selection.and_then(|selection| {
        if projects.iter().any(|project| project.id == selection) {
            Some(selection)
        } else {
            warnings.push(ImportDiagnostic::new(
                "danglingSelectedProjectId",
                "/SelectedProjectId",
            ));
            None
        }
    });
    let (tabs, active_tab_id) =
        deterministic_tabs(&projects, selected_project_id.as_deref(), source_sha256);
    let draft = if blocking.is_empty() {
        Some(LegacyWorkspaceDraft {
            selected_project_id,
            projects,
            tabs,
            active_tab_id,
            legacy_extensions: unknown_members(root, &["Projects", "SelectedProjectId"]),
        })
    } else {
        None
    };

    Ok(LegacyAnalysis {
        project_count,
        terminal_count,
        warnings,
        blocking_errors: blocking,
        draft,
    })
}

fn blocked_analysis(code: &'static str, pointer: &'static str) -> LegacyAnalysis {
    LegacyAnalysis {
        project_count: 0,
        terminal_count: 0,
        warnings: Vec::new(),
        blocking_errors: vec![ImportDiagnostic::new(code, pointer)],
        draft: None,
    }
}

fn required_nonempty_string(
    object: &Map<String, Value>,
    key: &'static str,
    parent_pointer: &str,
    blocking: &mut Vec<ImportDiagnostic>,
) -> Option<String> {
    match object.get(key) {
        Some(Value::String(value)) if !value.trim().is_empty() && value.len() <= 16 * 1024 => {
            Some(value.clone())
        }
        _ => {
            blocking.push(ImportDiagnostic::new(
                "invalidRequiredString",
                format!("{parent_pointer}/{key}"),
            ));
            None
        }
    }
}

fn nullable_uuid_string(
    object: &Map<String, Value>,
    key: &'static str,
    parent_pointer: &str,
    blocking: &mut Vec<ImportDiagnostic>,
) -> Option<(Uuid, String)> {
    match object.get(key) {
        Some(Value::Null) => None,
        Some(Value::String(value)) => match Uuid::parse_str(value) {
            Ok(uuid) => Some((uuid, value.clone())),
            Err(_) => {
                blocking.push(ImportDiagnostic::new(
                    "invalidResumeId",
                    format!("{parent_pointer}/{key}"),
                ));
                None
            }
        },
        _ => {
            blocking.push(ImportDiagnostic::new(
                "invalidResumeId",
                format!("{parent_pointer}/{key}"),
            ));
            None
        }
    }
}

fn nullable_timestamp(
    object: &Map<String, Value>,
    key: &'static str,
    parent_pointer: &str,
    blocking: &mut Vec<ImportDiagnostic>,
) -> Option<String> {
    match object.get(key) {
        Some(Value::Null) => None,
        Some(Value::String(value)) => match normalize_rfc3339_utc(value) {
            Some(normalized) => Some(normalized),
            None => {
                blocking.push(ImportDiagnostic::new(
                    "invalidTimestamp",
                    format!("{parent_pointer}/{key}"),
                ));
                None
            }
        },
        _ => {
            blocking.push(ImportDiagnostic::new(
                "invalidTimestamp",
                format!("{parent_pointer}/{key}"),
            ));
            None
        }
    }
}

fn unknown_members(object: &Map<String, Value>, known: &[&str]) -> Map<String, Value> {
    object
        .iter()
        .filter(|(key, _)| !known.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

fn parse_width_ratios(
    value: Option<&Value>,
    project_pointer: &str,
    warnings: &mut Vec<ImportDiagnostic>,
    blocking: &mut Vec<ImportDiagnostic>,
) -> (BTreeMap<String, Vec<f64>>, Map<String, Value>) {
    let Some(object) = value.and_then(Value::as_object) else {
        blocking.push(ImportDiagnostic::new(
            "invalidPaneWidthRatios",
            format!("{project_pointer}/PaneWidthRatios"),
        ));
        return (BTreeMap::new(), Map::new());
    };
    let mut active = BTreeMap::new();
    let mut inactive = Map::new();
    for (key, raw) in object {
        let valid = parse_layout_key(key).and_then(|columns| {
            let values = raw.as_array()?;
            if values.len() != columns {
                return None;
            }
            let mut numbers = Vec::with_capacity(values.len());
            for value in values {
                let number = value.as_f64()?;
                if !number.is_finite() || number <= 0.0 {
                    return None;
                }
                numbers.push(number);
            }
            let sum: f64 = numbers.iter().sum();
            if !sum.is_finite() || sum <= 0.0 {
                return None;
            }
            Some(numbers.into_iter().map(|number| number / sum).collect())
        });
        if let Some(normalized) = valid {
            active.insert(key.clone(), normalized);
        } else {
            inactive.insert(key.clone(), raw.clone());
            warnings.push(ImportDiagnostic::new(
                "inactivePaneWidthRatio",
                format!("{project_pointer}/PaneWidthRatios"),
            ));
        }
    }
    (active, inactive)
}

fn parse_layout_key(key: &str) -> Option<usize> {
    let (columns, rest) = key.split_once('x')?;
    let (rows, row_index) = rest.split_once(":row-")?;
    let columns = columns.parse::<usize>().ok()?;
    let rows = rows.parse::<usize>().ok()?;
    let row_index = row_index.parse::<usize>().ok()?;
    if (1..=5).contains(&columns) && (1..=4).contains(&rows) && row_index <= 3 && row_index < rows {
        Some(columns)
    } else {
        None
    }
}

fn deterministic_tabs(
    projects: &[LegacyProjectDraft],
    selected_project_id: Option<&str>,
    source_sha256: &str,
) -> (Vec<LegacyTabDraft>, Option<String>) {
    let hash_prefix = &source_sha256[..16];
    if let Some(selected) = selected_project_id
        && let Some((index, project)) = projects
            .iter()
            .enumerate()
            .find(|(_, project)| project.id == selected)
    {
        let id = format!("legacy-project-{hash_prefix}-{index}");
        return (
            vec![LegacyTabDraft {
                id: id.clone(),
                kind: LegacyTabKind::Project,
                title: project.name.clone(),
                project_id: Some(project.id.clone()),
            }],
            Some(id),
        );
    }
    let id = format!("legacy-empty-{hash_prefix}");
    (
        vec![LegacyTabDraft {
            id: id.clone(),
            kind: LegacyTabKind::Empty,
            title: "Workspace".to_owned(),
            project_id: None,
        }],
        Some(id),
    )
}

fn normalize_rfc3339_utc(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || !matches!(bytes.get(10), Some(b'T' | b't'))
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
    {
        return None;
    }

    let (time_end, offset_seconds) = if matches!(bytes.last(), Some(b'Z' | b'z')) {
        (bytes.len() - 1, 0i64)
    } else {
        if bytes.len() < 25 {
            return None;
        }
        let offset_start = bytes.len() - 6;
        let sign = match bytes[offset_start] {
            b'+' => 1i64,
            b'-' => -1i64,
            _ => return None,
        };
        if bytes[offset_start + 3] != b':' {
            return None;
        }
        let hours = parse_digits(&bytes[offset_start + 1..offset_start + 3])?;
        let minutes = parse_digits(&bytes[offset_start + 4..offset_start + 6])?;
        if hours > 23 || minutes > 59 {
            return None;
        }
        (offset_start, sign * i64::from(hours * 3_600 + minutes * 60))
    };
    if time_end < 19 {
        return None;
    }

    let year = i64::from(parse_digits(&bytes[0..4])?);
    let month = parse_digits(&bytes[5..7])?;
    let day = parse_digits(&bytes[8..10])?;
    let hour = parse_digits(&bytes[11..13])?;
    let minute = parse_digits(&bytes[14..16])?;
    let second = parse_digits(&bytes[17..19])?;
    if !(1..=12).contains(&month)
        || day == 0
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }

    let fraction = if time_end == 19 {
        String::new()
    } else {
        if bytes[19] != b'.' || time_end <= 20 || time_end - 20 > 9 {
            return None;
        }
        let digits = &bytes[20..time_end];
        if !digits.iter().all(u8::is_ascii_digit) {
            return None;
        }
        let text = std::str::from_utf8(digits).ok()?.trim_end_matches('0');
        if text.is_empty() {
            String::new()
        } else {
            format!(".{text}")
        }
    };

    let local_seconds = days_from_civil(year, month, day)
        .checked_mul(86_400)?
        .checked_add(i64::from(hour * 3_600 + minute * 60 + second))?;
    let utc_seconds = local_seconds.checked_sub(offset_seconds)?;
    let utc_days = utc_seconds.div_euclid(86_400);
    let seconds_of_day = utc_seconds.rem_euclid(86_400);
    let (utc_year, utc_month, utc_day) = civil_from_days(utc_days);
    if !(0..=9_999).contains(&utc_year) {
        return None;
    }
    let utc_hour = seconds_of_day / 3_600;
    let utc_minute = (seconds_of_day % 3_600) / 60;
    let utc_second = seconds_of_day % 60;
    Some(format!(
        "{utc_year:04}-{utc_month:02}-{utc_day:02}T{utc_hour:02}:{utc_minute:02}:{utc_second:02}{fraction}Z"
    ))
}

fn parse_digits(bytes: &[u8]) -> Option<u32> {
    if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    bytes.iter().try_fold(0u32, |value, digit| {
        value.checked_mul(10)?.checked_add(u32::from(*digit - b'0'))
    })
}

fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year.rem_euclid(4) == 0
            && (year.rem_euclid(100) != 0 || year.rem_euclid(400) == 0) =>
        {
            29
        }
        2 => 28,
        _ => 0,
    }
}

fn days_from_civil(mut year: i64, month: u32, day: u32) -> i64 {
    year -= i64::from(month <= 2);
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let adjusted_month = i64::from(month) + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * adjusted_month + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
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

fn is_lower_hex_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = sha256(bytes);
    let mut output = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    const INITIAL: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut state = INITIAL;
    let mut chunks = bytes.chunks_exact(64);
    for chunk in &mut chunks {
        compress_sha256(&mut state, chunk.try_into().expect("SHA-256 block length"));
    }
    let remainder = chunks.remainder();
    let mut tail = [0u8; 128];
    tail[..remainder.len()].copy_from_slice(remainder);
    tail[remainder.len()] = 0x80;
    let tail_length = if remainder.len() < 56 { 64 } else { 128 };
    let bit_length = (bytes.len() as u64).wrapping_mul(8).to_be_bytes();
    tail[tail_length - 8..tail_length].copy_from_slice(&bit_length);
    for block in tail[..tail_length].chunks_exact(64) {
        compress_sha256(
            &mut state,
            block.try_into().expect("SHA-256 tail block length"),
        );
    }
    let mut digest = [0u8; 32];
    for (index, word) in state.into_iter().enumerate() {
        digest[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    digest
}

fn compress_sha256(state: &mut [u32; 8], block: &[u8; 64]) {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut schedule = [0u32; 64];
    for (index, word) in block.chunks_exact(4).enumerate() {
        schedule[index] = u32::from_be_bytes(word.try_into().expect("SHA-256 word length"));
    }
    for index in 16..64 {
        let sigma0 = schedule[index - 15].rotate_right(7)
            ^ schedule[index - 15].rotate_right(18)
            ^ (schedule[index - 15] >> 3);
        let sigma1 = schedule[index - 2].rotate_right(17)
            ^ schedule[index - 2].rotate_right(19)
            ^ (schedule[index - 2] >> 10);
        schedule[index] = schedule[index - 16]
            .wrapping_add(sigma0)
            .wrapping_add(schedule[index - 7])
            .wrapping_add(sigma1);
    }

    let mut a = state[0];
    let mut b = state[1];
    let mut c = state[2];
    let mut d = state[3];
    let mut e = state[4];
    let mut f = state[5];
    let mut g = state[6];
    let mut h = state[7];
    for index in 0..64 {
        let big_sigma1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
        let choice = (e & f) ^ ((!e) & g);
        let temporary1 = h
            .wrapping_add(big_sigma1)
            .wrapping_add(choice)
            .wrapping_add(K[index])
            .wrapping_add(schedule[index]);
        let big_sigma0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
        let majority = (a & b) ^ (a & c) ^ (b & c);
        let temporary2 = big_sigma0.wrapping_add(majority);
        h = g;
        g = f;
        f = e;
        e = d.wrapping_add(temporary1);
        d = c;
        c = b;
        b = a;
        a = temporary1.wrapping_add(temporary2);
    }
    state[0] = state[0].wrapping_add(a);
    state[1] = state[1].wrapping_add(b);
    state[2] = state[2].wrapping_add(c);
    state[3] = state[3].wrapping_add(d);
    state[4] = state[4].wrapping_add(e);
    state[5] = state[5].wrapping_add(f);
    state[6] = state[6].wrapping_add(g);
    state[7] = state[7].wrapping_add(h);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::path::{Path, PathBuf};

    const SANITIZED_FIXTURE: &[u8] = include_bytes!("../../../../fixtures/projects-v1.json");

    struct TestDirectory {
        root: PathBuf,
    }

    impl TestDirectory {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("ihc-legacy-import-contract-{}", Uuid::new_v4()));
            fs::create_dir(&root).expect("create isolated contract directory");
            fs::write(root.join(".ihc-test-owned"), b"legacy-import-contract\n")
                .expect("mark isolated contract directory");
            Self { root }
        }

        fn path(&self, relative: &str) -> PathBuf {
            self.root.join(relative)
        }

        fn create_directory(&self, relative: &str) -> PathBuf {
            let path = self.path(relative);
            fs::create_dir_all(&path).expect("create isolated subdirectory");
            path
        }

        fn write(&self, relative: &str, bytes: &[u8]) -> PathBuf {
            let path = self.path(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("create isolated file parent");
            }
            fs::write(&path, bytes).expect("write sanitized test file");
            path
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let Some(file_name) = self.root.file_name().and_then(|name| name.to_str()) else {
                return;
            };
            if !file_name.starts_with("ihc-legacy-import-contract-")
                || !self.root.join(".ihc-test-owned").is_file()
            {
                return;
            }
            let Ok(metadata) = fs::symlink_metadata(&self.root) else {
                return;
            };
            if metadata.file_type().is_symlink() {
                return;
            }
            make_tree_writable(&self.root);
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn make_tree_writable(path: &Path) {
        let Ok(metadata) = fs::symlink_metadata(path) else {
            return;
        };
        if metadata.file_type().is_symlink() {
            return;
        }
        if metadata.is_dir()
            && let Ok(entries) = fs::read_dir(path)
        {
            for entry in entries.flatten() {
                make_tree_writable(&entry.path());
            }
        }
        let mut permissions = metadata.permissions();
        if permissions.readonly() {
            make_permissions_writable(&mut permissions);
            let _ = fs::set_permissions(path, permissions);
        }
    }

    #[cfg(windows)]
    fn make_permissions_writable(permissions: &mut fs::Permissions) {
        permissions.set_readonly(false);
    }

    #[cfg(unix)]
    fn make_permissions_writable(permissions: &mut fs::Permissions) {
        use std::os::unix::fs::PermissionsExt;
        permissions.set_mode(permissions.mode() | 0o200);
    }

    #[cfg(not(any(windows, unix)))]
    fn make_permissions_writable(_permissions: &mut fs::Permissions) {}

    struct TestLayout {
        service: LegacyImportService,
        preview: PathBuf,
        production_catalog: PathBuf,
        detached: PathBuf,
    }

    fn test_layout(directory: &TestDirectory, source: &[u8]) -> TestLayout {
        let preview = directory.create_directory("preview/state");
        let production = directory.create_directory("production");
        let production_catalog = directory.path("production/projects.json");
        let agent_sessions = directory.create_directory("agent-sessions");
        let detached = directory.write("detached/projects-copy.json", source);
        let policy = LegacyImportPolicy::new(preview.clone())
            .expect("preview policy")
            .with_production_roots(vec![production.clone()])
            .expect("production root policy")
            .with_production_catalogs(vec![production_catalog.clone()])
            .expect("production catalog policy")
            .with_agent_session_roots(vec![agent_sessions.clone()])
            .expect("agent root policy");
        let service = LegacyImportService::new(policy).expect("legacy import service");
        TestLayout {
            service,
            preview,
            production_catalog,
            detached,
        }
    }

    fn inspect(service: &LegacyImportService, source: &Path) -> LegacyInspection {
        service
            .inspect_detached_copy(InspectLegacyCatalogRequest {
                source_path: source.to_string_lossy().into_owned(),
                source_is_detached_copy: true,
            })
            .expect("inspect detached copy")
    }

    fn commit(
        service: &LegacyImportService,
        source: &Path,
        inspection: &LegacyInspection,
    ) -> PreparedLegacyImport {
        service
            .commit_detached_copy(CommitLegacyCatalogRequest {
                inspect_token: inspection.inspect_token.clone(),
                source_path: source.to_string_lossy().into_owned(),
                source_sha256: inspection.source_sha256.clone(),
                mode: LegacyImportMode::ReplacePreview,
            })
            .expect("commit detached copy")
    }

    fn terminal(
        id: &str,
        name: &str,
        start_directory: &str,
        codex_thread_id: Option<&str>,
        grok_session_id: Option<&str>,
        created_at_utc: Option<&str>,
        completion_pending: bool,
    ) -> Value {
        json!({
            "Id": id,
            "Name": name,
            "StartDirectory": start_directory,
            "CodexThreadId": codex_thread_id,
            "GrokSessionId": grok_session_id,
            "CreatedAtUtc": created_at_utc,
            "CompletionPending": completion_pending
        })
    }

    fn project(
        id: &str,
        name: &str,
        folder_path: &str,
        terminals: Vec<Value>,
        ratios: Value,
    ) -> Value {
        json!({
            "Id": id,
            "Name": name,
            "FolderPath": folder_path,
            "Terminals": terminals,
            "PaneWidthRatios": ratios
        })
    }

    fn catalog(projects: Vec<Value>, selected_project_id: Option<&str>) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "Projects": projects,
            "SelectedProjectId": selected_project_id
        }))
        .expect("serialize sanitized legacy catalog")
    }

    fn committed_fixture(bytes: &[u8]) -> (TestDirectory, PreparedLegacyImport) {
        let directory = TestDirectory::new();
        let layout = test_layout(&directory, bytes);
        let inspection = inspect(&layout.service, &layout.detached);
        assert!(inspection.blocking_errors.is_empty());
        let prepared = commit(&layout.service, &layout.detached, &inspection);
        (directory, prepared)
    }

    #[test]
    fn sha256_matches_published_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn phase3_legacy_fixture_matches_csharp_shape() {
        let directory = TestDirectory::new();
        let layout = test_layout(&directory, SANITIZED_FIXTURE);
        let inspection = inspect(&layout.service, &layout.detached);
        assert_eq!(inspection.source_format, LEGACY_SOURCE_FORMAT);
        assert_eq!(inspection.project_count, 1);
        assert_eq!(inspection.terminal_count, 1);
        assert!(inspection.blocking_errors.is_empty());
    }

    #[test]
    fn phase3_import_never_opens_source_for_write() {
        let directory = TestDirectory::new();
        let layout = test_layout(&directory, SANITIZED_FIXTURE);
        let mut permissions = fs::metadata(&layout.detached)
            .expect("source metadata")
            .permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&layout.detached, permissions).expect("make source read-only");
        let before = read_stable_source(&layout.detached).expect("source before import");
        let inspection = inspect(&layout.service, &layout.detached);
        let prepared = commit(&layout.service, &layout.detached, &inspection);
        let after = read_stable_source(&layout.detached).expect("source after import");
        assert_eq!(before, after);
        assert_eq!(prepared.source_sha256, before.sha256);
        assert!(
            fs::metadata(&layout.detached)
                .expect("source metadata after import")
                .permissions()
                .readonly()
        );
    }

    #[test]
    fn phase3_import_preserves_source_hash_metadata_and_acl() {
        let directory = TestDirectory::new();
        let layout = test_layout(&directory, SANITIZED_FIXTURE);
        let before = read_stable_source(&layout.detached).expect("source before import");
        let inspection = inspect(&layout.service, &layout.detached);
        let prepared = commit(&layout.service, &layout.detached, &inspection);
        let after = read_stable_source(&layout.detached).expect("source after import");
        assert_eq!(before.bytes, after.bytes);
        assert_eq!(before.sha256, after.sha256);
        assert_eq!(before.stamp, after.stamp);
        assert_eq!(prepared.source_sha256, before.sha256);
    }

    #[test]
    fn phase3_preview_path_cannot_alias_source() {
        let directory = TestDirectory::new();
        let layout = test_layout(&directory, SANITIZED_FIXTURE);

        let direct_preview = directory.write("preview/state/direct.json", SANITIZED_FIXTURE);
        let direct_error = layout
            .service
            .inspect_detached_copy(InspectLegacyCatalogRequest {
                source_path: direct_preview.to_string_lossy().into_owned(),
                source_is_detached_copy: true,
            })
            .expect_err("preview-owned source must be denied");
        assert_eq!(direct_error.code, LegacyImportErrorCode::PathDenied);

        let preview_catalog = directory.write("preview/state/workspace-v1.json", SANITIZED_FIXTURE);
        let preview_alias = directory.path("detached/preview-hardlink.json");
        fs::hard_link(&preview_catalog, &preview_alias).expect("create preview hard-link alias");
        let alias_error = layout
            .service
            .inspect_detached_copy(InspectLegacyCatalogRequest {
                source_path: preview_alias.to_string_lossy().into_owned(),
                source_is_detached_copy: true,
            })
            .expect_err("preview hard-link alias must be denied");
        assert_eq!(alias_error.code, LegacyImportErrorCode::PathDenied);

        fs::write(&layout.production_catalog, SANITIZED_FIXTURE)
            .expect("write fake production catalog");
        let production_alias = directory.path("detached/production-hardlink.json");
        fs::hard_link(&layout.production_catalog, &production_alias)
            .expect("create production hard-link alias");
        let production_error = layout
            .service
            .inspect_detached_copy(InspectLegacyCatalogRequest {
                source_path: production_alias.to_string_lossy().into_owned(),
                source_is_detached_copy: true,
            })
            .expect_err("production hard-link alias must be denied");
        assert_eq!(production_error.code, LegacyImportErrorCode::PathDenied);
    }

    #[test]
    fn phase3_same_source_hash_is_idempotent() {
        let directory = TestDirectory::new();
        let layout = test_layout(&directory, SANITIZED_FIXTURE);
        let first_inspection = inspect(&layout.service, &layout.detached);
        let first = commit(&layout.service, &layout.detached, &first_inspection);
        let second_inspection = inspect(&layout.service, &layout.detached);
        let second = commit(&layout.service, &layout.detached, &second_inspection);
        assert_eq!(first.draft, second.draft);
        assert_eq!(first.snapshot_file, second.snapshot_file);
        assert!(!first.snapshot_already_present);
        assert!(second.snapshot_already_present);
        let imports = layout.preview.join("imports");
        let files: Vec<_> = fs::read_dir(&imports)
            .expect("read imports")
            .map(|entry| entry.expect("import entry").path())
            .collect();
        assert_eq!(files.len(), 1);
        assert_eq!(
            fs::read(&files[0]).expect("read exact import"),
            SANITIZED_FIXTURE
        );

        let replay = commit(&layout.service, &layout.detached, &first_inspection);
        assert_eq!(replay, first);
    }

    #[test]
    fn phase3_import_does_not_touch_agent_sessions() {
        let directory = TestDirectory::new();
        let layout = test_layout(&directory, SANITIZED_FIXTURE);
        let sentinel = directory.write("agent-sessions/sentinel.bin", b"opaque-agent-sentinel");
        let before = read_stable_source(&sentinel).expect("agent sentinel before import");
        let inspection = inspect(&layout.service, &layout.detached);
        commit(&layout.service, &layout.detached, &inspection);
        let after = read_stable_source(&sentinel).expect("agent sentinel after import");
        assert_eq!(before, after);

        let blocked = directory.write("agent-sessions/not-a-catalog.bin", &[0xff, 0xfe]);
        let error = layout
            .service
            .inspect_detached_copy(InspectLegacyCatalogRequest {
                source_path: blocked.to_string_lossy().into_owned(),
                source_is_detached_copy: true,
            })
            .expect_err("agent session tree must be denied before content parsing");
        assert_eq!(error.code, LegacyImportErrorCode::PathDenied);
    }

    #[test]
    fn phase3_failed_import_leaves_no_committed_preview_state() {
        let directory = TestDirectory::new();
        let layout = test_layout(&directory, SANITIZED_FIXTURE);
        let inspection = inspect(&layout.service, &layout.detached);
        let mut changed = SANITIZED_FIXTURE.to_vec();
        changed.extend_from_slice(b" ");
        fs::write(&layout.detached, changed).expect("mutate detached copy after inspection");
        let error = layout
            .service
            .commit_detached_copy(CommitLegacyCatalogRequest {
                inspect_token: inspection.inspect_token,
                source_path: layout.detached.to_string_lossy().into_owned(),
                source_sha256: inspection.source_sha256,
                mode: LegacyImportMode::ReplacePreview,
            })
            .expect_err("changed source must not commit");
        assert_eq!(error.code, LegacyImportErrorCode::SourceChanged);
        assert!(!layout.preview.join("workspace-v1.json").exists());
        assert!(!layout.preview.join("imports").exists());
    }

    #[test]
    fn phase3_inspect_token_is_bound_to_the_exact_source_copy() {
        let directory = TestDirectory::new();
        let layout = test_layout(&directory, SANITIZED_FIXTURE);
        let other = directory.write("detached/other-copy.json", SANITIZED_FIXTURE);
        let inspection = inspect(&layout.service, &layout.detached);
        let error = layout
            .service
            .commit_detached_copy(CommitLegacyCatalogRequest {
                inspect_token: inspection.inspect_token,
                source_path: other.to_string_lossy().into_owned(),
                source_sha256: inspection.source_sha256,
                mode: LegacyImportMode::ReplacePreview,
            })
            .expect_err("token must not authorize another byte-identical path");
        assert_eq!(error.code, LegacyImportErrorCode::SourceChanged);
        assert!(!layout.preview.join("imports").exists());
    }

    #[test]
    fn phase3_stable_read_has_a_bounded_retry_and_reports_change() {
        let directory = TestDirectory::new();
        let source = directory.write("detached/changing.json", SANITIZED_FIXTURE);
        let mut mutation = 0usize;
        let error = read_stable_source_with_hook(&source, |_attempt, path| {
            mutation += 1;
            let bytes = vec![b' '; SANITIZED_FIXTURE.len() + mutation];
            fs::write(path, bytes).map_err(|_| LegacyImportError::io())?;
            Ok(())
        })
        .expect_err("continually changing source must fail after bounded retries");
        assert_eq!(mutation, MAX_STABLE_READ_ATTEMPTS);
        assert_eq!(error.code, LegacyImportErrorCode::SourceChanged);
    }

    #[test]
    fn phase3_rejects_duplicate_json_members() {
        let directory = TestDirectory::new();
        let duplicate = br#"{"Projects":[],"Projects":[],"SelectedProjectId":null}"#;
        let layout = test_layout(&directory, duplicate);
        let error = layout
            .service
            .inspect_detached_copy(InspectLegacyCatalogRequest {
                source_path: layout.detached.to_string_lossy().into_owned(),
                source_is_detached_copy: true,
            })
            .expect_err("duplicate members must be rejected");
        assert_eq!(error.code, LegacyImportErrorCode::InvalidSource);
    }

    #[test]
    fn phase3_rejects_oversized_catalog_before_parse() {
        let directory = TestDirectory::new();
        let source = directory.path("detached/oversized.json");
        fs::create_dir_all(source.parent().expect("oversized parent"))
            .expect("create oversized parent");
        let file = File::create(&source).expect("create oversized source");
        file.set_len(MAX_LEGACY_SOURCE_BYTES + 1)
            .expect("size oversized source");
        drop(file);
        let layout = test_layout(&directory, SANITIZED_FIXTURE);
        let error = layout
            .service
            .inspect_detached_copy(InspectLegacyCatalogRequest {
                source_path: source.to_string_lossy().into_owned(),
                source_is_detached_copy: true,
            })
            .expect_err("oversized source must be rejected before parse");
        assert_eq!(error.code, LegacyImportErrorCode::TooLarge);
    }

    #[test]
    fn phase3_rejects_invalid_utf8_and_trailing_json() {
        let directory = TestDirectory::new();
        let layout = test_layout(&directory, SANITIZED_FIXTURE);
        let invalid_utf8 = directory.write("detached/invalid-utf8.json", &[0xff]);
        let utf8_error = layout
            .service
            .inspect_detached_copy(InspectLegacyCatalogRequest {
                source_path: invalid_utf8.to_string_lossy().into_owned(),
                source_is_detached_copy: true,
            })
            .expect_err("invalid UTF-8 must be rejected");
        assert_eq!(utf8_error.code, LegacyImportErrorCode::InvalidSource);

        let trailing = directory.write(
            "detached/trailing.json",
            br#"{"Projects":[],"SelectedProjectId":null} false"#,
        );
        let trailing_error = layout
            .service
            .inspect_detached_copy(InspectLegacyCatalogRequest {
                source_path: trailing.to_string_lossy().into_owned(),
                source_is_detached_copy: true,
            })
            .expect_err("trailing JSON must be rejected");
        assert_eq!(trailing_error.code, LegacyImportErrorCode::InvalidSource);
    }

    #[test]
    fn phase3_exact_bom_source_bytes_are_hashed_and_snapshotted() {
        let mut bytes = vec![0xef, 0xbb, 0xbf];
        bytes.extend_from_slice(SANITIZED_FIXTURE);
        let directory = TestDirectory::new();
        let layout = test_layout(&directory, &bytes);
        let inspection = inspect(&layout.service, &layout.detached);
        assert_eq!(inspection.source_sha256, sha256_hex(&bytes));
        let prepared = commit(&layout.service, &layout.detached, &inspection);
        assert_eq!(
            fs::read(layout.preview.join("imports").join(prepared.snapshot_file))
                .expect("read BOM snapshot"),
            bytes
        );
    }

    #[test]
    fn phase3_import_preserves_project_and_terminal_order() {
        let first_terminals = vec![
            terminal("t-1", "FIRST", r"C:\Fixture\One", None, None, None, false),
            terminal("t-2", "SECOND", r"C:\Fixture\One", None, None, None, false),
        ];
        let second_terminals = vec![
            terminal("t-3", "THIRD", r"C:\Fixture\Two", None, None, None, false),
            terminal("t-4", "FOURTH", r"C:\Fixture\Two", None, None, None, false),
        ];
        let bytes = catalog(
            vec![
                project(
                    "project-2",
                    "Second visual project",
                    r"C:\Fixture\One",
                    first_terminals,
                    json!({"2x1:row-0": [1, 1]}),
                ),
                project(
                    "project-1",
                    "First lexical project",
                    r"C:\Fixture\Two",
                    second_terminals,
                    json!({"2x1:row-0": [1, 1]}),
                ),
            ],
            Some("project-2"),
        );
        let (_directory, prepared) = committed_fixture(&bytes);
        assert_eq!(
            prepared
                .draft
                .projects
                .iter()
                .map(|project| project.id.as_str())
                .collect::<Vec<_>>(),
            ["project-2", "project-1"]
        );
        assert_eq!(
            prepared.draft.projects[0]
                .terminals
                .iter()
                .map(|terminal| terminal.id.as_str())
                .collect::<Vec<_>>(),
            ["t-1", "t-2"]
        );
        assert_eq!(
            prepared.draft.projects[1]
                .terminals
                .iter()
                .map(|terminal| terminal.id.as_str())
                .collect::<Vec<_>>(),
            ["t-3", "t-4"]
        );
    }

    #[test]
    fn phase3_import_preserves_terminals_after_the_twentieth_entry() {
        let terminals = (0..21)
            .map(|index| {
                terminal(
                    &format!("terminal-{index}"),
                    &format!("Terminal {index}"),
                    r"C:\Fixture\Many",
                    None,
                    None,
                    None,
                    false,
                )
            })
            .collect();
        let bytes = catalog(
            vec![project(
                "many-terminals",
                "Many terminals",
                r"C:\Fixture\Many",
                terminals,
                json!({"1x1:row-0": [1]}),
            )],
            Some("many-terminals"),
        );
        let directory = TestDirectory::new();
        let layout = test_layout(&directory, &bytes);
        let inspection = inspect(&layout.service, &layout.detached);
        assert!(inspection.blocking_errors.is_empty());
        assert_eq!(inspection.terminal_count, 21);
        assert!(
            inspection
                .recoverable_warnings
                .iter()
                .all(|warning| warning.code != "terminalOverflow")
        );

        let prepared = commit(&layout.service, &layout.detached, &inspection);
        assert_eq!(prepared.draft.projects[0].terminals.len(), 21);
        assert_eq!(prepared.draft.projects[0].terminals[20].id, "terminal-20");
    }

    #[test]
    fn phase3_import_preserves_names_paths_timestamps_and_alerts() {
        let codex = "33333333-3333-3333-3333-333333333333";
        let grok = "44444444-4444-4444-4444-444444444444";
        let bytes = catalog(
            vec![project(
                "project-preserve",
                "  한글 Project  ",
                r"Z:\Offline Fixture\한글",
                vec![terminal(
                    "terminal-preserve",
                    "  MAIN 한글  ",
                    r"Z:\Offline Fixture\한글\Missing",
                    Some(codex),
                    Some(grok),
                    Some("2026-07-17T09:10:11.1200+09:00"),
                    true,
                )],
                json!({"1x1:row-0": [5]}),
            )],
            Some("project-preserve"),
        );
        let (_directory, prepared) = committed_fixture(&bytes);
        let project = &prepared.draft.projects[0];
        let terminal = &project.terminals[0];
        assert_eq!(project.name, "  한글 Project  ");
        assert_eq!(project.folder_path, r"Z:\Offline Fixture\한글");
        assert_eq!(terminal.name, "  MAIN 한글  ");
        assert_eq!(terminal.start_directory, r"Z:\Offline Fixture\한글\Missing");
        assert_eq!(terminal.codex_thread_id.as_deref(), Some(codex));
        assert_eq!(terminal.grok_session_id.as_deref(), Some(grok));
        assert_eq!(
            terminal.created_at_utc.as_deref(),
            Some("2026-07-17T00:10:11.12Z")
        );
        assert!(terminal.completion_pending);
    }

    #[test]
    fn phase3_import_preserves_and_normalizes_valid_width_ratios() {
        let bytes = catalog(
            vec![project(
                "ratio-project",
                "Ratios",
                r"C:\Fixture\Ratios",
                Vec::new(),
                json!({
                    "2x1:row-0": [2, 6],
                    "3x2:row-1": [1, 1, 2],
                    "future-layout": [9, 8, 7],
                    "2x1:row-9": [1, 1]
                }),
            )],
            Some("ratio-project"),
        );
        let (_directory, prepared) = committed_fixture(&bytes);
        let project = &prepared.draft.projects[0];
        assert_eq!(project.pane_width_ratios["2x1:row-0"], [0.25, 0.75]);
        assert_eq!(project.pane_width_ratios["3x2:row-1"], [0.25, 0.25, 0.5]);
        let inactive = project.legacy_extensions["inactivePaneWidthRatios"]
            .as_object()
            .expect("inactive ratios object");
        assert_eq!(inactive["future-layout"], json!([9, 8, 7]));
        assert_eq!(inactive["2x1:row-9"], json!([1, 1]));
    }

    #[test]
    fn phase3_invalid_selected_project_becomes_unselected() {
        let bytes = catalog(
            vec![project(
                "existing-project",
                "Existing",
                r"C:\Fixture\Existing",
                Vec::new(),
                json!({"1x1:row-0": [1]}),
            )],
            Some("missing-project"),
        );
        let (_directory, prepared) = committed_fixture(&bytes);
        assert_eq!(prepared.draft.selected_project_id, None);
        assert_eq!(prepared.draft.tabs.len(), 1);
        assert_eq!(prepared.draft.tabs[0].kind, LegacyTabKind::Empty);
        assert_eq!(prepared.draft.tabs[0].project_id, None);
        assert!(
            prepared
                .recoverable_warnings
                .iter()
                .any(|warning| warning.code == "danglingSelectedProjectId")
        );
    }

    #[test]
    fn phase3_duplicate_resume_ids_are_flagged_not_started() {
        let duplicate_codex = "55555555-5555-5555-5555-555555555555";
        let duplicate_grok = "66666666-6666-6666-6666-666666666666";
        let bytes = catalog(
            vec![project(
                "duplicate-resume-project",
                "Resume conflict",
                r"C:\Fixture\Conflict",
                vec![
                    terminal(
                        "owner-a",
                        "A",
                        r"C:\Fixture\Conflict",
                        Some(duplicate_codex),
                        Some(duplicate_grok),
                        None,
                        false,
                    ),
                    terminal(
                        "owner-b",
                        "B",
                        r"C:\Fixture\Conflict",
                        Some(duplicate_codex),
                        Some(duplicate_grok),
                        None,
                        false,
                    ),
                ],
                json!({"2x1:row-0": [1, 1]}),
            )],
            Some("duplicate-resume-project"),
        );
        let (_directory, prepared) = committed_fixture(&bytes);
        let terminals = &prepared.draft.projects[0].terminals;
        assert!(terminals.iter().all(|terminal| terminal.resume_blocked));
        assert!(
            terminals
                .iter()
                .all(|terminal| terminal.codex_thread_id.as_deref() == Some(duplicate_codex))
        );
        assert!(
            terminals
                .iter()
                .all(|terminal| terminal.grok_session_id.as_deref() == Some(duplicate_grok))
        );
        assert_eq!(
            prepared
                .recoverable_warnings
                .iter()
                .filter(|warning| warning.code == "duplicateCodexThreadId")
                .count(),
            2
        );
        assert_eq!(
            prepared
                .recoverable_warnings
                .iter()
                .filter(|warning| warning.code == "duplicateGrokSessionId")
                .count(),
            2
        );
    }

    #[test]
    fn phase3_initial_tabs_are_deterministic() {
        let selected_bytes = catalog(
            vec![project(
                "selected-project",
                "Selected project",
                r"C:\Fixture\Selected",
                Vec::new(),
                json!({"1x1:row-0": [1]}),
            )],
            Some("selected-project"),
        );
        let hash = sha256_hex(&selected_bytes);
        let first = analyze_legacy_catalog(&selected_bytes, &hash)
            .expect("first deterministic analysis")
            .draft
            .expect("first deterministic draft");
        let second = analyze_legacy_catalog(&selected_bytes, &hash)
            .expect("second deterministic analysis")
            .draft
            .expect("second deterministic draft");
        assert_eq!(first.tabs, second.tabs);
        assert_eq!(first.active_tab_id, second.active_tab_id);
        assert_eq!(first.tabs.len(), 1);
        assert_eq!(first.tabs[0].kind, LegacyTabKind::Project);
        assert_eq!(
            first.tabs[0].project_id.as_deref(),
            Some("selected-project")
        );

        let empty_bytes = catalog(Vec::new(), None);
        let empty_hash = sha256_hex(&empty_bytes);
        let empty = analyze_legacy_catalog(&empty_bytes, &empty_hash)
            .expect("empty deterministic analysis")
            .draft
            .expect("empty deterministic draft");
        assert_eq!(empty.tabs.len(), 1);
        assert_eq!(empty.tabs[0].kind, LegacyTabKind::Empty);
        assert_eq!(empty.tabs[0].project_id, None);
    }

    #[test]
    fn phase3_unknown_fields_survive_lossless_import() {
        let mut value: Value = serde_json::from_slice(SANITIZED_FIXTURE)
            .expect("parse sanitized fixture for extension test");
        value["UnknownTopLevelInteger"] = json!(9_007_199_254_740_993u64);
        value["Projects"][0]["UnknownProjectObject"] = json!({"sentinel": [1, 2, 3]});
        value["Projects"][0]["Terminals"][0]["UnknownTerminalFlag"] = json!(true);
        let bytes = serde_json::to_vec(&value).expect("serialize extension fixture");
        let (directory, prepared) = committed_fixture(&bytes);
        assert_eq!(
            prepared.draft.legacy_extensions["UnknownTopLevelInteger"],
            json!(9_007_199_254_740_993u64)
        );
        assert_eq!(
            prepared.draft.projects[0].legacy_extensions["UnknownProjectObject"],
            json!({"sentinel": [1, 2, 3]})
        );
        assert_eq!(
            prepared.draft.projects[0].terminals[0].legacy_extensions["UnknownTerminalFlag"],
            json!(true)
        );
        let snapshot = directory
            .path("preview/state/imports")
            .join(prepared.snapshot_file);
        assert_eq!(fs::read(snapshot).expect("read lossless snapshot"), bytes);
    }

    #[test]
    fn phase3_first_duplicate_ids_win_and_raw_snapshot_retains_all() {
        let first_terminal = terminal(
            "same-terminal",
            "First terminal",
            r"C:\Fixture\Duplicate",
            None,
            None,
            None,
            false,
        );
        let second_terminal = terminal(
            "same-terminal",
            "Second terminal",
            r"C:\Fixture\Duplicate",
            None,
            None,
            None,
            false,
        );
        let first_project = project(
            "same-project",
            "First project",
            r"C:\Fixture\Duplicate",
            vec![first_terminal, second_terminal],
            json!({"1x1:row-0": [1]}),
        );
        let second_project = project(
            "same-project",
            "Second project",
            r"C:\Fixture\Duplicate2",
            Vec::new(),
            json!({"1x1:row-0": [1]}),
        );
        let bytes = catalog(vec![first_project, second_project], Some("same-project"));
        let (directory, prepared) = committed_fixture(&bytes);
        assert_eq!(prepared.draft.projects.len(), 1);
        assert_eq!(prepared.draft.projects[0].name, "First project");
        assert_eq!(prepared.draft.projects[0].terminals.len(), 1);
        assert_eq!(
            prepared.draft.projects[0].terminals[0].name,
            "First terminal"
        );
        assert!(
            prepared
                .recoverable_warnings
                .iter()
                .any(|warning| warning.code == "duplicateProjectId")
        );
        assert!(
            prepared
                .recoverable_warnings
                .iter()
                .any(|warning| warning.code == "duplicateTerminalId")
        );
        let snapshot = directory
            .path("preview/state/imports")
            .join(prepared.snapshot_file);
        assert_eq!(fs::read(snapshot).expect("read duplicate snapshot"), bytes);
    }
}
