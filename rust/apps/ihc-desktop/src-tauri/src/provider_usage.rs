use serde::Serialize;
use serde_json::Value;
use std::env;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const CODEX_TAIL_BYTES: usize = 512 * 1024;
const GROK_TAIL_BYTES: usize = 8 * 1024 * 1024;
const MAX_CODEX_CANDIDATES: usize = 12;
const MAX_CODEX_SCAN_ENTRIES: usize = 8_192;
const MAX_CODEX_SCAN_DEPTH: usize = 32;
const FIVE_HOUR_MIN_MINUTES: i64 = 240;
const FIVE_HOUR_MAX_MINUTES: i64 = 360;
const WEEKLY_MIN_MINUTES: i64 = 9_000;
const GROK_WINDOW_MINUTES: i64 = 10_080;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderUsageResponse {
    pub(crate) codex: ProviderUsage,
    pub(crate) grok: ProviderUsage,
    pub(crate) read_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderUsage {
    pub(crate) five_hour: Option<ProviderLimitUsage>,
    pub(crate) weekly: Option<ProviderLimitUsage>,
    pub(crate) updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderLimitUsage {
    pub(crate) used_percent: f64,
    pub(crate) window_minutes: i64,
    pub(crate) resets_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone)]
struct UsagePaths {
    codex_sessions: Option<PathBuf>,
    grok_log: Option<PathBuf>,
}

#[derive(Debug, Clone)]
struct FileCandidate {
    path: PathBuf,
    modified_millis: i64,
}

#[derive(Debug, Clone, PartialEq)]
struct LimitRecord {
    used_percent: f64,
    window_minutes: i64,
    resets_at_millis: i64,
    updated_at_millis: i64,
}

pub(crate) fn read_provider_usage() -> ProviderUsageResponse {
    let now = SystemTime::now();
    read_provider_usage_at(usage_paths(), now)
}

fn read_provider_usage_at(paths: UsagePaths, now: SystemTime) -> ProviderUsageResponse {
    let now_millis = system_time_millis(now);
    ProviderUsageResponse {
        codex: read_codex(paths.codex_sessions.as_deref(), now_millis),
        grok: read_grok(paths.grok_log.as_deref()),
        read_at: format_rfc3339_millis(now_millis).unwrap_or_else(epoch_rfc3339),
    }
}

fn usage_paths() -> UsagePaths {
    usage_paths_from(|name: &str| env::var_os(name))
}

fn usage_paths_from(mut lookup: impl FnMut(&str) -> Option<OsString>) -> UsagePaths {
    let home = non_empty_path(lookup("USERPROFILE")).or_else(|| non_empty_path(lookup("HOME")));
    let codex_home = non_empty_path(lookup("CODEX_HOME"))
        .or_else(|| home.as_ref().map(|path| path.join(".codex")));
    let grok_home = non_empty_path(lookup("GROK_HOME"))
        .or_else(|| home.as_ref().map(|path| path.join(".grok")));
    UsagePaths {
        codex_sessions: codex_home.map(|path| path.join("sessions")),
        grok_log: grok_home.map(|path| path.join("logs").join("unified.jsonl")),
    }
}

fn non_empty_path(value: Option<OsString>) -> Option<PathBuf> {
    let value = value?;
    if value.is_empty() {
        None
    } else {
        Some(PathBuf::from(value))
    }
}

fn read_codex(sessions: Option<&Path>, now_millis: i64) -> ProviderUsage {
    let Some(sessions) = sessions else {
        return empty_provider();
    };
    let mut records = Vec::new();
    for candidate in newest_codex_candidates(sessions) {
        if let Some(mut latest) = read_latest_codex_record(&candidate) {
            records.append(&mut latest);
        }
    }

    let five_hour = choose_current(&records, now_millis, |window| {
        (FIVE_HOUR_MIN_MINUTES..=FIVE_HOUR_MAX_MINUTES).contains(&window)
    });
    let weekly = choose_current(&records, now_millis, |window| window >= WEEKLY_MIN_MINUTES);
    ProviderUsage {
        five_hour: five_hour.and_then(provider_limit_usage),
        weekly: weekly.and_then(provider_limit_usage),
        updated_at: records
            .iter()
            .map(|record| record.updated_at_millis)
            .max()
            .and_then(format_rfc3339_millis),
    }
}

fn empty_provider() -> ProviderUsage {
    ProviderUsage {
        five_hour: None,
        weekly: None,
        updated_at: None,
    }
}

fn newest_codex_candidates(root: &Path) -> Vec<FileCandidate> {
    let Ok(root_metadata) = fs::symlink_metadata(root) else {
        return Vec::new();
    };
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return Vec::new();
    }

    let mut pending = vec![(root.to_path_buf(), 0_usize)];
    let mut candidates = Vec::new();
    let mut scanned = 0_usize;
    while let Some((directory, depth)) = pending.pop() {
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            scanned += 1;
            if scanned > MAX_CODEX_SCAN_ENTRIES {
                pending.clear();
                break;
            }
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                if depth < MAX_CODEX_SCAN_DEPTH {
                    pending.push((path, depth + 1));
                }
                continue;
            }
            if !metadata.is_file() || !has_jsonl_extension(&path) {
                continue;
            }
            candidates.push(FileCandidate {
                path,
                modified_millis: metadata
                    .modified()
                    .map(system_time_millis)
                    .unwrap_or_default(),
            });
        }
    }
    candidates.sort_by(|left, right| {
        right
            .modified_millis
            .cmp(&left.modified_millis)
            .then_with(|| left.path.cmp(&right.path))
    });
    candidates.truncate(MAX_CODEX_CANDIDATES);
    candidates
}

fn has_jsonl_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("jsonl"))
}

fn read_latest_codex_record(candidate: &FileCandidate) -> Option<Vec<LimitRecord>> {
    let bytes = read_tail(&candidate.path, CODEX_TAIL_BYTES);
    for line in bytes.rsplit(|byte| *byte == b'\n') {
        if !contains_bytes(line, br#""rate_limits""#) {
            continue;
        }
        let Ok(root) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        let Some(rate_limits) = root
            .get("payload")
            .and_then(|payload| payload.get("rate_limits"))
            .and_then(Value::as_object)
        else {
            continue;
        };
        if rate_limits.get("limit_id").and_then(Value::as_str) != Some("codex") {
            continue;
        }
        let updated_at_millis = root
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_rfc3339_millis)
            .unwrap_or(candidate.modified_millis);
        let mut records = Vec::with_capacity(2);
        if let Some(record) = parse_codex_limit(rate_limits.get("primary"), updated_at_millis) {
            records.push(record);
        }
        if let Some(record) = parse_codex_limit(rate_limits.get("secondary"), updated_at_millis) {
            records.push(record);
        }
        return Some(records);
    }
    None
}

fn parse_codex_limit(value: Option<&Value>, updated_at_millis: i64) -> Option<LimitRecord> {
    let limit = value?.as_object()?;
    let used_percent = finite_percentage(limit.get("used_percent")?.as_f64()?)?;
    let window_minutes = limit.get("window_minutes")?.as_i64()?;
    let resets_at_seconds = limit.get("resets_at")?.as_i64()?;
    Some(LimitRecord {
        used_percent,
        window_minutes,
        resets_at_millis: resets_at_seconds.checked_mul(1_000)?,
        updated_at_millis,
    })
}

fn choose_current(
    records: &[LimitRecord],
    now_millis: i64,
    window_matches: impl Fn(i64) -> bool,
) -> Option<LimitRecord> {
    records
        .iter()
        .filter(|record| {
            record.resets_at_millis > now_millis && window_matches(record.window_minutes)
        })
        .min_by(|left, right| {
            left.resets_at_millis
                .cmp(&right.resets_at_millis)
                .then_with(|| right.used_percent.total_cmp(&left.used_percent))
                .then_with(|| right.updated_at_millis.cmp(&left.updated_at_millis))
        })
        .cloned()
}

fn read_grok(log: Option<&Path>) -> ProviderUsage {
    let Some(path) = log else {
        return empty_provider();
    };
    let modified_millis = fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .map(system_time_millis)
        .unwrap_or_default();
    let bytes = read_tail(path, GROK_TAIL_BYTES);
    for line in bytes.rsplit(|byte| *byte == b'\n') {
        if !contains_bytes(line, br#""creditUsagePercent""#) {
            continue;
        }
        let Ok(root) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        let Some(config) = root
            .get("ctx")
            .and_then(|ctx| ctx.get("config"))
            .and_then(Value::as_object)
        else {
            continue;
        };
        let Some(used_percent) = config
            .get("creditUsagePercent")
            .and_then(Value::as_f64)
            .and_then(finite_percentage)
        else {
            continue;
        };
        let reset_text = match config.get("currentPeriod").and_then(Value::as_object) {
            Some(period) => period.get("end").and_then(Value::as_str),
            None => config.get("billingPeriodEnd").and_then(Value::as_str),
        };
        let Some(resets_at_millis) = reset_text.and_then(parse_rfc3339_millis) else {
            continue;
        };
        let updated_at_millis = root
            .get("ts")
            .and_then(Value::as_str)
            .and_then(parse_rfc3339_millis)
            .unwrap_or(modified_millis);
        let record = LimitRecord {
            used_percent,
            window_minutes: GROK_WINDOW_MINUTES,
            resets_at_millis,
            updated_at_millis,
        };
        let Some(weekly) = provider_limit_usage(record.clone()) else {
            continue;
        };
        return ProviderUsage {
            five_hour: None,
            weekly: Some(weekly),
            updated_at: format_rfc3339_millis(record.updated_at_millis),
        };
    }
    empty_provider()
}

fn provider_limit_usage(record: LimitRecord) -> Option<ProviderLimitUsage> {
    Some(ProviderLimitUsage {
        used_percent: record.used_percent,
        window_minutes: record.window_minutes,
        resets_at: format_rfc3339_millis(record.resets_at_millis)?,
        updated_at: format_rfc3339_millis(record.updated_at_millis)?,
    })
}

fn finite_percentage(value: f64) -> Option<f64> {
    value.is_finite().then_some(value.clamp(0.0, 100.0))
}

fn read_tail(path: &Path, maximum_bytes: usize) -> Vec<u8> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x0000_0001;
        const FILE_SHARE_WRITE: u32 = 0x0000_0002;
        const FILE_SHARE_DELETE: u32 = 0x0000_0004;
        options.share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
    }
    let Ok(mut file) = options.open(path) else {
        return Vec::new();
    };
    let Ok(length) = file.metadata().map(|metadata| metadata.len()) else {
        return Vec::new();
    };
    let bytes_to_read = length.min(maximum_bytes as u64);
    let start = length.saturating_sub(bytes_to_read);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut bytes = Vec::with_capacity(bytes_to_read as usize);
    if file.take(bytes_to_read).read_to_end(&mut bytes).is_err() {
        return Vec::new();
    }
    if start > 0 {
        if let Some(newline) = bytes.iter().position(|byte| *byte == b'\n') {
            bytes.drain(..=newline);
        } else {
            bytes.clear();
        }
    }
    bytes
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

fn system_time_millis(value: SystemTime) -> i64 {
    match value.duration_since(UNIX_EPOCH) {
        Ok(duration) => i64::try_from(duration.as_millis()).unwrap_or(i64::MAX),
        Err(error) => -i64::try_from(error.duration().as_millis()).unwrap_or(i64::MAX),
    }
}

fn epoch_rfc3339() -> String {
    "1970-01-01T00:00:00Z".to_owned()
}

fn format_rfc3339_millis(value: i64) -> Option<String> {
    let seconds = value.div_euclid(1_000);
    let milliseconds = value.rem_euclid(1_000);
    let days = seconds.div_euclid(86_400);
    let second_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    if !(0..=9_999).contains(&year) {
        return None;
    }
    let hour = second_of_day / 3_600;
    let minute = second_of_day % 3_600 / 60;
    let second = second_of_day % 60;
    if milliseconds == 0 {
        Some(format!(
            "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z"
        ))
    } else {
        Some(format!(
            "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milliseconds:03}Z"
        ))
    }
}

fn parse_rfc3339_millis(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || !matches!(bytes.get(10), Some(b'T' | b't' | b' '))
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
    {
        return None;
    }
    let year = parse_decimal(bytes, 0, 4)? as i64;
    let month = parse_decimal(bytes, 5, 7)?;
    let day = parse_decimal(bytes, 8, 10)?;
    let hour = parse_decimal(bytes, 11, 13)? as i64;
    let minute = parse_decimal(bytes, 14, 16)? as i64;
    let second = parse_decimal(bytes, 17, 19)? as i64;
    if !(1..=12).contains(&month)
        || day == 0
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }

    let mut index = 19_usize;
    let mut fraction_millis = 0_i64;
    if matches!(bytes.get(index), Some(b'.' | b',')) {
        index += 1;
        let fraction_start = index;
        let mut digits = 0_usize;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            if digits < 3 {
                fraction_millis = fraction_millis
                    .checked_mul(10)?
                    .checked_add(i64::from(bytes[index] - b'0'))?;
            }
            digits += 1;
            index += 1;
        }
        if index == fraction_start {
            return None;
        }
        for _ in digits..3 {
            fraction_millis = fraction_millis.checked_mul(10)?;
        }
    }

    let offset_seconds = match bytes.get(index).copied()? {
        b'Z' | b'z' => {
            index += 1;
            0_i64
        }
        sign @ (b'+' | b'-') => {
            if bytes.get(index + 3) != Some(&b':') {
                return None;
            }
            let offset_hour = parse_decimal(bytes, index + 1, index + 3)? as i64;
            let offset_minute = parse_decimal(bytes, index + 4, index + 6)? as i64;
            if offset_hour > 23 || offset_minute > 59 {
                return None;
            }
            index += 6;
            let absolute = offset_hour
                .checked_mul(3_600)?
                .checked_add(offset_minute * 60)?;
            if sign == b'+' { absolute } else { -absolute }
        }
        _ => return None,
    };
    if index != bytes.len() {
        return None;
    }

    let days = days_from_civil(year, month, day);
    let local_seconds = days
        .checked_mul(86_400)?
        .checked_add(hour.checked_mul(3_600)?)?
        .checked_add(minute.checked_mul(60)?)?
        .checked_add(second)?;
    local_seconds
        .checked_sub(offset_seconds)?
        .checked_mul(1_000)?
        .checked_add(fraction_millis)
}

fn parse_decimal(bytes: &[u8], start: usize, end: usize) -> Option<u32> {
    if start >= end || end > bytes.len() {
        return None;
    }
    let mut value = 0_u32;
    for byte in &bytes[start..end] {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value
            .checked_mul(10)?
            .checked_add(u32::from(*byte - b'0'))?;
    }
    Some(value)
}

fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn is_leap_year(year: i64) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

// Howard Hinnant's civil-date conversion, offset to the Unix epoch.
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let adjusted_year = year - i64::from(month <= 2);
    let era = if adjusted_year >= 0 {
        adjusted_year
    } else {
        adjusted_year - 399
    } / 400;
    let year_of_era = adjusted_year - era * 400;
    let shifted_month = i64::from(month) + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_piece = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_piece + 2) / 5 + 1;
    let month = month_piece + if month_piece < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month as u32, day as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;

    const NOW_SECONDS: i64 = 1_700_000_000;
    static TEST_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory {
        root: PathBuf,
    }

    impl TestDirectory {
        fn new() -> Self {
            let number = TEST_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed);
            let root = env::temp_dir().join(format!(
                "ihc-provider-usage-test-{}-{number}",
                std::process::id()
            ));
            fs::create_dir(&root).expect("create private provider usage test directory");
            Self { root }
        }

        fn directory(&self, relative: &str) -> PathBuf {
            let path = self.root.join(relative);
            fs::create_dir_all(&path).expect("create test subdirectory");
            path
        }

        fn write(&self, relative: &str, bytes: impl AsRef<[u8]>) -> PathBuf {
            let path = self.root.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("create test file parent");
            }
            fs::write(&path, bytes).expect("write provider usage fixture");
            path
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let expected_prefix = format!("ihc-provider-usage-test-{}-", std::process::id());
            let owned = self
                .root
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(&expected_prefix))
                && self.root.parent() == Some(env::temp_dir().as_path());
            if owned {
                let _ = fs::remove_dir_all(&self.root);
            }
        }
    }

    fn fixed_now() -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(NOW_SECONDS as u64)
    }

    fn paths(codex_sessions: Option<PathBuf>, grok_log: Option<PathBuf>) -> UsagePaths {
        UsagePaths {
            codex_sessions,
            grok_log,
        }
    }

    #[test]
    fn public_reader_keeps_the_no_argument_response_signature() {
        let _reader: fn() -> ProviderUsageResponse = read_provider_usage;
    }

    fn codex_line(
        timestamp: &str,
        primary: Option<(f64, i64, i64)>,
        secondary: Option<(f64, i64, i64)>,
    ) -> Vec<u8> {
        let limit = |value: Option<(f64, i64, i64)>| {
            value.map(|(used, window, reset)| {
                json!({
                    "used_percent": used,
                    "window_minutes": window,
                    "resets_at": reset
                })
            })
        };
        serde_json::to_vec(&json!({
            "timestamp": timestamp,
            "payload": {
                "rate_limits": {
                    "limit_id": "codex",
                    "primary": limit(primary),
                    "secondary": limit(secondary)
                }
            }
        }))
        .expect("serialize Codex fixture")
    }

    fn grok_line(used_percent: f64, reset_property: Value, timestamp: Option<&str>) -> Vec<u8> {
        let mut config = serde_json::Map::new();
        config.insert("creditUsagePercent".into(), json!(used_percent));
        for (key, value) in reset_property.as_object().expect("reset object") {
            config.insert(key.clone(), value.clone());
        }
        serde_json::to_vec(&json!({
            "ts": timestamp,
            "ctx": { "config": config },
            "message": "SECRET_TRANSCRIPT_MUST_NOT_ESCAPE"
        }))
        .expect("serialize Grok fixture")
    }

    #[test]
    fn response_matches_frontend_contract_and_contains_no_source_data() {
        let response = ProviderUsageResponse {
            codex: ProviderUsage {
                five_hour: Some(ProviderLimitUsage {
                    used_percent: 25.0,
                    window_minutes: 300,
                    resets_at: "1970-01-01T00:00:10Z".into(),
                    updated_at: "1970-01-01T00:00:05Z".into(),
                }),
                weekly: None,
                updated_at: Some("1970-01-01T00:00:05Z".into()),
            },
            grok: empty_provider(),
            read_at: "1970-01-01T00:00:01Z".into(),
        };
        let encoded = serde_json::to_string(&response).expect("serialize response");
        assert!(encoded.contains("\"fiveHour\""));
        assert!(encoded.contains("\"weekly\""));
        assert!(encoded.contains("\"usedPercent\":25.0"));
        assert!(encoded.contains("\"resetsAt\":\"1970-01-01T00:00:10Z\""));
        assert!(encoded.contains("\"readAt\":\"1970-01-01T00:00:01Z\""));
        assert!(!encoded.contains("remainingPercent"));
        assert!(!encoded.contains("path"));
        assert!(!encoded.contains("transcript"));
    }

    #[test]
    fn environment_roots_prefer_provider_overrides_and_fall_back_to_user_home() {
        let overridden = usage_paths_from(|name| match name {
            "USERPROFILE" => Some(OsString::from(r"C:\Users\Example")),
            "CODEX_HOME" => Some(OsString::from(r"D:\Agents\Codex")),
            "GROK_HOME" => Some(OsString::from(r"E:\Agents\Grok")),
            _ => None,
        });
        assert_eq!(
            overridden.codex_sessions,
            Some(PathBuf::from(r"D:\Agents\Codex").join("sessions"))
        );
        assert_eq!(
            overridden.grok_log,
            Some(
                PathBuf::from(r"E:\Agents\Grok")
                    .join("logs")
                    .join("unified.jsonl")
            )
        );

        let fallback =
            usage_paths_from(|name| (name == "HOME").then_some(OsString::from("/safe/home")));
        assert_eq!(
            fallback.codex_sessions,
            Some(PathBuf::from("/safe/home/.codex/sessions"))
        );
        assert_eq!(
            fallback.grok_log,
            Some(PathBuf::from("/safe/home/.grok/logs/unified.jsonl"))
        );
    }

    #[test]
    fn missing_provider_roots_return_empty_usage_without_error_details() {
        let response = read_provider_usage_at(paths(None, None), fixed_now());
        assert_eq!(response.codex, empty_provider());
        assert_eq!(response.grok, empty_provider());
        assert_eq!(response.read_at, "2023-11-14T22:13:20Z");
    }

    #[test]
    fn codex_selects_current_nearest_reset_then_highest_usage() {
        let directory = TestDirectory::new();
        let sessions = directory.directory("sessions");
        directory.write(
            "sessions/a.jsonl",
            codex_line(
                "2023-11-14T22:13:20Z",
                Some((30.0, 300, NOW_SECONDS + 500)),
                Some((20.0, 10_080, NOW_SECONDS + 1_000)),
            ),
        );
        directory.write(
            "sessions/nested/b.jsonl",
            codex_line(
                "2023-11-14T22:13:21Z",
                Some((70.0, 300, NOW_SECONDS + 500)),
                Some((95.0, 10_080, NOW_SECONDS + 2_000)),
            ),
        );
        directory.write(
            "sessions/expired.jsonl",
            codex_line("2023-11-14T22:13:22Z", Some((99.0, 300, NOW_SECONDS)), None),
        );

        let response = read_provider_usage_at(paths(Some(sessions), None), fixed_now());
        let five_hour = response.codex.five_hour.expect("five hour");
        assert_eq!(five_hour.used_percent, 70.0);
        assert_eq!(
            five_hour.resets_at,
            format_rfc3339_millis((NOW_SECONDS + 500) * 1_000).unwrap()
        );
        let weekly = response.codex.weekly.expect("weekly");
        assert_eq!(weekly.used_percent, 20.0);
        assert_eq!(
            weekly.resets_at,
            format_rfc3339_millis((NOW_SECONDS + 1_000) * 1_000).unwrap()
        );
        assert_eq!(
            response.codex.updated_at,
            Some("2023-11-14T22:13:22Z".into())
        );
    }

    #[test]
    fn codex_skips_malformed_and_foreign_latest_lines_but_stops_at_valid_record() {
        let directory = TestDirectory::new();
        let sessions = directory.directory("sessions");
        let mut bytes = codex_line(
            "2023-11-14T22:13:20Z",
            Some((25.0, 300, NOW_SECONDS + 500)),
            None,
        );
        bytes.extend_from_slice(b"\n{\"payload\":{\"rate_limits\":broken}}\n");
        bytes.extend_from_slice(br#"{"payload":{"rate_limits":{"limit_id":"other"}}}"#);
        directory.write("sessions/latest.jsonl", bytes);

        let response = read_provider_usage_at(paths(Some(sessions), None), fixed_now());
        assert_eq!(
            response
                .codex
                .five_hour
                .expect("recovered valid record")
                .used_percent,
            25.0
        );
    }

    #[test]
    fn used_percentages_are_clamped_for_frontend_remaining_calculation() {
        let directory = TestDirectory::new();
        let sessions = directory.directory("sessions");
        directory.write(
            "sessions/clamped.jsonl",
            codex_line(
                "2023-11-14T22:13:20Z",
                Some((-10.0, 300, NOW_SECONDS + 500)),
                Some((150.0, 10_080, NOW_SECONDS + 600)),
            ),
        );
        let response = read_provider_usage_at(paths(Some(sessions), None), fixed_now());
        assert_eq!(response.codex.five_hour.unwrap().used_percent, 0.0);
        assert_eq!(response.codex.weekly.unwrap().used_percent, 100.0);
    }

    #[test]
    fn bounded_codex_tail_does_not_read_an_old_transcript_record() {
        let directory = TestDirectory::new();
        let sessions = directory.directory("sessions");
        let mut bytes = codex_line(
            "2023-11-14T22:13:20Z",
            Some((10.0, 300, NOW_SECONDS + 500)),
            None,
        );
        bytes.push(b'\n');
        bytes.extend(std::iter::repeat_n(b'x', CODEX_TAIL_BYTES + 1_024));
        directory.write("sessions/large.jsonl", &bytes);
        let absent = read_provider_usage_at(paths(Some(sessions.clone()), None), fixed_now());
        assert!(absent.codex.five_hour.is_none());

        bytes.push(b'\n');
        bytes.extend(codex_line(
            "2023-11-14T22:13:21Z",
            Some((40.0, 300, NOW_SECONDS + 600)),
            None,
        ));
        directory.write("sessions/large.jsonl", bytes);
        let present = read_provider_usage_at(paths(Some(sessions), None), fixed_now());
        assert_eq!(present.codex.five_hour.unwrap().used_percent, 40.0);
    }

    #[test]
    fn codex_candidate_enumeration_is_bounded_to_the_twelve_newest_slots() {
        let directory = TestDirectory::new();
        let sessions = directory.directory("sessions");
        for index in 0..(MAX_CODEX_CANDIDATES + 5) {
            directory.write(
                &format!("sessions/{index:02}.jsonl"),
                codex_line(
                    "2023-11-14T22:13:20Z",
                    Some((index as f64, 300, NOW_SECONDS + 500)),
                    None,
                ),
            );
        }
        let candidates = newest_codex_candidates(&sessions);
        assert_eq!(candidates.len(), MAX_CODEX_CANDIDATES);
        assert!(
            candidates
                .iter()
                .all(|candidate| has_jsonl_extension(&candidate.path))
        );
    }

    #[test]
    fn grok_uses_latest_valid_credit_record_and_current_period_end() {
        let directory = TestDirectory::new();
        let log = directory.write(
            "grok/logs/unified.jsonl",
            [
                grok_line(
                    10.0,
                    json!({ "billingPeriodEnd": "2023-11-15T00:00:00Z" }),
                    Some("2023-11-14T22:13:20Z"),
                ),
                b"\n{\"creditUsagePercent\": malformed}\n".to_vec(),
                grok_line(
                    65.0,
                    json!({
                        "currentPeriod": { "end": "2023-11-16T00:00:00+01:00" },
                        "billingPeriodEnd": "2023-11-20T00:00:00Z"
                    }),
                    Some("2023-11-14T22:13:22Z"),
                ),
            ]
            .concat(),
        );
        let response = read_provider_usage_at(paths(None, Some(log)), fixed_now());
        assert!(response.grok.five_hour.is_none());
        let credits = response.grok.weekly.expect("Grok credits");
        assert_eq!(credits.used_percent, 65.0);
        assert_eq!(credits.window_minutes, GROK_WINDOW_MINUTES);
        assert_eq!(
            credits.resets_at,
            format_rfc3339_millis(parse_rfc3339_millis("2023-11-16T00:00:00+01:00").unwrap())
                .unwrap()
        );
        assert_eq!(
            response.grok.updated_at,
            Some("2023-11-14T22:13:22Z".into())
        );
    }

    #[test]
    fn grok_supports_billing_fallback_and_rejects_bad_shapes_resiliently() {
        let directory = TestDirectory::new();
        let fallback = directory.write(
            "grok/logs/unified.jsonl",
            grok_line(
                120.0,
                json!({ "billingPeriodEnd": "2023-11-17T00:00:00Z" }),
                Some("bad timestamp"),
            ),
        );
        let response = read_provider_usage_at(paths(None, Some(fallback)), fixed_now());
        assert_eq!(response.grok.weekly.unwrap().used_percent, 100.0);

        let invalid = directory.write(
            "invalid/logs/unified.jsonl",
            br#"{"ctx":{"config":{"creditUsagePercent":"secret","billingPeriodEnd":false}}}"#,
        );
        let response = read_provider_usage_at(paths(None, Some(invalid)), fixed_now());
        assert_eq!(response.grok, empty_provider());
    }

    #[test]
    fn bounded_grok_tail_ignores_old_transcript_content_and_reads_a_new_record() {
        let directory = TestDirectory::new();
        let old_record = grok_line(
            10.0,
            json!({ "billingPeriodEnd": "2023-11-17T00:00:00Z" }),
            Some("2023-11-14T22:13:20Z"),
        );
        let mut bytes = old_record;
        bytes.push(b'\n');
        bytes.extend(std::iter::repeat_n(b's', GROK_TAIL_BYTES + 1_024));
        let log = directory.write("grok/logs/unified.jsonl", &bytes);
        let absent = read_provider_usage_at(paths(None, Some(log.clone())), fixed_now());
        assert!(absent.grok.weekly.is_none());

        bytes.push(b'\n');
        bytes.extend(grok_line(
            45.0,
            json!({ "billingPeriodEnd": "2023-11-18T00:00:00Z" }),
            Some("2023-11-14T22:13:23Z"),
        ));
        directory.write("grok/logs/unified.jsonl", bytes);
        let present = read_provider_usage_at(paths(None, Some(log)), fixed_now());
        assert_eq!(present.grok.weekly.unwrap().used_percent, 45.0);
    }

    #[test]
    fn symlinked_codex_roots_and_entries_are_not_followed() {
        let directory = TestDirectory::new();
        let real = directory.directory("real");
        directory.write(
            "real/session.jsonl",
            codex_line(
                "2023-11-14T22:13:20Z",
                Some((25.0, 300, NOW_SECONDS + 500)),
                None,
            ),
        );
        let linked = directory.root.join("linked");
        #[cfg(windows)]
        let linked_result = std::os::windows::fs::symlink_dir(&real, &linked);
        #[cfg(unix)]
        let linked_result = std::os::unix::fs::symlink(&real, &linked);
        #[cfg(not(any(windows, unix)))]
        let linked_result: std::io::Result<()> = Err(std::io::ErrorKind::Unsupported.into());
        if linked_result.is_ok() {
            let response = read_provider_usage_at(paths(Some(linked), None), fixed_now());
            assert!(response.codex.five_hour.is_none());
        }
    }

    #[test]
    fn rfc3339_parser_handles_offsets_fractions_leap_days_and_invalid_dates() {
        assert_eq!(parse_rfc3339_millis("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339_millis("1970-01-01T01:30:00+01:30"), Some(0));
        assert_eq!(parse_rfc3339_millis("1969-12-31T23:59:59.500Z"), Some(-500));
        assert!(parse_rfc3339_millis("2024-02-29T12:00:00.123456Z").is_some());
        assert_eq!(parse_rfc3339_millis("2023-02-29T12:00:00Z"), None);
        assert_eq!(parse_rfc3339_millis("2024-01-01T24:00:00Z"), None);
        assert_eq!(parse_rfc3339_millis("2024-01-01T00:00:00"), None);
        assert_eq!(parse_rfc3339_millis("2024-01-01T00:00:00Z trailing"), None);
        for value in [-500, 0, 1_700_000_000_123] {
            let encoded = format_rfc3339_millis(value).expect("format in-range timestamp");
            assert_eq!(parse_rfc3339_millis(&encoded), Some(value));
        }
    }

    #[test]
    fn valid_empty_codex_record_does_not_fall_back_to_older_transcript_data() {
        let directory = TestDirectory::new();
        let sessions = directory.directory("sessions");
        let mut bytes = codex_line(
            "2023-11-14T22:13:20Z",
            Some((25.0, 300, NOW_SECONDS + 500)),
            None,
        );
        bytes.push(b'\n');
        bytes.extend(codex_line("2023-11-14T22:13:21Z", None, None));
        directory.write("sessions/latest.jsonl", bytes);
        let response = read_provider_usage_at(paths(Some(sessions), None), fixed_now());
        assert!(response.codex.five_hour.is_none());
    }
}
