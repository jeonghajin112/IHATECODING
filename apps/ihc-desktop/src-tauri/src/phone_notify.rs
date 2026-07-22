use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

const SETTINGS_FILE_NAME: &str = "phone-notifications.json";
const SETTINGS_VERSION: u8 = 1;
const MAX_SETTINGS_BYTES: u64 = 32 * 1024;
const MAX_PROTECTED_WEBHOOK_BYTES: usize = 16 * 1024;
const MAX_WEBHOOK_URL_BYTES: usize = 2_048;
const MAX_DISPLAY_NAME_CHARS: usize = 80;
const MAX_DISPLAY_NAME_BYTES: usize = 256;
const DELIVERY_LEDGER_FILE_NAME: &str = "phone-notification-delivery-v1.log";
const DELIVERY_LEDGER_LOCK_FILE_NAME: &str = "phone-notification-delivery-v1.lock";
const DELIVERY_LEDGER_HEADER: &str = "IHATECODING-PHONE-NOTIFICATION-DELIVERY-V1\n";
const DELIVERY_LEDGER_HASH_BYTES: usize = 32;
const DELIVERY_LEDGER_HASH_HEX_LEN: usize = DELIVERY_LEDGER_HASH_BYTES * 2;
const MAX_DELIVERY_LEDGER_BYTES: u64 = 64 * 1024 * 1024;
const DELIVERY_LEDGER_LOCK_TIMEOUT: Duration = Duration::from_secs(3);
const DELIVERY_LEDGER_LOCK_RETRY: Duration = Duration::from_millis(10);
const DISCORD_HOST: &str = "discord.com";
const DISCORD_LEGACY_HOST: &str = "discordapp.com";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PhoneNotificationSettings {
    pub(crate) enabled: bool,
    pub(crate) webhook_configured: bool,
    pub(crate) notify_on_success: bool,
    pub(crate) notify_on_error: bool,
    pub(crate) notify_on_safety_check: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SavePhoneNotificationSettingsRequest {
    pub(crate) enabled: bool,
    pub(crate) webhook_url: Option<String>,
    pub(crate) clear_webhook: bool,
    pub(crate) notify_on_success: bool,
    pub(crate) notify_on_error: bool,
    pub(crate) notify_on_safety_check: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PhoneNotificationKind {
    Success,
    Error,
    SafetyCheck,
    Test,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PhoneNotificationAgent {
    Powershell,
    Codex,
    Grok,
    Claude,
    Opencode,
    Cline,
    Cursor,
}

impl PhoneNotificationAgent {
    fn display_name(self) -> &'static str {
        match self {
            Self::Powershell => "PowerShell",
            Self::Codex => "Codex",
            Self::Grok => "Grok",
            Self::Claude => "Claude Code",
            Self::Opencode => "OpenCode",
            Self::Cline => "Cline",
            Self::Cursor => "Cursor",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SendPhoneNotificationRequest {
    pub(crate) kind: PhoneNotificationKind,
    pub(crate) event_id: String,
    pub(crate) project_name: String,
    pub(crate) terminal_name: String,
    pub(crate) agent: PhoneNotificationAgent,
    #[serde(default)]
    pub(crate) model_name: Option<String>,
    pub(crate) language: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PhoneNotificationResult {
    pub(crate) sent: bool,
}

#[derive(Clone)]
struct RuntimeSettings {
    enabled: bool,
    webhook_url: Option<String>,
    notify_on_success: bool,
    notify_on_error: bool,
    notify_on_safety_check: bool,
}

impl Default for RuntimeSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            webhook_url: None,
            notify_on_success: true,
            notify_on_error: true,
            notify_on_safety_check: true,
        }
    }
}

impl RuntimeSettings {
    fn public(&self) -> PhoneNotificationSettings {
        PhoneNotificationSettings {
            enabled: self.enabled,
            webhook_configured: self.webhook_url.is_some(),
            notify_on_success: self.notify_on_success,
            notify_on_error: self.notify_on_error,
            notify_on_safety_check: self.notify_on_safety_check,
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiskSettings {
    version: u8,
    enabled: bool,
    protected_webhook: Option<String>,
    notify_on_success: bool,
    notify_on_error: bool,
    #[serde(default = "default_enabled_notification_kind")]
    notify_on_safety_check: bool,
}

const fn default_enabled_notification_kind() -> bool {
    true
}

pub(crate) struct PhoneNotificationService {
    path: PathBuf,
    delivery_ledger_path: PathBuf,
    delivery_lock_path: PathBuf,
    settings: Mutex<RuntimeSettings>,
    delivery_gate: Mutex<()>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PublishFailureStage {
    DefinitelyBeforeSend,
    SendAttempted,
}

#[derive(Debug)]
struct PublishFailure {
    message: String,
    stage: PublishFailureStage,
}

impl PublishFailure {
    fn before_send(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            stage: PublishFailureStage::DefinitelyBeforeSend,
        }
    }

    fn send_attempted(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            stage: PublishFailureStage::SendAttempted,
        }
    }
}

impl PhoneNotificationService {
    pub(crate) fn open(app_local_data_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(app_local_data_dir).map_err(|_| {
            "Could not create the phone notification settings directory.".to_owned()
        })?;
        let path = app_local_data_dir.join(SETTINGS_FILE_NAME);
        let delivery_ledger_path = app_local_data_dir.join(DELIVERY_LEDGER_FILE_NAME);
        let delivery_lock_path = app_local_data_dir.join(DELIVERY_LEDGER_LOCK_FILE_NAME);
        // Corrupt, legacy, or undecryptable settings must never leave notifications enabled.
        let settings = load_settings(&path).unwrap_or_default();
        Ok(Self {
            path,
            delivery_ledger_path,
            delivery_lock_path,
            settings: Mutex::new(settings),
            delivery_gate: Mutex::new(()),
        })
    }

    pub(crate) fn settings(&self) -> Result<PhoneNotificationSettings, String> {
        self.settings
            .lock()
            .map(|settings| settings.public())
            .map_err(|_| "Phone notification settings are unavailable.".to_owned())
    }

    pub(crate) fn save(
        &self,
        request: SavePhoneNotificationSettingsRequest,
    ) -> Result<PhoneNotificationSettings, String> {
        if request.clear_webhook && request.webhook_url.is_some() {
            return Err(
                "Choose either a new Discord webhook or clear the existing one.".to_owned(),
            );
        }

        let mut next = self
            .settings
            .lock()
            .map_err(|_| "Phone notification settings are unavailable.".to_owned())?
            .clone();
        if request.clear_webhook {
            next.webhook_url = None;
        } else if let Some(candidate) = request.webhook_url.as_deref() {
            next.webhook_url = Some(normalize_webhook_url(candidate)?);
        }
        next.enabled = request.enabled;
        next.notify_on_success = request.notify_on_success;
        next.notify_on_error = request.notify_on_error;
        next.notify_on_safety_check = request.notify_on_safety_check;
        if next.enabled && next.webhook_url.is_none() {
            return Err("Configure a Discord webhook before enabling notifications.".to_owned());
        }

        save_settings(&self.path, &next)?;
        let public = next.public();
        *self
            .settings
            .lock()
            .map_err(|_| "Phone notification settings are unavailable.".to_owned())? = next;
        Ok(public)
    }

    pub(crate) fn send(
        &self,
        request: SendPhoneNotificationRequest,
    ) -> Result<PhoneNotificationResult, String> {
        self.send_with_publisher(request, publish_discord)
    }

    fn send_with_publisher<F>(
        &self,
        request: SendPhoneNotificationRequest,
        publisher: F,
    ) -> Result<PhoneNotificationResult, String>
    where
        F: FnOnce(&str, &[u8]) -> Result<(), PublishFailure>,
    {
        validate_event_id(&request.event_id)?;
        let project_name = normalize_display_name(&request.project_name, "project")?;
        let terminal_name = normalize_display_name(&request.terminal_name, "CLI")?;
        let model_name = request
            .model_name
            .as_deref()
            .map(|value| normalize_display_name(value, "model"))
            .transpose()?;
        let settings = self
            .settings
            .lock()
            .map_err(|_| "Phone notification settings are unavailable.".to_owned())?
            .clone();
        if !settings.enabled || !kind_enabled(&settings, request.kind) {
            return Ok(PhoneNotificationResult { sent: false });
        }
        let webhook_url = settings.webhook_url.as_deref().ok_or_else(|| {
            "Discord notifications are enabled without a configured webhook.".to_owned()
        })?;
        // Build everything that can fail locally before durably reserving the event.
        let payload = notification_payload(
            request.kind,
            &project_name,
            &terminal_name,
            request.agent,
            model_name.as_deref(),
            request.language.as_deref(),
        )?;
        if request.kind != PhoneNotificationKind::Test && !self.reserve_event(&request.event_id)? {
            return Ok(PhoneNotificationResult { sent: false });
        }

        let result = publisher(webhook_url, &payload);
        if let Err(failure) = result {
            // Once WinHttpSendRequest has been attempted, Discord may have accepted the message
            // even when its acknowledgement is lost. Keep that event reserved permanently so a
            // frontend retry (or a restarted app replay) cannot create a second webhook message.
            if request.kind != PhoneNotificationKind::Test
                && failure.stage == PublishFailureStage::DefinitelyBeforeSend
            {
                let _ = self.release_event(&request.event_id);
            }
            return Err(failure.message);
        }
        Ok(PhoneNotificationResult { sent: true })
    }

    fn reserve_event(&self, event_id: &str) -> Result<bool, String> {
        let event_hash = delivery_event_hash(event_id);
        let _gate = self
            .delivery_gate
            .lock()
            .map_err(|_| "Phone notification delivery history is unavailable.".to_owned())?;
        with_delivery_ledger_lock(&self.delivery_lock_path, || {
            let current = load_delivery_ledger(&self.delivery_ledger_path)?;
            if current.contains(&event_hash) {
                return Ok(false);
            }
            append_delivery_ledger_record(&self.delivery_ledger_path, '+', &event_hash)?;
            Ok(true)
        })
    }

    fn release_event(&self, event_id: &str) -> Result<(), String> {
        let event_hash = delivery_event_hash(event_id);
        let _gate = self
            .delivery_gate
            .lock()
            .map_err(|_| "Phone notification delivery history is unavailable.".to_owned())?;
        with_delivery_ledger_lock(&self.delivery_lock_path, || {
            let mut current = load_delivery_ledger(&self.delivery_ledger_path)?;
            if current.remove(&event_hash) {
                append_delivery_ledger_record(&self.delivery_ledger_path, '-', &event_hash)?;
            }
            Ok(())
        })
    }
}

fn delivery_event_hash(event_id: &str) -> String {
    const DOMAIN: &[u8] = b"IHATECODING phone notification event v1\0";
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut hasher = Sha256::new();
    hasher.update(DOMAIN);
    hasher.update(event_id.as_bytes());
    let digest = hasher.finalize();
    let mut encoded = String::with_capacity(DELIVERY_LEDGER_HASH_HEX_LEN);
    for byte in digest {
        encoded.push(HEX[usize::from(byte >> 4)] as char);
        encoded.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    encoded
}

fn valid_delivery_hash(value: &str) -> bool {
    value.len() == DELIVERY_LEDGER_HASH_HEX_LEN
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn load_delivery_ledger(path: &Path) -> Result<HashSet<String>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(HashSet::new());
        }
        Err(_) => {
            return Err("Phone notification delivery history is unavailable.".to_owned());
        }
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_DELIVERY_LEDGER_BYTES
    {
        return Err("Phone notification delivery history is unavailable.".to_owned());
    }
    let bytes = fs::read(path)
        .map_err(|_| "Phone notification delivery history is unavailable.".to_owned())?;
    if bytes.is_empty() {
        return Ok(HashSet::new());
    }
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| "Phone notification delivery history is unavailable.".to_owned())?;
    let records = text
        .strip_prefix(DELIVERY_LEDGER_HEADER)
        .ok_or_else(|| "Phone notification delivery history is unavailable.".to_owned())?;
    if !records.is_empty() && !records.ends_with('\n') {
        return Err("Phone notification delivery history is unavailable.".to_owned());
    }
    let mut present = HashSet::new();
    for record in records.lines() {
        let bytes = record.as_bytes();
        if bytes.len() != DELIVERY_LEDGER_HASH_HEX_LEN + 1 || !matches!(bytes[0], b'+' | b'-') {
            return Err("Phone notification delivery history is unavailable.".to_owned());
        }
        let event_hash = &record[1..];
        if !valid_delivery_hash(event_hash) {
            return Err("Phone notification delivery history is unavailable.".to_owned());
        }
        if bytes[0] == b'+' {
            present.insert(event_hash.to_owned());
        } else {
            present.remove(event_hash);
        }
    }
    Ok(present)
}

fn append_delivery_ledger_record(
    path: &Path,
    operation: char,
    event_hash: &str,
) -> Result<(), String> {
    if !matches!(operation, '+' | '-') || !valid_delivery_hash(event_hash) {
        return Err("Phone notification delivery history is unavailable.".to_owned());
    }
    if let Ok(metadata) = fs::symlink_metadata(path)
        && (!metadata.is_file() || metadata.file_type().is_symlink())
    {
        return Err("Phone notification delivery history is unavailable.".to_owned());
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|_| "Phone notification delivery history is unavailable.".to_owned())?;
    let length = file
        .metadata()
        .map_err(|_| "Phone notification delivery history is unavailable.".to_owned())?
        .len();
    let record = format!("{operation}{event_hash}\n");
    let added = if length == 0 {
        DELIVERY_LEDGER_HEADER.len() + record.len()
    } else {
        record.len()
    };
    if length.saturating_add(added as u64) > MAX_DELIVERY_LEDGER_BYTES {
        return Err("Phone notification delivery history is full.".to_owned());
    }
    if length == 0 {
        file.write_all(DELIVERY_LEDGER_HEADER.as_bytes())
            .map_err(|_| "Phone notification delivery history is unavailable.".to_owned())?;
    }
    file.write_all(record.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|_| "Phone notification delivery history is unavailable.".to_owned())
}

fn with_delivery_ledger_lock<T>(
    lock_path: &Path,
    action: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _lock = acquire_delivery_ledger_lock(lock_path)?;
    action()
}

#[cfg(windows)]
struct DeliveryLedgerLock {
    _file: File,
}

#[cfg(windows)]
fn acquire_delivery_ledger_lock(path: &Path) -> Result<DeliveryLedgerLock, String> {
    use std::os::windows::fs::OpenOptionsExt;

    let started = Instant::now();
    loop {
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).share_mode(0);
        match options.open(path) {
            Ok(file) => return Ok(DeliveryLedgerLock { _file: file }),
            Err(_) if started.elapsed() < DELIVERY_LEDGER_LOCK_TIMEOUT => {
                thread::sleep(DELIVERY_LEDGER_LOCK_RETRY);
            }
            Err(_) => {
                return Err("Phone notification delivery history is busy.".to_owned());
            }
        }
    }
}

#[cfg(not(windows))]
struct DeliveryLedgerLock {
    _file: File,
    path: PathBuf,
}

#[cfg(not(windows))]
impl Drop for DeliveryLedgerLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(not(windows))]
fn acquire_delivery_ledger_lock(path: &Path) -> Result<DeliveryLedgerLock, String> {
    let started = Instant::now();
    loop {
        match OpenOptions::new().write(true).create_new(true).open(path) {
            Ok(file) => {
                return Ok(DeliveryLedgerLock {
                    _file: file,
                    path: path.to_path_buf(),
                });
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::AlreadyExists
                    && started.elapsed() < DELIVERY_LEDGER_LOCK_TIMEOUT =>
            {
                thread::sleep(DELIVERY_LEDGER_LOCK_RETRY);
            }
            Err(_) => {
                return Err("Phone notification delivery history is busy.".to_owned());
            }
        }
    }
}

fn load_settings(path: &Path) -> Option<RuntimeSettings> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_SETTINGS_BYTES
    {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    let disk = serde_json::from_slice::<DiskSettings>(&bytes).ok()?;
    if disk.version != SETTINGS_VERSION {
        return None;
    }
    let webhook_url = match disk.protected_webhook {
        Some(encoded) if encoded.len() <= MAX_PROTECTED_WEBHOOK_BYTES => {
            let protected = BASE64_STANDARD.decode(encoded).ok()?;
            let plain = unprotect_secret(&protected).ok()?;
            Some(normalize_webhook_url(&plain).ok()?)
        }
        Some(_) => return None,
        None => None,
    };
    if disk.enabled && webhook_url.is_none() {
        return None;
    }
    Some(RuntimeSettings {
        enabled: disk.enabled,
        webhook_url,
        notify_on_success: disk.notify_on_success,
        notify_on_error: disk.notify_on_error,
        notify_on_safety_check: disk.notify_on_safety_check,
    })
}

fn save_settings(path: &Path, settings: &RuntimeSettings) -> Result<(), String> {
    if let Ok(metadata) = fs::symlink_metadata(path)
        && (!metadata.is_file() || metadata.file_type().is_symlink())
    {
        return Err("The phone notification settings path is not a regular file.".to_owned());
    }
    let protected_webhook = settings
        .webhook_url
        .as_deref()
        .map(protect_secret)
        .transpose()?
        .map(|protected| BASE64_STANDARD.encode(protected));
    let disk = DiskSettings {
        version: SETTINGS_VERSION,
        enabled: settings.enabled,
        protected_webhook,
        notify_on_success: settings.notify_on_success,
        notify_on_error: settings.notify_on_error,
        notify_on_safety_check: settings.notify_on_safety_check,
    };
    let bytes = serde_json::to_vec_pretty(&disk)
        .map_err(|_| "Could not encode phone notification settings.".to_owned())?;
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)
        .map_err(|_| "Could not save phone notification settings.".to_owned())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Could not save phone notification settings.".to_owned())
}

struct DiscordWebhookEndpoint {
    host: &'static str,
    path: String,
}

fn normalize_webhook_url(candidate: &str) -> Result<String, String> {
    let candidate = candidate.trim();
    let endpoint = parse_webhook_url(candidate)?;
    Ok(format!("https://{}{}", endpoint.host, endpoint.path))
}

fn parse_webhook_url(candidate: &str) -> Result<DiscordWebhookEndpoint, String> {
    if candidate.is_empty()
        || candidate.len() > MAX_WEBHOOK_URL_BYTES
        || !candidate.is_ascii()
        || candidate.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err("Enter a valid Discord webhook URL.".to_owned());
    }
    let rest = candidate
        .strip_prefix("https://")
        .ok_or_else(|| "Discord webhook URLs must use HTTPS.".to_owned())?;
    if rest.contains(['?', '#', '\\', '%']) {
        return Err("Enter a Discord webhook URL without query parameters.".to_owned());
    }
    let slash = rest
        .find('/')
        .ok_or_else(|| "Enter a valid Discord webhook URL.".to_owned())?;
    let _accepted_host = match &rest[..slash] {
        value if value.eq_ignore_ascii_case(DISCORD_HOST) => DISCORD_HOST,
        value if value.eq_ignore_ascii_case(DISCORD_LEGACY_HOST) => DISCORD_LEGACY_HOST,
        _ => return Err("Only official Discord webhook hosts are supported.".to_owned()),
    };
    let path = &rest[slash..];
    let segments = path
        .strip_prefix('/')
        .unwrap_or(path)
        .split('/')
        .collect::<Vec<_>>();
    let (webhook_id, token) = match segments.as_slice() {
        ["api", "webhooks", webhook_id, token] | ["api", "v10", "webhooks", webhook_id, token] => {
            (*webhook_id, *token)
        }
        _ => return Err("Enter a valid Discord webhook URL.".to_owned()),
    };
    if !(16..=20).contains(&webhook_id.len())
        || !webhook_id.bytes().all(|byte| byte.is_ascii_digit())
        || !(40..=128).contains(&token.len())
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("Enter a valid Discord webhook URL.".to_owned());
    }
    // Accept Discord's legacy hostname and unversioned copied URLs as input, but never connect
    // to them. Canonicalizing here keeps all outbound requests on the current official endpoint.
    Ok(DiscordWebhookEndpoint {
        host: DISCORD_HOST,
        path: format!("/api/v10/webhooks/{webhook_id}/{token}"),
    })
}

fn normalize_display_name(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > MAX_DISPLAY_NAME_BYTES
        || value.chars().count() > MAX_DISPLAY_NAME_CHARS
        || value.chars().any(is_unsafe_name_character)
    {
        return Err(format!("The {label} name is invalid."));
    }
    Ok(value.to_owned())
}

fn is_unsafe_name_character(character: char) -> bool {
    character.is_control()
        || matches!(
            character,
            '\u{200B}'..='\u{200F}'
                | '\u{202A}'..='\u{202E}'
                | '\u{2060}'..='\u{206F}'
                | '\u{FEFF}'
        )
}

fn escape_discord_markdown(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if matches!(
            character,
            '\\' | '*' | '_' | '~' | '`' | '>' | '#' | '[' | ']' | '(' | ')' | '|' | '<' | '@'
        ) {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

fn notification_payload(
    kind: PhoneNotificationKind,
    project_name: &str,
    terminal_name: &str,
    agent: PhoneNotificationAgent,
    model_name: Option<&str>,
    language: Option<&str>,
) -> Result<Vec<u8>, String> {
    let korean = language.is_some_and(|value| value.eq_ignore_ascii_case("ko"));
    let (icon, status, color) = match (kind, korean) {
        (PhoneNotificationKind::Success, false) => ("✅", "completed", 0x57_f2_87_u32),
        (PhoneNotificationKind::Error, false) => ("⚠️", "error", 0xed_42_45_u32),
        (PhoneNotificationKind::SafetyCheck, false) => {
            ("🛡️", "waiting for a safety check", 0xfe_e7_5c_u32)
        }
        (PhoneNotificationKind::Test, false) => ("🔔", "Discord notification test", 0x99_aa_b5_u32),
        (PhoneNotificationKind::Success, true) => ("✅", "작업 완료", 0x57_f2_87_u32),
        (PhoneNotificationKind::Error, true) => ("⚠️", "오류 발생", 0xed_42_45_u32),
        (PhoneNotificationKind::SafetyCheck, true) => ("🛡️", "안전 검사 대기", 0xfe_e7_5c_u32),
        (PhoneNotificationKind::Test, true) => ("🔔", "Discord 알림 테스트", 0x99_aa_b5_u32),
    };
    let agent_name = agent.display_name();
    let content = format!(
        "{icon} [{} · {}] {} {status}",
        escape_discord_markdown(project_name),
        escape_discord_markdown(agent_name),
        escape_discord_markdown(terminal_name),
    );
    let (project_label, agent_label, terminal_label, model_label) = if korean {
        ("프로젝트", "에이전트", "CLI 창", "모델")
    } else {
        ("Project", "Agent", "CLI pane", "Model")
    };
    let mut fields = vec![
        serde_json::json!({
            "name": project_label,
            "value": escape_discord_markdown(project_name),
            "inline": true,
        }),
        serde_json::json!({
            "name": agent_label,
            "value": escape_discord_markdown(agent_name),
            "inline": true,
        }),
        serde_json::json!({
            "name": terminal_label,
            "value": escape_discord_markdown(terminal_name),
            "inline": true,
        }),
    ];
    if let Some(model_name) = model_name {
        fields.push(serde_json::json!({
            "name": model_label,
            "value": escape_discord_markdown(model_name),
            "inline": true,
        }));
    }
    serde_json::to_vec(&serde_json::json!({
        "content": content,
        "username": "IHATECODING",
        "allowed_mentions": { "parse": [] },
        "embeds": [{
            "title": format!("{icon} {status}"),
            "color": color,
            "fields": fields,
            "footer": { "text": "IHATECODING" },
        }],
    }))
    .map_err(|_| "Could not encode the Discord notification.".to_owned())
}

fn validate_event_id(event_id: &str) -> Result<(), String> {
    if event_id.is_empty()
        || event_id.len() > 256
        || !event_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
    {
        return Err("The phone notification event identifier is invalid.".to_owned());
    }
    Ok(())
}

fn kind_enabled(settings: &RuntimeSettings, kind: PhoneNotificationKind) -> bool {
    match kind {
        PhoneNotificationKind::Success => settings.notify_on_success,
        PhoneNotificationKind::Error => settings.notify_on_error,
        PhoneNotificationKind::SafetyCheck => settings.notify_on_safety_check,
        PhoneNotificationKind::Test => true,
    }
}

#[cfg(windows)]
fn protect_secret(secret: &str) -> Result<Vec<u8>, String> {
    use std::ptr;
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData},
    };

    const ENTROPY: &[u8] = b"IHATECODING Discord Webhook v1";
    let input_length = u32::try_from(secret.len())
        .map_err(|_| "The Discord webhook secret is too long.".to_owned())?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: input_length,
        pbData: secret.as_ptr().cast_mut(),
    };
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: ENTROPY.len() as u32,
        pbData: ENTROPY.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: All blobs point to live buffers for the duration of the call. DPAPI allocates
    // output with LocalAlloc, and the returned allocation is copied before LocalFree.
    let succeeded = unsafe {
        CryptProtectData(
            &input,
            ptr::null(),
            &entropy,
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if succeeded == 0 || output.pbData.is_null() {
        return Err("Could not protect the Discord webhook.".to_owned());
    }
    // SAFETY: DPAPI returned output.pbData with exactly output.cbData initialized bytes.
    let protected =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    // SAFETY: output.pbData is the LocalAlloc allocation returned by CryptProtectData.
    unsafe {
        let _ = LocalFree(output.pbData.cast());
    }
    Ok(protected)
}

#[cfg(not(windows))]
fn protect_secret(_secret: &str) -> Result<Vec<u8>, String> {
    Err("Secure Discord webhook storage is only available on Windows.".to_owned())
}

#[cfg(windows)]
fn unprotect_secret(protected: &[u8]) -> Result<String, String> {
    use std::ptr;
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
        },
    };

    const ENTROPY: &[u8] = b"IHATECODING Discord Webhook v1";
    let input_length = u32::try_from(protected.len())
        .map_err(|_| "The protected Discord webhook is invalid.".to_owned())?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: input_length,
        pbData: protected.as_ptr().cast_mut(),
    };
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: ENTROPY.len() as u32,
        pbData: ENTROPY.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: All input blobs point to live buffers. DPAPI allocates the output buffer.
    let succeeded = unsafe {
        CryptUnprotectData(
            &input,
            ptr::null_mut(),
            &entropy,
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if succeeded == 0 || output.pbData.is_null() {
        return Err("Could not unlock the Discord webhook.".to_owned());
    }
    // SAFETY: DPAPI returned output.pbData with exactly output.cbData initialized bytes.
    let secret = unsafe {
        std::str::from_utf8(std::slice::from_raw_parts(
            output.pbData,
            output.cbData as usize,
        ))
        .map(str::to_owned)
    };
    // SAFETY: The allocation belongs to this function. Clear plaintext before LocalFree.
    unsafe {
        std::ptr::write_bytes(output.pbData, 0, output.cbData as usize);
        let _ = LocalFree(output.pbData.cast());
    }
    secret.map_err(|_| "The protected Discord webhook is invalid.".to_owned())
}

#[cfg(not(windows))]
fn unprotect_secret(_protected: &[u8]) -> Result<String, String> {
    Err("Secure Discord webhook storage is only available on Windows.".to_owned())
}

#[cfg(windows)]
fn publish_discord(webhook_url: &str, payload: &[u8]) -> Result<(), PublishFailure> {
    use std::{ffi::c_void, mem, ptr};
    use windows_sys::Win32::Networking::WinHttp::{
        WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_FLAG_SECURE, WINHTTP_OPTION_REDIRECT_POLICY,
        WINHTTP_OPTION_REDIRECT_POLICY_NEVER, WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_STATUS_CODE,
        WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest, WinHttpQueryHeaders,
        WinHttpReceiveResponse, WinHttpSendRequest, WinHttpSetOption, WinHttpSetTimeouts,
    };

    struct WinHttpHandle(*mut c_void);
    impl Drop for WinHttpHandle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: The handle is owned by this wrapper and closed exactly once.
                unsafe {
                    let _ = WinHttpCloseHandle(self.0);
                }
            }
        }
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn handle(value: *mut c_void) -> Result<WinHttpHandle, PublishFailure> {
        if value.is_null() {
            Err(PublishFailure::before_send(
                "Could not initialize the Discord notification request.",
            ))
        } else {
            Ok(WinHttpHandle(value))
        }
    }

    let endpoint = parse_webhook_url(webhook_url).map_err(PublishFailure::before_send)?;
    let user_agent = wide("IHATECODING/1.0");
    // SAFETY: Null-terminated UTF-16 strings remain live for the call; null proxy pointers select
    // the system automatic proxy configuration.
    let session = handle(unsafe {
        WinHttpOpen(
            user_agent.as_ptr(),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            ptr::null(),
            ptr::null(),
            0,
        )
    })?;
    // SAFETY: session is a valid WinHTTP session handle.
    if unsafe { WinHttpSetTimeouts(session.0, 5_000, 5_000, 8_000, 8_000) } == 0 {
        return Err(PublishFailure::before_send(
            "Could not configure the Discord notification request.",
        ));
    }

    let host = wide(endpoint.host);
    // SAFETY: session is valid and host is null-terminated UTF-16.
    let connection = handle(unsafe { WinHttpConnect(session.0, host.as_ptr(), 443, 0) })?;
    let verb = wide("POST");
    let object_path = wide(&format!("{}?wait=true", endpoint.path));
    // SAFETY: All strings and parent handles remain valid for the call. WINHTTP_FLAG_SECURE
    // requires TLS and the default certificate validation remains enabled.
    let request = handle(unsafe {
        WinHttpOpenRequest(
            connection.0,
            verb.as_ptr(),
            object_path.as_ptr(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            WINHTTP_FLAG_SECURE,
        )
    })?;
    let redirect_policy = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
    // SAFETY: request is valid and redirect_policy points to a u32 of the documented size.
    if unsafe {
        WinHttpSetOption(
            request.0,
            WINHTTP_OPTION_REDIRECT_POLICY,
            (&redirect_policy as *const u32).cast(),
            mem::size_of::<u32>() as u32,
        )
    } == 0
    {
        return Err(PublishFailure::before_send(
            "Could not secure the Discord notification request.",
        ));
    }

    let headers = wide("Content-Type: application/json; charset=utf-8\r\n");
    let header_length = u32::try_from(headers.len().saturating_sub(1)).map_err(|_| {
        PublishFailure::before_send("Could not encode the Discord notification headers.")
    })?;
    let payload_length = u32::try_from(payload.len())
        .map_err(|_| PublishFailure::before_send("The Discord notification is too large."))?;
    // SAFETY: Request, headers, and payload buffers remain live until this synchronous call
    // returns. The payload length exactly matches the initialized byte slice.
    if unsafe {
        WinHttpSendRequest(
            request.0,
            headers.as_ptr(),
            header_length,
            payload.as_ptr().cast(),
            payload_length,
            payload_length,
            0,
        )
    } == 0
    {
        return Err(PublishFailure::send_attempted(
            "Could not send the Discord notification.",
        ));
    }
    // SAFETY: request is valid and the reserved parameter is required to be null.
    if unsafe { WinHttpReceiveResponse(request.0, ptr::null_mut()) } == 0 {
        return Err(PublishFailure::send_attempted(
            "Discord did not confirm the notification.",
        ));
    }

    let mut status = 0_u32;
    let mut status_size = mem::size_of::<u32>() as u32;
    // SAFETY: status points to a u32 buffer described by status_size.
    if unsafe {
        WinHttpQueryHeaders(
            request.0,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            ptr::null(),
            (&mut status as *mut u32).cast(),
            &mut status_size,
            ptr::null_mut(),
        )
    } == 0
        || !(200..300).contains(&status)
    {
        return Err(PublishFailure::send_attempted(
            "Discord rejected the notification.",
        ));
    }

    // A 2xx response is Discord's delivery acknowledgement. The response body
    // is not used by IHATECODING, so reading it creates an unsafe retry edge:
    // if the message was accepted but the body read later failed, the frontend
    // retried the same webhook and Discord displayed a duplicate notification.
    // Closing the WinHTTP handles after the acknowledged status is sufficient.
    Ok(())
}

#[cfg(not(windows))]
fn publish_discord(_webhook_url: &str, _payload: &[u8]) -> Result<(), PublishFailure> {
    Err(PublishFailure::before_send(
        "Discord notifications are only available on Windows.",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID_WEBHOOK: &str = concat!(
        "https://discord.com/api/webhooks/12345678901234567/",
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN0123456789_-"
    );

    fn save_request(
        enabled: bool,
        webhook_url: Option<&str>,
        clear_webhook: bool,
    ) -> SavePhoneNotificationSettingsRequest {
        SavePhoneNotificationSettingsRequest {
            enabled,
            webhook_url: webhook_url.map(str::to_owned),
            clear_webhook,
            notify_on_success: true,
            notify_on_error: true,
            notify_on_safety_check: true,
        }
    }

    fn notification_request(event_id: &str) -> SendPhoneNotificationRequest {
        SendPhoneNotificationRequest {
            kind: PhoneNotificationKind::Success,
            event_id: event_id.to_owned(),
            project_name: "IHATECODING".to_owned(),
            terminal_name: "MAIN".to_owned(),
            agent: PhoneNotificationAgent::Cline,
            model_name: None,
            language: Some("en".to_owned()),
        }
    }

    fn enabled_service(path: &Path) -> PhoneNotificationService {
        let service = PhoneNotificationService::open(path).unwrap();
        *service.settings.lock().unwrap() = RuntimeSettings {
            enabled: true,
            webhook_url: Some(VALID_WEBHOOK.to_owned()),
            notify_on_success: true,
            notify_on_error: true,
            notify_on_safety_check: true,
        };
        service
    }

    #[test]
    fn public_settings_never_serialize_a_webhook() {
        let public = RuntimeSettings {
            enabled: true,
            webhook_url: Some(VALID_WEBHOOK.to_owned()),
            notify_on_success: true,
            notify_on_error: true,
            notify_on_safety_check: true,
        }
        .public();
        let json = serde_json::to_string(&public).unwrap();
        assert!(json.contains("webhookConfigured"));
        assert!(!json.contains("discord.com"));
        assert!(!json.contains("12345678901234567"));
        assert!(!json.contains("abcdefghijklmnopqrstuvwxyz"));
    }

    #[test]
    fn discord_webhook_validation_is_host_and_path_exact() {
        let normalized = normalize_webhook_url(VALID_WEBHOOK).unwrap();
        assert_eq!(
            normalized,
            VALID_WEBHOOK.replace("/api/webhooks/", "/api/v10/webhooks/")
        );
        assert!(normalize_webhook_url(&VALID_WEBHOOK.replace("/api/", "/api/v10/")).is_ok());
        assert_eq!(
            normalize_webhook_url(&VALID_WEBHOOK.replace("discord.com", "discordapp.com")).unwrap(),
            normalized
        );

        for invalid in [
            VALID_WEBHOOK.replace("https://", "http://"),
            VALID_WEBHOOK.replace("discord.com", "discord.com.evil.test"),
            VALID_WEBHOOK.replace("discord.com", "evil.test@discord.com"),
            format!("{VALID_WEBHOOK}?wait=true"),
            format!("{VALID_WEBHOOK}#fragment"),
            VALID_WEBHOOK.replace("/api/webhooks/", "/api/channels/"),
            VALID_WEBHOOK.replace("12345678901234567", "not-a-snowflake"),
            VALID_WEBHOOK.replace(
                "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN0123456789_-",
                "short",
            ),
            VALID_WEBHOOK.replace("discord.com/", "discord.com:443/"),
        ] {
            assert!(
                normalize_webhook_url(&invalid).is_err(),
                "accepted invalid URL"
            );
        }
    }

    #[test]
    fn notification_payload_contains_only_safe_display_context() {
        let payload = notification_payload(
            PhoneNotificationKind::Success,
            "프로젝트 [A] @everyone",
            "CLI `백엔드`",
            PhoneNotificationAgent::Cline,
            Some("Kimi K3 `beta`"),
            Some("ko"),
        )
        .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&payload).unwrap();
        assert_eq!(json["username"], "IHATECODING");
        assert_eq!(json["allowed_mentions"]["parse"], serde_json::json!([]));
        let content = json["content"].as_str().unwrap();
        assert!(content.contains("프로젝트"));
        assert!(content.contains("백엔드"));
        assert!(content.contains("Cline"));
        assert!(content.contains("\\@everyone"));
        assert!(content.contains("\\`백엔드\\`"));
        assert!(!content.contains("event"));
        assert!(!content.contains("C:\\"));
        let fields = json["embeds"][0]["fields"].as_array().unwrap();
        assert_eq!(fields.len(), 4);
        assert_eq!(fields[0]["name"], "프로젝트");
        assert_eq!(fields[1]["name"], "에이전트");
        assert_eq!(fields[1]["value"], "Cline");
        assert_eq!(fields[2]["name"], "CLI 창");
        assert_eq!(fields[3]["name"], "모델");
        assert_eq!(fields[3]["value"], "Kimi K3 \\`beta\\`");
    }

    #[test]
    fn notification_payload_uses_the_requested_app_language() {
        let english = notification_payload(
            PhoneNotificationKind::Success,
            "IHATECODING",
            "MAIN",
            PhoneNotificationAgent::Codex,
            None,
            Some("en"),
        )
        .unwrap();
        let korean = notification_payload(
            PhoneNotificationKind::Success,
            "IHATECODING",
            "MAIN",
            PhoneNotificationAgent::Codex,
            None,
            Some("ko"),
        )
        .unwrap();
        assert!(String::from_utf8(english).unwrap().contains("completed"));
        assert!(String::from_utf8(korean).unwrap().contains("작업 완료"));
    }

    #[test]
    fn safety_check_payload_is_distinct_and_existing_settings_default_to_enabled() {
        let english = notification_payload(
            PhoneNotificationKind::SafetyCheck,
            "IHATECODING",
            "MAIN",
            PhoneNotificationAgent::Codex,
            None,
            Some("en"),
        )
        .unwrap();
        let korean = notification_payload(
            PhoneNotificationKind::SafetyCheck,
            "IHATECODING",
            "MAIN",
            PhoneNotificationAgent::Codex,
            None,
            Some("ko"),
        )
        .unwrap();
        assert!(
            String::from_utf8(english)
                .unwrap()
                .contains("waiting for a safety check")
        );
        assert!(
            String::from_utf8(korean)
                .unwrap()
                .contains("안전 검사 대기")
        );

        let legacy: DiskSettings = serde_json::from_value(serde_json::json!({
            "version": SETTINGS_VERSION,
            "enabled": false,
            "protectedWebhook": null,
            "notifyOnSuccess": true,
            "notifyOnError": true
        }))
        .unwrap();
        assert!(legacy.notify_on_safety_check);
    }

    #[test]
    fn display_names_and_event_ids_are_strict() {
        assert_eq!(
            normalize_display_name("  한글 CLI  ", "CLI").unwrap(),
            "한글 CLI"
        );
        for invalid in ["", "  ", "line\nbreak", "nul\0byte", "bidi\u{202E}name"] {
            assert!(normalize_display_name(invalid, "CLI").is_err());
        }
        assert!(normalize_display_name(&"가".repeat(81), "project").is_err());
        assert!(validate_event_id("terminal:turn-42.ok").is_ok());
        assert!(validate_event_id("../../secret").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_round_trip_uses_non_plaintext_bytes() {
        let protected = protect_secret(VALID_WEBHOOK).unwrap();
        assert!(protected.len() > VALID_WEBHOOK.len());
        assert!(
            !protected
                .windows(VALID_WEBHOOK.len())
                .any(|window| window == VALID_WEBHOOK.as_bytes())
        );
        assert_eq!(unprotect_secret(&protected).unwrap(), VALID_WEBHOOK);
    }

    #[cfg(windows)]
    #[test]
    fn saved_webhook_is_encrypted_and_can_be_preserved_or_cleared() {
        let directory = tempfile::tempdir().unwrap();
        let service = PhoneNotificationService::open(directory.path()).unwrap();
        let saved = service
            .save(save_request(true, Some(VALID_WEBHOOK), false))
            .unwrap();
        assert!(saved.enabled);
        assert!(saved.webhook_configured);

        let disk = fs::read_to_string(directory.path().join(SETTINGS_FILE_NAME)).unwrap();
        assert!(!disk.contains("discord.com"));
        assert!(!disk.contains("12345678901234567"));
        assert!(!disk.contains("abcdefghijklmnopqrstuvwxyz"));

        let reopened = PhoneNotificationService::open(directory.path()).unwrap();
        assert_eq!(reopened.settings().unwrap(), saved);
        let preserved = reopened.save(save_request(true, None, false)).unwrap();
        assert!(preserved.webhook_configured);
        let cleared = reopened.save(save_request(false, None, true)).unwrap();
        assert!(!cleared.enabled);
        assert!(!cleared.webhook_configured);
    }

    #[test]
    fn enabling_without_a_webhook_fails_and_disabled_send_deduplicates() {
        let directory = tempfile::tempdir().unwrap();
        let service = PhoneNotificationService::open(directory.path()).unwrap();
        assert!(service.save(save_request(true, None, false)).is_err());
        assert!(
            !service
                .send(SendPhoneNotificationRequest {
                    kind: PhoneNotificationKind::Success,
                    event_id: "turn:1".to_owned(),
                    project_name: "IHATECODING".to_owned(),
                    terminal_name: "MAIN".to_owned(),
                    agent: PhoneNotificationAgent::Powershell,
                    model_name: None,
                    language: Some("en".to_owned()),
                })
                .unwrap()
                .sent
        );
        assert!(service.reserve_event("turn:2").unwrap());
        assert!(!service.reserve_event("turn:2").unwrap());
        service.release_event("turn:2").unwrap();
        assert!(service.reserve_event("turn:2").unwrap());
    }

    #[test]
    fn concurrent_delivery_reservations_are_atomic() {
        use std::{sync::Arc, thread};

        let directory = tempfile::tempdir().unwrap();
        let service = Arc::new(PhoneNotificationService::open(directory.path()).unwrap());
        let workers = (0..16)
            .map(|_| {
                let service = Arc::clone(&service);
                thread::spawn(move || service.reserve_event("turn:shared").unwrap())
            })
            .collect::<Vec<_>>();
        let winners = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .filter(|reserved| *reserved)
            .count();

        assert_eq!(winners, 1, "only one delivery may own a shared event id");
    }

    #[test]
    fn delivered_event_ledger_is_hashed_and_survives_service_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let event_id = "turn:codex:11111111-1111-4111-8111-111111111111:72345:success";
        let service = PhoneNotificationService::open(directory.path()).unwrap();
        assert!(service.reserve_event(event_id).unwrap());
        drop(service);

        let ledger = fs::read_to_string(directory.path().join(DELIVERY_LEDGER_FILE_NAME)).unwrap();
        assert!(ledger.starts_with(DELIVERY_LEDGER_HEADER));
        assert!(ledger.contains(&delivery_event_hash(event_id)));
        assert!(!ledger.contains(event_id));
        assert!(!ledger.contains("11111111-1111-4111-8111-111111111111"));

        let reopened = PhoneNotificationService::open(directory.path()).unwrap();
        assert!(!reopened.reserve_event(event_id).unwrap());
    }

    #[test]
    fn duplicate_success_event_invokes_publisher_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let directory = tempfile::tempdir().unwrap();
        let service = enabled_service(directory.path());
        let calls = AtomicUsize::new(0);
        let first = service
            .send_with_publisher(notification_request("turn:duplicate"), |_, _| {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .unwrap();
        let duplicate = service
            .send_with_publisher(notification_request("turn:duplicate"), |_, _| {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .unwrap();

        assert!(first.sent);
        assert!(!duplicate.sent);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn ambiguous_failure_after_send_stays_reserved_across_reopen() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let directory = tempfile::tempdir().unwrap();
        let calls = AtomicUsize::new(0);
        let service = enabled_service(directory.path());
        let first = service.send_with_publisher(notification_request("turn:ambiguous"), |_, _| {
            calls.fetch_add(1, Ordering::SeqCst);
            Err(PublishFailure::send_attempted("acknowledgement lost"))
        });
        assert!(first.is_err());
        drop(service);

        let reopened = enabled_service(directory.path());
        let retry = reopened
            .send_with_publisher(notification_request("turn:ambiguous"), |_, _| {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .unwrap();
        assert!(!retry.sent);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn definitely_pre_send_failure_releases_durable_reservation_for_retry() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let directory = tempfile::tempdir().unwrap();
        let calls = AtomicUsize::new(0);
        let service = enabled_service(directory.path());
        let first = service.send_with_publisher(notification_request("turn:retryable"), |_, _| {
            calls.fetch_add(1, Ordering::SeqCst);
            Err(PublishFailure::before_send("connection was not created"))
        });
        assert!(first.is_err());
        drop(service);

        let reopened = enabled_service(directory.path());
        let retry = reopened
            .send_with_publisher(notification_request("turn:retryable"), |_, _| {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .unwrap();
        assert!(retry.sent);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn concurrent_duplicate_sends_invoke_publisher_once() {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };

        let directory = tempfile::tempdir().unwrap();
        let service = Arc::new(enabled_service(directory.path()));
        let calls = Arc::new(AtomicUsize::new(0));
        let workers = (0..16)
            .map(|_| {
                let service = Arc::clone(&service);
                let calls = Arc::clone(&calls);
                thread::spawn(move || {
                    service
                        .send_with_publisher(notification_request("turn:concurrent"), |_, _| {
                            calls.fetch_add(1, Ordering::SeqCst);
                            thread::sleep(Duration::from_millis(5));
                            Ok(())
                        })
                        .unwrap()
                        .sent
                })
            })
            .collect::<Vec<_>>();
        let sent = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .filter(|sent| *sent)
            .count();

        assert_eq!(sent, 1);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn independently_opened_services_share_one_atomic_reservation() {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };

        let directory = tempfile::tempdir().unwrap();
        let first = Arc::new(enabled_service(directory.path()));
        let second = Arc::new(enabled_service(directory.path()));
        let calls = Arc::new(AtomicUsize::new(0));
        let workers = [first, second]
            .into_iter()
            .map(|service| {
                let calls = Arc::clone(&calls);
                thread::spawn(move || {
                    service
                        .send_with_publisher(notification_request("turn:cross-service"), |_, _| {
                            calls.fetch_add(1, Ordering::SeqCst);
                            thread::sleep(Duration::from_millis(5));
                            Ok(())
                        })
                        .unwrap()
                        .sent
                })
            })
            .collect::<Vec<_>>();
        let sent = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .filter(|sent| *sent)
            .count();

        assert_eq!(sent, 1);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn damaged_delivery_ledger_fails_closed_before_publisher() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join(DELIVERY_LEDGER_FILE_NAME),
            b"raw-event-id-that-must-never-be-replayed\n",
        )
        .unwrap();
        let service = enabled_service(directory.path());
        let calls = AtomicUsize::new(0);
        let result =
            service.send_with_publisher(notification_request("turn:fail-closed"), |_, _| {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            });

        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
}
