//! Phase 6 read-only staging for the production C# project catalog.
//!
//! This module deliberately stops at an exact, detached staging copy. The
//! existing `LegacyImportService` remains responsible for inspecting and
//! committing that copy. No catalog data or production path is returned to the
//! caller.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::env;
use std::ffi::OsString;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

pub(crate) const MAX_PRODUCTION_CATALOG_BYTES: u64 = 8 * 1024 * 1024;
const PRODUCTION_CATALOG_ENV: &str = "POWERWORKSPACE_PROJECTS_PATH";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProductionImportErrorCode {
    MissingSource,
    InvalidSource,
    TooLarge,
    SourceChanged,
    PathDenied,
    CorruptStaging,
    Io,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProductionImportError {
    pub(crate) code: ProductionImportErrorCode,
    pub(crate) message: String,
    pub(crate) retryable: bool,
}

impl ProductionImportError {
    fn new(code: ProductionImportErrorCode, message: &'static str, retryable: bool) -> Self {
        Self {
            code,
            message: message.to_owned(),
            retryable,
        }
    }

    fn missing() -> Self {
        Self::new(
            ProductionImportErrorCode::MissingSource,
            "The production project catalog was not found.",
            false,
        )
    }

    fn invalid() -> Self {
        Self::new(
            ProductionImportErrorCode::InvalidSource,
            "The production project catalog is not valid JSON.",
            false,
        )
    }

    fn too_large() -> Self {
        Self::new(
            ProductionImportErrorCode::TooLarge,
            "The production project catalog exceeds the staging size limit.",
            false,
        )
    }

    fn changed() -> Self {
        Self::new(
            ProductionImportErrorCode::SourceChanged,
            "The production project catalog changed while it was being staged.",
            true,
        )
    }

    fn denied() -> Self {
        Self::new(
            ProductionImportErrorCode::PathDenied,
            "The production project catalog cannot be staged at the configured location.",
            false,
        )
    }

    fn corrupt_staging() -> Self {
        Self::new(
            ProductionImportErrorCode::CorruptStaging,
            "The existing detached staging copy does not match its content hash.",
            false,
        )
    }

    fn io() -> Self {
        Self::new(
            ProductionImportErrorCode::Io,
            "The production project catalog could not be staged safely.",
            true,
        )
    }
}

impl fmt::Display for ProductionImportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ProductionImportError {}

pub(crate) type ProductionImportResult<T> = Result<T, ProductionImportError>;

/// A content-free handoff for `LegacyImportService::inspect_detached_copy`.
///
/// This descriptor is not a trust token. The consumer must let
/// `LegacyImportService` reopen the path and verify the returned inspection SHA
/// against `sha256`; commit then performs its normal source identity recheck.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProductionStagingDescriptor {
    pub(crate) path: String,
    pub(crate) sha256: String,
    pub(crate) byte_length: u64,
}

/// Defines the only location this service may write and the roots it must stay
/// disjoint from. The discovered C# catalog parent and standard Codex/Grok
/// session roots are added automatically for every staging operation.
#[derive(Clone, Debug)]
pub(crate) struct ProductionImportPolicy {
    staging_root: PathBuf,
    canonical_roots: Vec<PathBuf>,
    production_roots: Vec<PathBuf>,
    agent_session_roots: Vec<PathBuf>,
}

impl ProductionImportPolicy {
    pub(crate) fn new(
        staging_root: PathBuf,
        canonical_roots: Vec<PathBuf>,
    ) -> ProductionImportResult<Self> {
        if canonical_roots.is_empty()
            || !staging_root.is_absolute()
            || canonical_roots.iter().any(|path| !path.is_absolute())
        {
            return Err(ProductionImportError::denied());
        }
        let policy = Self {
            staging_root,
            canonical_roots,
            production_roots: Vec::new(),
            agent_session_roots: Vec::new(),
        };
        validate_static_policy(&policy)?;
        Ok(policy)
    }

    #[cfg(test)]
    pub(crate) fn with_production_roots(
        mut self,
        roots: Vec<PathBuf>,
    ) -> ProductionImportResult<Self> {
        require_absolute_paths(&roots)?;
        self.production_roots = roots;
        validate_static_policy(&self)?;
        Ok(self)
    }

    #[cfg(test)]
    pub(crate) fn with_agent_session_roots(
        mut self,
        roots: Vec<PathBuf>,
    ) -> ProductionImportResult<Self> {
        require_absolute_paths(&roots)?;
        self.agent_session_roots = roots;
        validate_static_policy(&self)?;
        Ok(self)
    }

    #[cfg(test)]
    pub(crate) fn staging_root(&self) -> &Path {
        &self.staging_root
    }
}

pub(crate) struct ProductionImportService {
    policy: ProductionImportPolicy,
    operation_lock: Mutex<()>,
}

impl ProductionImportService {
    pub(crate) fn new(policy: ProductionImportPolicy) -> ProductionImportResult<Self> {
        validate_static_policy(&policy)?;
        Ok(Self {
            policy,
            operation_lock: Mutex::new(()),
        })
    }

    /// Discovers the live C# catalog, stages an exact read-only detached copy,
    /// and returns only the copy path, digest, and byte length.
    pub(crate) fn stage_discovered_catalog(
        &self,
    ) -> ProductionImportResult<ProductionStagingDescriptor> {
        self.stage_with_environment_and_hook(&ProcessEnvironment::capture(), || Ok(()))
    }

    fn stage_with_environment_and_hook<F>(
        &self,
        environment: &ProcessEnvironment,
        after_copy: F,
    ) -> ProductionImportResult<ProductionStagingDescriptor>
    where
        F: FnOnce() -> ProductionImportResult<()>,
    {
        let _operation = self
            .operation_lock
            .lock()
            .map_err(|_| ProductionImportError::io())?;
        stage_catalog(&self.policy, environment, after_copy)
    }
}

#[derive(Clone, Debug, Default)]
struct ProcessEnvironment {
    configured_catalog: Option<OsString>,
    local_app_data: Option<OsString>,
    roaming_app_data: Option<OsString>,
    user_profile: Option<OsString>,
    home: Option<OsString>,
    codex_home: Option<OsString>,
    grok_home: Option<OsString>,
    current_directory: Option<PathBuf>,
}

impl ProcessEnvironment {
    fn capture() -> Self {
        Self {
            configured_catalog: env::var_os(PRODUCTION_CATALOG_ENV),
            local_app_data: env::var_os("LOCALAPPDATA"),
            roaming_app_data: env::var_os("APPDATA"),
            user_profile: env::var_os("USERPROFILE"),
            home: env::var_os("HOME"),
            codex_home: env::var_os("CODEX_HOME"),
            grok_home: env::var_os("GROK_HOME"),
            current_directory: env::current_dir().ok(),
        }
    }

    fn discover_catalog(&self) -> ProductionImportResult<PathBuf> {
        if let Some(configured) = self
            .configured_catalog
            .as_ref()
            .filter(|configured| !configured.is_empty())
        {
            let configured = PathBuf::from(configured);
            let path = if configured.is_absolute() {
                configured
            } else {
                self.current_directory
                    .as_ref()
                    .ok_or_else(ProductionImportError::denied)?
                    .join(configured)
            };
            return absolute_normalized_path(&path);
        }

        let local_app_data = self
            .absolute_environment_path(self.local_app_data.as_ref())
            .ok_or_else(ProductionImportError::missing)?;
        Ok(local_app_data.join("PowerWorkspace").join("projects.json"))
    }

    fn protected_production_roots(&self, source: &Path) -> Vec<PathBuf> {
        let mut roots = Vec::new();
        if let Some(parent) = source.parent() {
            roots.push(parent.to_path_buf());
        }
        if let Some(local_app_data) = self.absolute_environment_path(self.local_app_data.as_ref()) {
            roots.push(local_app_data.join("PowerWorkspace"));
        }
        roots
    }

    fn protected_session_roots(&self) -> ProductionImportResult<Vec<PathBuf>> {
        let mut roots = Vec::new();
        if let Some(codex_home) = self.provider_environment_path(self.codex_home.as_ref())? {
            roots.push(codex_home);
        }
        if let Some(grok_home) = self.provider_environment_path(self.grok_home.as_ref())? {
            roots.push(grok_home);
        }
        if let Some(local_app_data) = self.absolute_environment_path(self.local_app_data.as_ref()) {
            roots.push(local_app_data.join("Grok"));
            roots.push(local_app_data.join("xAI").join("Grok"));
        }
        if let Some(roaming_app_data) =
            self.absolute_environment_path(self.roaming_app_data.as_ref())
        {
            roots.push(roaming_app_data.join("Grok"));
            roots.push(roaming_app_data.join("xAI").join("Grok"));
        }
        if let Some(user_profile) = self.absolute_environment_path(self.user_profile.as_ref()) {
            roots.push(user_profile.join(".codex").join("sessions"));
            roots.push(user_profile.join(".grok"));
            roots.push(user_profile.join(".xai"));
            roots.push(user_profile.join(".config").join("grok"));
        }
        if let Some(home) = self.absolute_environment_path(self.home.as_ref()) {
            roots.push(home.join(".codex").join("sessions"));
            roots.push(home.join(".grok"));
            roots.push(home.join(".xai"));
            roots.push(home.join(".config").join("grok"));
        }
        Ok(roots)
    }

    fn absolute_environment_path(&self, value: Option<&OsString>) -> Option<PathBuf> {
        value
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
    }

    fn provider_environment_path(
        &self,
        value: Option<&OsString>,
    ) -> ProductionImportResult<Option<PathBuf>> {
        let Some(value) = value.filter(|value| !value.is_empty()) else {
            return Ok(None);
        };
        let path = PathBuf::from(value);
        if !path.is_absolute() {
            return Err(ProductionImportError::denied());
        }
        Ok(Some(path))
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
}

struct DirectoryComponentGuard {
    requested_path: PathBuf,
    canonical_path: PathBuf,
    identity: FileIdentity,
    file: File,
}

struct StagingDirectoryGuard {
    canonical_path: PathBuf,
    components: Vec<DirectoryComponentGuard>,
}

impl StagingDirectoryGuard {
    fn path(&self) -> &Path {
        &self.canonical_path
    }

    fn verify(&self) -> ProductionImportResult<()> {
        for component in &self.components {
            let metadata = fs::symlink_metadata(&component.requested_path)
                .map_err(|_| ProductionImportError::changed())?;
            if !metadata.is_dir()
                || metadata.file_type().is_symlink()
                || has_reparse_attribute(&metadata)
            {
                return Err(ProductionImportError::changed());
            }
            let held_identity =
                file_identity(&component.file).map_err(|_| ProductionImportError::changed())?;
            require_plain_directory_handle(&component.file)
                .map_err(|_| ProductionImportError::changed())?;
            let reopened = open_directory_guard(&component.requested_path)
                .map_err(|_| ProductionImportError::changed())?;
            require_plain_directory_handle(&reopened)
                .map_err(|_| ProductionImportError::changed())?;
            let reopened_identity =
                file_identity(&reopened).map_err(|_| ProductionImportError::changed())?;
            let held_canonical =
                canonical_path_from_handle(&component.file, &component.requested_path)
                    .map_err(|_| ProductionImportError::changed())?;
            let canonical = canonical_path_from_handle(&reopened, &component.requested_path)
                .map_err(|_| ProductionImportError::changed())?;
            if held_identity != component.identity
                || reopened_identity != component.identity
                || !paths_equal(&held_canonical, &component.canonical_path)
                || !paths_equal(&canonical, &component.canonical_path)
            {
                return Err(ProductionImportError::changed());
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum FileIdentity {
    #[cfg(windows)]
    Windows {
        volume_serial: u64,
        file_id: [u8; 16],
    },
    #[cfg(unix)]
    Unix { device: u64, inode: u64 },
    #[cfg(not(any(windows, unix)))]
    Unsupported,
}

fn stage_catalog<F>(
    policy: &ProductionImportPolicy,
    environment: &ProcessEnvironment,
    after_copy: F,
) -> ProductionImportResult<ProductionStagingDescriptor>
where
    F: FnOnce() -> ProductionImportResult<()>,
{
    let source_path = environment.discover_catalog()?;
    let source = read_source_snapshot(&source_path)?;

    let mut protected_roots = policy.canonical_roots.clone();
    protected_roots.extend(policy.production_roots.iter().cloned());
    protected_roots.extend(policy.agent_session_roots.iter().cloned());
    protected_roots.extend(environment.protected_production_roots(&source_path));
    let environment_session_roots = environment.protected_session_roots()?;
    protected_roots.extend(environment_session_roots.iter().cloned());

    let mut forbidden_source_roots = policy.canonical_roots.clone();
    forbidden_source_roots.extend(policy.agent_session_roots.iter().cloned());
    forbidden_source_roots.extend(environment_session_roots);
    forbidden_source_roots.push(policy.staging_root.clone());
    validate_source_location(&source.canonical_path, &forbidden_source_roots)?;

    let staging_root = prepare_staging_root(&policy.staging_root, &protected_roots)?;
    let destination = staging_root
        .path()
        .join(format!("{}.projects.json", source.sha256));
    let mut staged = stage_exact_copy(&destination, &staging_root, &protected_roots, &source)?;

    after_copy().inspect_err(|_| staged.cleanup_if_created())?;

    let source_after = read_source_snapshot(&source_path).map_err(|_| {
        staged.cleanup_if_created();
        ProductionImportError::changed()
    })?;
    if source_after != source {
        staged.cleanup_if_created();
        return Err(ProductionImportError::changed());
    }

    staging_root.verify()?;
    let final_validation =
        validate_staged_copy(&staged.path, &staging_root, &protected_roots, &source)?;
    staged.replace_validation(final_validation);
    staging_root.verify()?;
    staged.verify_retained_identity()?;
    let canonical_destination = staged.canonical_path().to_path_buf();
    let path = canonical_destination
        .to_str()
        .ok_or_else(ProductionImportError::denied)?
        .to_owned();
    staged.persist();

    Ok(ProductionStagingDescriptor {
        path,
        sha256: source.sha256,
        byte_length: source.bytes.len() as u64,
    })
}

fn validate_source_location(
    source: &Path,
    forbidden_roots: &[PathBuf],
) -> ProductionImportResult<()> {
    for forbidden in forbidden_roots {
        let forbidden = resolve_with_existing_ancestor(forbidden)?;
        if path_is_within(source, &forbidden) {
            return Err(ProductionImportError::denied());
        }
    }
    Ok(())
}

fn read_source_snapshot(path: &Path) -> ProductionImportResult<SourceSnapshot> {
    let path_metadata = source_path_metadata(path)?;
    if !path_metadata.is_file() {
        return Err(ProductionImportError::denied());
    }

    let canonical_before = fs::canonicalize(path).map_err(map_source_io_error)?;
    let mut file = open_shared_read(path).map_err(map_source_io_error)?;
    let before = source_stamp(&file)?;
    if before.byte_length > MAX_PRODUCTION_CATALOG_BYTES {
        return Err(ProductionImportError::too_large());
    }

    let capacity = usize::try_from(before.byte_length)
        .unwrap_or(0)
        .min(MAX_PRODUCTION_CATALOG_BYTES as usize);
    let mut bytes = Vec::with_capacity(capacity);
    Read::by_ref(&mut file)
        .take(MAX_PRODUCTION_CATALOG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ProductionImportError::io())?;
    if bytes.len() as u64 > MAX_PRODUCTION_CATALOG_BYTES {
        return Err(ProductionImportError::too_large());
    }

    let after = source_stamp(&file)?;
    let canonical_after = fs::canonicalize(path).map_err(|_| ProductionImportError::changed())?;
    let path_metadata_after =
        source_path_metadata(path).map_err(|_| ProductionImportError::changed())?;
    if !path_metadata_after.is_file() {
        return Err(ProductionImportError::changed());
    }
    let path_file = open_shared_read(path).map_err(|_| ProductionImportError::changed())?;
    let path_identity = file_identity(&path_file).map_err(|_| ProductionImportError::changed())?;
    if before != after
        || before.byte_length != bytes.len() as u64
        || !paths_equal(&canonical_before, &canonical_after)
        || path_identity != before.identity
    {
        return Err(ProductionImportError::changed());
    }

    validate_json(&bytes)?;
    let sha256 = sha256_hex(&bytes);
    Ok(SourceSnapshot {
        canonical_path: canonical_after,
        stamp: before,
        bytes,
        sha256,
    })
}

fn source_path_metadata(path: &Path) -> ProductionImportResult<fs::Metadata> {
    reject_linked_ancestor_directories(path)?;
    let metadata = fs::symlink_metadata(path).map_err(map_source_io_error)?;
    if metadata.file_type().is_symlink() || has_reparse_attribute(&metadata) {
        return Err(ProductionImportError::denied());
    }
    Ok(metadata)
}

fn reject_linked_ancestor_directories(path: &Path) -> ProductionImportResult<()> {
    for ancestor in path.ancestors().skip(1) {
        if ancestor.as_os_str().is_empty() {
            continue;
        }
        let metadata = fs::symlink_metadata(ancestor).map_err(map_source_io_error)?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || has_reparse_attribute(&metadata)
        {
            return Err(ProductionImportError::denied());
        }
    }
    Ok(())
}

fn map_source_io_error(error: io::Error) -> ProductionImportError {
    if error.kind() == io::ErrorKind::NotFound {
        ProductionImportError::missing()
    } else {
        ProductionImportError::io()
    }
}

fn validate_json(bytes: &[u8]) -> ProductionImportResult<()> {
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    Value::deserialize(&mut deserializer).map_err(|_| ProductionImportError::invalid())?;
    deserializer
        .end()
        .map_err(|_| ProductionImportError::invalid())
}

fn source_stamp(file: &File) -> ProductionImportResult<SourceStamp> {
    let metadata = file.metadata().map_err(|_| ProductionImportError::io())?;
    if !metadata.is_file() || has_reparse_attribute(&metadata) {
        return Err(ProductionImportError::denied());
    }
    let hard_link_count = hard_link_count(file)?;
    if hard_link_count != 1 {
        return Err(ProductionImportError::denied());
    }
    Ok(SourceStamp {
        identity: file_identity(file)?,
        hard_link_count,
        byte_length: metadata.len(),
        modified: metadata.modified().ok(),
        platform_attributes: platform_attributes(&metadata),
    })
}

fn prepare_staging_root(
    requested: &Path,
    protected_roots: &[PathBuf],
) -> ProductionImportResult<StagingDirectoryGuard> {
    if !requested.is_absolute() {
        return Err(ProductionImportError::denied());
    }
    let resolved_before = resolve_with_existing_ancestor(requested)?;
    validate_disjoint_root(&resolved_before, protected_roots)?;

    let components = guard_or_create_directory_chain(requested)?;
    let canonical_path = components
        .last()
        .ok_or_else(ProductionImportError::denied)?
        .canonical_path
        .clone();
    validate_disjoint_root(&canonical_path, protected_roots)?;
    let guard = StagingDirectoryGuard {
        canonical_path,
        components,
    };
    guard.verify()?;
    Ok(guard)
}

fn guard_or_create_directory_chain(
    requested: &Path,
) -> ProductionImportResult<Vec<DirectoryComponentGuard>> {
    let normalized = normalize_lexical(requested);
    let mut current = PathBuf::new();
    let mut guards = Vec::new();
    let mut saw_root = false;
    for component in normalized.components() {
        current.push(component.as_os_str());
        if matches!(component, Component::RootDir) {
            saw_root = true;
        }
        // `Path::is_absolute()` is already true for a Windows verbatim disk
        // prefix such as `\\?\C:` before its RootDir component arrives. Trying
        // to open that incomplete prefix produces a false PathDenied.
        if !saw_root {
            continue;
        }

        match fs::symlink_metadata(&current) {
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                match fs::create_dir(&current) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(_) => return Err(ProductionImportError::io()),
                }
            }
            Err(_) => return Err(ProductionImportError::denied()),
        }

        let metadata = fs::symlink_metadata(&current).map_err(|_| ProductionImportError::io())?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || has_reparse_attribute(&metadata)
        {
            return Err(ProductionImportError::denied());
        }
        let file = open_directory_guard(&current).map_err(|_| ProductionImportError::denied())?;
        require_plain_directory_handle(&file)?;
        let identity = file_identity(&file)?;
        let canonical_path = canonical_path_from_handle(&file, &current)?;
        let reopened =
            open_directory_guard(&current).map_err(|_| ProductionImportError::denied())?;
        require_plain_directory_handle(&reopened)?;
        if file_identity(&reopened)? != identity
            || !paths_equal(
                &canonical_path_from_handle(&reopened, &current)
                    .map_err(|_| ProductionImportError::changed())?,
                &canonical_path,
            )
        {
            return Err(ProductionImportError::changed());
        }
        guards.push(DirectoryComponentGuard {
            requested_path: current.clone(),
            canonical_path,
            identity,
            file,
        });
    }
    Ok(guards)
}

fn require_plain_directory_handle(file: &File) -> ProductionImportResult<()> {
    let metadata = file.metadata().map_err(|_| ProductionImportError::io())?;
    if !metadata.is_dir() || has_reparse_attribute(&metadata) {
        return Err(ProductionImportError::denied());
    }
    Ok(())
}

fn stage_exact_copy(
    destination: &Path,
    staging_root: &StagingDirectoryGuard,
    protected_roots: &[PathBuf],
    source: &SourceSnapshot,
) -> ProductionImportResult<StagedFile> {
    staging_root.verify()?;
    match create_new_staged_file(destination) {
        Ok(file) => {
            let mut pending = PendingCreatedFile::new(destination.to_path_buf(), file);
            staging_root.verify()?;
            let identity = file_identity(pending.file())?;
            pending
                .file_mut()
                .write_all(&source.bytes)
                .map_err(|_| ProductionImportError::io())?;
            pending
                .file()
                .sync_all()
                .map_err(|_| ProductionImportError::io())?;
            set_file_read_only(pending.file())?;
            let transition = open_staged_transition_guard(destination)
                .map_err(|_| ProductionImportError::corrupt_staging())?;
            if file_identity(&transition)? != identity {
                return Err(ProductionImportError::changed());
            }
            let mut staged = StagedFile::created(destination.to_path_buf(), identity.clone());
            drop(pending.persist());
            let strict_guard = match open_staged_read_guard(destination) {
                Ok(file) => file,
                Err(_) => {
                    drop(transition);
                    staged.cleanup_if_created();
                    return Err(ProductionImportError::corrupt_staging());
                }
            };
            if file_identity(&strict_guard)? != identity {
                return Err(ProductionImportError::changed());
            }
            drop(transition);
            let validation = validate_staged_copy_with_guard(
                destination,
                staging_root,
                protected_roots,
                source,
                strict_guard,
            )?;
            staged.replace_validation(validation);
            staging_root.verify()?;
            Ok(staged)
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            staging_root.verify()?;
            let validation =
                validate_staged_copy(destination, staging_root, protected_roots, source)?;
            Ok(StagedFile::existing(destination.to_path_buf(), validation))
        }
        Err(_) => Err(ProductionImportError::io()),
    }
}

fn validate_staged_copy(
    path: &Path,
    staging_root: &StagingDirectoryGuard,
    protected_roots: &[PathBuf],
    source: &SourceSnapshot,
) -> ProductionImportResult<ValidatedStagedCopy> {
    staging_root.verify()?;
    let file =
        open_staged_read_guard(path).map_err(|_| ProductionImportError::corrupt_staging())?;
    validate_staged_copy_with_guard(path, staging_root, protected_roots, source, file)
}

fn validate_staged_copy_with_guard(
    path: &Path,
    staging_root: &StagingDirectoryGuard,
    protected_roots: &[PathBuf],
    source: &SourceSnapshot,
    mut file: File,
) -> ProductionImportResult<ValidatedStagedCopy> {
    staging_root.verify()?;
    let metadata =
        fs::symlink_metadata(path).map_err(|_| ProductionImportError::corrupt_staging())?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || has_reparse_attribute(&metadata)
        || !metadata.permissions().readonly()
        || metadata.len() > MAX_PRODUCTION_CATALOG_BYTES
        || metadata.len() != source.bytes.len() as u64
    {
        return Err(ProductionImportError::corrupt_staging());
    }

    let canonical_before = canonical_path_from_handle(&file, path)
        .map_err(|_| ProductionImportError::corrupt_staging())?;
    let path_canonical_before =
        fs::canonicalize(path).map_err(|_| ProductionImportError::corrupt_staging())?;
    if !paths_equal(&canonical_before, &path_canonical_before) {
        return Err(ProductionImportError::corrupt_staging());
    }
    if !path_is_within(&canonical_before, staging_root.path()) {
        return Err(ProductionImportError::denied());
    }
    for protected in protected_roots {
        let protected = resolve_with_existing_ancestor(protected)?;
        if path_is_within(&canonical_before, &protected)
            || path_is_within(&protected, &canonical_before)
        {
            return Err(ProductionImportError::denied());
        }
    }

    let before = source_stamp(&file).map_err(|error| match error.code {
        ProductionImportErrorCode::PathDenied => ProductionImportError::denied(),
        _ => ProductionImportError::corrupt_staging(),
    })?;
    if before.identity == source.stamp.identity || before.byte_length != source.bytes.len() as u64 {
        return Err(ProductionImportError::denied());
    }
    let mut bytes = Vec::with_capacity(source.bytes.len());
    file.seek(SeekFrom::Start(0))
        .map_err(|_| ProductionImportError::corrupt_staging())?;
    Read::by_ref(&mut file)
        .take(MAX_PRODUCTION_CATALOG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ProductionImportError::corrupt_staging())?;
    if bytes != source.bytes || sha256_hex(&bytes) != source.sha256 {
        return Err(ProductionImportError::corrupt_staging());
    }
    let after = source_stamp(&file).map_err(|_| ProductionImportError::corrupt_staging())?;
    let metadata_after =
        fs::symlink_metadata(path).map_err(|_| ProductionImportError::corrupt_staging())?;
    let canonical_after =
        fs::canonicalize(path).map_err(|_| ProductionImportError::corrupt_staging())?;
    let handle_canonical_after = canonical_path_from_handle(&file, path)
        .map_err(|_| ProductionImportError::corrupt_staging())?;
    if before != after
        || !metadata_after.is_file()
        || metadata_after.file_type().is_symlink()
        || has_reparse_attribute(&metadata_after)
        || !metadata_after.permissions().readonly()
        || !paths_equal(&canonical_before, &canonical_after)
        || !paths_equal(&canonical_before, &handle_canonical_after)
    {
        return Err(ProductionImportError::corrupt_staging());
    }

    let path_guard =
        open_staged_read_guard(path).map_err(|_| ProductionImportError::corrupt_staging())?;
    let path_stamp =
        source_stamp(&path_guard).map_err(|_| ProductionImportError::corrupt_staging())?;
    let path_guard_canonical = canonical_path_from_handle(&path_guard, path)
        .map_err(|_| ProductionImportError::corrupt_staging())?;
    if path_stamp != before || !paths_equal(&path_guard_canonical, &canonical_before) {
        return Err(ProductionImportError::corrupt_staging());
    }
    staging_root.verify()?;
    Ok(ValidatedStagedCopy {
        canonical_path: canonical_after,
        identity: before.identity.clone(),
        stamp: before,
        sha256: source.sha256.clone(),
        read_guard: file,
    })
}

struct ValidatedStagedCopy {
    canonical_path: PathBuf,
    identity: FileIdentity,
    stamp: SourceStamp,
    sha256: String,
    read_guard: File,
}

struct PendingCreatedFile {
    path: PathBuf,
    file: Option<File>,
    remove_on_drop: bool,
}

impl PendingCreatedFile {
    fn new(path: PathBuf, file: File) -> Self {
        Self {
            path,
            file: Some(file),
            remove_on_drop: true,
        }
    }

    fn file(&self) -> &File {
        self.file
            .as_ref()
            .expect("pending created file owns its handle")
    }

    fn file_mut(&mut self) -> &mut File {
        self.file
            .as_mut()
            .expect("pending created file owns its handle")
    }

    fn persist(mut self) -> File {
        self.remove_on_drop = false;
        self.file
            .take()
            .expect("pending created file owns its handle")
    }
}

impl Drop for PendingCreatedFile {
    fn drop(&mut self) {
        if self.remove_on_drop
            && let Some(file) = self.file.as_ref()
        {
            let _ = delete_pending_created_file(file, &self.path);
        }
    }
}

struct StagedFile {
    path: PathBuf,
    created_identity: Option<FileIdentity>,
    validation: Option<ValidatedStagedCopy>,
    remove_on_drop: bool,
}

impl StagedFile {
    fn created(path: PathBuf, identity: FileIdentity) -> Self {
        Self {
            path,
            created_identity: Some(identity),
            validation: None,
            remove_on_drop: true,
        }
    }

    fn existing(path: PathBuf, validation: ValidatedStagedCopy) -> Self {
        Self {
            path,
            created_identity: None,
            validation: Some(validation),
            remove_on_drop: false,
        }
    }

    fn replace_validation(&mut self, validation: ValidatedStagedCopy) {
        self.validation = Some(validation);
    }

    fn canonical_path(&self) -> &Path {
        &self
            .validation
            .as_ref()
            .expect("a staged copy is validated before handoff")
            .canonical_path
    }

    fn verify_retained_identity(&mut self) -> ProductionImportResult<()> {
        let validation = self
            .validation
            .as_mut()
            .ok_or_else(ProductionImportError::corrupt_staging)?;
        let held_stamp = source_stamp(&validation.read_guard)
            .map_err(|_| ProductionImportError::corrupt_staging())?;
        let metadata = fs::symlink_metadata(&self.path)
            .map_err(|_| ProductionImportError::corrupt_staging())?;
        let canonical =
            fs::canonicalize(&self.path).map_err(|_| ProductionImportError::corrupt_staging())?;
        let held_canonical = canonical_path_from_handle(&validation.read_guard, &self.path)
            .map_err(|_| ProductionImportError::corrupt_staging())?;
        let reopened = open_staged_read_guard(&self.path)
            .map_err(|_| ProductionImportError::corrupt_staging())?;
        let reopened_canonical = canonical_path_from_handle(&reopened, &self.path)
            .map_err(|_| ProductionImportError::corrupt_staging())?;
        validation
            .read_guard
            .seek(SeekFrom::Start(0))
            .map_err(|_| ProductionImportError::corrupt_staging())?;
        let mut bytes = Vec::with_capacity(validation.stamp.byte_length as usize);
        Read::by_ref(&mut validation.read_guard)
            .take(MAX_PRODUCTION_CATALOG_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| ProductionImportError::corrupt_staging())?;
        if held_stamp != validation.stamp
            || file_identity(&reopened).map_err(|_| ProductionImportError::corrupt_staging())?
                != validation.identity
            || !metadata.is_file()
            || metadata.file_type().is_symlink()
            || has_reparse_attribute(&metadata)
            || !metadata.permissions().readonly()
            || !paths_equal(&canonical, &validation.canonical_path)
            || !paths_equal(&held_canonical, &validation.canonical_path)
            || !paths_equal(&reopened_canonical, &validation.canonical_path)
            || bytes.len() as u64 != validation.stamp.byte_length
            || sha256_hex(&bytes) != validation.sha256
        {
            return Err(ProductionImportError::corrupt_staging());
        }
        Ok(())
    }

    fn cleanup_if_created(&mut self) {
        if self.remove_on_drop {
            self.validation = None;
            if let Some(identity) = self.created_identity.as_ref()
                && remove_created_file_if_identity(&self.path, identity)
            {
                self.remove_on_drop = false;
            }
        }
    }

    fn persist(&mut self) {
        self.remove_on_drop = false;
    }
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        self.cleanup_if_created();
    }
}

fn validate_static_policy(policy: &ProductionImportPolicy) -> ProductionImportResult<()> {
    if !policy.staging_root.is_absolute() || policy.canonical_roots.is_empty() {
        return Err(ProductionImportError::denied());
    }
    require_absolute_paths(&policy.canonical_roots)?;
    require_absolute_paths(&policy.production_roots)?;
    require_absolute_paths(&policy.agent_session_roots)?;

    let protected = policy
        .canonical_roots
        .iter()
        .chain(policy.production_roots.iter())
        .chain(policy.agent_session_roots.iter())
        .cloned()
        .collect::<Vec<_>>();
    let staging = resolve_with_existing_ancestor(&policy.staging_root)?;
    validate_disjoint_root(&staging, &protected)
}

fn validate_disjoint_root(
    candidate: &Path,
    protected_roots: &[PathBuf],
) -> ProductionImportResult<()> {
    for protected in protected_roots {
        let protected = resolve_with_existing_ancestor(protected)?;
        if path_is_within(candidate, &protected) || path_is_within(&protected, candidate) {
            return Err(ProductionImportError::denied());
        }
    }
    Ok(())
}

fn require_absolute_paths(paths: &[PathBuf]) -> ProductionImportResult<()> {
    if paths.iter().any(|path| !path.is_absolute()) {
        return Err(ProductionImportError::denied());
    }
    Ok(())
}

fn absolute_normalized_path(path: &Path) -> ProductionImportResult<PathBuf> {
    if !path.is_absolute() {
        return Err(ProductionImportError::denied());
    }
    Ok(normalize_lexical(path))
}

fn resolve_with_existing_ancestor(path: &Path) -> ProductionImportResult<PathBuf> {
    if !path.is_absolute() {
        return Err(ProductionImportError::denied());
    }
    let normalized = normalize_lexical(path);
    let mut cursor = normalized.as_path();
    let mut missing = Vec::<OsString>::new();
    loop {
        match fs::canonicalize(cursor) {
            Ok(mut resolved) => {
                for component in missing.iter().rev() {
                    resolved.push(component);
                }
                return Ok(normalize_lexical(&resolved));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let name = cursor
                    .file_name()
                    .ok_or_else(ProductionImportError::denied)?;
                missing.push(name.to_os_string());
                cursor = cursor.parent().ok_or_else(ProductionImportError::denied)?;
            }
            Err(_) => return Err(ProductionImportError::denied()),
        }
    }
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
    let candidate = comparable_components(candidate);
    let root = comparable_components(root);
    candidate.len() >= root.len() && candidate[..root.len()] == root
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    comparable_components(left) == comparable_components(right)
}

fn comparable_components(path: &Path) -> Vec<String> {
    path.components()
        .map(|component| {
            let value = component.as_os_str().to_string_lossy().into_owned();
            if cfg!(windows) {
                value.to_lowercase()
            } else {
                value
            }
        })
        .collect()
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(64);
    for byte in digest {
        use fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn set_file_read_only(file: &File) -> ProductionImportResult<()> {
    let mut permissions = file
        .metadata()
        .map_err(|_| ProductionImportError::io())?
        .permissions();
    make_permissions_read_only(&mut permissions);
    file.set_permissions(permissions)
        .map_err(|_| ProductionImportError::io())
}

#[cfg(windows)]
fn make_permissions_read_only(permissions: &mut fs::Permissions) {
    permissions.set_readonly(true);
}

#[cfg(unix)]
fn make_permissions_read_only(permissions: &mut fs::Permissions) {
    use std::os::unix::fs::PermissionsExt;
    permissions.set_mode(permissions.mode() & !0o222);
}

#[cfg(not(any(windows, unix)))]
fn make_permissions_read_only(permissions: &mut fs::Permissions) {
    permissions.set_readonly(true);
}

#[cfg(windows)]
fn delete_pending_created_file(file: &File, _path: &Path) -> bool {
    use std::mem::size_of;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_DISPOSITION_INFO, FileDispositionInfo, SetFileInformationByHandle,
    };

    let metadata = match file.metadata() {
        Ok(metadata) => metadata,
        Err(_) => return false,
    };
    if !metadata.is_file() || has_reparse_attribute(&metadata) {
        return false;
    }
    let mut permissions = metadata.permissions();
    make_permissions_writable(&mut permissions);
    if file.set_permissions(permissions).is_err() {
        return false;
    }
    let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    let ok = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfo,
            (&raw const disposition).cast(),
            size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    };
    ok != 0
}

#[cfg(not(windows))]
fn delete_pending_created_file(file: &File, path: &Path) -> bool {
    let expected = match file_identity(file) {
        Ok(identity) => identity,
        Err(_) => return false,
    };
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return true,
        Err(_) => return false,
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || has_reparse_attribute(&metadata)
    {
        return false;
    }
    let reopened = match open_shared_read(path) {
        Ok(file) => file,
        Err(_) => return false,
    };
    if file_identity(&reopened).ok().as_ref() != Some(&expected) {
        return false;
    }
    let mut permissions = metadata.permissions();
    make_permissions_writable(&mut permissions);
    if file.set_permissions(permissions).is_err() {
        return false;
    }
    fs::remove_file(path).is_ok() || !path.exists()
}

#[cfg(windows)]
fn remove_created_file_if_identity(path: &Path, expected: &FileIdentity) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, FILE_WRITE_ATTRIBUTES,
    };

    const DELETE_ACCESS: u32 = 0x0001_0000;
    let file = match OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES | DELETE_ACCESS)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return true,
        Err(_) => return false,
    };
    let metadata = match file.metadata() {
        Ok(metadata) => metadata,
        Err(_) => return false,
    };
    if !metadata.is_file()
        || has_reparse_attribute(&metadata)
        || file_identity(&file).ok().as_ref() != Some(expected)
    {
        return false;
    }
    if !delete_pending_created_file(&file, path) {
        return false;
    }
    drop(file);
    !path.exists()
}

#[cfg(not(windows))]
fn remove_created_file_if_identity(path: &Path, expected: &FileIdentity) -> bool {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return true,
        Err(_) => return false,
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || has_reparse_attribute(&metadata)
    {
        return false;
    }
    let file = match open_shared_read(path) {
        Ok(file) => file,
        Err(_) => return false,
    };
    if file_identity(&file).ok().as_ref() != Some(expected) {
        return false;
    }
    let mut permissions = match file.metadata() {
        Ok(metadata) => metadata.permissions(),
        Err(_) => return false,
    };
    make_permissions_writable(&mut permissions);
    if file.set_permissions(permissions).is_err() {
        return false;
    }
    drop(file);

    let reopened = match open_shared_read(path) {
        Ok(file) => file,
        Err(_) => return false,
    };
    if file_identity(&reopened).ok().as_ref() != Some(expected) {
        return false;
    }
    drop(reopened);
    match fs::remove_file(path) {
        Ok(()) => true,
        Err(error) if error.kind() == io::ErrorKind::NotFound => true,
        Err(_) => false,
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
fn make_permissions_writable(permissions: &mut fs::Permissions) {
    permissions.set_readonly(false);
}

#[cfg(windows)]
fn has_reparse_attribute(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn has_reparse_attribute(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(windows)]
fn open_shared_read(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .open(path)
}

#[cfg(not(windows))]
fn open_shared_read(path: &Path) -> io::Result<File> {
    OpenOptions::new().read(true).open(path)
}

#[cfg(windows)]
fn open_directory_guard(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ,
    };

    OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(not(windows))]
fn open_directory_guard(path: &Path) -> io::Result<File> {
    OpenOptions::new().read(true).open(path)
}

#[cfg(windows)]
fn create_new_staged_file(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, FILE_WRITE_ATTRIBUTES,
    };

    const DELETE_ACCESS: u32 = 0x0001_0000;
    OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .access_mode(FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_WRITE_ATTRIBUTES | DELETE_ACCESS)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(not(windows))]
fn create_new_staged_file(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(path)
}

#[cfg(windows)]
fn open_staged_read_guard(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ};

    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(not(windows))]
fn open_staged_read_guard(path: &Path) -> io::Result<File> {
    OpenOptions::new().read(true).open(path)
}

#[cfg(windows)]
fn open_staged_transition_guard(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(not(windows))]
fn open_staged_transition_guard(path: &Path) -> io::Result<File> {
    OpenOptions::new().read(true).open(path)
}

#[cfg(windows)]
fn canonical_path_from_handle(
    file: &File,
    _fallback_path: &Path,
) -> ProductionImportResult<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_NAME_NORMALIZED, GetFinalPathNameByHandleW, VOLUME_NAME_DOS,
    };

    let required = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            std::ptr::null_mut(),
            0,
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
        )
    };
    if required == 0 {
        return Err(ProductionImportError::io());
    }
    let mut buffer = vec![0u16; required as usize + 1];
    let written = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
        )
    };
    if written == 0 || written as usize >= buffer.len() {
        return Err(ProductionImportError::io());
    }
    Ok(PathBuf::from(OsString::from_wide(
        &buffer[..written as usize],
    )))
}

#[cfg(not(windows))]
fn canonical_path_from_handle(
    _file: &File,
    fallback_path: &Path,
) -> ProductionImportResult<PathBuf> {
    fs::canonicalize(fallback_path).map_err(|_| ProductionImportError::io())
}

#[cfg(windows)]
fn hard_link_count(file: &File) -> ProductionImportResult<u64> {
    use std::mem::MaybeUninit;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };

    let mut information = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) };
    if ok == 0 {
        return Err(ProductionImportError::io());
    }
    Ok(u64::from(
        unsafe { information.assume_init() }.nNumberOfLinks,
    ))
}

#[cfg(unix)]
fn hard_link_count(file: &File) -> ProductionImportResult<u64> {
    use std::os::unix::fs::MetadataExt;
    Ok(file
        .metadata()
        .map_err(|_| ProductionImportError::io())?
        .nlink())
}

#[cfg(not(any(windows, unix)))]
fn hard_link_count(_file: &File) -> ProductionImportResult<u64> {
    Ok(1)
}

#[cfg(windows)]
fn file_identity(file: &File) -> ProductionImportResult<FileIdentity> {
    use std::mem::{MaybeUninit, size_of};
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ID_INFO, FileIdInfo, GetFileInformationByHandleEx,
    };

    let mut information = MaybeUninit::<FILE_ID_INFO>::zeroed();
    let ok = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileIdInfo,
            information.as_mut_ptr().cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if ok == 0 {
        return Err(ProductionImportError::io());
    }
    let information = unsafe { information.assume_init() };
    Ok(FileIdentity::Windows {
        volume_serial: information.VolumeSerialNumber,
        file_id: information.FileId.Identifier,
    })
}

#[cfg(unix)]
fn file_identity(file: &File) -> ProductionImportResult<FileIdentity> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata().map_err(|_| ProductionImportError::io())?;
    Ok(FileIdentity::Unix {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[cfg(not(any(windows, unix)))]
fn file_identity(_file: &File) -> ProductionImportResult<FileIdentity> {
    Ok(FileIdentity::Unsupported)
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    const SANITIZED_CATALOG: &[u8] =
        br#"{"Projects":[],"SelectedProjectId":null,"Fixture":"synthetic-only"}"#;

    static NEXT_TEST_DIRECTORY: AtomicU64 = AtomicU64::new(1);

    struct TestDirectory {
        root: PathBuf,
    }

    impl TestDirectory {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("test clock")
                .as_nanos();
            let serial = NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed);
            let root = env::temp_dir().join(format!(
                "ihc-production-import-{}-{nonce}-{serial}",
                std::process::id()
            ));
            fs::create_dir(&root).expect("create isolated test directory");
            Self { root }
        }

        fn path(&self, relative: &str) -> PathBuf {
            self.root.join(relative)
        }

        fn directory(&self, relative: &str) -> PathBuf {
            let path = self.path(relative);
            fs::create_dir_all(&path).expect("create test directory");
            path
        }

        fn write(&self, relative: &str, bytes: &[u8]) -> PathBuf {
            let path = self.path(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("create fixture parent");
            }
            fs::write(&path, bytes).expect("write synthetic fixture");
            path
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
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
        make_permissions_writable(&mut permissions);
        let _ = fs::set_permissions(path, permissions);
    }

    struct TestLayout {
        directory: TestDirectory,
        source: PathBuf,
        staging: PathBuf,
        canonical: PathBuf,
        sessions: PathBuf,
        environment: ProcessEnvironment,
        service: ProductionImportService,
    }

    impl TestLayout {
        fn new(bytes: &[u8]) -> Self {
            let directory = TestDirectory::new();
            let source = directory.write("production/projects.json", bytes);
            let staging = directory.path("detached-staging");
            let canonical = directory.directory("canonical/state");
            let sessions = directory.directory("agent-sessions");
            let environment = ProcessEnvironment {
                configured_catalog: Some(source.clone().into_os_string()),
                current_directory: Some(directory.root.clone()),
                ..ProcessEnvironment::default()
            };
            let policy = ProductionImportPolicy::new(staging.clone(), vec![canonical.clone()])
                .expect("test policy")
                .with_production_roots(vec![directory.path("production")])
                .expect("production roots")
                .with_agent_session_roots(vec![sessions.clone()])
                .expect("session roots");
            let service = ProductionImportService::new(policy).expect("test service");
            Self {
                directory,
                source,
                staging,
                canonical,
                sessions,
                environment,
                service,
            }
        }

        fn stage(&self) -> ProductionImportResult<ProductionStagingDescriptor> {
            self.service
                .stage_with_environment_and_hook(&self.environment, || Ok(()))
        }
    }

    fn set_path_writable(path: &Path) {
        let metadata = fs::metadata(path).expect("fixture metadata");
        let mut permissions = metadata.permissions();
        make_permissions_writable(&mut permissions);
        fs::set_permissions(path, permissions).expect("make fixture writable");
    }

    #[test]
    fn public_service_keeps_a_lib_usable_signature() {
        let _constructor: fn(
            ProductionImportPolicy,
        ) -> ProductionImportResult<ProductionImportService> = ProductionImportService::new;
        let _stage: fn(
            &ProductionImportService,
        ) -> ProductionImportResult<ProductionStagingDescriptor> =
            ProductionImportService::stage_discovered_catalog;
        let layout = TestLayout::new(SANITIZED_CATALOG);
        assert_eq!(layout.service.policy.staging_root(), layout.staging);
    }

    #[test]
    fn discovery_prefers_override_and_defaults_to_local_app_data() {
        let directory = TestDirectory::new();
        let environment = ProcessEnvironment {
            configured_catalog: Some(OsString::from("relative/projects.json")),
            local_app_data: Some(directory.path("local").into_os_string()),
            current_directory: Some(directory.root.clone()),
            ..ProcessEnvironment::default()
        };
        assert_eq!(
            environment.discover_catalog().expect("override path"),
            directory.path("relative/projects.json")
        );

        let fallback = ProcessEnvironment {
            local_app_data: Some(directory.path("local").into_os_string()),
            ..ProcessEnvironment::default()
        };
        assert_eq!(
            fallback.discover_catalog().expect("default path"),
            directory.path("local/PowerWorkspace/projects.json")
        );
    }

    #[test]
    fn missing_source_is_sanitized_and_does_not_create_staging() {
        let layout = TestLayout::new(SANITIZED_CATALOG);
        fs::remove_file(&layout.source).expect("remove synthetic source");
        let error = layout.stage().expect_err("missing source must fail");
        assert_eq!(error.code, ProductionImportErrorCode::MissingSource);
        assert!(
            !error
                .message
                .contains(layout.directory.root.to_string_lossy().as_ref())
        );
        assert!(!layout.staging.exists());
    }

    #[test]
    fn malformed_source_is_rejected_before_any_staging_write() {
        let layout = TestLayout::new(br#"{"Projects":["#);
        let error = layout.stage().expect_err("malformed source must fail");
        assert_eq!(error.code, ProductionImportErrorCode::InvalidSource);
        assert!(!layout.staging.exists());
    }

    #[test]
    fn oversized_source_is_rejected_by_metadata_without_full_read() {
        let layout = TestLayout::new(SANITIZED_CATALOG);
        OpenOptions::new()
            .write(true)
            .open(&layout.source)
            .expect("open synthetic source")
            .set_len(MAX_PRODUCTION_CATALOG_BYTES + 1)
            .expect("extend sparse synthetic source");
        let error = layout.stage().expect_err("oversized source must fail");
        assert_eq!(error.code, ProductionImportErrorCode::TooLarge);
        assert!(!layout.staging.exists());
    }

    #[test]
    fn source_change_after_copy_is_rejected_and_new_copy_is_removed() {
        let layout = TestLayout::new(SANITIZED_CATALOG);
        let changed_source = layout.source.clone();
        let error = layout
            .service
            .stage_with_environment_and_hook(&layout.environment, move || {
                fs::write(
                    changed_source,
                    br#"{"Projects":[],"SelectedProjectId":"changed"}"#,
                )
                .map_err(|_| ProductionImportError::io())?;
                Ok(())
            })
            .expect_err("changed source must fail");
        assert_eq!(error.code, ProductionImportErrorCode::SourceChanged);
        let staged_files = fs::read_dir(&layout.staging)
            .expect("read staging directory")
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        assert!(staged_files.is_empty());
    }

    #[test]
    fn pending_create_guard_removes_read_only_partial_file_on_early_failure() {
        let directory = TestDirectory::new();
        let staging = directory.directory("staging");
        let path = staging.join("partial.projects.json");
        {
            let file = create_new_staged_file(&path).expect("create pending staged file");
            let mut pending = PendingCreatedFile::new(path.clone(), file);
            pending
                .file_mut()
                .write_all(b"partial")
                .expect("write partial fixture");
            set_file_read_only(pending.file()).expect("make partial fixture read only");
            // Dropping while the original writer is still owned simulates any
            // early write/sync/identity error in `stage_exact_copy`.
        }
        assert!(!path.exists());
    }

    #[test]
    fn rerun_is_idempotent_by_sha_and_copy_is_exact_and_read_only() {
        let layout = TestLayout::new(SANITIZED_CATALOG);
        let first = layout.stage().expect("first staging");
        let restarted_service =
            ProductionImportService::new(layout.service.policy.clone()).expect("restart service");
        let second = restarted_service
            .stage_with_environment_and_hook(&layout.environment, || Ok(()))
            .expect("idempotent staging after service restart");
        assert_eq!(first, second);
        assert_eq!(first.sha256, sha256_hex(SANITIZED_CATALOG));
        assert_eq!(first.byte_length, SANITIZED_CATALOG.len() as u64);
        let path = PathBuf::from(&first.path);
        assert_eq!(
            fs::read(&path).expect("read staging copy"),
            SANITIZED_CATALOG
        );
        assert!(
            fs::metadata(&path)
                .expect("staging metadata")
                .permissions()
                .readonly()
        );
        assert_eq!(
            fs::read_dir(&layout.staging)
                .expect("read staging directory")
                .count(),
            1
        );
    }

    #[test]
    fn corrupt_existing_sha_named_copy_is_never_reused_or_overwritten() {
        let layout = TestLayout::new(SANITIZED_CATALOG);
        let descriptor = layout.stage().expect("initial staging");
        let path = PathBuf::from(descriptor.path);
        set_path_writable(&path);
        fs::write(&path, b"corrupt").expect("corrupt synthetic staging copy");

        let error = layout.stage().expect_err("corrupt copy must fail closed");
        assert_eq!(error.code, ProductionImportErrorCode::CorruptStaging);
        assert_eq!(fs::read(path).expect("corrupt copy remains"), b"corrupt");
    }

    #[test]
    fn descriptor_serialization_contains_only_staging_metadata() {
        let layout = TestLayout::new(SANITIZED_CATALOG);
        let descriptor = layout.stage().expect("stage synthetic catalog");
        let serialized = serde_json::to_value(&descriptor).expect("serialize descriptor");
        assert_eq!(
            serialized
                .as_object()
                .expect("descriptor object")
                .keys()
                .collect::<Vec<_>>(),
            vec!["byteLength", "path", "sha256"]
        );
        let text = serialized.to_string();
        assert!(!text.contains("Projects"));
        assert!(!text.contains("synthetic-only"));
        assert!(!text.contains(layout.source.to_string_lossy().as_ref()));
    }

    #[test]
    fn staging_root_must_be_disjoint_from_every_protected_root() {
        let layout = TestLayout::new(SANITIZED_CATALOG);
        for denied in [
            layout.canonical.join("imports"),
            layout.directory.path("production/staging"),
            layout.sessions.join("staging"),
        ] {
            let policy =
                ProductionImportPolicy::new(denied.clone(), vec![layout.canonical.clone()]);
            if path_is_within(&denied, &layout.canonical) {
                assert_eq!(
                    policy.expect_err("canonical overlap must fail").code,
                    ProductionImportErrorCode::PathDenied
                );
                continue;
            }
            let policy = policy
                .expect("initial policy")
                .with_production_roots(vec![layout.directory.path("production")]);
            if path_is_within(&denied, &layout.directory.path("production")) {
                assert_eq!(
                    policy.expect_err("production overlap must fail").code,
                    ProductionImportErrorCode::PathDenied
                );
                continue;
            }
            let error = policy
                .expect("production-safe policy")
                .with_agent_session_roots(vec![layout.sessions.clone()])
                .expect_err("session overlap must fail");
            assert_eq!(error.code, ProductionImportErrorCode::PathDenied);
        }
    }

    #[test]
    fn source_hard_link_alias_is_rejected() {
        let layout = TestLayout::new(SANITIZED_CATALOG);
        let alias = layout.directory.path("source-alias.json");
        fs::hard_link(&layout.source, alias).expect("create source hard-link alias");
        let error = layout.stage().expect_err("hard-linked source must fail");
        assert_eq!(error.code, ProductionImportErrorCode::PathDenied);
        assert!(!layout.staging.exists());
    }

    #[test]
    fn nonregular_source_is_rejected() {
        let layout = TestLayout::new(SANITIZED_CATALOG);
        fs::remove_file(&layout.source).expect("remove synthetic source");
        fs::create_dir(&layout.source).expect("replace source with directory");
        let error = layout.stage().expect_err("directory source must fail");
        assert_eq!(error.code, ProductionImportErrorCode::PathDenied);
        assert!(!layout.staging.exists());
    }

    #[test]
    fn configured_source_inside_canonical_or_session_state_is_rejected() {
        let layout = TestLayout::new(SANITIZED_CATALOG);
        for forbidden_source in [
            layout
                .directory
                .write("canonical/state/projects.json", SANITIZED_CATALOG),
            layout
                .directory
                .write("agent-sessions/projects.json", SANITIZED_CATALOG),
        ] {
            let environment = ProcessEnvironment {
                configured_catalog: Some(forbidden_source.into_os_string()),
                current_directory: Some(layout.directory.root.clone()),
                ..ProcessEnvironment::default()
            };
            let error = layout
                .service
                .stage_with_environment_and_hook(&environment, || Ok(()))
                .expect_err("protected state source must fail");
            assert_eq!(error.code, ProductionImportErrorCode::PathDenied);
        }
        assert!(!layout.staging.exists());
    }

    #[test]
    fn home_session_defaults_are_protected_and_relative_provider_roots_fail_closed() {
        let layout = TestLayout::new(SANITIZED_CATALOG);
        let home = layout.directory.directory("home");
        let denied_staging = home.join(".codex/sessions/staging");
        let policy =
            ProductionImportPolicy::new(denied_staging.clone(), vec![layout.canonical.clone()])
                .expect("policy before environment roots");
        let service = ProductionImportService::new(policy).expect("home-root service");
        let home_environment = ProcessEnvironment {
            configured_catalog: Some(layout.source.clone().into_os_string()),
            home: Some(home.into_os_string()),
            current_directory: Some(layout.directory.root.clone()),
            ..ProcessEnvironment::default()
        };
        let error = service
            .stage_with_environment_and_hook(&home_environment, || Ok(()))
            .expect_err("HOME session overlap must fail");
        assert_eq!(error.code, ProductionImportErrorCode::PathDenied);
        assert!(!denied_staging.exists());

        let relative_provider_environment = ProcessEnvironment {
            configured_catalog: Some(layout.source.clone().into_os_string()),
            codex_home: Some(OsString::from("relative-codex-home")),
            current_directory: Some(layout.directory.root.clone()),
            ..ProcessEnvironment::default()
        };
        let error = layout
            .service
            .stage_with_environment_and_hook(&relative_provider_environment, || Ok(()))
            .expect_err("relative CODEX_HOME must fail closed");
        assert_eq!(error.code, ProductionImportErrorCode::PathDenied);
        assert!(!layout.staging.exists());
    }

    #[test]
    fn hard_linked_existing_staging_copy_is_rejected_as_an_alias() {
        let layout = TestLayout::new(SANITIZED_CATALOG);
        fs::create_dir(&layout.staging).expect("create staging root");
        let hash = sha256_hex(SANITIZED_CATALOG);
        let unrelated = layout.directory.write("unrelated.json", SANITIZED_CATALOG);
        let destination = layout.staging.join(format!("{hash}.projects.json"));
        fs::hard_link(&unrelated, &destination).expect("create staged hard-link alias");
        let mut permissions = fs::metadata(&destination)
            .expect("hard-link metadata")
            .permissions();
        make_permissions_read_only(&mut permissions);
        fs::set_permissions(&destination, permissions).expect("make hard-link read only");

        let error = layout.stage().expect_err("staged hard-link must fail");
        assert_eq!(error.code, ProductionImportErrorCode::PathDenied);
    }

    #[test]
    fn source_symlink_is_rejected_when_the_platform_can_create_one() {
        let layout = TestLayout::new(SANITIZED_CATALOG);
        let link = layout.directory.path("production-link.json");
        if create_file_symlink(&layout.source, &link).is_err() {
            return;
        }
        let environment = ProcessEnvironment {
            configured_catalog: Some(link.into_os_string()),
            current_directory: Some(layout.directory.root.clone()),
            ..ProcessEnvironment::default()
        };
        let error = layout
            .service
            .stage_with_environment_and_hook(&environment, || Ok(()))
            .expect_err("symlink source must fail");
        assert_eq!(error.code, ProductionImportErrorCode::PathDenied);
    }

    #[test]
    fn source_and_staging_ancestor_links_are_rejected_when_supported() {
        let layout = TestLayout::new(SANITIZED_CATALOG);
        let real_source_parent = layout.directory.directory("real-source-parent");
        let linked_source_parent = layout.directory.path("linked-source-parent");
        if create_directory_symlink(&real_source_parent, &linked_source_parent).is_err() {
            return;
        }
        let linked_source = real_source_parent.join("projects.json");
        fs::write(&linked_source, SANITIZED_CATALOG).expect("write linked source fixture");
        let environment = ProcessEnvironment {
            configured_catalog: Some(linked_source_parent.join("projects.json").into_os_string()),
            current_directory: Some(layout.directory.root.clone()),
            ..ProcessEnvironment::default()
        };
        let error = layout
            .service
            .stage_with_environment_and_hook(&environment, || Ok(()))
            .expect_err("linked source ancestor must fail");
        assert_eq!(error.code, ProductionImportErrorCode::PathDenied);

        let real_staging_parent = layout.directory.directory("real-staging-parent");
        let linked_staging_parent = layout.directory.path("linked-staging-parent");
        create_directory_symlink(&real_staging_parent, &linked_staging_parent)
            .expect("second directory symlink");
        let policy = ProductionImportPolicy::new(
            linked_staging_parent.join("staging"),
            vec![layout.canonical.clone()],
        )
        .expect("lexically separate staging policy");
        let service = ProductionImportService::new(policy).expect("linked staging service");
        let error = service
            .stage_with_environment_and_hook(&layout.environment, || Ok(()))
            .expect_err("linked staging ancestor must fail");
        assert_eq!(error.code, ProductionImportErrorCode::PathDenied);
        assert!(!real_staging_parent.join("staging").exists());
    }

    #[cfg(windows)]
    #[test]
    fn windows_guards_block_staging_root_swap_and_copy_replacement_until_handoff() {
        let layout = TestLayout::new(SANITIZED_CATALOG);
        let staging = layout.staging.clone();
        let moved = layout.directory.path("moved-staging");
        let destination = staging.join(format!("{}.projects.json", sha256_hex(SANITIZED_CATALOG)));
        let descriptor = layout
            .service
            .stage_with_environment_and_hook(&layout.environment, move || {
                assert!(fs::rename(&staging, &moved).is_err());
                assert!(fs::remove_file(&destination).is_err());
                assert!(OpenOptions::new().write(true).open(&destination).is_err());
                Ok(())
            })
            .expect("guarded staging handoff");
        assert_eq!(
            fs::read(descriptor.path).expect("stable copy"),
            SANITIZED_CATALOG
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_verbatim_app_data_path_allows_sibling_state_staging_and_catalog_roots() {
        let directory = TestDirectory::new();
        let app_local_data_raw = directory.directory("isolated-app-data");
        let app_local_data =
            fs::canonicalize(&app_local_data_raw).expect("canonical app-local-data path");
        assert!(app_local_data.to_string_lossy().starts_with(r"\\?\"));

        let canonical = app_local_data.join("state");
        fs::create_dir(&canonical).expect("create canonical sibling");
        let staging = app_local_data.join("production-import-staging");
        let source = directory.write("catalog/projects.json", SANITIZED_CATALOG);
        let codex_home = directory.directory("providers/codex-home");
        let grok_home = directory.directory("providers/grok-home");
        let environment = ProcessEnvironment {
            configured_catalog: Some(source.into_os_string()),
            codex_home: Some(codex_home.into_os_string()),
            grok_home: Some(grok_home.into_os_string()),
            current_directory: Some(directory.root.clone()),
            ..ProcessEnvironment::default()
        };
        let policy =
            ProductionImportPolicy::new(staging, vec![canonical]).expect("verbatim sibling policy");
        let service = ProductionImportService::new(policy).expect("verbatim path service");

        let descriptor = service
            .stage_with_environment_and_hook(&environment, || Ok(()))
            .expect("verbatim path staging must succeed");
        assert_eq!(descriptor.sha256, sha256_hex(SANITIZED_CATALOG));
        assert_eq!(descriptor.byte_length, SANITIZED_CATALOG.len() as u64);
        assert_eq!(
            fs::read(descriptor.path).expect("staged copy"),
            SANITIZED_CATALOG
        );
    }

    #[test]
    fn sha256_matches_published_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn error_envelopes_never_include_paths_or_project_content() {
        let error = ProductionImportError::corrupt_staging();
        let value = serde_json::to_value(error).expect("serialize error");
        assert_eq!(
            value,
            json!({
                "code": "corruptStaging",
                "message": "The existing detached staging copy does not match its content hash.",
                "retryable": false
            })
        );
    }

    #[cfg(windows)]
    fn create_file_symlink(source: &Path, link: &Path) -> io::Result<()> {
        std::os::windows::fs::symlink_file(source, link)
    }

    #[cfg(unix)]
    fn create_file_symlink(source: &Path, link: &Path) -> io::Result<()> {
        std::os::unix::fs::symlink(source, link)
    }

    #[cfg(not(any(windows, unix)))]
    fn create_file_symlink(_source: &Path, _link: &Path) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "symlinks unsupported",
        ))
    }

    #[cfg(windows)]
    fn create_directory_symlink(source: &Path, link: &Path) -> io::Result<()> {
        std::os::windows::fs::symlink_dir(source, link)
    }

    #[cfg(unix)]
    fn create_directory_symlink(source: &Path, link: &Path) -> io::Result<()> {
        std::os::unix::fs::symlink(source, link)
    }

    #[cfg(not(any(windows, unix)))]
    fn create_directory_symlink(_source: &Path, _link: &Path) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "symlinks unsupported",
        ))
    }
}
