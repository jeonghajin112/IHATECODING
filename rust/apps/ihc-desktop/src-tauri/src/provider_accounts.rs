use crate::provider_usage;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    env,
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicU8, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

#[cfg(windows)]
use std::os::windows::{
    ffi::OsStrExt,
    fs::{MetadataExt, OpenOptionsExt},
    io::{AsRawHandle, FromRawHandle, OwnedHandle},
    process::CommandExt,
};
#[cfg(windows)]
use windows_sys::Win32::{
    Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT, MOVEFILE_REPLACE_EXISTING,
        MOVEFILE_WRITE_THROUGH, MoveFileExW, REPLACEFILE_WRITE_THROUGH, ReplaceFileW,
    },
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject,
        },
        Threading::CREATE_NO_WINDOW,
    },
};

#[cfg(unix)]
use std::os::unix::{fs::OpenOptionsExt, io::AsRawFd};

const REGISTRY_SCHEMA_VERSION: u32 = 1;
const REGISTRY_DIRECTORY_NAME: &str = "provider-accounts-v1";
const REGISTRY_FILE_NAME: &str = "registry.json";
const REGISTRY_WRITER_LOCK_FILE_NAME: &str = "writer.lock";
const MANAGED_HOME_DIRECTORY_NAME: &str = "homes";
const DEFAULT_CODEX_ACCOUNT_ID: &str = "00000000-0000-4000-8000-000000000001";
const DEFAULT_GROK_ACCOUNT_ID: &str = "00000000-0000-4000-8000-000000000002";
const DEFAULT_CODEX_HOME_ENV: &str = "IHATECODING_DEFAULT_CODEX_HOME";
const DEFAULT_GROK_HOME_ENV: &str = "IHATECODING_DEFAULT_GROK_HOME";
pub(crate) const CODEX_OAUTH_ISOLATION_ENV: &str = "IHATECODING_CODEX_OAUTH_ISOLATION";
pub(crate) const GROK_OAUTH_ISOLATION_ENV: &str = "IHATECODING_GROK_OAUTH_ISOLATION";
const MAX_REGISTRY_BYTES: u64 = 256 * 1024;
const MAX_MANAGED_ACCOUNTS_PER_PROVIDER: usize = 31;
const MAX_ACCOUNT_LABEL_CHARS: usize = 254;
const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const LOGIN_CANCEL_WAIT_TIMEOUT: Duration = Duration::from_secs(2);
const LOGIN_CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(20);
const LOGIN_PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(25);
const REGISTRY_WRITER_LOCK_TIMEOUT: Duration = Duration::from_secs(5);
const LOGIN_RUNNING: u8 = 0;
const LOGIN_CANCEL_REQUESTED: u8 = 1;
const LOGIN_FINALIZING: u8 = 2;
const LOGIN_CANCELLED_MESSAGE: &str = "계정 추가가 취소되었습니다.";
const OAUTH_CREDENTIAL_ENVIRONMENT_NAMES: [&str; 4] = [
    "OPENAI_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "XAI_API_KEY",
    "GROK_API_KEY",
];

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Provider {
    Codex,
    Grok,
}

impl Provider {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "codex" => Ok(Self::Codex),
            "grok" => Ok(Self::Grok),
            _ => Err("지원하지 않는 AI 제공자입니다.".to_owned()),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Grok => "grok",
        }
    }

    fn home_environment_name(self) -> &'static str {
        match self {
            Self::Codex => "CODEX_HOME",
            Self::Grok => "GROK_HOME",
        }
    }

    fn fallback_label(self) -> &'static str {
        "로그인 안 됨"
    }

    fn default_account_id(self) -> &'static str {
        match self {
            Self::Codex => DEFAULT_CODEX_ACCOUNT_ID,
            Self::Grok => DEFAULT_GROK_ACCOUNT_ID,
        }
    }

    fn default_home_environment_name(self) -> &'static str {
        match self {
            Self::Codex => DEFAULT_CODEX_HOME_ENV,
            Self::Grok => DEFAULT_GROK_HOME_ENV,
        }
    }

    fn expected_oauth_mode(self) -> &'static str {
        match self {
            Self::Codex => "chatgpt",
            Self::Grok => "xai",
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ProviderHomes {
    codex: PathBuf,
    grok: PathBuf,
}

impl ProviderHomes {
    fn from_environment() -> Result<Self, String> {
        Self::from_lookup(|name| env::var_os(name))
    }

    fn from_lookup(mut lookup: impl FnMut(&str) -> Option<OsString>) -> Result<Self, String> {
        let user_home = non_empty_path(lookup("USERPROFILE"))
            .or_else(|| non_empty_path(lookup("HOME")))
            .ok_or_else(|| "사용자 홈 디렉터리를 찾지 못했습니다.".to_owned())?;
        let codex = non_empty_path(lookup(DEFAULT_CODEX_HOME_ENV))
            .or_else(|| non_empty_path(lookup("CODEX_HOME")))
            .unwrap_or_else(|| user_home.join(".codex"));
        let grok = non_empty_path(lookup(DEFAULT_GROK_HOME_ENV))
            .or_else(|| non_empty_path(lookup("GROK_HOME")))
            .unwrap_or_else(|| user_home.join(".grok"));
        validate_absolute_home(&codex)?;
        validate_absolute_home(&grok)?;
        Ok(Self { codex, grok })
    }

    fn get(&self, provider: Provider) -> &Path {
        match provider {
            Provider::Codex => &self.codex,
            Provider::Grok => &self.grok,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManagedAccountRecord {
    id: String,
    provider: Provider,
    display_label: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistryDocument {
    schema_version: u32,
    active_codex_account_id: String,
    active_grok_account_id: String,
    accounts: Vec<ManagedAccountRecord>,
}

impl Default for RegistryDocument {
    fn default() -> Self {
        Self {
            schema_version: REGISTRY_SCHEMA_VERSION,
            active_codex_account_id: DEFAULT_CODEX_ACCOUNT_ID.to_owned(),
            active_grok_account_id: DEFAULT_GROK_ACCOUNT_ID.to_owned(),
            accounts: Vec::new(),
        }
    }
}

impl RegistryDocument {
    fn active_account_id(&self, provider: Provider) -> &str {
        match provider {
            Provider::Codex => &self.active_codex_account_id,
            Provider::Grok => &self.active_grok_account_id,
        }
    }

    fn set_active_account_id(&mut self, provider: Provider, account_id: String) {
        match provider {
            Provider::Codex => self.active_codex_account_id = account_id,
            Provider::Grok => self.active_grok_account_id = account_id,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderAccountView {
    id: String,
    display_label: String,
    active: bool,
    managed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderAccountsResponse {
    provider: String,
    accounts: Vec<ProviderAccountView>,
    active_account_id: String,
    restart_required: bool,
}

#[derive(Debug)]
struct RegistryPaths {
    root: PathBuf,
    registry: PathBuf,
    writer_lock: PathBuf,
    managed_homes: PathBuf,
}

impl RegistryPaths {
    fn new(app_local_data_dir: &Path) -> Result<Self, String> {
        if !app_local_data_dir.is_absolute() {
            return Err("앱 데이터 디렉터리는 절대 경로여야 합니다.".to_owned());
        }
        reject_reparse_components(app_local_data_dir)?;
        fs::create_dir_all(app_local_data_dir)
            .map_err(|_| "앱 데이터 디렉터리를 만들지 못했습니다.".to_owned())?;
        reject_reparse_components(app_local_data_dir)?;

        let root = app_local_data_dir.join(REGISTRY_DIRECTORY_NAME);
        fs::create_dir_all(&root)
            .map_err(|_| "계정 레지스트리 디렉터리를 만들지 못했습니다.".to_owned())?;
        reject_reparse_components(&root)?;
        let managed_homes = root.join(MANAGED_HOME_DIRECTORY_NAME);
        fs::create_dir_all(&managed_homes)
            .map_err(|_| "관리 계정 디렉터리를 만들지 못했습니다.".to_owned())?;
        reject_reparse_components(&managed_homes)?;

        Ok(Self {
            registry: root.join(REGISTRY_FILE_NAME),
            writer_lock: root.join(REGISTRY_WRITER_LOCK_FILE_NAME),
            root,
            managed_homes,
        })
    }

    fn managed_home(&self, provider: Provider, id: Uuid) -> PathBuf {
        self.managed_homes
            .join(provider.as_str())
            .join(id.hyphenated().to_string())
    }
}

struct RegistryWriterLock {
    _file: File,
}

impl RegistryWriterLock {
    fn acquire(paths: &RegistryPaths) -> Result<Self, String> {
        Self::acquire_with_timeout(paths, REGISTRY_WRITER_LOCK_TIMEOUT)
    }

    fn acquire_with_timeout(paths: &RegistryPaths, timeout: Duration) -> Result<Self, String> {
        reject_reparse_components(&paths.root)?;
        if let Ok(metadata) = fs::symlink_metadata(&paths.writer_lock)
            && (!metadata.is_file() || metadata_is_reparse(&metadata))
        {
            return Err("계정 writer lock 파일이 안전하지 않습니다.".to_owned());
        }
        let started = Instant::now();
        loop {
            match open_registry_writer_lock(&paths.writer_lock) {
                Ok(file) => return Ok(Self { _file: file }),
                Err(_) if started.elapsed() < timeout => {
                    thread::sleep(Duration::from_millis(25));
                }
                Err(_) => {
                    return Err("다른 IHATECODING 창에서 계정 설정을 변경하고 있습니다.".to_owned());
                }
            }
        }
    }
}

#[cfg(windows)]
fn open_registry_writer_lock(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create(true)
        .share_mode(0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    let file = options
        .open(path)
        .map_err(|_| "계정 writer lock을 열지 못했습니다.".to_owned())?;
    let metadata = file
        .metadata()
        .map_err(|_| "계정 writer lock을 확인하지 못했습니다.".to_owned())?;
    if !metadata.is_file() || metadata_is_reparse(&metadata) {
        return Err("계정 writer lock 파일이 안전하지 않습니다.".to_owned());
    }
    Ok(file)
}

#[cfg(unix)]
fn open_registry_writer_lock(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let file = options
        .open(path)
        .map_err(|_| "계정 writer lock을 열지 못했습니다.".to_owned())?;
    // SAFETY: flock receives a live file descriptor and retains no Rust reference.
    let locked = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if locked != 0 {
        return Err("계정 writer lock을 획득하지 못했습니다.".to_owned());
    }
    Ok(file)
}

#[derive(Debug)]
struct LoginCancellation {
    state: AtomicU8,
}

impl LoginCancellation {
    fn new() -> Self {
        Self {
            state: AtomicU8::new(LOGIN_RUNNING),
        }
    }

    fn request_cancel(&self) -> bool {
        self.state
            .compare_exchange(
                LOGIN_RUNNING,
                LOGIN_CANCEL_REQUESTED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    fn is_cancelled(&self) -> bool {
        self.state.load(Ordering::Acquire) == LOGIN_CANCEL_REQUESTED
    }

    fn ensure_not_cancelled(&self) -> Result<(), String> {
        if self.is_cancelled() {
            Err(LOGIN_CANCELLED_MESSAGE.to_owned())
        } else {
            Ok(())
        }
    }

    fn begin_finalizing(&self) -> Result<(), String> {
        self.state
            .compare_exchange(
                LOGIN_RUNNING,
                LOGIN_FINALIZING,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .map(|_| ())
            .map_err(|state| {
                if state == LOGIN_CANCEL_REQUESTED {
                    LOGIN_CANCELLED_MESSAGE.to_owned()
                } else {
                    "계정 추가 작업의 완료 상태가 올바르지 않습니다.".to_owned()
                }
            })
    }
}

trait LoginRunner: Send + Sync {
    fn run(
        &self,
        provider: Provider,
        home: &Path,
        cancellation: &LoginCancellation,
    ) -> Result<i32, String>;
}

struct ProcessLoginRunner;

impl LoginRunner for ProcessLoginRunner {
    fn run(
        &self,
        provider: Provider,
        home: &Path,
        cancellation: &LoginCancellation,
    ) -> Result<i32, String> {
        cancellation.ensure_not_cancelled()?;
        let mut command = build_login_command(provider, home)?;
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);

        let mut child = command
            .spawn()
            .map_err(|_| "공식 CLI 로그인 프로세스를 시작하지 못했습니다.".to_owned())?;
        #[cfg(windows)]
        let mut login_job = LoginJob::attach(&child).ok();
        let started = Instant::now();
        loop {
            if cancellation.is_cancelled() {
                #[cfg(windows)]
                if let Some(job) = login_job.as_ref() {
                    let _ = job.terminate();
                }
                let _ = child.kill();
                let _ = child.wait();
                return Err(LOGIN_CANCELLED_MESSAGE.to_owned());
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    #[cfg(windows)]
                    if let Some(job) = login_job.as_mut() {
                        job.disarm()?;
                    }
                    return status.code().ok_or_else(|| {
                        "공식 CLI 로그인 프로세스가 비정상 종료되었습니다.".to_owned()
                    });
                }
                Ok(None) if started.elapsed() < LOGIN_TIMEOUT => {
                    thread::sleep(LOGIN_PROCESS_POLL_INTERVAL);
                }
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("공식 CLI 로그인이 제한 시간을 초과했습니다.".to_owned());
                }
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("공식 CLI 로그인 상태를 확인하지 못했습니다.".to_owned());
                }
            }
        }
    }
}

#[cfg(windows)]
struct LoginJob {
    handle: OwnedHandle,
    armed: bool,
}

#[cfg(windows)]
impl LoginJob {
    fn attach(child: &std::process::Child) -> Result<Self, String> {
        // SAFETY: null name and security attributes request an unnamed job with defaults.
        let raw_job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if raw_job.is_null() {
            return Err("OAuth 로그인 보호 작업을 만들지 못했습니다.".to_owned());
        }
        // SAFETY: CreateJobObjectW returned a new owned HANDLE.
        let handle = unsafe { OwnedHandle::from_raw_handle(raw_job) };
        set_login_job_kill_on_close(&handle, true)?;
        // SAFETY: Both handles remain valid for the duration of this call.
        let assigned =
            unsafe { AssignProcessToJobObject(handle.as_raw_handle(), child.as_raw_handle()) };
        if assigned == 0 {
            return Err("OAuth 로그인 프로세스를 보호 작업에 연결하지 못했습니다.".to_owned());
        }
        Ok(Self {
            handle,
            armed: true,
        })
    }

    fn disarm(&mut self) -> Result<(), String> {
        if self.armed {
            set_login_job_kill_on_close(&self.handle, false)?;
            self.armed = false;
        }
        Ok(())
    }

    fn terminate(&self) -> Result<(), String> {
        // SAFETY: the handle remains live for this call and refers to the login job.
        let terminated = unsafe { TerminateJobObject(self.handle.as_raw_handle(), 1) };
        if terminated == 0 {
            Err("OAuth 로그인 프로세스를 종료하지 못했습니다.".to_owned())
        } else {
            Ok(())
        }
    }
}

#[cfg(windows)]
fn set_login_job_kill_on_close(handle: &OwnedHandle, enabled: bool) -> Result<(), String> {
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    if enabled {
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    }
    // SAFETY: the pointer refers to a fully initialized structure for the documented info class.
    let configured = unsafe {
        SetInformationJobObject(
            handle.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            std::ptr::from_ref(&limits).cast(),
            std::mem::size_of_val(&limits) as u32,
        )
    };
    if configured == 0 {
        Err("OAuth 로그인 보호 작업을 설정하지 못했습니다.".to_owned())
    } else {
        Ok(())
    }
}

struct ProviderAccountServiceInner {
    paths: RegistryPaths,
    default_homes: ProviderHomes,
    registry: Mutex<RegistryDocument>,
    active_logins: Arc<Mutex<HashMap<Provider, Arc<LoginCancellation>>>>,
    login_runner: Arc<dyn LoginRunner>,
}

#[derive(Clone)]
pub(crate) struct ProviderAccountService {
    inner: Arc<ProviderAccountServiceInner>,
}

impl ProviderAccountService {
    pub(crate) fn open(app_local_data_dir: &Path) -> Result<Self, String> {
        Self::open_with_runner(
            app_local_data_dir,
            ProviderHomes::from_environment()?,
            Arc::new(ProcessLoginRunner),
        )
    }

    fn open_with_runner(
        app_local_data_dir: &Path,
        default_homes: ProviderHomes,
        login_runner: Arc<dyn LoginRunner>,
    ) -> Result<Self, String> {
        let paths = RegistryPaths::new(app_local_data_dir)?;
        let _writer = RegistryWriterLock::acquire(&paths)?;
        let mut registry = load_current_registry(&paths)?;
        repair_unavailable_active_homes(&paths, &mut registry)?;
        Ok(Self {
            inner: Arc::new(ProviderAccountServiceInner {
                paths,
                default_homes,
                registry: Mutex::new(registry),
                active_logins: Arc::new(Mutex::new(HashMap::new())),
                login_runner,
            }),
        })
    }

    pub(crate) fn list(&self, provider: &str) -> Result<ProviderAccountsResponse, String> {
        let provider = Provider::parse(provider)?;
        self.response(provider, false)
    }

    pub(crate) fn add(&self, provider: &str) -> Result<ProviderAccountsResponse, String> {
        let provider = Provider::parse(provider)?;
        let login_lease = self.acquire_login(provider)?;
        {
            let current = self.refresh_registry_from_disk()?;
            let provider_count = current
                .accounts
                .iter()
                .filter(|account| account.provider == provider)
                .count();
            if provider_count >= MAX_MANAGED_ACCOUNTS_PER_PROVIDER {
                return Err("이 제공자에 더 이상 계정을 추가할 수 없습니다.".to_owned());
            }
        }
        let (id, home) = self.create_managed_home(provider)?;
        let cleanup = ManagedHomeCleanup::new(self.inner.paths.managed_homes.clone(), provider, id);

        if provider == Provider::Codex {
            write_managed_codex_config(&home)?;
        }
        let exit_code = self
            .inner
            .login_runner
            .run(provider, &home, login_lease.cancellation())?;
        login_lease.ensure_not_cancelled()?;
        if exit_code != 0 {
            return Err(format!(
                "공식 CLI 로그인이 완료되지 않았습니다 (종료 코드 {exit_code})."
            ));
        }
        ensure_existing_managed_home(&self.inner.paths, &home)?;
        let account = provider_usage::read_provider_account_from_home(provider.as_str(), &home)?
            .ok_or_else(|| "로그인한 계정 정보를 확인하지 못했습니다.".to_owned())?;
        if account.auth_mode != provider.expected_oauth_mode() {
            return Err("OAuth 계정 로그인이 확인되지 않았습니다.".to_owned());
        }
        let display_label = validate_account_label(&account.display_label)?.to_owned();
        let normalized_label = display_label.to_lowercase();
        login_lease.ensure_not_cancelled()?;

        let duplicates_default_oauth = provider_usage::read_provider_account_from_home(
            provider.as_str(),
            self.inner.default_homes.get(provider),
        )?
        .is_some_and(|default_account| {
            default_account.auth_mode == provider.expected_oauth_mode()
                && default_account.display_label.to_lowercase() == normalized_label
        });

        if duplicates_default_oauth {
            login_lease.begin_finalizing()?;
            return self.response(provider, false);
        }

        {
            login_lease.ensure_not_cancelled()?;
            let _writer = RegistryWriterLock::acquire(&self.inner.paths)?;
            let current = load_current_registry(&self.inner.paths)?;
            let mut duplicates_managed_oauth = false;
            for existing in current
                .accounts
                .iter()
                .filter(|existing| existing.provider == provider)
            {
                if self
                    .live_managed_account_label(existing)?
                    .is_some_and(|label| label.to_lowercase() == normalized_label)
                {
                    duplicates_managed_oauth = true;
                    break;
                }
            }
            login_lease.ensure_not_cancelled()?;
            if duplicates_managed_oauth {
                login_lease.begin_finalizing()?;
                self.replace_registry_cache(current)?;
                return self.response(provider, false);
            }
            let provider_count = current
                .accounts
                .iter()
                .filter(|account| account.provider == provider)
                .count();
            if provider_count >= MAX_MANAGED_ACCOUNTS_PER_PROVIDER {
                return Err("이 제공자에 더 이상 계정을 추가할 수 없습니다.".to_owned());
            }
            let id_text = id.hyphenated().to_string();
            let mut next = current;
            next.accounts.push(ManagedAccountRecord {
                id: id_text,
                provider,
                display_label,
            });
            validate_registry(&next)?;
            login_lease.begin_finalizing()?;
            save_registry(&self.inner.paths, &next)?;
            self.replace_registry_cache(next)?;
        }

        cleanup.disarm();
        self.response(provider, false)
    }

    pub(crate) fn cancel_login(&self, provider: &str) -> Result<bool, String> {
        let provider = Provider::parse(provider)?;
        let cancellation = {
            let active = lock(&self.inner.active_logins, "로그인 상태")?;
            active.get(&provider).cloned()
        };
        let Some(cancellation) = cancellation else {
            return Ok(false);
        };

        let cancellation_requested = cancellation.request_cancel();
        let started = Instant::now();
        loop {
            let still_active = {
                let active = lock(&self.inner.active_logins, "로그인 상태")?;
                active
                    .get(&provider)
                    .is_some_and(|current| Arc::ptr_eq(current, &cancellation))
            };
            if !still_active {
                return Ok(cancellation_requested);
            }
            if started.elapsed() >= LOGIN_CANCEL_WAIT_TIMEOUT {
                return Err("계정 추가 취소를 기다리는 시간이 초과되었습니다.".to_owned());
            }
            thread::sleep(LOGIN_CANCEL_POLL_INTERVAL);
        }
    }

    pub(crate) fn switch(
        &self,
        provider: &str,
        account_id: &str,
    ) -> Result<ProviderAccountsResponse, String> {
        let provider = Provider::parse(provider)?;
        validate_account_id(account_id)?;
        let changed;
        {
            let _writer = RegistryWriterLock::acquire(&self.inner.paths)?;
            let current = load_current_registry(&self.inner.paths)?;
            if account_id != provider.default_account_id()
                && !current
                    .accounts
                    .iter()
                    .any(|account| account.provider == provider && account.id == account_id)
            {
                return Err("선택한 계정을 찾지 못했습니다.".to_owned());
            }
            if account_id != provider.default_account_id() {
                let home = self
                    .inner
                    .paths
                    .managed_home(provider, parse_managed_id(account_id)?);
                ensure_existing_managed_home(&self.inner.paths, &home)?;
            }
            changed = current.active_account_id(provider) != account_id;
            if changed {
                let mut next = current;
                next.set_active_account_id(provider, account_id.to_owned());
                validate_registry(&next)?;
                save_registry(&self.inner.paths, &next)?;
                self.replace_registry_cache(next)?;
            } else {
                self.replace_registry_cache(current)?;
            }
        }
        self.response(provider, changed)
    }

    #[cfg(test)]
    pub(crate) fn active_homes(&self) -> Result<ProviderHomes, String> {
        let registry = self.refresh_registry_from_disk()?;
        Ok(ProviderHomes {
            codex: self.resolve_home(&registry, Provider::Codex)?,
            grok: self.resolve_home(&registry, Provider::Grok)?,
        })
    }

    pub(crate) fn ensure_restart_ready(&self) -> Result<(), String> {
        if lock(&self.inner.active_logins, "로그인 상태")?.is_empty() {
            Ok(())
        } else {
            Err("계정 로그인이 진행 중이라 앱을 다시 시작할 수 없습니다.".to_owned())
        }
    }

    /// # Safety
    ///
    /// The caller must invoke this before any application worker threads are started. Rust
    /// process environment mutation is not safe while another thread may read the environment.
    pub(crate) unsafe fn apply_active_homes_to_environment(&self) -> Result<(), String> {
        let registry = self.refresh_registry_from_disk()?;
        let homes = ProviderHomes {
            codex: self.resolve_home(&registry, Provider::Codex)?,
            grok: self.resolve_home(&registry, Provider::Grok)?,
        };
        let codex_oauth_isolated =
            self.active_profile_requires_oauth_isolation(&registry, Provider::Codex, &homes.codex)?;
        let grok_oauth_isolated =
            self.active_profile_requires_oauth_isolation(&registry, Provider::Grok, &homes.grok)?;
        // SAFETY: The public contract of this method requires single-threaded startup.
        unsafe {
            env::set_var(
                Provider::Codex.default_home_environment_name(),
                &self.inner.default_homes.codex,
            );
            env::set_var(
                Provider::Grok.default_home_environment_name(),
                &self.inner.default_homes.grok,
            );
            env::set_var("CODEX_HOME", &homes.codex);
            env::set_var("GROK_HOME", &homes.grok);
            env::set_var(
                CODEX_OAUTH_ISOLATION_ENV,
                if codex_oauth_isolated { "1" } else { "0" },
            );
            env::set_var(
                GROK_OAUTH_ISOLATION_ENV,
                if grok_oauth_isolated { "1" } else { "0" },
            );
        }
        Ok(())
    }

    fn active_profile_requires_oauth_isolation(
        &self,
        registry: &RegistryDocument,
        provider: Provider,
        home: &Path,
    ) -> Result<bool, String> {
        if registry.active_account_id(provider) != provider.default_account_id() {
            // Managed profiles are created only through OAuth. Keep them isolated even if
            // their auth file is later removed so they never silently fall back to an
            // ambient API key belonging to another identity.
            return Ok(true);
        }
        Ok(
            provider_usage::read_provider_account_from_home(provider.as_str(), home)?
                .is_some_and(|account| account.auth_mode == provider.expected_oauth_mode()),
        )
    }

    fn response(
        &self,
        provider: Provider,
        restart_required: bool,
    ) -> Result<ProviderAccountsResponse, String> {
        let registry = self.refresh_registry_from_disk()?;
        let active_account_id = registry.active_account_id(provider).to_owned();
        let default_label = provider_usage::read_provider_account_from_home(
            provider.as_str(),
            self.inner.default_homes.get(provider),
        )?
        .map(|account| account.display_label)
        .or_else(|| default_environment_api_key_label(provider))
        .unwrap_or_else(|| provider.fallback_label().to_owned());
        let mut accounts = vec![ProviderAccountView {
            id: provider.default_account_id().to_owned(),
            display_label: default_label,
            active: active_account_id == provider.default_account_id(),
            managed: false,
        }];
        let mut managed = registry
            .accounts
            .iter()
            .filter(|account| account.provider == provider)
            .map(|account| {
                Ok(ProviderAccountView {
                    id: account.id.clone(),
                    display_label: self
                        .live_managed_account_label(account)?
                        .unwrap_or_else(|| provider.fallback_label().to_owned()),
                    active: active_account_id == account.id,
                    managed: true,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        managed.sort_by(|left, right| {
            left.display_label
                .to_lowercase()
                .cmp(&right.display_label.to_lowercase())
                .then_with(|| left.id.cmp(&right.id))
        });
        accounts.extend(managed);
        Ok(ProviderAccountsResponse {
            provider: provider.as_str().to_owned(),
            accounts,
            active_account_id,
            restart_required,
        })
    }

    fn resolve_home(
        &self,
        registry: &RegistryDocument,
        provider: Provider,
    ) -> Result<PathBuf, String> {
        let active = registry.active_account_id(provider);
        if active == provider.default_account_id() {
            return Ok(self.inner.default_homes.get(provider).to_path_buf());
        }
        let id = parse_managed_id(active)?;
        if !registry
            .accounts
            .iter()
            .any(|account| account.provider == provider && account.id == active)
        {
            return Err("활성 계정 메타데이터가 올바르지 않습니다.".to_owned());
        }
        let home = self.inner.paths.managed_home(provider, id);
        ensure_existing_managed_home(&self.inner.paths, &home)?;
        Ok(home)
    }

    fn create_managed_home(&self, provider: Provider) -> Result<(Uuid, PathBuf), String> {
        let provider_root = self.inner.paths.managed_homes.join(provider.as_str());
        fs::create_dir_all(&provider_root)
            .map_err(|_| "관리 계정 제공자 디렉터리를 만들지 못했습니다.".to_owned())?;
        reject_reparse_components(&provider_root)?;
        for _ in 0..8 {
            let id = Uuid::new_v4();
            let home = self.inner.paths.managed_home(provider, id);
            match fs::create_dir(&home) {
                Ok(()) => {
                    reject_reparse_components(&home)?;
                    return Ok((id, home));
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => return Err("관리 계정 홈을 만들지 못했습니다.".to_owned()),
            }
        }
        Err("고유한 관리 계정 홈을 만들지 못했습니다.".to_owned())
    }

    fn live_managed_account_label(
        &self,
        account: &ManagedAccountRecord,
    ) -> Result<Option<String>, String> {
        let home = self
            .inner
            .paths
            .managed_home(account.provider, parse_managed_id(&account.id)?);
        if !managed_home_is_available(&self.inner.paths, &home)? {
            return Ok(None);
        }
        Ok(
            provider_usage::read_provider_account_from_home(account.provider.as_str(), &home)?
                .filter(|summary| summary.auth_mode == account.provider.expected_oauth_mode())
                .and_then(|summary| {
                    validate_account_label(&summary.display_label)
                        .ok()
                        .map(str::to_owned)
                }),
        )
    }

    fn refresh_registry_from_disk(&self) -> Result<RegistryDocument, String> {
        let mut cache = self.lock_registry()?;
        let current = load_current_registry(&self.inner.paths)?;
        *cache = current.clone();
        Ok(current)
    }

    fn replace_registry_cache(&self, current: RegistryDocument) -> Result<(), String> {
        *self.lock_registry()? = current;
        Ok(())
    }

    fn acquire_login(&self, provider: Provider) -> Result<LoginLease, String> {
        let mut active = lock(&self.inner.active_logins, "로그인 상태")?;
        if active.contains_key(&provider) {
            return Err("이 제공자의 계정 로그인이 이미 진행 중입니다.".to_owned());
        }
        let cancellation = Arc::new(LoginCancellation::new());
        active.insert(provider, Arc::clone(&cancellation));
        Ok(LoginLease {
            active: Arc::clone(&self.inner.active_logins),
            provider,
            cancellation,
        })
    }

    fn lock_registry(&self) -> Result<MutexGuard<'_, RegistryDocument>, String> {
        lock(&self.inner.registry, "계정 레지스트리")
    }
}

struct LoginLease {
    active: Arc<Mutex<HashMap<Provider, Arc<LoginCancellation>>>>,
    provider: Provider,
    cancellation: Arc<LoginCancellation>,
}

impl LoginLease {
    fn cancellation(&self) -> &LoginCancellation {
        &self.cancellation
    }

    fn ensure_not_cancelled(&self) -> Result<(), String> {
        self.cancellation.ensure_not_cancelled()
    }

    fn begin_finalizing(&self) -> Result<(), String> {
        self.cancellation.begin_finalizing()
    }
}

impl Drop for LoginLease {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active.lock()
            && active
                .get(&self.provider)
                .is_some_and(|current| Arc::ptr_eq(current, &self.cancellation))
        {
            active.remove(&self.provider);
        }
    }
}

struct ManagedHomeCleanup {
    managed_homes: PathBuf,
    provider: Provider,
    id: Uuid,
    armed: bool,
}

impl ManagedHomeCleanup {
    fn new(managed_homes: PathBuf, provider: Provider, id: Uuid) -> Self {
        Self {
            managed_homes,
            provider,
            id,
            armed: true,
        }
    }

    fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for ManagedHomeCleanup {
    fn drop(&mut self) {
        if self.armed {
            let _ = remove_owned_managed_home(&self.managed_homes, self.provider, self.id);
        }
    }
}

struct TemporaryFileCleanup(Option<PathBuf>);

impl TemporaryFileCleanup {
    fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for TemporaryFileCleanup {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = fs::remove_file(path);
        }
    }
}

fn non_empty_environment_path(name: &str) -> Option<PathBuf> {
    non_empty_path(env::var_os(name))
}

fn default_environment_api_key_label(provider: Provider) -> Option<String> {
    let names = match provider {
        Provider::Codex => &["OPENAI_API_KEY"][..],
        Provider::Grok => &["XAI_API_KEY", "GROK_API_KEY"][..],
    };
    names
        .iter()
        .any(|name| env::var_os(name).is_some_and(|value| !value.is_empty()))
        .then(|| "Environment API key".to_owned())
}

fn non_empty_path(value: Option<OsString>) -> Option<PathBuf> {
    value.filter(|value| !value.is_empty()).map(PathBuf::from)
}

fn validate_absolute_home(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        Err("CLI 홈 디렉터리는 절대 경로여야 합니다.".to_owned())
    } else {
        Ok(())
    }
}

fn validate_account_label(value: &str) -> Result<&str, String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.chars().count() > MAX_ACCOUNT_LABEL_CHARS
        || trimmed.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '\u{200b}'..='\u{200f}'
                        | '\u{202a}'..='\u{202e}'
                        | '\u{2060}'..='\u{206f}'
                        | '\u{feff}'
                )
        })
    {
        return Err("계정 표시 이름이 올바르지 않습니다.".to_owned());
    }
    Ok(trimmed)
}

fn validate_account_id(value: &str) -> Result<(), String> {
    let id = parse_managed_id(value)?;
    if value != id.hyphenated().to_string() {
        return Err("계정 식별자가 올바르지 않습니다.".to_owned());
    }
    Ok(())
}

fn parse_managed_id(value: &str) -> Result<Uuid, String> {
    Uuid::parse_str(value).map_err(|_| "계정 식별자가 올바르지 않습니다.".to_owned())
}

fn validate_registry(document: &RegistryDocument) -> Result<(), String> {
    if document.schema_version != REGISTRY_SCHEMA_VERSION {
        return Err("지원하지 않는 계정 레지스트리 버전입니다.".to_owned());
    }
    validate_account_id(&document.active_codex_account_id)?;
    validate_account_id(&document.active_grok_account_id)?;
    let mut ids = HashSet::new();
    let mut codex_count = 0_usize;
    let mut grok_count = 0_usize;
    for account in &document.accounts {
        validate_account_id(&account.id)?;
        if account.id == DEFAULT_CODEX_ACCOUNT_ID
            || account.id == DEFAULT_GROK_ACCOUNT_ID
            || !ids.insert(account.id.clone())
        {
            return Err("계정 레지스트리에 중복 식별자가 있습니다.".to_owned());
        }
        validate_account_label(&account.display_label)?;
        match account.provider {
            Provider::Codex => codex_count += 1,
            Provider::Grok => grok_count += 1,
        }
    }
    if codex_count > MAX_MANAGED_ACCOUNTS_PER_PROVIDER
        || grok_count > MAX_MANAGED_ACCOUNTS_PER_PROVIDER
    {
        return Err("계정 레지스트리의 계정 수가 제한을 초과했습니다.".to_owned());
    }
    for (provider, active) in [
        (Provider::Codex, document.active_account_id(Provider::Codex)),
        (Provider::Grok, document.active_account_id(Provider::Grok)),
    ] {
        if active != provider.default_account_id()
            && !document
                .accounts
                .iter()
                .any(|account| account.provider == provider && account.id == active)
        {
            return Err("활성 계정이 레지스트리에 없습니다.".to_owned());
        }
    }
    Ok(())
}

fn load_current_registry(paths: &RegistryPaths) -> Result<RegistryDocument, String> {
    let registry = load_registry(&paths.registry)?.unwrap_or_default();
    validate_registry(&registry)?;
    Ok(registry)
}

fn load_registry(path: &Path) -> Result<Option<RegistryDocument>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("계정 레지스트리를 확인하지 못했습니다.".to_owned()),
    };
    if !metadata.is_file() || metadata_is_reparse(&metadata) || metadata.len() > MAX_REGISTRY_BYTES
    {
        return Err("계정 레지스트리 파일이 안전하지 않습니다.".to_owned());
    }
    let mut file = File::open(path).map_err(|_| "계정 레지스트리를 열지 못했습니다.".to_owned())?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    Read::by_ref(&mut file)
        .take(MAX_REGISTRY_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "계정 레지스트리를 읽지 못했습니다.".to_owned())?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_REGISTRY_BYTES {
        return Err("계정 레지스트리 크기가 올바르지 않습니다.".to_owned());
    }
    let final_metadata = file
        .metadata()
        .map_err(|_| "계정 레지스트리를 다시 확인하지 못했습니다.".to_owned())?;
    if !final_metadata.is_file()
        || metadata_is_reparse(&final_metadata)
        || final_metadata.len() > MAX_REGISTRY_BYTES
    {
        return Err("계정 레지스트리가 읽는 동안 변경되었습니다.".to_owned());
    }
    let document = serde_json::from_slice::<RegistryDocument>(&bytes)
        .map_err(|_| "계정 레지스트리 형식이 올바르지 않습니다.".to_owned())?;
    Ok(Some(document))
}

fn save_registry(paths: &RegistryPaths, document: &RegistryDocument) -> Result<(), String> {
    validate_registry(document)?;
    reject_reparse_components(&paths.root)?;
    if let Ok(metadata) = fs::symlink_metadata(&paths.registry)
        && (!metadata.is_file() || metadata_is_reparse(&metadata))
    {
        return Err("계정 레지스트리 대상이 안전하지 않습니다.".to_owned());
    }
    let bytes = serde_json::to_vec_pretty(document)
        .map_err(|_| "계정 레지스트리를 직렬화하지 못했습니다.".to_owned())?;
    if bytes.len() as u64 > MAX_REGISTRY_BYTES {
        return Err("계정 레지스트리가 너무 큽니다.".to_owned());
    }
    let temporary = paths.root.join(format!(
        ".{REGISTRY_FILE_NAME}.{}.tmp",
        Uuid::new_v4().simple()
    ));
    let mut cleanup = TemporaryFileCleanup(Some(temporary.clone()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| "계정 레지스트리 임시 파일을 만들지 못했습니다.".to_owned())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "계정 레지스트리 임시 파일을 기록하지 못했습니다.".to_owned())?;
    drop(file);
    let verified = fs::read(&temporary)
        .map_err(|_| "계정 레지스트리 임시 파일을 검증하지 못했습니다.".to_owned())?;
    if verified != bytes {
        return Err("계정 레지스트리 임시 파일 검증에 실패했습니다.".to_owned());
    }
    atomic_replace(&temporary, &paths.registry)?;
    cleanup.disarm();
    // The destination is already the committed source of truth. A directory fsync failure must
    // not make the caller delete a managed home that the committed registry now references.
    let _ = sync_directory(&paths.root);
    Ok(())
}

fn write_managed_codex_config(home: &Path) -> Result<(), String> {
    reject_reparse_components(home)?;
    let path = home.join("config.toml");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| "Codex 계정 설정을 만들지 못했습니다.".to_owned())?;
    file.write_all(b"cli_auth_credentials_store = \"file\"\n")
        .and_then(|_| file.sync_all())
        .map_err(|_| "Codex 계정 설정을 기록하지 못했습니다.".to_owned())
}

fn repair_unavailable_active_homes(
    paths: &RegistryPaths,
    registry: &mut RegistryDocument,
) -> Result<(), String> {
    let mut repaired = false;
    for provider in [Provider::Codex, Provider::Grok] {
        let active = registry.active_account_id(provider).to_owned();
        if active == provider.default_account_id() {
            continue;
        }
        let home = paths.managed_home(provider, parse_managed_id(&active)?);
        if !managed_home_is_available(paths, &home).unwrap_or(false) {
            registry.set_active_account_id(provider, provider.default_account_id().to_owned());
            repaired = true;
        }
    }
    if repaired {
        validate_registry(registry)?;
        save_registry(paths, registry)?;
    }
    Ok(())
}

fn ensure_existing_managed_home(paths: &RegistryPaths, home: &Path) -> Result<(), String> {
    if managed_home_is_available(paths, home)? {
        Ok(())
    } else {
        Err("관리 계정 홈을 찾지 못했습니다.".to_owned())
    }
}

fn managed_home_is_available(paths: &RegistryPaths, home: &Path) -> Result<bool, String> {
    let parent = home
        .parent()
        .ok_or_else(|| "관리 계정 홈 경로가 올바르지 않습니다.".to_owned())?;
    let provider_parent = parent
        .parent()
        .ok_or_else(|| "관리 계정 홈 경로가 올바르지 않습니다.".to_owned())?;
    if provider_parent != paths.managed_homes {
        return Err("관리 계정 홈이 허용된 경로 밖에 있습니다.".to_owned());
    }
    reject_reparse_components(home)?;
    let metadata = match fs::symlink_metadata(home) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err("관리 계정 홈을 확인하지 못했습니다.".to_owned()),
    };
    if !metadata.is_dir() || metadata_is_reparse(&metadata) {
        return Err("관리 계정 홈이 안전하지 않습니다.".to_owned());
    }
    Ok(true)
}

fn remove_owned_managed_home(
    managed_homes: &Path,
    provider: Provider,
    id: Uuid,
) -> Result<(), String> {
    let provider_root = managed_homes.join(provider.as_str());
    let home = provider_root.join(id.hyphenated().to_string());
    if home.parent() != Some(provider_root.as_path())
        || provider_root.parent() != Some(managed_homes)
    {
        return Err("관리 계정 정리 경로가 올바르지 않습니다.".to_owned());
    }
    let metadata = match fs::symlink_metadata(&home) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("관리 계정 정리 대상을 확인하지 못했습니다.".to_owned()),
    };
    reject_reparse_components(&home)?;
    if !metadata.is_dir() || metadata_is_reparse(&metadata) {
        return Err("관리 계정 정리 대상이 안전하지 않습니다.".to_owned());
    }
    fs::remove_dir_all(home).map_err(|_| "관리 계정 임시 홈을 정리하지 못했습니다.".to_owned())
}

fn reject_reparse_components(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("계정 저장 경로는 절대 경로여야 합니다.".to_owned());
    }
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata_is_reparse(&metadata) => {
                return Err("계정 저장 경로에 심볼릭 링크 또는 재분석 지점이 있습니다.".to_owned());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(_) => return Err("계정 저장 경로를 검증하지 못했습니다.".to_owned()),
        }
    }
    Ok(())
}

#[cfg(windows)]
fn metadata_is_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> Result<(), String> {
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
        .map_err(|_| "계정 레지스트리 대상을 확인하지 못했습니다.".to_owned())?;
    let result = if destination_exists {
        // SAFETY: Both path buffers are live, NUL-terminated UTF-16 strings for this call.
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
        // SAFETY: Both path buffers are live, NUL-terminated UTF-16 strings for this call.
        unsafe {
            MoveFileExW(
                source_wide.as_ptr(),
                destination_wide.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
    };
    if result == 0 {
        Err("계정 레지스트리를 원자적으로 교체하지 못했습니다.".to_owned())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination)
        .map_err(|_| "계정 레지스트리를 원자적으로 교체하지 못했습니다.".to_owned())
}

#[cfg(windows)]
fn sync_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
fn sync_directory(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "계정 레지스트리 디렉터리를 동기화하지 못했습니다.".to_owned())
}

enum LoginExecutable {
    Direct(PathBuf),
    CommandScript { shell: PathBuf, script: PathBuf },
}

fn build_login_command(provider: Provider, home: &Path) -> Result<Command, String> {
    let arguments = match provider {
        Provider::Codex => &["login"][..],
        Provider::Grok => &["login", "--oauth"][..],
    };
    let executable = resolve_provider_executable(provider)?;
    let mut command = match executable {
        LoginExecutable::Direct(path) => {
            let mut command = Command::new(path);
            command.args(arguments);
            command
        }
        #[cfg(windows)]
        LoginExecutable::CommandScript { shell, script } => {
            let command_line = windows_command_script_line(&script, arguments)?;
            let mut command = Command::new(shell);
            command.args(["/D", "/V:OFF", "/S", "/C"]);
            command.arg(command_line);
            command
        }
        #[cfg(not(windows))]
        LoginExecutable::CommandScript { .. } => unreachable!(),
    };
    configure_login_environment(&mut command, provider, home);
    Ok(command)
}

fn configure_login_environment(command: &mut Command, provider: Provider, home: &Path) {
    command.env(provider.home_environment_name(), home);
    for name in OAUTH_CREDENTIAL_ENVIRONMENT_NAMES {
        command.env_remove(name);
    }
}

fn resolve_provider_executable(provider: Provider) -> Result<LoginExecutable, String> {
    #[cfg(windows)]
    {
        let command_name = provider.as_str();
        let fallback = match provider {
            Provider::Codex => non_empty_environment_path("LOCALAPPDATA").map(|root| {
                root.join("Programs")
                    .join("OpenAI")
                    .join("Codex")
                    .join("bin")
                    .join("codex.exe")
            }),
            Provider::Grok => non_empty_environment_path("USERPROFILE")
                .map(|root| root.join(".grok").join("bin").join("grok.exe")),
        };
        if let Some(path) = fallback.filter(|path| is_regular_non_reparse_file(path)) {
            return Ok(LoginExecutable::Direct(path));
        }
        if let Some((path, is_script)) = find_executable_on_path(command_name) {
            return if is_script {
                Ok(LoginExecutable::CommandScript {
                    shell: resolve_windows_command_shell()?,
                    script: path,
                })
            } else {
                Ok(LoginExecutable::Direct(path))
            };
        }
        Err("공식 CLI 실행 파일을 찾지 못했습니다.".to_owned())
    }
    #[cfg(not(windows))]
    {
        Ok(LoginExecutable::Direct(PathBuf::from(provider.as_str())))
    }
}

#[cfg(windows)]
fn find_executable_on_path(name: &str) -> Option<(PathBuf, bool)> {
    let path = env::var_os("PATH")?;
    for directory in env::split_paths(&path) {
        let executable = directory.join(format!("{name}.exe"));
        if is_regular_non_reparse_file(&executable) {
            return Some((executable, false));
        }
        let script = directory.join(format!("{name}.cmd"));
        if is_regular_non_reparse_file(&script) {
            return Some((script, true));
        }
    }
    None
}

#[cfg(windows)]
fn is_regular_non_reparse_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && !metadata_is_reparse(&metadata))
}

#[cfg(windows)]
fn resolve_windows_command_shell() -> Result<PathBuf, String> {
    let candidates = [
        env::var_os("COMSPEC").map(PathBuf::from),
        non_empty_environment_path("SystemRoot").map(|root| root.join("System32").join("cmd.exe")),
    ];
    candidates
        .into_iter()
        .flatten()
        .find(|path| {
            path.is_absolute()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.eq_ignore_ascii_case("cmd.exe"))
                && is_regular_non_reparse_file(path)
        })
        .ok_or_else(|| "Windows 명령 셸을 안전하게 찾지 못했습니다.".to_owned())
}

#[cfg(windows)]
fn windows_command_script_line(script: &Path, arguments: &[&str]) -> Result<OsString, String> {
    let script = script
        .to_str()
        .filter(|value| {
            !value.is_empty()
                && !value
                    .chars()
                    .any(|character| matches!(character, '\0' | '\r' | '\n' | '"' | '%'))
        })
        .ok_or_else(|| "CLI 명령 스크립트 경로가 안전하지 않습니다.".to_owned())?;
    if arguments.iter().any(|argument| {
        argument.is_empty()
            || !argument
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    }) {
        return Err("CLI 로그인 인수가 안전하지 않습니다.".to_owned());
    }
    Ok(OsString::from(format!(
        "\"\"{script}\" {}\"",
        arguments.join(" ")
    )))
}

fn lock<'a, T>(mutex: &'a Mutex<T>, name: &str) -> Result<MutexGuard<'a, T>, String> {
    mutex
        .lock()
        .map_err(|_| format!("{name} 잠금이 손상되었습니다."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use std::sync::{Barrier, Condvar, mpsc};

    struct FixtureLoginRunner;

    fn codex_oauth_fixture(email: &str) -> Vec<u8> {
        let payload = URL_SAFE_NO_PAD.encode(format!(
            r#"{{"email":"{email}","https://api.openai.com/auth":{{"chatgpt_plan_type":"plus"}}}}"#
        ));
        format!(r#"{{"tokens":{{"id_token":"header.{payload}.signature"}}}}"#).into_bytes()
    }

    impl LoginRunner for FixtureLoginRunner {
        fn run(
            &self,
            provider: Provider,
            home: &Path,
            cancellation: &LoginCancellation,
        ) -> Result<i32, String> {
            cancellation.ensure_not_cancelled()?;
            let bytes = match provider {
                Provider::Codex => codex_oauth_fixture("codex@example.invalid"),
                Provider::Grok => {
                    br#"{"fixture":{"email":"grok@example.invalid","refresh_token":"never-store-this"}}"#
                        .to_vec()
                }
            };
            fs::write(home.join("auth.json"), bytes)
                .map_err(|_| "fixture auth write failed".to_owned())?;
            Ok(0)
        }
    }

    struct BlockingLoginRunner {
        entered: Arc<Barrier>,
        release: Arc<(Mutex<bool>, Condvar)>,
    }

    struct CancellationAwareLoginRunner {
        entered: Arc<Barrier>,
    }

    impl LoginRunner for CancellationAwareLoginRunner {
        fn run(
            &self,
            provider: Provider,
            home: &Path,
            cancellation: &LoginCancellation,
        ) -> Result<i32, String> {
            FixtureLoginRunner.run(provider, home, cancellation)?;
            self.entered.wait();
            loop {
                cancellation.ensure_not_cancelled()?;
                thread::sleep(Duration::from_millis(5));
            }
        }
    }

    struct CancelAfterSuccessfulLoginRunner;

    impl LoginRunner for CancelAfterSuccessfulLoginRunner {
        fn run(
            &self,
            provider: Provider,
            home: &Path,
            cancellation: &LoginCancellation,
        ) -> Result<i32, String> {
            FixtureLoginRunner.run(provider, home, cancellation)?;
            assert!(cancellation.request_cancel());
            Ok(0)
        }
    }

    impl LoginRunner for BlockingLoginRunner {
        fn run(
            &self,
            provider: Provider,
            home: &Path,
            cancellation: &LoginCancellation,
        ) -> Result<i32, String> {
            FixtureLoginRunner.run(provider, home, cancellation)?;
            self.entered.wait();
            let (lock, signal) = &*self.release;
            let mut released = lock.lock().unwrap();
            while !*released {
                released = signal.wait(released).unwrap();
            }
            cancellation.ensure_not_cancelled()?;
            Ok(0)
        }
    }

    fn defaults(root: &Path) -> ProviderHomes {
        let codex = root.join("default-codex");
        let grok = root.join("default-grok");
        fs::create_dir_all(&codex).unwrap();
        fs::create_dir_all(&grok).unwrap();
        ProviderHomes { codex, grok }
    }

    fn service(root: &Path) -> ProviderAccountService {
        ProviderAccountService::open_with_runner(root, defaults(root), Arc::new(FixtureLoginRunner))
            .unwrap()
    }

    #[test]
    fn list_contains_only_the_default_pseudo_profile_initially() {
        let directory = tempfile::tempdir().unwrap();
        let service = service(directory.path());
        let response = service.list("codex").unwrap();
        assert_eq!(response.provider, "codex");
        assert_eq!(response.active_account_id, DEFAULT_CODEX_ACCOUNT_ID);
        assert!(!response.restart_required);
        assert_eq!(response.accounts.len(), 1);
        assert_eq!(response.accounts[0].id, DEFAULT_CODEX_ACCOUNT_ID);
        assert!(!response.accounts[0].managed);
        assert!(response.accounts[0].active);
    }

    #[test]
    fn add_persists_metadata_without_auth_secrets_or_home_paths() {
        let directory = tempfile::tempdir().unwrap();
        let service = service(directory.path());
        let response = service.add("grok").unwrap();
        assert!(!response.restart_required);
        assert_eq!(response.active_account_id, DEFAULT_GROK_ACCOUNT_ID);
        assert_eq!(response.accounts.len(), 2);

        let registry = fs::read_to_string(&service.inner.paths.registry).unwrap();
        assert!(registry.contains("grok@example.invalid"));
        assert!(!registry.contains("never-store-this"));
        assert!(!registry.contains("refresh_token"));
        assert!(!registry.contains("auth.json"));
        assert!(!registry.contains(directory.path().to_string_lossy().as_ref()));
    }

    #[test]
    fn adding_the_same_oauth_identity_twice_does_not_duplicate_it() {
        let directory = tempfile::tempdir().unwrap();
        let service = service(directory.path());
        let first = service.add("codex").unwrap();
        let second = service.add("codex").unwrap();
        assert_eq!(first.accounts.len(), 2);
        assert_eq!(second.accounts.len(), 2);
        assert_eq!(second.active_account_id, DEFAULT_CODEX_ACCOUNT_ID);
        assert!(!second.restart_required);
        assert_eq!(
            fs::read_dir(service.inner.paths.managed_homes.join("codex"))
                .unwrap()
                .count(),
            1
        );
    }

    #[test]
    fn managed_oauth_does_not_duplicate_the_same_default_oauth_identity() {
        let directory = tempfile::tempdir().unwrap();
        let default_homes = defaults(directory.path());
        FixtureLoginRunner
            .run(
                Provider::Codex,
                &default_homes.codex,
                &LoginCancellation::new(),
            )
            .unwrap();
        let service = ProviderAccountService::open_with_runner(
            directory.path(),
            default_homes,
            Arc::new(FixtureLoginRunner),
        )
        .unwrap();

        let response = service.add("codex").unwrap();

        assert_eq!(response.accounts.len(), 1);
        assert_eq!(response.active_account_id, DEFAULT_CODEX_ACCOUNT_ID);
        assert!(!response.restart_required);
        assert_eq!(
            fs::read_dir(service.inner.paths.managed_homes.join("codex"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn default_api_key_label_is_not_treated_as_the_managed_oauth_identity() {
        let directory = tempfile::tempdir().unwrap();
        let default_homes = defaults(directory.path());
        fs::write(
            default_homes.codex.join("auth.json"),
            br#"{"OPENAI_API_KEY":"fixture-only","tokens":null}"#,
        )
        .unwrap();
        let service = ProviderAccountService::open_with_runner(
            directory.path(),
            default_homes,
            Arc::new(FixtureLoginRunner),
        )
        .unwrap();

        let response = service.add("codex").unwrap();

        assert_eq!(response.accounts.len(), 2);
        assert_eq!(response.active_account_id, DEFAULT_CODEX_ACCOUNT_ID);
    }

    #[test]
    fn managed_codex_profile_forces_file_credential_storage() {
        let directory = tempfile::tempdir().unwrap();
        let service = service(directory.path());
        let response = service.add("codex").unwrap();
        let id = response
            .accounts
            .iter()
            .find(|account| account.managed)
            .and_then(|account| Uuid::parse_str(&account.id).ok())
            .unwrap();
        let config = fs::read_to_string(
            service
                .inner
                .paths
                .managed_home(Provider::Codex, id)
                .join("config.toml"),
        )
        .unwrap();
        assert_eq!(config, "cli_auth_credentials_store = \"file\"\n");
        assert!(!config.contains("token"));
    }

    #[test]
    fn switch_is_persisted_and_reports_restart_only_for_a_change() {
        let directory = tempfile::tempdir().unwrap();
        let service = service(directory.path());
        let added = service.add("codex").unwrap();
        let id = added
            .accounts
            .iter()
            .find(|account| account.managed)
            .unwrap()
            .id
            .clone();
        assert!(service.switch("codex", &id).unwrap().restart_required);
        assert!(!service.switch("codex", &id).unwrap().restart_required);
        assert!(
            service
                .switch("codex", DEFAULT_CODEX_ACCOUNT_ID)
                .unwrap()
                .restart_required
        );

        let reopened = ProviderAccountService::open_with_runner(
            directory.path(),
            defaults(directory.path()),
            Arc::new(FixtureLoginRunner),
        )
        .unwrap();
        assert_eq!(
            reopened.list("codex").unwrap().active_account_id,
            DEFAULT_CODEX_ACCOUNT_ID
        );
    }

    #[test]
    fn active_homes_resolve_only_registered_managed_directories() {
        let directory = tempfile::tempdir().unwrap();
        let service = service(directory.path());
        let defaults = service.inner.default_homes.clone();
        let initial = service.active_homes().unwrap();
        assert_eq!(initial.codex, defaults.codex);
        let added = service.add("codex").unwrap();
        let managed_id = added
            .accounts
            .iter()
            .find(|account| account.managed)
            .and_then(|account| Uuid::parse_str(&account.id).ok())
            .unwrap();
        service
            .switch("codex", &managed_id.hyphenated().to_string())
            .unwrap();
        let active = service.active_homes().unwrap();
        assert_eq!(
            active.codex,
            service
                .inner
                .paths
                .managed_home(Provider::Codex, managed_id)
        );
        assert_eq!(active.grok, defaults.grok);
    }

    #[test]
    fn managed_account_labels_follow_the_current_bounded_auth_file() {
        let directory = tempfile::tempdir().unwrap();
        let service = service(directory.path());
        let added = service.add("codex").unwrap();
        let managed = added
            .accounts
            .iter()
            .find(|account| account.managed)
            .unwrap();
        let id = Uuid::parse_str(&managed.id).unwrap();
        let home = service.inner.paths.managed_home(Provider::Codex, id);
        fs::write(
            home.join("auth.json"),
            codex_oauth_fixture("changed@example.invalid"),
        )
        .unwrap();

        let refreshed = service.list("codex").unwrap();
        assert_eq!(
            refreshed
                .accounts
                .iter()
                .find(|account| account.managed)
                .unwrap()
                .display_label,
            "changed@example.invalid"
        );

        fs::remove_file(home.join("auth.json")).unwrap();
        let logged_out = service.list("codex").unwrap();
        assert_eq!(
            logged_out
                .accounts
                .iter()
                .find(|account| account.managed)
                .unwrap()
                .display_label,
            "로그인 안 됨"
        );
    }

    #[test]
    fn missing_active_managed_home_recovers_to_default_and_cannot_be_selected() {
        let directory = tempfile::tempdir().unwrap();
        let service = service(directory.path());
        let added = service.add("codex").unwrap();
        let id = added
            .accounts
            .iter()
            .find(|account| account.managed)
            .unwrap()
            .id
            .clone();
        service.switch("codex", &id).unwrap();
        let home = service
            .inner
            .paths
            .managed_home(Provider::Codex, Uuid::parse_str(&id).unwrap());
        fs::remove_dir_all(home).unwrap();
        assert!(service.switch("codex", DEFAULT_CODEX_ACCOUNT_ID).is_ok());
        assert!(service.switch("codex", &id).is_err());

        {
            let mut registry = service.lock_registry().unwrap();
            registry.set_active_account_id(Provider::Codex, id);
            save_registry(&service.inner.paths, &registry).unwrap();
        }
        let reopened = ProviderAccountService::open_with_runner(
            directory.path(),
            defaults(directory.path()),
            Arc::new(FixtureLoginRunner),
        )
        .unwrap();
        assert_eq!(
            reopened.list("codex").unwrap().active_account_id,
            DEFAULT_CODEX_ACCOUNT_ID
        );
        let persisted = load_registry(&reopened.inner.paths.registry)
            .unwrap()
            .unwrap();
        assert_eq!(
            persisted.active_account_id(Provider::Codex),
            DEFAULT_CODEX_ACCOUNT_ID
        );
    }

    #[test]
    fn a_provider_rejects_overlapping_login_attempts() {
        let directory = tempfile::tempdir().unwrap();
        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let service = ProviderAccountService::open_with_runner(
            directory.path(),
            defaults(directory.path()),
            Arc::new(BlockingLoginRunner {
                entered: Arc::clone(&entered),
                release: Arc::clone(&release),
            }),
        )
        .unwrap();
        let first = service.clone();
        let worker = thread::spawn(move || first.add("codex"));
        entered.wait();
        let second = service.add("codex").unwrap_err();
        assert!(second.contains("이미 진행 중"));
        let (lock, signal) = &*release;
        *lock.lock().unwrap() = true;
        signal.notify_all();
        assert!(worker.join().unwrap().is_ok());
    }

    #[test]
    fn cancelling_an_active_login_waits_for_cleanup_and_unblocks_the_provider() {
        let directory = tempfile::tempdir().unwrap();
        let entered = Arc::new(Barrier::new(2));
        let service = ProviderAccountService::open_with_runner(
            directory.path(),
            defaults(directory.path()),
            Arc::new(CancellationAwareLoginRunner {
                entered: Arc::clone(&entered),
            }),
        )
        .unwrap();
        let worker_service = service.clone();
        let (finished_tx, finished_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            let _ = finished_tx.send(worker_service.add("codex"));
        });
        entered.wait();

        assert!(service.ensure_restart_ready().is_err());
        let started = Instant::now();
        assert!(service.cancel_login("codex").unwrap());
        assert!(started.elapsed() < LOGIN_CANCEL_WAIT_TIMEOUT);
        let result = finished_rx
            .recv_timeout(Duration::from_millis(250))
            .expect("cancelled add must return promptly");
        assert_eq!(result.unwrap_err(), LOGIN_CANCELLED_MESSAGE);
        worker.join().unwrap();

        assert!(service.ensure_restart_ready().is_ok());
        assert!(!service.cancel_login("codex").unwrap());
        assert_eq!(service.list("codex").unwrap().accounts.len(), 1);
        assert_eq!(
            fs::read_dir(service.inner.paths.managed_homes.join("codex"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn cancellation_after_runner_success_prevents_registry_commit() {
        let directory = tempfile::tempdir().unwrap();
        let service = ProviderAccountService::open_with_runner(
            directory.path(),
            defaults(directory.path()),
            Arc::new(CancelAfterSuccessfulLoginRunner),
        )
        .unwrap();

        assert_eq!(service.add("grok").unwrap_err(), LOGIN_CANCELLED_MESSAGE);
        assert_eq!(service.list("grok").unwrap().accounts.len(), 1);
        assert_eq!(
            fs::read_dir(service.inner.paths.managed_homes.join("grok"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn stale_login_lease_never_removes_a_newer_provider_token() {
        let old = Arc::new(LoginCancellation::new());
        let current = Arc::new(LoginCancellation::new());
        let active = Arc::new(Mutex::new(HashMap::from([(
            Provider::Codex,
            Arc::clone(&current),
        )])));
        let stale = LoginLease {
            active: Arc::clone(&active),
            provider: Provider::Codex,
            cancellation: old,
        };

        drop(stale);

        let stored = active.lock().unwrap().get(&Provider::Codex).cloned();
        assert!(stored.is_some_and(|value| Arc::ptr_eq(&value, &current)));
    }

    #[test]
    fn independent_services_serialize_commits_and_reload_the_latest_registry() {
        let directory = tempfile::tempdir().unwrap();
        let first = service(directory.path());
        let second = ProviderAccountService::open_with_runner(
            directory.path(),
            defaults(directory.path()),
            Arc::new(FixtureLoginRunner),
        )
        .unwrap();
        let first_worker = first.clone();
        let second_worker = second.clone();

        let codex = thread::spawn(move || first_worker.add("codex"));
        let grok = thread::spawn(move || second_worker.add("grok"));
        let codex = codex.join().unwrap().unwrap();
        let grok = grok.join().unwrap().unwrap();

        assert_eq!(codex.accounts.len(), 2);
        assert_eq!(grok.accounts.len(), 2);
        assert_eq!(first.list("codex").unwrap().accounts.len(), 2);
        assert_eq!(first.list("grok").unwrap().accounts.len(), 2);
        assert_eq!(second.list("codex").unwrap().accounts.len(), 2);
        assert_eq!(second.list("grok").unwrap().accounts.len(), 2);
        let codex_id = codex
            .accounts
            .iter()
            .find(|account| account.managed)
            .unwrap()
            .id
            .clone();
        second.switch("codex", &codex_id).unwrap();
        assert_eq!(first.list("codex").unwrap().active_account_id, codex_id);
        assert_eq!(
            load_current_registry(&first.inner.paths)
                .unwrap()
                .accounts
                .len(),
            2
        );
    }

    #[test]
    fn writer_lock_rejects_a_second_writer_until_the_first_releases() {
        let directory = tempfile::tempdir().unwrap();
        let paths = RegistryPaths::new(directory.path()).unwrap();
        let held = RegistryWriterLock::acquire(&paths).unwrap();

        let error = RegistryWriterLock::acquire_with_timeout(&paths, Duration::from_millis(75))
            .err()
            .expect("a second writer must not enter");
        assert!(error.contains("다른 IHATECODING"));

        drop(held);
        assert!(
            RegistryWriterLock::acquire_with_timeout(&paths, Duration::from_millis(75)).is_ok()
        );
    }

    #[test]
    fn malformed_or_unknown_registry_fields_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let paths = RegistryPaths::new(directory.path()).unwrap();
        fs::write(
            &paths.registry,
            br#"{"schemaVersion":1,"activeCodexAccountId":"default","activeGrokAccountId":"default","accounts":[],"secret":"no"}"#,
        )
        .unwrap();
        let error = ProviderAccountService::open_with_runner(
            directory.path(),
            defaults(directory.path()),
            Arc::new(FixtureLoginRunner),
        )
        .err()
        .expect("unknown registry fields must fail");
        assert!(error.contains("형식"));
    }

    #[cfg(unix)]
    #[test]
    fn registry_symlink_is_rejected() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let paths = RegistryPaths::new(directory.path()).unwrap();
        let target = directory.path().join("outside.json");
        fs::write(&target, b"{}").unwrap();
        symlink(&target, &paths.registry).unwrap();
        let error = load_registry(&paths.registry).unwrap_err();
        assert!(error.contains("안전"));
    }

    #[test]
    fn relative_registry_root_is_rejected() {
        assert!(ProviderAccountService::open(Path::new("relative-root")).is_err());
    }

    #[test]
    fn inherited_managed_homes_do_not_replace_stable_default_homes() {
        let directory = tempfile::tempdir().unwrap();
        let baseline_codex = directory.path().join("baseline-codex");
        let baseline_grok = directory.path().join("baseline-grok");
        let inherited_managed_codex = directory.path().join("managed-codex");
        let homes = ProviderHomes::from_lookup(|name| match name {
            DEFAULT_CODEX_HOME_ENV => Some(baseline_codex.clone().into_os_string()),
            DEFAULT_GROK_HOME_ENV => Some(baseline_grok.clone().into_os_string()),
            "CODEX_HOME" => Some(inherited_managed_codex.clone().into_os_string()),
            "USERPROFILE" => Some(directory.path().to_path_buf().into_os_string()),
            _ => None,
        })
        .unwrap();
        assert_eq!(homes.codex, baseline_codex);
        assert_eq!(homes.grok, baseline_grok);
    }

    #[test]
    fn default_oauth_profiles_require_ambient_api_key_isolation() {
        let directory = tempfile::tempdir().unwrap();
        let default_homes = defaults(directory.path());
        FixtureLoginRunner
            .run(
                Provider::Codex,
                &default_homes.codex,
                &LoginCancellation::new(),
            )
            .unwrap();
        FixtureLoginRunner
            .run(
                Provider::Grok,
                &default_homes.grok,
                &LoginCancellation::new(),
            )
            .unwrap();
        let service = ProviderAccountService::open_with_runner(
            directory.path(),
            default_homes.clone(),
            Arc::new(FixtureLoginRunner),
        )
        .unwrap();
        let registry = service.refresh_registry_from_disk().unwrap();

        assert!(
            service
                .active_profile_requires_oauth_isolation(
                    &registry,
                    Provider::Codex,
                    &default_homes.codex,
                )
                .unwrap()
        );
        assert!(
            service
                .active_profile_requires_oauth_isolation(
                    &registry,
                    Provider::Grok,
                    &default_homes.grok,
                )
                .unwrap()
        );

        fs::write(
            default_homes.codex.join("auth.json"),
            br#"{"OPENAI_API_KEY":"fixture-only","tokens":null}"#,
        )
        .unwrap();
        assert!(
            !service
                .active_profile_requires_oauth_isolation(
                    &registry,
                    Provider::Codex,
                    &default_homes.codex,
                )
                .unwrap()
        );
    }

    #[test]
    fn managed_oauth_profile_stays_isolated_after_logout() {
        let directory = tempfile::tempdir().unwrap();
        let service = service(directory.path());
        let added = service.add("codex").unwrap();
        let id = added
            .accounts
            .iter()
            .find(|account| account.managed)
            .unwrap()
            .id
            .clone();
        service.switch("codex", &id).unwrap();
        let registry = service.refresh_registry_from_disk().unwrap();
        let home = service.resolve_home(&registry, Provider::Codex).unwrap();
        fs::remove_file(home.join("auth.json")).unwrap();

        assert!(
            service
                .active_profile_requires_oauth_isolation(&registry, Provider::Codex, &home)
                .unwrap()
        );
    }

    #[test]
    fn account_response_exposes_only_the_public_contract() {
        let directory = tempfile::tempdir().unwrap();
        let response = service(directory.path()).add("codex").unwrap();
        let value = serde_json::to_value(response).unwrap();
        let object = value.as_object().unwrap();
        assert_eq!(
            object.keys().map(String::as_str).collect::<HashSet<_>>(),
            HashSet::from(["provider", "accounts", "activeAccountId", "restartRequired"])
        );
        for account in object["accounts"].as_array().unwrap() {
            assert_eq!(
                account
                    .as_object()
                    .unwrap()
                    .keys()
                    .map(String::as_str)
                    .collect::<HashSet<_>>(),
                HashSet::from(["id", "displayLabel", "active", "managed"])
            );
        }
        let serialized = serde_json::to_string(&object).unwrap();
        for forbidden in ["home", "path", "plan", "authMode", "token"] {
            assert!(!serialized.contains(forbidden));
        }
    }

    #[test]
    fn login_environment_removes_all_ambient_api_credentials() {
        let directory = tempfile::tempdir().unwrap();
        let mut command = Command::new("unused");
        configure_login_environment(&mut command, Provider::Codex, directory.path());
        let environments = command
            .get_envs()
            .map(|(name, value)| (name.to_owned(), value.map(OsString::from)))
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(
            environments.get(std::ffi::OsStr::new("CODEX_HOME")),
            Some(&Some(directory.path().as_os_str().to_owned()))
        );
        for name in OAUTH_CREDENTIAL_ENVIRONMENT_NAMES {
            assert_eq!(
                environments.get(std::ffi::OsStr::new(name)),
                Some(&None),
                "{name} must be removed"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn command_script_invocation_quotes_a_path_with_spaces_and_fixed_arguments() {
        let line = windows_command_script_line(
            Path::new(r"C:\Program Files\Grok CLI\grok.cmd"),
            &["login", "--oauth"],
        )
        .unwrap();
        assert_eq!(
            line,
            OsString::from(r#"""C:\Program Files\Grok CLI\grok.cmd" login --oauth""#)
        );
        assert!(
            windows_command_script_line(Path::new(r"C:\unsafe%PATH%\grok.cmd"), &["login"])
                .is_err()
        );
    }

    #[test]
    fn cleanup_removes_only_the_exact_owned_uuid_home() {
        let directory = tempfile::tempdir().unwrap();
        let managed_homes = directory.path().join("homes");
        let provider_root = managed_homes.join("codex");
        fs::create_dir_all(&provider_root).unwrap();
        let id = Uuid::new_v4();
        let owned = provider_root.join(id.hyphenated().to_string());
        fs::create_dir(&owned).unwrap();
        fs::write(owned.join("auth.json"), b"fixture").unwrap();
        let unrelated = directory.path().join("unrelated");
        fs::create_dir(&unrelated).unwrap();

        remove_owned_managed_home(&managed_homes, Provider::Codex, id).unwrap();

        assert!(!owned.exists());
        assert!(unrelated.exists());
    }
}
