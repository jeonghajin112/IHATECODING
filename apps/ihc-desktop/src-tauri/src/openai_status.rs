use serde::{Deserialize, Serialize};
use std::{
    sync::{Condvar, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const CACHE_TTL: Duration = Duration::from_secs(60);
const FORCE_THROTTLE: Duration = Duration::from_secs(10);
const MAX_STALE_AGE: Duration = Duration::from_secs(10 * 60);
const MAX_RESPONSE_BYTES: usize = 512 * 1024;
const MAX_COMPONENTS: usize = 256;
const MAX_INCIDENTS: usize = 64;
const MAX_INCIDENT_UPDATES: usize = 64;
const MAX_NAME_CHARS: usize = 160;
const MAX_DESCRIPTION_CHARS: usize = 240;
const MAX_UPDATE_CHARS: usize = 1_000;
const MAX_TIMESTAMP_CHARS: usize = 64;
const MAX_ID_CHARS: usize = 128;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiServiceStatus {
    pub key: String,
    pub name: String,
    pub status: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiStatusIncident {
    pub id: String,
    pub name: String,
    pub status: String,
    pub impact: String,
    pub updated_at: Option<String>,
    pub latest_update: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiStatusSnapshot {
    pub overall_status: String,
    pub overall_description: String,
    pub status: String,
    pub services: Vec<OpenAiServiceStatus>,
    pub incidents: Vec<OpenAiStatusIncident>,
    pub source_updated_at: Option<String>,
    pub checked_at_unix_ms: u64,
    pub stale: bool,
}

struct CachedSnapshot {
    snapshot: OpenAiStatusSnapshot,
    stored_at: Instant,
}

#[derive(Default)]
struct CacheState {
    cached: Option<CachedSnapshot>,
    refreshing: bool,
    last_attempt: Option<Instant>,
}

pub struct OpenAiStatusService {
    state: Mutex<CacheState>,
    refreshed: Condvar,
}

impl Default for OpenAiStatusService {
    fn default() -> Self {
        Self {
            state: Mutex::new(CacheState::default()),
            refreshed: Condvar::new(),
        }
    }
}

impl OpenAiStatusService {
    pub fn read(&self, force: bool) -> Result<OpenAiStatusSnapshot, String> {
        self.read_with(force, fetch_status_summary)
    }

    fn read_with<F>(&self, force: bool, fetch: F) -> Result<OpenAiStatusSnapshot, String>
    where
        F: FnOnce() -> Result<Vec<u8>, String>,
    {
        let mut fetch = Some(fetch);
        loop {
            let now = Instant::now();
            let mut state = self
                .state
                .lock()
                .map_err(|_| "OpenAI status cache is unavailable.".to_owned())?;

            if let Some(cached) = state.cached.as_ref() {
                let age = now.saturating_duration_since(cached.stored_at);
                if !force && age < CACHE_TTL {
                    return Ok(cached.snapshot.clone());
                }
                if force
                    && age <= MAX_STALE_AGE
                    && state
                        .last_attempt
                        .is_some_and(|last| now.saturating_duration_since(last) < FORCE_THROTTLE)
                {
                    return Ok(snapshot_with_staleness(cached, now));
                }
            }

            if state.refreshing {
                state = self
                    .refreshed
                    .wait(state)
                    .map_err(|_| "OpenAI status cache is unavailable.".to_owned())?;
                drop(state);
                continue;
            }

            state.refreshing = true;
            state.last_attempt = Some(now);
            drop(state);

            let checked_at_unix_ms = unix_time_ms();
            let result = fetch
                .take()
                .expect("status fetch is consumed by only one refresh")()
            .and_then(|body| parse_status_summary(&body, checked_at_unix_ms));

            let mut state = self
                .state
                .lock()
                .map_err(|_| "OpenAI status cache is unavailable.".to_owned())?;
            state.refreshing = false;
            let response = match result {
                Ok(snapshot) => {
                    state.cached = Some(CachedSnapshot {
                        snapshot: snapshot.clone(),
                        stored_at: Instant::now(),
                    });
                    Ok(snapshot)
                }
                Err(error) => state
                    .cached
                    .as_ref()
                    .filter(|cached| cached.stored_at.elapsed() <= MAX_STALE_AGE)
                    .map(|cached| {
                        let mut snapshot = cached.snapshot.clone();
                        snapshot.stale = true;
                        snapshot
                    })
                    .ok_or(error),
            };
            self.refreshed.notify_all();
            return response;
        }
    }
}

fn snapshot_with_staleness(cached: &CachedSnapshot, now: Instant) -> OpenAiStatusSnapshot {
    let mut snapshot = cached.snapshot.clone();
    snapshot.stale = now.saturating_duration_since(cached.stored_at) >= CACHE_TTL;
    snapshot
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[derive(Deserialize)]
struct UpstreamSummary {
    #[serde(default)]
    page: UpstreamPage,
    #[serde(default)]
    status: UpstreamPageStatus,
    #[serde(default)]
    components: Vec<UpstreamComponent>,
    #[serde(default)]
    incidents: Vec<UpstreamIncident>,
}

#[derive(Default, Deserialize)]
struct UpstreamPage {
    updated_at: Option<String>,
}

#[derive(Default, Deserialize)]
struct UpstreamPageStatus {
    indicator: Option<String>,
    description: Option<String>,
}

#[derive(Deserialize)]
struct UpstreamComponent {
    name: Option<String>,
    status: Option<String>,
}

#[derive(Deserialize)]
struct UpstreamIncident {
    id: Option<String>,
    name: Option<String>,
    status: Option<String>,
    impact: Option<String>,
    updated_at: Option<String>,
    #[serde(default)]
    incident_updates: Vec<UpstreamIncidentUpdate>,
}

#[derive(Deserialize)]
struct UpstreamIncidentUpdate {
    body: Option<String>,
    updated_at: Option<String>,
    display_at: Option<String>,
}

fn parse_status_summary(
    body: &[u8],
    checked_at_unix_ms: u64,
) -> Result<OpenAiStatusSnapshot, String> {
    if body.is_empty() || body.len() > MAX_RESPONSE_BYTES {
        return Err("OpenAI returned an invalid status response size.".to_owned());
    }
    let upstream: UpstreamSummary = serde_json::from_slice(body)
        .map_err(|_| "OpenAI returned an invalid status response.".to_owned())?;
    if upstream.components.len() > MAX_COMPONENTS
        || upstream.incidents.len() > MAX_INCIDENTS
        || upstream
            .incidents
            .iter()
            .any(|incident| incident.incident_updates.len() > MAX_INCIDENT_UPDATES)
    {
        return Err("OpenAI returned an unexpectedly large status response.".to_owned());
    }

    let groups: [(&str, &str, &[&str]); 3] = [
        (
            "chatgpt",
            "ChatGPT",
            &[
                "Conversations",
                "GPTs",
                "ChatGPT Work",
                "Search",
                "File uploads",
                "Voice mode",
                "Image Generation",
                "Deep Research",
                "Agent",
                "Sites",
                "Connectors/Apps",
            ],
        ),
        (
            "api",
            "API",
            &[
                "Chat Completions",
                "Responses",
                "Fine-tuning",
                "Embeddings",
                "Images",
                "Batch",
                "Audio",
                "Moderations",
                "Realtime",
                "Files",
            ],
        ),
        (
            "codex",
            "Codex",
            &[
                "Codex Web",
                "Codex API",
                "CLI",
                "VS Code extension",
                "Codex in ChatGPT Desktop",
            ],
        ),
    ];
    let services = groups
        .iter()
        .map(|(key, group_name, component_names)| OpenAiServiceStatus {
            key: (*key).to_owned(),
            name: (*group_name).to_owned(),
            status: aggregate_component_status(&upstream.components, component_names).to_owned(),
        })
        .collect::<Vec<_>>();
    let related_status =
        aggregate_normalized_statuses(services.iter().map(|service| service.status.as_str()));

    let mut incidents = upstream
        .incidents
        .into_iter()
        .filter(|incident| {
            !matches!(
                incident
                    .status
                    .as_deref()
                    .map(str::to_ascii_lowercase)
                    .as_deref(),
                Some("resolved" | "completed" | "postmortem")
            )
        })
        .collect::<Vec<_>>();
    incidents.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    let incidents = incidents
        .into_iter()
        .take(3)
        .map(normalize_incident)
        .collect();

    Ok(OpenAiStatusSnapshot {
        overall_status: normalize_indicator(upstream.status.indicator.as_deref()).to_owned(),
        overall_description: bounded_text(
            upstream
                .status
                .description
                .as_deref()
                .unwrap_or("Status unavailable"),
            MAX_DESCRIPTION_CHARS,
        ),
        status: related_status.to_owned(),
        services,
        incidents,
        source_updated_at: bounded_optional(
            upstream.page.updated_at.as_deref(),
            MAX_TIMESTAMP_CHARS,
        ),
        checked_at_unix_ms,
        stale: false,
    })
}

fn aggregate_component_status(
    components: &[UpstreamComponent],
    selected_names: &[&str],
) -> &'static str {
    aggregate_normalized_statuses(components.iter().filter_map(|component| {
        let name = component.name.as_deref()?;
        selected_names
            .iter()
            .any(|selected| name.eq_ignore_ascii_case(selected))
            .then(|| normalize_component_status(component.status.as_deref()))
    }))
}

fn aggregate_normalized_statuses<'a>(statuses: impl Iterator<Item = &'a str>) -> &'static str {
    let mut best = "unknown";
    let mut best_severity = 0_u8;
    for status in statuses {
        let severity = match status {
            "operational" => 1,
            "maintenance" => 2,
            "degraded" => 3,
            "outage" => 4,
            _ => 0,
        };
        if severity > best_severity {
            best = match severity {
                1 => "operational",
                2 => "maintenance",
                3 => "degraded",
                4 => "outage",
                _ => "unknown",
            };
            best_severity = severity;
        }
    }
    best
}

fn normalize_component_status(status: Option<&str>) -> &'static str {
    match status.map(str::to_ascii_lowercase).as_deref() {
        Some("operational") => "operational",
        Some("degraded_performance" | "degraded") => "degraded",
        Some("partial_outage" | "major_outage" | "outage") => "outage",
        Some("under_maintenance" | "maintenance") => "maintenance",
        _ => "unknown",
    }
}

fn normalize_indicator(indicator: Option<&str>) -> &'static str {
    match indicator.map(str::to_ascii_lowercase).as_deref() {
        Some("none" | "operational") => "operational",
        Some("minor" | "degraded") => "degraded",
        Some("major" | "critical" | "outage") => "outage",
        Some("maintenance") => "maintenance",
        _ => "unknown",
    }
}

fn normalize_incident(incident: UpstreamIncident) -> OpenAiStatusIncident {
    let latest_update = incident
        .incident_updates
        .iter()
        .max_by_key(|update| {
            update
                .display_at
                .as_deref()
                .or(update.updated_at.as_deref())
                .unwrap_or("")
        })
        .and_then(|update| bounded_optional(update.body.as_deref(), MAX_UPDATE_CHARS));
    OpenAiStatusIncident {
        id: bounded_text(incident.id.as_deref().unwrap_or("unknown"), MAX_ID_CHARS),
        name: bounded_text(
            incident
                .name
                .as_deref()
                .unwrap_or("OpenAI service incident"),
            MAX_NAME_CHARS,
        ),
        status: bounded_text(incident.status.as_deref().unwrap_or("unknown"), 48),
        impact: bounded_text(incident.impact.as_deref().unwrap_or("unknown"), 48),
        updated_at: bounded_optional(incident.updated_at.as_deref(), MAX_TIMESTAMP_CHARS),
        latest_update,
    }
}

fn bounded_optional(value: Option<&str>, max_chars: usize) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| bounded_text(value, max_chars))
}

fn bounded_text(value: &str, max_chars: usize) -> String {
    value.trim().chars().take(max_chars).collect()
}

#[cfg(windows)]
fn fetch_status_summary() -> Result<Vec<u8>, String> {
    use std::{ffi::c_void, mem, ptr};
    use windows_sys::Win32::Networking::WinHttp::{
        WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_FLAG_SECURE, WINHTTP_OPTION_REDIRECT_POLICY,
        WINHTTP_OPTION_REDIRECT_POLICY_NEVER, WINHTTP_QUERY_CONTENT_TYPE,
        WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_STATUS_CODE, WinHttpCloseHandle, WinHttpConnect,
        WinHttpOpen, WinHttpOpenRequest, WinHttpQueryDataAvailable, WinHttpQueryHeaders,
        WinHttpReadData, WinHttpReceiveResponse, WinHttpSendRequest, WinHttpSetOption,
        WinHttpSetTimeouts,
    };

    struct WinHttpHandle(*mut c_void);
    impl Drop for WinHttpHandle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: This wrapper exclusively owns the handle and closes it once.
                unsafe {
                    let _ = WinHttpCloseHandle(self.0);
                }
            }
        }
    }
    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }
    fn handle(value: *mut c_void) -> Result<WinHttpHandle, String> {
        (!value.is_null())
            .then_some(WinHttpHandle(value))
            .ok_or_else(|| "Could not initialize the OpenAI status request.".to_owned())
    }

    let user_agent = wide("IHATECODING/1.0");
    // SAFETY: Strings are null-terminated and remain live for this synchronous call.
    let session = handle(unsafe {
        WinHttpOpen(
            user_agent.as_ptr(),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            ptr::null(),
            ptr::null(),
            0,
        )
    })?;
    // SAFETY: session is a valid WinHTTP handle.
    if unsafe { WinHttpSetTimeouts(session.0, 5_000, 5_000, 8_000, 8_000) } == 0 {
        return Err("Could not configure the OpenAI status request.".to_owned());
    }
    let host = wide("status.openai.com");
    // SAFETY: host is a live, null-terminated UTF-16 string.
    let connection = handle(unsafe { WinHttpConnect(session.0, host.as_ptr(), 443, 0) })?;
    let verb = wide("GET");
    let path = wide("/api/v2/summary.json");
    // SAFETY: Parent handles and strings remain live. Secure mode retains WinHTTP's default TLS
    // certificate and hostname validation.
    let request = handle(unsafe {
        WinHttpOpenRequest(
            connection.0,
            verb.as_ptr(),
            path.as_ptr(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            WINHTTP_FLAG_SECURE,
        )
    })?;
    let redirect_policy = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
    // SAFETY: request is valid and the option buffer has the documented u32 layout.
    if unsafe {
        WinHttpSetOption(
            request.0,
            WINHTTP_OPTION_REDIRECT_POLICY,
            (&redirect_policy as *const u32).cast(),
            mem::size_of::<u32>() as u32,
        )
    } == 0
    {
        return Err("Could not secure the OpenAI status request.".to_owned());
    }
    // SAFETY: GET has no optional request body; all pointers follow the WinHTTP contract.
    if unsafe { WinHttpSendRequest(request.0, ptr::null(), 0, ptr::null(), 0, 0, 0) } == 0
        || unsafe { WinHttpReceiveResponse(request.0, ptr::null_mut()) } == 0
    {
        return Err("Could not retrieve OpenAI status.".to_owned());
    }

    let mut status_code = 0_u32;
    let mut status_size = mem::size_of::<u32>() as u32;
    // SAFETY: status_code points to a writable u32 buffer described by status_size.
    if unsafe {
        WinHttpQueryHeaders(
            request.0,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            ptr::null(),
            (&mut status_code as *mut u32).cast(),
            &mut status_size,
            ptr::null_mut(),
        )
    } == 0
        || status_code != 200
    {
        return Err("OpenAI rejected the status request.".to_owned());
    }

    let mut content_type_buffer = [0_u16; 128];
    let mut content_type_size = (content_type_buffer.len() * mem::size_of::<u16>()) as u32;
    // SAFETY: The fixed buffer and byte length are valid for the synchronous header query.
    if unsafe {
        WinHttpQueryHeaders(
            request.0,
            WINHTTP_QUERY_CONTENT_TYPE,
            ptr::null(),
            content_type_buffer.as_mut_ptr().cast(),
            &mut content_type_size,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err("OpenAI status response has no content type.".to_owned());
    }
    let content_type_len = usize::try_from(content_type_size)
        .unwrap_or(0)
        .checked_div(mem::size_of::<u16>())
        .unwrap_or(0)
        .min(content_type_buffer.len());
    let content_type = String::from_utf16_lossy(&content_type_buffer[..content_type_len])
        .trim_matches(char::from(0))
        .trim()
        .to_ascii_lowercase();
    if content_type.split(';').next().map(str::trim) != Some("application/json") {
        return Err("OpenAI status response is not JSON.".to_owned());
    }

    let mut body = Vec::new();
    loop {
        let mut available = 0_u32;
        // SAFETY: available is a writable u32 and request has received a response.
        if unsafe { WinHttpQueryDataAvailable(request.0, &mut available) } == 0 {
            return Err("Could not read the OpenAI status response.".to_owned());
        }
        if available == 0 {
            break;
        }
        let available = usize::try_from(available)
            .map_err(|_| "OpenAI status response is too large.".to_owned())?;
        if body.len().saturating_add(available) > MAX_RESPONSE_BYTES {
            return Err("OpenAI status response is too large.".to_owned());
        }
        let start = body.len();
        body.resize(start + available, 0);
        let mut read = 0_u32;
        // SAFETY: The appended Vec region is writable for exactly `available` bytes.
        if unsafe {
            WinHttpReadData(
                request.0,
                body[start..].as_mut_ptr().cast(),
                u32::try_from(available).unwrap_or(u32::MAX),
                &mut read,
            )
        } == 0
        {
            return Err("Could not read the OpenAI status response.".to_owned());
        }
        let read = usize::try_from(read).unwrap_or(0).min(available);
        body.truncate(start + read);
        if read == 0 {
            return Err("OpenAI returned an incomplete status response.".to_owned());
        }
    }
    Ok(body)
}

#[cfg(not(windows))]
fn fetch_status_summary() -> Result<Vec<u8>, String> {
    Err("OpenAI status checks are only available on Windows.".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        thread,
    };

    const SUMMARY: &str = r#"{
      "page":{"updated_at":"2026-07-22T07:54:15Z"},
      "status":{"indicator":"minor","description":"Partial System Degradation"},
      "components":[
        {"name":"GPTs","status":"operational"},
        {"name":"Conversations","status":"degraded_performance"},
        {"name":"Responses","status":"operational"},
        {"name":"Codex API","status":"partial_outage"}
      ],
      "incidents":[{
        "id":"incident-1","name":"Elevated errors","status":"investigating",
        "impact":"minor","updated_at":"2026-07-22T07:54:15Z",
        "incident_updates":[
          {"body":"Earlier update","updated_at":"2026-07-22T07:40:00Z"},
          {"body":"Latest update","display_at":"2026-07-22T07:54:15Z"}
        ]
      }]
    }"#;

    fn parsed_snapshot(checked_at: u64) -> OpenAiStatusSnapshot {
        parse_status_summary(SUMMARY.as_bytes(), checked_at).unwrap()
    }

    #[test]
    fn parser_groups_services_and_keeps_latest_active_incident_update() {
        let snapshot = parsed_snapshot(42);
        assert_eq!(snapshot.overall_status, "degraded");
        assert_eq!(snapshot.status, "outage");
        assert_eq!(snapshot.checked_at_unix_ms, 42);
        assert_eq!(snapshot.services.len(), 3);
        assert_eq!(snapshot.services[0].status, "degraded");
        assert_eq!(snapshot.services[1].status, "operational");
        assert_eq!(snapshot.services[2].status, "outage");
        assert_eq!(snapshot.incidents.len(), 1);
        assert_eq!(
            snapshot.incidents[0].latest_update.as_deref(),
            Some("Latest update")
        );
    }

    #[test]
    fn parser_rejects_oversized_or_invalid_responses() {
        assert!(parse_status_summary(&vec![b'x'; MAX_RESPONSE_BYTES + 1], 0).is_err());
        assert!(parse_status_summary(br#"{"components":"wrong"}"#, 0).is_err());
    }

    #[test]
    fn parser_bounds_untrusted_strings_and_filters_resolved_incidents() {
        let long = "x".repeat(MAX_UPDATE_CHARS + 50);
        let body = format!(
            r#"{{"components":[],"incidents":[
              {{"id":"done","name":"done","status":"resolved","incident_updates":[]}},
              {{"id":"live","name":"live","status":"monitoring","incident_updates":[{{"body":"{long}"}}]}}
            ]}}"#
        );
        let snapshot = parse_status_summary(body.as_bytes(), 0).unwrap();
        assert_eq!(snapshot.incidents.len(), 1);
        assert_eq!(
            snapshot.incidents[0]
                .latest_update
                .as_ref()
                .unwrap()
                .chars()
                .count(),
            MAX_UPDATE_CHARS
        );
        assert!(
            snapshot
                .services
                .iter()
                .all(|service| service.status == "unknown")
        );
    }

    #[test]
    fn fresh_cache_and_forced_throttle_do_not_refetch() {
        let service = OpenAiStatusService::default();
        let first = service
            .read_with(false, || Ok(SUMMARY.as_bytes().to_vec()))
            .unwrap();
        let second = service
            .read_with(false, || panic!("fresh cache must be used"))
            .unwrap();
        let forced = service
            .read_with(true, || panic!("forced refresh must be throttled"))
            .unwrap();
        assert_eq!(first, second);
        assert_eq!(second, forced);
    }

    #[test]
    fn failed_refresh_uses_only_recent_cache_as_stale() {
        let service = OpenAiStatusService::default();
        let snapshot = parsed_snapshot(1);
        service.state.lock().unwrap().cached = Some(CachedSnapshot {
            snapshot,
            stored_at: Instant::now() - CACHE_TTL,
        });
        let stale = service
            .read_with(false, || Err("offline".to_owned()))
            .unwrap();
        assert!(stale.stale);

        let mut state = service.state.lock().unwrap();
        state.cached.as_mut().unwrap().stored_at =
            Instant::now() - MAX_STALE_AGE - Duration::from_secs(1);
        state.last_attempt = None;
        drop(state);
        assert_eq!(
            service.read_with(false, || Err("offline".to_owned())),
            Err("offline".to_owned())
        );
    }

    #[test]
    fn concurrent_reads_share_one_refresh() {
        let service = Arc::new(OpenAiStatusService::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let mut threads = Vec::new();
        for _ in 0..4 {
            let service = Arc::clone(&service);
            let calls = Arc::clone(&calls);
            threads.push(thread::spawn(move || {
                service
                    .read_with(false, || {
                        calls.fetch_add(1, Ordering::SeqCst);
                        thread::sleep(Duration::from_millis(40));
                        Ok(SUMMARY.as_bytes().to_vec())
                    })
                    .unwrap()
            }));
        }
        for handle in threads {
            assert!(!handle.join().unwrap().stale);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
