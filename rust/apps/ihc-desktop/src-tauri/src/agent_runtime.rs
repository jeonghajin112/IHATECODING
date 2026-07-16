use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    env, fs,
    hash::Hash,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::ipc::Channel;
use uuid::Uuid;

const MAX_STABLE_KEY_BYTES: usize = 512;
const MAX_DISCOVERY_ENTRIES: usize = 50_000;
const MAX_TAIL_READ_BYTES: u64 = 256 * 1024;
const MAX_LINE_BYTES: usize = 1024 * 1024;
const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(180);

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AgentProvider {
    Codex,
    Grok,
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StableTerminalKey {
    pub(crate) project_id: String,
    pub(crate) terminal_id: String,
}

impl StableTerminalKey {
    fn validate(&self) -> Result<(), String> {
        validate_key_part(&self.project_id, "project")?;
        validate_key_part(&self.terminal_id, "terminal")
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentResumeBinding {
    pub(crate) provider: AgentProvider,
    pub(crate) conversation_id: String,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct OwnershipKey {
    provider: AgentProvider,
    conversation_id: Uuid,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ValidatedAgentBinding {
    provider: AgentProvider,
    conversation_id: Uuid,
}

impl ValidatedAgentBinding {
    fn ownership_key(&self) -> OwnershipKey {
        OwnershipKey {
            provider: self.provider,
            conversation_id: self.conversation_id,
        }
    }
}

impl TryFrom<AgentResumeBinding> for ValidatedAgentBinding {
    type Error = String;

    fn try_from(value: AgentResumeBinding) -> Result<Self, Self::Error> {
        let conversation_id = Uuid::parse_str(value.conversation_id.trim())
            .map_err(|_| "The agent conversation identifier is not a valid UUID.".to_owned())?;
        Ok(Self {
            provider: value.provider,
            conversation_id,
        })
    }
}

#[derive(Clone, Debug)]
pub(crate) struct TerminalLaunchPlan {
    arguments: Vec<String>,
    terminal_key: Option<StableTerminalKey>,
    binding: Option<ValidatedAgentBinding>,
}

impl TerminalLaunchPlan {
    pub(crate) fn from_request(
        terminal_key: Option<StableTerminalKey>,
        resume: Option<AgentResumeBinding>,
    ) -> Result<Self, String> {
        if let Some(key) = &terminal_key {
            key.validate()?;
        }
        let binding = resume.map(ValidatedAgentBinding::try_from).transpose()?;
        if binding.is_some() && terminal_key.is_none() {
            return Err(
                "A stable terminal key is required to resume an agent conversation.".to_owned(),
            );
        }

        let mut arguments = vec!["-NoLogo".to_owned(), "-NoExit".to_owned()];
        if let Some(binding) = &binding {
            arguments.push("-EncodedCommand".to_owned());
            arguments.push(encode_powershell(resume_script(binding)));
        }
        Ok(Self {
            arguments,
            terminal_key,
            binding,
        })
    }

    pub(crate) fn arguments(&self) -> &[String] {
        &self.arguments
    }

    pub(crate) fn ownership(&self) -> Option<(&StableTerminalKey, &ValidatedAgentBinding)> {
        self.terminal_key.as_ref().zip(self.binding.as_ref())
    }
}

fn resume_script(binding: &ValidatedAgentBinding) -> String {
    let id = binding.conversation_id.hyphenated();
    match binding.provider {
        AgentProvider::Codex => format!(
            "Start-Sleep -Milliseconds 100; & codex resume '{id}' --dangerously-bypass-approvals-and-sandbox; $ihcExit=$LASTEXITCODE; if ($ihcExit -eq 1) {{ Start-Sleep -Milliseconds 1500; & codex resume '{id}' --dangerously-bypass-approvals-and-sandbox }}"
        ),
        AgentProvider::Grok => format!(
            "Start-Sleep -Milliseconds 100; $ihcStarted=[Diagnostics.Stopwatch]::StartNew(); & grok --resume '{id}'; $ihcOk=$?; if (-not $ihcOk -and $ihcStarted.Elapsed.TotalSeconds -lt 8) {{ Start-Sleep -Milliseconds 1800; & grok --resume '{id}' }}"
        ),
    }
}

fn encode_powershell(script: String) -> String {
    let mut bytes = Vec::with_capacity(script.len() * 2);
    for unit in script.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    BASE64_STANDARD.encode(bytes)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentBindingSnapshot {
    pub(crate) runtime_session_id: String,
    pub(crate) terminal_key: StableTerminalKey,
    pub(crate) provider: AgentProvider,
    pub(crate) conversation_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "event",
    content = "data"
)]
pub(crate) enum AgentEvent {
    TurnComplete {
        runtime_session_id: String,
        terminal_key: StableTerminalKey,
        provider: AgentProvider,
        conversation_id: String,
        observed_at_unix_ms: u64,
    },
}

trait AgentEventSink: Send + Sync + 'static {
    fn send(&self, event: AgentEvent) -> Result<(), String>;
}

struct TauriAgentEventSink(Channel<AgentEvent>);

impl AgentEventSink for TauriAgentEventSink {
    fn send(&self, event: AgentEvent) -> Result<(), String> {
        self.0.send(event).map_err(|error| error.to_string())
    }
}

#[derive(Clone, Debug)]
struct BoundAgent {
    runtime_session_id: String,
    terminal_key: StableTerminalKey,
    binding: ValidatedAgentBinding,
}

impl BoundAgent {
    fn snapshot(&self) -> AgentBindingSnapshot {
        AgentBindingSnapshot {
            runtime_session_id: self.runtime_session_id.clone(),
            terminal_key: self.terminal_key.clone(),
            provider: self.binding.provider,
            conversation_id: self.binding.conversation_id.to_string(),
        }
    }

    fn completion_event(&self) -> AgentEvent {
        AgentEvent::TurnComplete {
            runtime_session_id: self.runtime_session_id.clone(),
            terminal_key: self.terminal_key.clone(),
            provider: self.binding.provider,
            conversation_id: self.binding.conversation_id.to_string(),
            observed_at_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .min(u128::from(u64::MAX)) as u64,
        }
    }
}

#[derive(Default)]
struct AgentRuntimeState {
    shutting_down: bool,
    bindings: HashMap<String, BoundAgent>,
    conversation_owners: HashMap<OwnershipKey, String>,
    terminal_owners: HashMap<StableTerminalKey, String>,
    subscribers: Vec<Arc<dyn AgentEventSink>>,
}

#[derive(Clone, Debug)]
struct AgentRuntimeConfig {
    codex_sessions_root: PathBuf,
    grok_sessions_root: PathBuf,
    poll_interval: Duration,
}

impl AgentRuntimeConfig {
    fn from_environment() -> Self {
        let profile = env::var_os("USERPROFILE")
            .or_else(|| env::var_os("HOME"))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        let codex_home = env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| profile.join(".codex"));
        let grok_home = env::var_os("GROK_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| profile.join(".grok"));
        Self {
            codex_sessions_root: codex_home.join("sessions"),
            grok_sessions_root: grok_home.join("sessions"),
            poll_interval: DEFAULT_POLL_INTERVAL,
        }
    }
}

struct AgentRuntimeInner {
    state: Mutex<AgentRuntimeState>,
    watchers: Mutex<HashMap<String, BoundWatchState>>,
    config: AgentRuntimeConfig,
    monitor_enabled: bool,
    monitor_stop: AtomicBool,
    monitor_signal: Arc<(Mutex<bool>, Condvar)>,
    monitor: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Clone)]
pub(crate) struct AgentRuntime {
    inner: Arc<AgentRuntimeInner>,
}

impl Default for AgentRuntime {
    fn default() -> Self {
        Self::new(AgentRuntimeConfig::from_environment(), true)
    }
}

impl AgentRuntime {
    fn new(config: AgentRuntimeConfig, monitor_enabled: bool) -> Self {
        Self {
            inner: Arc::new(AgentRuntimeInner {
                state: Mutex::new(AgentRuntimeState::default()),
                watchers: Mutex::new(HashMap::new()),
                config,
                monitor_enabled,
                monitor_stop: AtomicBool::new(false),
                monitor_signal: Arc::new((Mutex::new(false), Condvar::new())),
                monitor: Mutex::new(None),
            }),
        }
    }

    pub(crate) fn subscribe(&self, channel: Channel<AgentEvent>) -> Result<(), String> {
        self.subscribe_sink(Arc::new(TauriAgentEventSink(channel)))
    }

    fn subscribe_sink(&self, sink: Arc<dyn AgentEventSink>) -> Result<(), String> {
        let mut state = agent_lock(&self.inner.state)?;
        if state.shutting_down {
            return Err("The agent runtime is shutting down.".to_owned());
        }
        state.subscribers.push(sink);
        drop(state);
        self.ensure_monitor()?;
        Ok(())
    }

    pub(crate) fn bind(
        &self,
        runtime_session_id: &str,
        terminal_key: StableTerminalKey,
        resume: AgentResumeBinding,
    ) -> Result<AgentBindingSnapshot, String> {
        terminal_key.validate()?;
        validate_runtime_session_id(runtime_session_id)?;
        let binding = ValidatedAgentBinding::try_from(resume)?;
        self.bind_validated(runtime_session_id, terminal_key, binding)
    }

    fn bind_validated(
        &self,
        runtime_session_id: &str,
        terminal_key: StableTerminalKey,
        binding: ValidatedAgentBinding,
    ) -> Result<AgentBindingSnapshot, String> {
        terminal_key.validate()?;
        validate_runtime_session_id(runtime_session_id)?;
        let ownership_key = binding.ownership_key();
        let bound = BoundAgent {
            runtime_session_id: runtime_session_id.to_owned(),
            terminal_key: terminal_key.clone(),
            binding,
        };

        {
            let mut state = agent_lock(&self.inner.state)?;
            if state.shutting_down {
                return Err("The agent runtime is shutting down.".to_owned());
            }
            if let Some(existing) = state.bindings.get(runtime_session_id) {
                if existing.terminal_key == terminal_key && existing.binding == bound.binding {
                    return Ok(existing.snapshot());
                }
                return Err(
                    "The terminal session already owns a different agent binding.".to_owned(),
                );
            }
            if state
                .conversation_owners
                .get(&ownership_key)
                .is_some_and(|owner| owner != runtime_session_id)
            {
                return Err(
                    "The agent conversation is already owned by another terminal.".to_owned(),
                );
            }
            if state
                .terminal_owners
                .get(&terminal_key)
                .is_some_and(|owner| owner != runtime_session_id)
            {
                return Err(
                    "The stable terminal is already bound to another runtime session.".to_owned(),
                );
            }
            state
                .conversation_owners
                .insert(ownership_key, runtime_session_id.to_owned());
            state
                .terminal_owners
                .insert(terminal_key, runtime_session_id.to_owned());
            state
                .bindings
                .insert(runtime_session_id.to_owned(), bound.clone());
        }

        let watch = BoundWatchState::seed(&self.inner.config, &bound);
        match agent_lock(&self.inner.watchers) {
            Ok(mut watchers) => {
                watchers.insert(runtime_session_id.to_owned(), watch);
            }
            Err(error) => {
                self.unbind(runtime_session_id);
                return Err(error);
            }
        }
        self.ensure_monitor()?;
        self.wake_monitor();
        Ok(bound.snapshot())
    }

    pub(crate) fn claim_for_start(
        &self,
        runtime_session_id: &str,
        terminal_key: &StableTerminalKey,
        binding: &ValidatedAgentBinding,
    ) -> Result<AgentBindingLease, String> {
        self.bind_validated(runtime_session_id, terminal_key.clone(), binding.clone())?;
        Ok(AgentBindingLease {
            runtime: self.clone(),
            runtime_session_id: runtime_session_id.to_owned(),
            armed: true,
        })
    }

    pub(crate) fn unbind(&self, runtime_session_id: &str) -> Option<AgentBindingSnapshot> {
        let removed = {
            let mut state = match self.inner.state.lock() {
                Ok(state) => state,
                Err(poisoned) => poisoned.into_inner(),
            };
            let removed = state.bindings.remove(runtime_session_id)?;
            let ownership_key = removed.binding.ownership_key();
            if state
                .conversation_owners
                .get(&ownership_key)
                .is_some_and(|owner| owner == runtime_session_id)
            {
                state.conversation_owners.remove(&ownership_key);
            }
            if state
                .terminal_owners
                .get(&removed.terminal_key)
                .is_some_and(|owner| owner == runtime_session_id)
            {
                state.terminal_owners.remove(&removed.terminal_key);
            }
            removed
        };
        match self.inner.watchers.lock() {
            Ok(mut watchers) => {
                watchers.remove(runtime_session_id);
            }
            Err(poisoned) => {
                poisoned.into_inner().remove(runtime_session_id);
            }
        }
        self.wake_monitor();
        Some(removed.snapshot())
    }

    pub(crate) fn shutdown(&self) {
        {
            let mut state = match self.inner.state.lock() {
                Ok(state) => state,
                Err(poisoned) => poisoned.into_inner(),
            };
            state.shutting_down = true;
            state.bindings.clear();
            state.conversation_owners.clear();
            state.terminal_owners.clear();
            state.subscribers.clear();
        }
        match self.inner.watchers.lock() {
            Ok(mut watchers) => watchers.clear(),
            Err(poisoned) => poisoned.into_inner().clear(),
        }
        self.inner.monitor_stop.store(true, Ordering::Release);
        self.wake_monitor();
        let handle = match self.inner.monitor.lock() {
            Ok(mut handle) => handle.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        };
        if let Some(handle) = handle {
            let _ = handle.join();
        }
    }

    fn ensure_monitor(&self) -> Result<(), String> {
        if !self.inner.monitor_enabled || self.inner.monitor_stop.load(Ordering::Acquire) {
            return Ok(());
        }
        let mut monitor = agent_lock(&self.inner.monitor)?;
        if monitor.is_some() {
            return Ok(());
        }
        let weak = Arc::downgrade(&self.inner);
        let signal = Arc::clone(&self.inner.monitor_signal);
        let poll_interval = self.inner.config.poll_interval;
        *monitor = Some(
            thread::Builder::new()
                .name("ihc-agent-monitor".to_owned())
                .spawn(move || monitor_loop(weak, signal, poll_interval))
                .map_err(|error| format!("Agent monitor thread failed to start: {error}"))?,
        );
        Ok(())
    }

    fn wake_monitor(&self) {
        let (gate, changed) = &*self.inner.monitor_signal;
        let mut wake = match gate.lock() {
            Ok(wake) => wake,
            Err(poisoned) => poisoned.into_inner(),
        };
        *wake = true;
        changed.notify_all();
    }

    #[cfg(test)]
    fn poll_once(&self) {
        poll_inner(&self.inner);
    }

    #[cfg(test)]
    fn binding_count(&self) -> usize {
        match self.inner.state.lock() {
            Ok(state) => state.bindings.len(),
            Err(poisoned) => poisoned.into_inner().bindings.len(),
        }
    }
}

pub(crate) struct AgentBindingLease {
    runtime: AgentRuntime,
    runtime_session_id: String,
    armed: bool,
}

impl AgentBindingLease {
    pub(crate) fn commit(mut self) {
        self.armed = false;
    }
}

impl Drop for AgentBindingLease {
    fn drop(&mut self) {
        if self.armed {
            self.runtime.unbind(&self.runtime_session_id);
        }
    }
}

fn monitor_loop(
    runtime: Weak<AgentRuntimeInner>,
    signal: Arc<(Mutex<bool>, Condvar)>,
    poll_interval: Duration,
) {
    loop {
        let Some(inner) = runtime.upgrade() else {
            return;
        };
        if inner.monitor_stop.load(Ordering::Acquire) {
            return;
        }
        poll_inner(&inner);
        drop(inner);

        let (gate, changed) = &*signal;
        let mut wake = match gate.lock() {
            Ok(wake) => wake,
            Err(poisoned) => poisoned.into_inner(),
        };
        if !*wake {
            wake = match changed.wait_timeout(wake, poll_interval) {
                Ok((wake, _)) => wake,
                Err(poisoned) => poisoned.into_inner().0,
            };
        }
        *wake = false;
    }
}

fn poll_inner(inner: &Arc<AgentRuntimeInner>) {
    let bindings = {
        let state = match inner.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        if state.shutting_down || state.bindings.is_empty() {
            return;
        }
        state.bindings.clone()
    };

    let mut completions = Vec::new();
    {
        let mut watchers = match inner.watchers.lock() {
            Ok(watchers) => watchers,
            Err(poisoned) => poisoned.into_inner(),
        };
        watchers.retain(|session_id, _| bindings.contains_key(session_id));
        for (session_id, bound) in &bindings {
            let watcher = watchers
                .entry(session_id.clone())
                .or_insert_with(|| BoundWatchState::seed(&inner.config, bound));
            let count = watcher.poll(&inner.config, bound);
            completions.extend((0..count).map(|_| bound.completion_event()));
        }
    }

    for event in completions {
        emit_event(inner, event);
    }
}

fn emit_event(inner: &AgentRuntimeInner, event: AgentEvent) {
    let mut state = match inner.state.lock() {
        Ok(state) => state,
        Err(poisoned) => poisoned.into_inner(),
    };
    state
        .subscribers
        .retain(|subscriber| subscriber.send(event.clone()).is_ok());
}

#[derive(Default)]
struct GrokTurnState {
    turn_started: bool,
}

impl GrokTurnState {
    fn observe(&mut self, line: &[u8], expected_session_id: Uuid) -> bool {
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            return false;
        };
        let Some(event_type) = value.get("type").and_then(Value::as_str) else {
            return false;
        };
        match event_type {
            "turn_started" => {
                let matches = value
                    .get("session_id")
                    .and_then(Value::as_str)
                    .and_then(|id| Uuid::parse_str(id).ok())
                    .is_some_and(|id| id == expected_session_id);
                if matches {
                    self.turn_started = true;
                }
                false
            }
            "turn_ended" if self.turn_started => {
                self.turn_started = false;
                matches!(
                    value.get("outcome").and_then(Value::as_str),
                    Some("completed" | "success" | "succeeded")
                )
            }
            _ => false,
        }
    }
}

struct BoundWatchState {
    path: Option<PathBuf>,
    cursor: TailCursor,
    grok: GrokTurnState,
    initial_discovery_complete: bool,
}

impl BoundWatchState {
    fn seed(config: &AgentRuntimeConfig, bound: &BoundAgent) -> Self {
        let path = discover_watch_file(config, bound);
        let cursor = path
            .as_deref()
            .and_then(|path| TailCursor::seed_at_end(path).ok())
            .unwrap_or_default();
        Self {
            path,
            cursor,
            grok: GrokTurnState::default(),
            initial_discovery_complete: true,
        }
    }

    fn poll(&mut self, config: &AgentRuntimeConfig, bound: &BoundAgent) -> usize {
        if self.path.as_ref().is_some_and(|path| !path.is_file()) {
            self.path = None;
            self.cursor = TailCursor::default();
            self.grok = GrokTurnState::default();
        }
        if self.path.is_none()
            && let Some(path) = discover_watch_file(config, bound)
        {
            self.cursor = if self.initial_discovery_complete {
                TailCursor::default()
            } else {
                TailCursor::seed_at_end(&path).unwrap_or_default()
            };
            self.path = Some(path);
            self.initial_discovery_complete = true;
        }
        let Some(path) = self.path.as_deref() else {
            return 0;
        };
        let Ok(lines) = self.cursor.read_appended_lines(path) else {
            return 0;
        };
        match bound.binding.provider {
            AgentProvider::Codex => lines
                .iter()
                .filter(|line| is_codex_task_complete(line))
                .count(),
            AgentProvider::Grok => lines
                .iter()
                .filter(|line| self.grok.observe(line, bound.binding.conversation_id))
                .count(),
        }
    }
}

#[derive(Default)]
struct TailCursor {
    offset: u64,
    carry: Vec<u8>,
    discard_oversized_line: bool,
}

impl TailCursor {
    fn seed_at_end(path: &Path) -> std::io::Result<Self> {
        Ok(Self {
            offset: fs::metadata(path)?.len(),
            carry: Vec::new(),
            discard_oversized_line: false,
        })
    }

    fn read_appended_lines(&mut self, path: &Path) -> std::io::Result<Vec<Vec<u8>>> {
        let mut file = fs::File::open(path)?;
        let length = file.metadata()?.len();
        if length < self.offset {
            self.offset = length;
            self.carry.clear();
            self.discard_oversized_line = false;
            return Ok(Vec::new());
        }
        if length == self.offset {
            return Ok(Vec::new());
        }
        file.seek(SeekFrom::Start(self.offset))?;
        let to_read = (length - self.offset).min(MAX_TAIL_READ_BYTES);
        let mut bytes = Vec::with_capacity(to_read as usize);
        file.take(to_read).read_to_end(&mut bytes)?;
        self.offset += bytes.len() as u64;

        let mut lines = Vec::new();
        for byte in bytes {
            if self.discard_oversized_line {
                if byte == b'\n' {
                    self.discard_oversized_line = false;
                }
                continue;
            }
            if byte == b'\n' {
                if self.carry.last() == Some(&b'\r') {
                    self.carry.pop();
                }
                lines.push(std::mem::take(&mut self.carry));
            } else {
                self.carry.push(byte);
                if self.carry.len() > MAX_LINE_BYTES {
                    self.carry.clear();
                    self.discard_oversized_line = true;
                }
            }
        }
        Ok(lines)
    }
}

fn discover_watch_file(config: &AgentRuntimeConfig, bound: &BoundAgent) -> Option<PathBuf> {
    let root = match bound.binding.provider {
        AgentProvider::Codex => &config.codex_sessions_root,
        AgentProvider::Grok => &config.grok_sessions_root,
    };
    if !root.is_dir() {
        return None;
    }
    let mut queue = VecDeque::from([root.clone()]);
    let mut visited = 0_usize;
    let mut candidates = Vec::new();
    while let Some(directory) = queue.pop_front() {
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited > MAX_DISCOVERY_ENTRIES {
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
                queue.push_back(path);
                continue;
            }
            if !metadata.is_file() || !watch_filename_matches(&path, &bound.binding) {
                continue;
            }
            if bound.binding.provider == AgentProvider::Codex
                && !is_codex_root_rollout(&path, bound.binding.conversation_id)
            {
                continue;
            }
            candidates.push((metadata.modified().unwrap_or(UNIX_EPOCH), path));
        }
        if visited > MAX_DISCOVERY_ENTRIES {
            break;
        }
    }
    candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.0));
    candidates.into_iter().next().map(|(_, path)| path)
}

fn watch_filename_matches(path: &Path, binding: &ValidatedAgentBinding) -> bool {
    match binding.provider {
        AgentProvider::Codex => {
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                return false;
            }
            let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
                return false;
            };
            stem.get(stem.len().saturating_sub(36)..)
                .and_then(|suffix| Uuid::parse_str(suffix).ok())
                .is_some_and(|id| id == binding.conversation_id)
        }
        AgentProvider::Grok => {
            path.file_name().and_then(|value| value.to_str()) == Some("events.jsonl")
                && path
                    .parent()
                    .and_then(Path::file_name)
                    .and_then(|value| value.to_str())
                    .and_then(|value| Uuid::parse_str(value).ok())
                    .is_some_and(|id| id == binding.conversation_id)
        }
    }
}

fn is_codex_root_rollout(path: &Path, expected_id: Uuid) -> bool {
    let Ok(file) = fs::File::open(path) else {
        return false;
    };
    let mut line = Vec::new();
    if BufReader::new(file)
        .take((MAX_LINE_BYTES + 1) as u64)
        .read_until(b'\n', &mut line)
        .is_err()
        || line.len() > MAX_LINE_BYTES
    {
        return false;
    }
    let Ok(root) = serde_json::from_slice::<Value>(&line) else {
        return false;
    };
    if root.get("type").and_then(Value::as_str) != Some("session_meta") {
        return false;
    }
    let Some(payload) = root.get("payload").and_then(Value::as_object) else {
        return false;
    };
    let id = payload
        .get("id")
        .or_else(|| payload.get("session_id"))
        .and_then(Value::as_str)
        .and_then(|id| Uuid::parse_str(id).ok());
    if id != Some(expected_id) {
        return false;
    }
    let source_is_subagent = payload
        .get("source")
        .and_then(Value::as_object)
        .is_some_and(|source| source.contains_key("subagent"));
    let thread_source_is_subagent = payload
        .get("thread_source")
        .and_then(Value::as_str)
        .is_some_and(|source| source.eq_ignore_ascii_case("subagent"));
    if source_is_subagent || thread_source_is_subagent {
        return false;
    }
    let source = payload.get("source");
    source.and_then(Value::as_str) == Some("cli")
        || (source.is_none()
            && payload.get("originator").and_then(Value::as_str) == Some("codex-tui"))
}

fn is_codex_task_complete(line: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<Value>(line) else {
        return false;
    };
    value.get("type").and_then(Value::as_str) == Some("event_msg")
        && value
            .get("payload")
            .and_then(Value::as_object)
            .and_then(|payload| payload.get("type"))
            .and_then(Value::as_str)
            == Some("task_complete")
}

fn validate_key_part(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty()
        || value.len() > MAX_STABLE_KEY_BYTES
        || value.as_bytes().contains(&0)
    {
        return Err(format!(
            "The stable terminal {label} identifier is invalid."
        ));
    }
    Ok(())
}

fn validate_runtime_session_id(value: &str) -> Result<(), String> {
    if Uuid::parse_str(value).is_err() {
        return Err("The runtime terminal session identifier is invalid.".to_owned());
    }
    Ok(())
}

fn agent_lock<T>(mutex: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, String> {
    mutex
        .lock()
        .map_err(|_| "The agent runtime lock was poisoned.".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
    use std::{fs::OpenOptions, io::Write};
    use tempfile::TempDir;

    #[derive(Default)]
    struct RecordingSink {
        events: Mutex<Vec<AgentEvent>>,
    }

    impl AgentEventSink for RecordingSink {
        fn send(&self, event: AgentEvent) -> Result<(), String> {
            self.events.lock().unwrap().push(event);
            Ok(())
        }
    }

    fn key(name: &str) -> StableTerminalKey {
        StableTerminalKey {
            project_id: "project-a".to_owned(),
            terminal_id: name.to_owned(),
        }
    }

    fn resume(provider: AgentProvider, id: Uuid) -> AgentResumeBinding {
        AgentResumeBinding {
            provider,
            conversation_id: id.to_string(),
        }
    }

    fn decode_plan(plan: &TerminalLaunchPlan) -> String {
        let encoded = plan.arguments().last().unwrap();
        let bytes = BASE64_STANDARD.decode(encoded).unwrap();
        let units = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        String::from_utf16(&units).unwrap()
    }

    fn test_runtime(directory: &TempDir) -> AgentRuntime {
        AgentRuntime::new(
            AgentRuntimeConfig {
                codex_sessions_root: directory.path().join("codex"),
                grok_sessions_root: directory.path().join("grok"),
                poll_interval: Duration::from_secs(60),
            },
            false,
        )
    }

    #[test]
    fn launch_plans_are_fixed_encoded_provider_commands() {
        let codex_id = Uuid::new_v4();
        let codex = TerminalLaunchPlan::from_request(
            Some(key("codex")),
            Some(resume(AgentProvider::Codex, codex_id)),
        )
        .unwrap();
        assert_eq!(
            &codex.arguments()[..3],
            ["-NoLogo", "-NoExit", "-EncodedCommand"]
        );
        let codex_script = decode_plan(&codex);
        assert!(codex_script.contains(&format!("codex resume '{codex_id}'")));
        assert!(codex_script.contains("--dangerously-bypass-approvals-and-sandbox"));
        assert!(!codex_script.contains("grok --resume"));

        let grok_id = Uuid::new_v4();
        let grok = TerminalLaunchPlan::from_request(
            Some(key("grok")),
            Some(resume(AgentProvider::Grok, grok_id)),
        )
        .unwrap();
        let grok_script = decode_plan(&grok);
        assert!(grok_script.contains(&format!("grok --resume '{grok_id}'")));
        assert!(!grok_script.contains("codex resume"));
    }

    #[test]
    fn invalid_uuid_and_missing_stable_key_fail_closed() {
        let invalid = TerminalLaunchPlan::from_request(
            Some(key("bad")),
            Some(AgentResumeBinding {
                provider: AgentProvider::Codex,
                conversation_id: "not-a-uuid'; Write-Host injected".to_owned(),
            }),
        );
        assert!(invalid.is_err());
        assert!(
            TerminalLaunchPlan::from_request(
                None,
                Some(resume(AgentProvider::Grok, Uuid::new_v4()))
            )
            .is_err()
        );
    }

    #[test]
    fn ownership_rejects_conversation_and_terminal_conflicts_then_releases() {
        let directory = TempDir::new().unwrap();
        let runtime = test_runtime(&directory);
        let conversation = Uuid::new_v4();
        let first_session = Uuid::new_v4().simple().to_string();
        let second_session = Uuid::new_v4().simple().to_string();
        runtime
            .bind(
                &first_session,
                key("one"),
                resume(AgentProvider::Codex, conversation),
            )
            .unwrap();
        assert!(
            runtime
                .bind(
                    &second_session,
                    key("two"),
                    resume(AgentProvider::Codex, conversation),
                )
                .is_err()
        );
        assert!(
            runtime
                .bind(
                    &second_session,
                    key("one"),
                    resume(AgentProvider::Grok, Uuid::new_v4()),
                )
                .is_err()
        );
        assert_eq!(runtime.binding_count(), 1);
        runtime.unbind(&first_session).unwrap();
        runtime
            .bind(
                &second_session,
                key("two"),
                resume(AgentProvider::Codex, conversation),
            )
            .unwrap();
        assert_eq!(runtime.binding_count(), 1);
        runtime.shutdown();
    }

    #[test]
    fn binding_is_idempotent_but_not_mutable() {
        let directory = TempDir::new().unwrap();
        let runtime = test_runtime(&directory);
        let session = Uuid::new_v4().simple().to_string();
        let conversation = Uuid::new_v4();
        let first = runtime
            .bind(
                &session,
                key("one"),
                resume(AgentProvider::Codex, conversation),
            )
            .unwrap();
        let duplicate = runtime
            .bind(
                &session,
                key("one"),
                resume(AgentProvider::Codex, conversation),
            )
            .unwrap();
        assert_eq!(first, duplicate);
        assert!(
            runtime
                .bind(
                    &session,
                    key("two"),
                    resume(AgentProvider::Codex, conversation),
                )
                .is_err()
        );
        runtime.shutdown();
    }

    #[test]
    fn grok_requires_matching_start_before_successful_end() {
        let session = Uuid::new_v4();
        let other = Uuid::new_v4();
        let mut state = GrokTurnState::default();
        assert!(!state.observe(br#"not json"#, session));
        assert!(!state.observe(br#"{"type":"turn_ended","outcome":"completed"}"#, session));
        assert!(!state.observe(
            format!(r#"{{"type":"turn_started","session_id":"{other}"}}"#).as_bytes(),
            session,
        ));
        assert!(!state.observe(
            format!(r#"{{"type":"turn_started","session_id":"{session}"}}"#).as_bytes(),
            session,
        ));
        assert!(!state.observe(br#"{"type":"turn_ended","outcome":"error"}"#, session));
        assert!(!state.observe(br#"{"type":"turn_ended","outcome":"completed"}"#, session));
        assert!(!state.observe(
            format!(r#"{{"type":"turn_started","session_id":"{session}"}}"#).as_bytes(),
            session,
        ));
        assert!(state.observe(br#"{"type":"turn_ended","outcome":"completed"}"#, session));
        assert!(!state.observe(br#"{"type":"turn_ended","outcome":"completed"}"#, session));
    }

    #[test]
    fn codex_watcher_seeds_eof_and_does_not_duplicate_polled_bytes() {
        let directory = TempDir::new().unwrap();
        let runtime = test_runtime(&directory);
        let id = Uuid::new_v4();
        let sessions = directory.path().join("codex").join("2026").join("07");
        fs::create_dir_all(&sessions).unwrap();
        let rollout = sessions.join(format!("rollout-test-{id}.jsonl"));
        fs::write(
            &rollout,
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{id}\",\"cwd\":\"C:\\\\work\",\"source\":\"cli\"}}}}\n{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"task_complete\"}}}}\n"
            ),
        )
        .unwrap();
        let sink = Arc::new(RecordingSink::default());
        runtime.subscribe_sink(sink.clone()).unwrap();
        let runtime_session = Uuid::new_v4().simple().to_string();
        runtime
            .bind(
                &runtime_session,
                key("codex"),
                resume(AgentProvider::Codex, id),
            )
            .unwrap();
        runtime.poll_once();
        assert!(sink.events.lock().unwrap().is_empty());

        let mut file = OpenOptions::new().append(true).open(&rollout).unwrap();
        writeln!(
            file,
            "{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"task_complete\"}}}}"
        )
        .unwrap();
        runtime.poll_once();
        runtime.poll_once();
        assert_eq!(sink.events.lock().unwrap().len(), 1);
        runtime.shutdown();
    }

    #[test]
    fn codex_subagent_rollout_is_never_watched() {
        let directory = TempDir::new().unwrap();
        let runtime = test_runtime(&directory);
        let id = Uuid::new_v4();
        let sessions = directory.path().join("codex");
        fs::create_dir_all(&sessions).unwrap();
        let rollout = sessions.join(format!("rollout-test-{id}.jsonl"));
        fs::write(
            &rollout,
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{id}\",\"cwd\":\"C:\\\\work\",\"source\":{{\"subagent\":{{}}}}}}}}\n"
            ),
        )
        .unwrap();
        let sink = Arc::new(RecordingSink::default());
        runtime.subscribe_sink(sink.clone()).unwrap();
        runtime
            .bind(
                &Uuid::new_v4().simple().to_string(),
                key("subagent"),
                resume(AgentProvider::Codex, id),
            )
            .unwrap();
        let mut file = OpenOptions::new().append(true).open(rollout).unwrap();
        writeln!(
            file,
            "{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"task_complete\"}}}}"
        )
        .unwrap();
        runtime.poll_once();
        assert!(sink.events.lock().unwrap().is_empty());
        runtime.shutdown();
    }
}
