use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    env, fs,
    hash::Hash,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::ipc::Channel;
use uuid::Uuid;

const MAX_STABLE_KEY_BYTES: usize = 512;
const MAX_DISCOVERY_ENTRIES: usize = 50_000;
const MAX_TAIL_READ_BYTES: u64 = 256 * 1024;
const MAX_CONTEXT_LOOKBACK_BYTES: u64 = 8 * 1024 * 1024;
const CONTEXT_SCAN_CHUNK_BYTES: usize = 64 * 1024;
const MAX_LINE_BYTES: usize = 1024 * 1024;
const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(180);
const GROK_DISCOVERY_SETTLE: Duration = Duration::from_millis(500);
const GROK_DISCOVERY_PROBE_TTL: Duration = Duration::from_secs(30);
const GROK_DISCOVERY_TIME_GRACE_MS: u64 = 2_000;
const MAX_SAFE_JS_INTEGER: u64 = 9_007_199_254_740_991;
const HOOK_TRANSCRIPT_SETTLE: Duration = Duration::from_secs(2);
const COMPLETED_TURN_RETENTION: Duration = Duration::from_secs(30);
const MAX_TRACKED_TURNS: usize = 32;

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
            "Start-Sleep -Milliseconds 100; $ihcAttempt=0; do {{ $ihcAttempt++; & codex resume '{id}' --dangerously-bypass-approvals-and-sandbox; $ihcExit=$LASTEXITCODE; if ($ihcExit -eq 0 -or $ihcAttempt -ge 3) {{ break }}; Start-Sleep -Milliseconds (750 * $ihcAttempt) }} while ($true)"
        ),
        AgentProvider::Grok => format!(
            "Start-Sleep -Milliseconds 100; $ihcAttempt=0; do {{ $ihcAttempt++; & grok --resume '{id}'; $ihcOk=$?; if ($ihcOk -or $ihcAttempt -ge 3) {{ break }}; Start-Sleep -Milliseconds (900 * $ihcAttempt) }} while ($true)"
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
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentDiscovery {
    pub(crate) binding: AgentBindingSnapshot,
    pub(crate) completion_observed_at_unix_ms: Option<u64>,
}

pub(crate) struct AgentDiscoveryRequest {
    pub(crate) runtime_session_id: String,
    pub(crate) terminal_key: StableTerminalKey,
    pub(crate) provider: AgentProvider,
    pub(crate) working_directory: PathBuf,
    pub(crate) not_before_unix_ms: u64,
    pub(crate) notified_completion: Option<crate::codex_notify::CodexCompletionRoute>,
    pub(crate) codex_notifications: Vec<crate::codex_notify::CodexHookEventRecord>,
    pub(crate) grok_notifications: Vec<crate::grok_notify::GrokHookEventRecord>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "event",
    content = "data"
)]
pub(crate) enum AgentEvent {
    TurnStarted {
        runtime_session_id: String,
        terminal_key: StableTerminalKey,
        provider: AgentProvider,
        conversation_id: String,
        turn_id: Option<String>,
        observed_at_unix_ms: u64,
    },
    TurnFinished {
        runtime_session_id: String,
        terminal_key: StableTerminalKey,
        provider: AgentProvider,
        conversation_id: String,
        turn_id: Option<String>,
        observed_at_unix_ms: u64,
        succeeded: bool,
        notification_observed_at_unix_ms: Option<u64>,
    },
    ContextUpdated {
        runtime_session_id: String,
        terminal_key: StableTerminalKey,
        provider: AgentProvider,
        conversation_id: String,
        observed_at_unix_ms: u64,
        used_tokens: u64,
        window_tokens: u64,
        remaining_percent: u8,
    },
}

impl AgentEvent {
    fn matches_bound_agent(&self, bound: &BoundAgent) -> bool {
        let (runtime_session_id, terminal_key, provider, conversation_id) = match self {
            Self::TurnStarted {
                runtime_session_id,
                terminal_key,
                provider,
                conversation_id,
                ..
            }
            | Self::TurnFinished {
                runtime_session_id,
                terminal_key,
                provider,
                conversation_id,
                ..
            }
            | Self::ContextUpdated {
                runtime_session_id,
                terminal_key,
                provider,
                conversation_id,
                ..
            } => (runtime_session_id, terminal_key, provider, conversation_id),
        };
        runtime_session_id == &bound.runtime_session_id
            && terminal_key == &bound.terminal_key
            && provider == &bound.binding.provider
            && Uuid::parse_str(conversation_id).is_ok_and(|id| id == bound.binding.conversation_id)
    }
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

    #[cfg(test)]
    fn lifecycle_event(&self, observation: TurnObservation) -> AgentEvent {
        self.lifecycle_event_with_notification(observation, None, None)
    }

    fn lifecycle_event_with_notification(
        &self,
        observation: TurnObservation,
        notification_observed_at_unix_ms: Option<u64>,
        turn_id: Option<String>,
    ) -> AgentEvent {
        let observed_at_unix_ms = notification_observed_at_unix_ms.unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .min(u128::from(u64::MAX)) as u64
        });
        match observation {
            TurnObservation::Started => AgentEvent::TurnStarted {
                runtime_session_id: self.runtime_session_id.clone(),
                terminal_key: self.terminal_key.clone(),
                provider: self.binding.provider,
                conversation_id: self.binding.conversation_id.to_string(),
                turn_id,
                observed_at_unix_ms,
            },
            TurnObservation::Finished { succeeded } => AgentEvent::TurnFinished {
                runtime_session_id: self.runtime_session_id.clone(),
                terminal_key: self.terminal_key.clone(),
                provider: self.binding.provider,
                conversation_id: self.binding.conversation_id.to_string(),
                turn_id,
                observed_at_unix_ms,
                succeeded,
                notification_observed_at_unix_ms,
            },
        }
    }

    fn context_event(&self, context: ContextSnapshot) -> AgentEvent {
        AgentEvent::ContextUpdated {
            runtime_session_id: self.runtime_session_id.clone(),
            terminal_key: self.terminal_key.clone(),
            provider: self.binding.provider,
            conversation_id: self.binding.conversation_id.to_string(),
            observed_at_unix_ms: system_time_millis(SystemTime::now()),
            used_tokens: context.used_tokens,
            window_tokens: context.max_tokens,
            remaining_percent: context.remaining_percent(),
        }
    }
}

#[derive(Default)]
struct AgentRuntimeState {
    shutting_down: bool,
    bindings: HashMap<String, BoundAgent>,
    conversation_owners: HashMap<OwnershipKey, String>,
    terminal_owners: HashMap<StableTerminalKey, String>,
    grok_discovery_probes: HashMap<String, GrokDiscoveryProbe>,
    subscribers: Vec<Arc<dyn AgentEventSink>>,
}

#[derive(Clone, Debug)]
struct GrokDiscoveryProbe {
    working_directory: PathBuf,
    first_seen: Instant,
    first_seen_unix_ms: u64,
    last_seen: Instant,
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

    #[cfg(test)]
    pub(crate) fn bind(
        &self,
        runtime_session_id: &str,
        terminal_key: StableTerminalKey,
        resume: AgentResumeBinding,
    ) -> Result<AgentBindingSnapshot, String> {
        terminal_key.validate()?;
        validate_runtime_session_id(runtime_session_id)?;
        let binding = ValidatedAgentBinding::try_from(resume)?;
        self.bind_validated(runtime_session_id, terminal_key, binding, None)
    }

    pub(crate) fn bind_discovered(
        &self,
        runtime_session_id: &str,
        terminal_key: StableTerminalKey,
        resume: AgentResumeBinding,
        replay_not_before_unix_ms: u64,
    ) -> Result<AgentBindingSnapshot, String> {
        terminal_key.validate()?;
        validate_runtime_session_id(runtime_session_id)?;
        let binding = ValidatedAgentBinding::try_from(resume)?;
        self.bind_validated(
            runtime_session_id,
            terminal_key,
            binding,
            Some(replay_not_before_unix_ms),
        )
    }

    pub(crate) fn discover_conversation(
        &self,
        request: AgentDiscoveryRequest,
    ) -> Result<Option<AgentDiscovery>, String> {
        let AgentDiscoveryRequest {
            runtime_session_id,
            terminal_key,
            provider,
            working_directory,
            not_before_unix_ms,
            notified_completion,
            codex_notifications,
            grok_notifications,
        } = request;
        terminal_key.validate()?;
        validate_runtime_session_id(&runtime_session_id)?;
        let normalized_directory = fs::canonicalize(&working_directory)
            .map_err(|_| "The agent discovery working directory is invalid.".to_owned())?;

        let notified_grok = (provider == AgentProvider::Grok)
            .then(|| {
                grok_notified_conversation(
                    &self.inner.config,
                    &grok_notifications,
                    &normalized_directory,
                    not_before_unix_ms,
                )
            })
            .flatten();
        let legacy_notified = notified_completion
            .as_ref()
            .filter(|_| provider == AgentProvider::Codex)
            .and_then(|notification| {
                Uuid::parse_str(&notification.conversation_id)
                    .ok()
                    .map(|conversation_id| (conversation_id, notification.observed_at_unix_ms))
            })
            .filter(|(conversation_id, _)| {
                codex_root_conversation_matches(
                    &self.inner.config,
                    *conversation_id,
                    &normalized_directory,
                )
            });
        let hook_notified = (provider == AgentProvider::Codex)
            .then(|| {
                codex_notified_conversation(
                    &self.inner.config,
                    &codex_notifications,
                    &normalized_directory,
                    not_before_unix_ms,
                )
            })
            .flatten();
        let notified = match (legacy_notified, hook_notified) {
            (Some(legacy), Some(hook)) if hook.1 > legacy.1 => Some(hook),
            (Some(legacy), _) => Some(legacy),
            (None, hook) => hook,
        };

        // Do not keep the state guard alive as the `if let` scrutinee. The
        // exact conversation-switch branch checks ownership again below and
        // would otherwise try to lock this same non-reentrant mutex twice.
        let existing = {
            let state = agent_lock(&self.inner.state)?;
            state.bindings.get(&runtime_session_id).cloned()
        };
        if let Some(existing) = existing {
            if existing.terminal_key != terminal_key {
                return Err(
                    "The terminal session already owns a different agent binding.".to_owned(),
                );
            }
            let switched = match provider {
                AgentProvider::Codex => notified.map(|(conversation_id, observed_at)| {
                    let completion = latest_codex_stop(
                        &codex_notifications,
                        conversation_id,
                        not_before_unix_ms,
                    )
                    .or_else(|| {
                        notified_completion
                            .as_ref()
                            .filter(|notification| {
                                Uuid::parse_str(&notification.conversation_id).ok()
                                    == Some(conversation_id)
                            })
                            .map(|_| observed_at)
                    });
                    (conversation_id, completion)
                }),
                AgentProvider::Grok => notified_grok,
            }
            .filter(|(conversation_id, _)| {
                existing.binding.provider != provider
                    || existing.binding.conversation_id != *conversation_id
            });
            if let Some((conversation_id, completion_observed_at_unix_ms)) = switched {
                let ownership_key = OwnershipKey {
                    provider,
                    conversation_id,
                };
                let available = agent_lock(&self.inner.state)?
                    .conversation_owners
                    .get(&ownership_key)
                    .is_none_or(|owner| owner == &runtime_session_id);
                if available {
                    return Ok(Some(AgentDiscovery {
                        binding: AgentBindingSnapshot {
                            runtime_session_id,
                            terminal_key,
                            provider,
                            conversation_id: conversation_id.to_string(),
                        },
                        completion_observed_at_unix_ms,
                    }));
                }
                return Ok(None);
            }
            if existing.binding.provider != provider {
                return Ok(None);
            }
            let completion_observed_at_unix_ms = match provider {
                AgentProvider::Codex => notified_completion
                    .filter(|notification| {
                        Uuid::parse_str(&notification.conversation_id)
                            .is_ok_and(|id| id == existing.binding.conversation_id)
                    })
                    .map(|notification| notification.observed_at_unix_ms)
                    .into_iter()
                    .chain(latest_codex_stop(
                        &codex_notifications,
                        existing.binding.conversation_id,
                        not_before_unix_ms,
                    ))
                    .max(),
                AgentProvider::Grok => latest_grok_stop(
                    &grok_notifications,
                    existing.binding.conversation_id,
                    not_before_unix_ms,
                ),
            };
            return Ok(Some(AgentDiscovery {
                binding: existing.snapshot(),
                completion_observed_at_unix_ms,
            }));
        }
        let discovery_not_before_unix_ms =
            if provider == AgentProvider::Grok && notified_grok.is_none() {
                let Some(provider_first_seen_unix_ms) = self
                    .grok_discovery_probe_not_before(&runtime_session_id, &normalized_directory)?
                else {
                    return Ok(None);
                };
                not_before_unix_ms
                    .max(provider_first_seen_unix_ms.saturating_sub(GROK_DISCOVERY_TIME_GRACE_MS))
            } else {
                not_before_unix_ms
            };

        let conversation_id = if provider == AgentProvider::Codex {
            notified.map(|(conversation_id, _)| conversation_id)
        } else if let Some((conversation_id, _)) = notified_grok {
            Some(conversation_id)
        } else {
            let owned = agent_lock(&self.inner.state)?
                .conversation_owners
                .keys()
                .filter(|key| key.provider == provider)
                .map(|key| key.conversation_id)
                .collect::<std::collections::HashSet<_>>();
            discover_unowned_conversation(
                &self.inner.config,
                provider,
                &normalized_directory,
                discovery_not_before_unix_ms,
                &owned,
            )
        };
        let Some(conversation_id) = conversation_id else {
            return Ok(None);
        };
        let ownership_key = OwnershipKey {
            provider,
            conversation_id,
        };
        {
            let state = agent_lock(&self.inner.state)?;
            if state.conversation_owners.contains_key(&ownership_key)
                || state.terminal_owners.contains_key(&terminal_key)
            {
                return Ok(None);
            }
        }
        let snapshot = AgentBindingSnapshot {
            runtime_session_id,
            terminal_key,
            provider,
            conversation_id: conversation_id.to_string(),
        };
        Ok(Some(AgentDiscovery {
            binding: snapshot,
            completion_observed_at_unix_ms: notified
                .and_then(|(conversation_id, observed_at)| {
                    latest_codex_stop(&codex_notifications, conversation_id, not_before_unix_ms)
                        .or_else(|| {
                            notified_completion
                                .as_ref()
                                .filter(|notification| {
                                    Uuid::parse_str(&notification.conversation_id).ok()
                                        == Some(conversation_id)
                                })
                                .map(|_| observed_at)
                        })
                })
                .or_else(|| notified_grok.and_then(|(_, observed_at)| observed_at))
                .or_else(|| {
                    (provider == AgentProvider::Grok && notified_grok.is_none())
                        .then(|| {
                            grok_latest_completed_turn(
                                &self.inner.config,
                                conversation_id,
                                discovery_not_before_unix_ms,
                            )
                        })
                        .flatten()
                }),
        }))
    }

    fn grok_discovery_probe_not_before(
        &self,
        runtime_session_id: &str,
        working_directory: &Path,
    ) -> Result<Option<u64>, String> {
        let now = Instant::now();
        let mut state = agent_lock(&self.inner.state)?;
        state
            .grok_discovery_probes
            .retain(|_, probe| now.duration_since(probe.last_seen) <= GROK_DISCOVERY_PROBE_TTL);
        let probe = state
            .grok_discovery_probes
            .entry(runtime_session_id.to_owned())
            .or_insert_with(|| GrokDiscoveryProbe {
                working_directory: working_directory.to_path_buf(),
                first_seen: now,
                first_seen_unix_ms: system_time_millis(SystemTime::now()),
                last_seen: now,
            });
        if !same_working_directory(&probe.working_directory, working_directory) {
            probe.working_directory = working_directory.to_path_buf();
            probe.first_seen = now;
            probe.first_seen_unix_ms = system_time_millis(SystemTime::now());
        }
        probe.last_seen = now;
        let settled = now.duration_since(probe.first_seen) >= GROK_DISCOVERY_SETTLE;
        let first_seen_unix_ms = probe.first_seen_unix_ms;
        let competing_probe = state
            .grok_discovery_probes
            .iter()
            .any(|(session_id, other)| {
                session_id != runtime_session_id
                    && same_working_directory(&other.working_directory, working_directory)
            });
        Ok((settled && !competing_probe).then_some(first_seen_unix_ms))
    }

    fn bind_validated(
        &self,
        runtime_session_id: &str,
        terminal_key: StableTerminalKey,
        binding: ValidatedAgentBinding,
        replay_not_before_unix_ms: Option<u64>,
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
            let replacing = if let Some(existing) = state.bindings.get(runtime_session_id) {
                if existing.terminal_key == terminal_key && existing.binding == bound.binding {
                    return Ok(existing.snapshot());
                }
                if existing.terminal_key != terminal_key {
                    return Err(
                        "The terminal session already owns a different stable terminal.".to_owned(),
                    );
                }
                Some(existing.binding.ownership_key())
            } else {
                None
            };
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
            if let Some(previous_ownership_key) = replacing
                && state
                    .conversation_owners
                    .get(&previous_ownership_key)
                    .is_some_and(|owner| owner == runtime_session_id)
            {
                state.conversation_owners.remove(&previous_ownership_key);
            }
            state
                .conversation_owners
                .insert(ownership_key, runtime_session_id.to_owned());
            state
                .terminal_owners
                .insert(terminal_key, runtime_session_id.to_owned());
            state.grok_discovery_probes.remove(runtime_session_id);
            state
                .bindings
                .insert(runtime_session_id.to_owned(), bound.clone());
        }

        let mut watch =
            BoundWatchState::seed(&self.inner.config, &bound, replay_not_before_unix_ms);
        let initial_observations = std::mem::take(&mut watch.initial_observations);
        let initial_context = watch.initial_context.take();
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
        for observation in initial_observations {
            emit_event(
                &self.inner,
                bound.lifecycle_event_with_notification(
                    observation.observation,
                    observation.notification_observed_at_unix_ms,
                    observation.turn_id,
                ),
            );
        }
        if let Some(context) = initial_context {
            emit_event(&self.inner, bound.context_event(context));
        }
        Ok(bound.snapshot())
    }

    pub(crate) fn claim_for_start(
        &self,
        runtime_session_id: &str,
        terminal_key: &StableTerminalKey,
        binding: &ValidatedAgentBinding,
    ) -> Result<AgentBindingLease, String> {
        self.bind_validated(
            runtime_session_id,
            terminal_key.clone(),
            binding.clone(),
            None,
        )?;
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
            state.grok_discovery_probes.remove(runtime_session_id);
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
            state.grok_discovery_probes.clear();
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

    let mut events = Vec::new();
    {
        let mut watchers = match inner.watchers.lock() {
            Ok(watchers) => watchers,
            Err(poisoned) => poisoned.into_inner(),
        };
        watchers.retain(|session_id, _| bindings.contains_key(session_id));
        for (session_id, bound) in &bindings {
            let watcher = watchers
                .entry(session_id.clone())
                .or_insert_with(|| BoundWatchState::seed(&inner.config, bound, None));
            let (observations, context) = watcher.poll(&inner.config, bound);
            events.extend(observations.into_iter().map(|observation| {
                bound.lifecycle_event_with_notification(
                    observation.observation,
                    observation.notification_observed_at_unix_ms,
                    observation.turn_id,
                )
            }));
            if let Some(context) = context {
                events.push(bound.context_event(context));
            }
        }
    }

    for event in events {
        emit_event(inner, event);
    }
}

fn emit_event(inner: &AgentRuntimeInner, event: AgentEvent) {
    let mut state = match inner.state.lock() {
        Ok(state) => state,
        Err(poisoned) => poisoned.into_inner(),
    };
    let current = match &event {
        AgentEvent::TurnStarted {
            runtime_session_id, ..
        }
        | AgentEvent::TurnFinished {
            runtime_session_id, ..
        }
        | AgentEvent::ContextUpdated {
            runtime_session_id, ..
        } => state.bindings.get(runtime_session_id),
    };
    if !current.is_some_and(|bound| event.matches_bound_agent(bound)) {
        return;
    }
    state
        .subscribers
        .retain(|subscriber| subscriber.send(event.clone()).is_ok());
}

#[derive(Default)]
struct GrokTurnState {
    turn_started: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TurnObservation {
    Started,
    Finished { succeeded: bool },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ContextSnapshot {
    used_tokens: u64,
    max_tokens: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct FileStamp {
    length: u64,
    modified: SystemTime,
}

impl ContextSnapshot {
    fn new(used_tokens: u64, max_tokens: u64) -> Option<Self> {
        (used_tokens > 0
            && max_tokens > 0
            && used_tokens <= max_tokens
            && used_tokens <= MAX_SAFE_JS_INTEGER
            && max_tokens <= MAX_SAFE_JS_INTEGER)
            .then_some(Self {
                used_tokens,
                max_tokens,
            })
    }

    fn remaining_percent(self) -> u8 {
        let remaining = u128::from(self.max_tokens - self.used_tokens) * 100;
        ((remaining + u128::from(self.max_tokens / 2)) / u128::from(self.max_tokens)) as u8
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ObservedTurn {
    observation: TurnObservation,
    notification_observed_at_unix_ms: Option<u64>,
    turn_id: Option<String>,
}

impl From<TurnObservation> for ObservedTurn {
    fn from(observation: TurnObservation) -> Self {
        Self {
            observation,
            notification_observed_at_unix_ms: None,
            turn_id: None,
        }
    }
}

#[derive(Default)]
struct TurnLifecycleState {
    turns: VecDeque<TrackedTurn>,
}

#[derive(Default)]
struct TrackedTurn {
    turn_id: Option<String>,
    hook_started: bool,
    transcript_started: bool,
    started_emitted: bool,
    hook_success_at_unix_ms: Option<u64>,
    hook_failure: bool,
    hook_completion_seen_at: Option<Instant>,
    transcript_outcome: Option<bool>,
    completion_emitted: bool,
    completion_emitted_at: Option<Instant>,
}

impl TrackedTurn {
    fn has_hook_completion(&self) -> bool {
        self.hook_failure || self.hook_success_at_unix_ms.is_some()
    }

    fn has_turn_id(&self, turn_id: &str) -> bool {
        self.turn_id.as_deref() == Some(turn_id)
    }

    fn accepts_turn_id(&self, turn_id: Option<&str>) -> bool {
        match (self.turn_id.as_deref(), turn_id) {
            (Some(current), Some(candidate)) => current == candidate,
            _ => true,
        }
    }

    fn remember_turn_id(&mut self, turn_id: &Option<String>) {
        if self.turn_id.is_none() {
            self.turn_id.clone_from(turn_id);
        }
    }
}

impl TurnLifecycleState {
    fn reconcile(
        &mut self,
        notifications: Vec<ObservedTurn>,
        fallback: Vec<ObservedTurn>,
        fallback_available: bool,
        now: Instant,
    ) -> Vec<ObservedTurn> {
        let mut observations = Vec::new();

        // Hook prompt boundaries create logical turns. Completions are retained
        // as candidates because a generic Stop does not prove success.
        for notification in notifications {
            let ObservedTurn {
                observation,
                notification_observed_at_unix_ms,
                turn_id,
            } = notification;
            match observation {
                TurnObservation::Started => {
                    if let Some(existing) = turn_id.as_deref().and_then(|turn_id| {
                        self.turns
                            .iter()
                            .rposition(|turn| turn.has_turn_id(turn_id))
                    }) {
                        let turn = &mut self.turns[existing];
                        if turn.completion_emitted || turn.hook_started {
                            continue;
                        }
                        turn.hook_started = true;
                        if !turn.started_emitted {
                            turn.started_emitted = true;
                            observations.push(ObservedTurn {
                                observation: TurnObservation::Started,
                                notification_observed_at_unix_ms: None,
                                turn_id,
                            });
                        }
                        continue;
                    }
                    if let Some(previous) = self
                        .turns
                        .iter()
                        .rposition(|turn| turn.has_hook_completion() && !turn.completion_emitted)
                        && let Some(completion) =
                            Self::finalize_turn(&mut self.turns[previous], false, now)
                    {
                        observations.push(completion);
                    }
                    self.turns.push_back(TrackedTurn {
                        turn_id: turn_id.clone(),
                        hook_started: true,
                        started_emitted: true,
                        ..TrackedTurn::default()
                    });
                    observations.push(ObservedTurn {
                        observation: TurnObservation::Started,
                        notification_observed_at_unix_ms: None,
                        turn_id,
                    });
                }
                TurnObservation::Finished { succeeded } => {
                    let exact_turn = turn_id.as_deref().and_then(|turn_id| {
                        self.turns
                            .iter()
                            .rposition(|turn| turn.has_turn_id(turn_id))
                    });
                    let turn_index = exact_turn.or_else(|| {
                        self.turns
                            .iter()
                            // Codex can deliver the same logical completion through both
                            // the stdin Stop hook and the legacy notify callback. When a
                            // UserPromptSubmit hook was missed, the first completion has
                            // no `hook_started` turn to attach to and creates an anonymous
                            // candidate below. Reuse that pending candidate for the second
                            // source instead of manufacturing a second finished turn.
                            .rposition(|turn| {
                                !turn.completion_emitted
                                    && turn.accepts_turn_id(turn_id.as_deref())
                                    && (turn.hook_started || turn.has_hook_completion())
                            })
                    });
                    let turn_index = turn_index.unwrap_or_else(|| {
                        self.turns.push_back(TrackedTurn {
                            turn_id: turn_id.clone(),
                            ..TrackedTurn::default()
                        });
                        self.turns.len() - 1
                    });
                    let turn = &mut self.turns[turn_index];
                    turn.remember_turn_id(&turn_id);
                    turn.hook_completion_seen_at.get_or_insert(now);
                    if succeeded {
                        turn.hook_success_at_unix_ms = turn
                            .hook_success_at_unix_ms
                            .max(notification_observed_at_unix_ms);
                    } else {
                        turn.hook_failure = true;
                    }
                }
            }
        }

        // Provider transcripts are the outcome authority. Match their turns to
        // hook turns FIFO so a delayed prior transcript cannot finish a newer
        // prompt that already started while the old Stop was settling.
        for transcript in fallback {
            let ObservedTurn {
                observation,
                notification_observed_at_unix_ms: _,
                turn_id,
            } = transcript;
            match observation {
                TurnObservation::Started => {
                    let exact_turn = turn_id.as_deref().and_then(|turn_id| {
                        self.turns.iter().position(|turn| turn.has_turn_id(turn_id))
                    });
                    if self.turns.iter().any(|turn| {
                        turn.transcript_started
                            && turn.transcript_outcome.is_none()
                            && turn.accepts_turn_id(turn_id.as_deref())
                    }) {
                        continue;
                    }
                    let turn_index = exact_turn
                        .or_else(|| {
                            self.turns.iter().position(|turn| {
                                !turn.transcript_started
                                    && turn.transcript_outcome.is_none()
                                    && turn.accepts_turn_id(turn_id.as_deref())
                            })
                        })
                        .unwrap_or_else(|| {
                            self.turns.push_back(TrackedTurn {
                                turn_id: turn_id.clone(),
                                ..TrackedTurn::default()
                            });
                            self.turns.len() - 1
                        });
                    let turn = &mut self.turns[turn_index];
                    turn.remember_turn_id(&turn_id);
                    turn.transcript_started = true;
                    if !turn.started_emitted && !turn.completion_emitted {
                        turn.started_emitted = true;
                        observations.push(ObservedTurn {
                            observation: TurnObservation::Started,
                            notification_observed_at_unix_ms: None,
                            turn_id,
                        });
                    }
                }
                TurnObservation::Finished { succeeded } => {
                    let exact_turn = turn_id.as_deref().and_then(|turn_id| {
                        self.turns.iter().position(|turn| turn.has_turn_id(turn_id))
                    });
                    let turn_index = exact_turn
                        .or_else(|| {
                            self.turns.iter().position(|turn| {
                                turn.transcript_started
                                    && turn.transcript_outcome.is_none()
                                    && turn.accepts_turn_id(turn_id.as_deref())
                            })
                        })
                        .or_else(|| {
                            self.turns.iter().position(|turn| {
                                turn.has_hook_completion()
                                    && turn.transcript_outcome.is_none()
                                    && turn.accepts_turn_id(turn_id.as_deref())
                            })
                        });
                    let Some(turn_index) = turn_index else {
                        if self.turns.iter().any(|turn| turn.completion_emitted) {
                            continue;
                        }
                        self.turns.push_back(TrackedTurn {
                            turn_id: turn_id.clone(),
                            ..TrackedTurn::default()
                        });
                        let turn_index = self.turns.len() - 1;
                        self.turns[turn_index].transcript_outcome = Some(succeeded);
                        if let Some(completion) = Self::finalize_turn(
                            &mut self.turns[turn_index],
                            fallback_available,
                            now,
                        ) {
                            observations.push(completion);
                        }
                        continue;
                    };
                    self.turns[turn_index].remember_turn_id(&turn_id);
                    if self.turns[turn_index].completion_emitted {
                        // The transcript, Stop hook and legacy notify callback
                        // can arrive in different poll cycles for the same
                        // Codex turn. Preserve the stronger outcome evidence,
                        // but never manufacture another completion edge.
                        self.turns[turn_index].transcript_outcome = Some(succeeded);
                        continue;
                    }
                    self.turns[turn_index].transcript_outcome = Some(succeeded);
                    if let Some(completion) =
                        Self::finalize_turn(&mut self.turns[turn_index], fallback_available, now)
                    {
                        observations.push(completion);
                    }
                }
            }
        }

        for turn in &mut self.turns {
            if let Some(completion) = Self::finalize_turn(turn, fallback_available, now) {
                observations.push(completion);
            }
        }

        self.turns.retain(|turn| {
            !turn.completion_emitted
                || turn.completion_emitted_at.is_some_and(|emitted| {
                    now.saturating_duration_since(emitted) < COMPLETED_TURN_RETENTION
                })
        });
        while self.turns.len() > MAX_TRACKED_TURNS {
            let removable = self
                .turns
                .iter()
                .position(|turn| turn.completion_emitted)
                .unwrap_or(0);
            self.turns.remove(removable);
        }

        observations
    }

    fn finalize_turn(
        turn: &mut TrackedTurn,
        fallback_available: bool,
        now: Instant,
    ) -> Option<ObservedTurn> {
        if turn.completion_emitted {
            return None;
        }
        let transcript_ready = turn.transcript_outcome.is_some();
        let hook_ready = turn.has_hook_completion()
            && (!fallback_available
                || turn.hook_completion_seen_at.is_some_and(|seen| {
                    now.saturating_duration_since(seen) >= HOOK_TRANSCRIPT_SETTLE
                }));
        if !transcript_ready && !hook_ready {
            return None;
        }

        // Any explicit abort/failure wins over generic success signals from
        // either source. This is the key precedence rule for Codex Stop +
        // turn_aborted and Grok Stop + StopFailure combinations.
        let succeeded = turn.transcript_outcome.unwrap_or(true) && !turn.hook_failure;
        turn.completion_emitted = true;
        turn.completion_emitted_at = Some(now);
        Some(ObservedTurn {
            observation: TurnObservation::Finished { succeeded },
            notification_observed_at_unix_ms: succeeded
                .then_some(turn.hook_success_at_unix_ms)
                .flatten(),
            turn_id: turn.turn_id.clone(),
        })
    }
}

impl GrokTurnState {
    fn observe(&mut self, line: &[u8], expected_session_id: Uuid) -> Option<TurnObservation> {
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            return None;
        };
        let event_type = value.get("type").and_then(Value::as_str)?;
        match event_type {
            "turn_started" => {
                let matches = value
                    .get("session_id")
                    .and_then(Value::as_str)
                    .and_then(|id| Uuid::parse_str(id).ok())
                    .is_some_and(|id| id == expected_session_id);
                if matches {
                    self.turn_started = true;
                    return Some(TurnObservation::Started);
                }
                None
            }
            "turn_ended" if self.turn_started => {
                let session_matches = value.get("session_id").is_none_or(|id| {
                    id.as_str()
                        .and_then(|id| Uuid::parse_str(id).ok())
                        .is_some_and(|id| id == expected_session_id)
                });
                if !session_matches {
                    return None;
                }
                self.turn_started = false;
                Some(TurnObservation::Finished {
                    succeeded: matches!(
                        value.get("outcome").and_then(Value::as_str),
                        Some("completed" | "success" | "succeeded")
                    ),
                })
            }
            _ => None,
        }
    }
}

struct BoundWatchState {
    path: Option<PathBuf>,
    cursor: TailCursor,
    context_cursor: TailCursor,
    grok: GrokTurnState,
    initial_observations: Vec<ObservedTurn>,
    initial_context: Option<ContextSnapshot>,
    last_context: Option<ContextSnapshot>,
    grok_signals_stamp: Option<FileStamp>,
    initial_discovery_complete: bool,
    last_codex_completion: Option<crate::codex_notify::CodexCompletionRoute>,
    last_codex_hook_completion: Option<crate::codex_notify::CodexHookEventRecord>,
    processed_codex_events: VecDeque<crate::codex_notify::CodexHookEventRecord>,
    last_grok_completion: Option<crate::grok_notify::GrokHookEventRecord>,
    processed_grok_events: VecDeque<crate::grok_notify::GrokHookEventRecord>,
    lifecycle: TurnLifecycleState,
}

impl BoundWatchState {
    fn seed(
        config: &AgentRuntimeConfig,
        bound: &BoundAgent,
        replay_not_before_unix_ms: Option<u64>,
    ) -> Self {
        let path = discover_watch_file(config, bound);
        let cursor = path
            .as_deref()
            .and_then(|path| TailCursor::seed_at_end(path).ok())
            .unwrap_or_default();
        let context_cursor = path
            .as_deref()
            .and_then(|path| TailCursor::seed_at_end(path).ok())
            .unwrap_or_default();
        let (initial_context, grok_signals_stamp) =
            read_initial_context(path.as_deref(), bound.binding.provider);
        let mut state = Self {
            path,
            cursor,
            context_cursor,
            grok: GrokTurnState::default(),
            initial_observations: Vec::new(),
            initial_context,
            last_context: initial_context,
            grok_signals_stamp,
            initial_discovery_complete: true,
            last_codex_completion: None,
            last_codex_hook_completion: None,
            processed_codex_events: VecDeque::new(),
            last_grok_completion: None,
            processed_grok_events: VecDeque::new(),
            lifecycle: TurnLifecycleState::default(),
        };
        let notifications = state.poll_provider_notifications(bound);
        let notification_has_completion = notifications
            .iter()
            .any(|observation| matches!(observation.observation, TurnObservation::Finished { .. }));
        let mut fallback = Vec::new();
        match bound.binding.provider {
            AgentProvider::Codex if notification_has_completion => {
                if let Some(path) = state.path.as_deref()
                    && let Some(finished) = read_latest_codex_completion(path)
                {
                    fallback.push(finished);
                }
            }
            AgentProvider::Grok => {
                if let Some(path) = state.path.as_deref()
                    && let Some(snapshot) =
                        read_grok_replay_snapshot(path, bound.binding.conversation_id)
                {
                    state.cursor = snapshot.cursor;
                    let replay_is_fresh = replay_not_before_unix_ms.is_some_and(|not_before| {
                        snapshot
                            .modified_at_unix_ms
                            .saturating_add(GROK_DISCOVERY_TIME_GRACE_MS)
                            >= not_before
                    });
                    if notification_has_completion || replay_is_fresh {
                        state.grok = snapshot.state;
                        fallback = match snapshot.latest_observation {
                            Some(TurnObservation::Started) => {
                                vec![TurnObservation::Started.into()]
                            }
                            Some(finished @ TurnObservation::Finished { .. }) => {
                                vec![TurnObservation::Started.into(), finished.into()]
                            }
                            None => Vec::new(),
                        };
                    }
                }
            }
            AgentProvider::Codex => {}
        }
        state.initial_observations = state.lifecycle.reconcile(
            notifications,
            fallback,
            state.path.is_some(),
            Instant::now(),
        );
        state
    }

    fn poll(
        &mut self,
        config: &AgentRuntimeConfig,
        bound: &BoundAgent,
    ) -> (Vec<ObservedTurn>, Option<ContextSnapshot>) {
        let notifications = self.poll_provider_notifications(bound);
        let mut context_updated = None;
        if self.path.as_ref().is_some_and(|path| !path.is_file()) {
            self.path = None;
            self.cursor = TailCursor::default();
            self.context_cursor = TailCursor::default();
            self.grok = GrokTurnState::default();
            self.grok_signals_stamp = None;
            self.initial_observations.clear();
        }
        if self.path.is_none()
            && let Some(path) = discover_watch_file(config, bound)
        {
            self.cursor = if self.initial_discovery_complete {
                TailCursor::default()
            } else {
                TailCursor::seed_at_end(&path).unwrap_or_default()
            };
            self.context_cursor = TailCursor::seed_at_end(&path).unwrap_or_default();
            let (context, stamp) = read_initial_context(Some(&path), bound.binding.provider);
            self.grok_signals_stamp = stamp;
            if context.is_some() && context != self.last_context {
                self.last_context = context;
                context_updated = context;
            }
            self.path = Some(path);
            self.initial_discovery_complete = true;
        }
        let Some(path) = self.path.as_deref() else {
            let observations =
                self.lifecycle
                    .reconcile(notifications, Vec::new(), false, Instant::now());
            return (observations, context_updated);
        };
        let Ok(lines) = self.cursor.read_appended_lines(path) else {
            let observations =
                self.lifecycle
                    .reconcile(notifications, Vec::new(), true, Instant::now());
            return (observations, context_updated);
        };
        let fallback = match bound.binding.provider {
            AgentProvider::Codex => lines
                .iter()
                .filter_map(|line| observe_codex_turn(line))
                .collect::<Vec<_>>(),
            AgentProvider::Grok => lines
                .iter()
                .filter_map(|line| self.grok.observe(line, bound.binding.conversation_id))
                .map(ObservedTurn::from)
                .collect::<Vec<_>>(),
        };
        let observations = self
            .lifecycle
            .reconcile(notifications, fallback, true, Instant::now());
        let context = match bound.binding.provider {
            AgentProvider::Codex => {
                self.context_cursor
                    .read_appended_lines(path)
                    .ok()
                    .and_then(|lines| {
                        lines
                            .iter()
                            .filter_map(|line| observe_codex_context(line))
                            .next_back()
                    })
            }
            AgentProvider::Grok => poll_grok_context(path, &mut self.grok_signals_stamp),
        };
        if context.is_some() && context != self.last_context {
            self.last_context = context;
            context_updated = context;
        }
        (observations, context_updated)
    }

    fn poll_provider_notifications(&mut self, bound: &BoundAgent) -> Vec<ObservedTurn> {
        match bound.binding.provider {
            AgentProvider::Codex => self.poll_codex_notification(bound),
            AgentProvider::Grok => self.poll_grok_notifications(bound),
        }
    }

    fn poll_codex_notification(&mut self, bound: &BoundAgent) -> Vec<ObservedTurn> {
        let mut observations = self.poll_codex_hook_notifications(bound);
        let Ok(notification) = crate::codex_notify::read_completion(&bound.runtime_session_id)
        else {
            return observations;
        };
        let Some(notification) = notification else {
            self.last_codex_completion = None;
            return observations;
        };
        let matches = Uuid::parse_str(&notification.conversation_id)
            .is_ok_and(|conversation_id| conversation_id == bound.binding.conversation_id);
        if !matches || self.last_codex_completion.as_ref() == Some(&notification) {
            return observations;
        }
        self.last_codex_completion = Some(notification.clone());
        observations.push(ObservedTurn {
            observation: TurnObservation::Finished { succeeded: true },
            notification_observed_at_unix_ms: Some(notification.observed_at_unix_ms),
            turn_id: notification.turn_id.clone(),
        });
        observations
    }

    fn poll_codex_hook_notifications(&mut self, bound: &BoundAgent) -> Vec<ObservedTurn> {
        let Ok(notifications) = crate::codex_notify::read_hook_events(&bound.runtime_session_id)
        else {
            return Vec::new();
        };
        let matching = notifications
            .into_iter()
            .filter(|notification| {
                Uuid::parse_str(&notification.session_id)
                    .is_ok_and(|conversation_id| conversation_id == bound.binding.conversation_id)
            })
            .collect::<Vec<_>>();
        let mut observations = Vec::new();
        let mut saw_stop = false;
        for notification in matching {
            match notification.event {
                crate::codex_notify::CodexHookEvent::SessionStart => {
                    let _ = crate::codex_notify::acknowledge_hook_event(
                        &bound.runtime_session_id,
                        &notification,
                    );
                }
                crate::codex_notify::CodexHookEvent::UserPromptSubmit => {
                    if self.remember_codex_event(notification.clone()) {
                        observations.push(ObservedTurn {
                            observation: TurnObservation::Started,
                            notification_observed_at_unix_ms: None,
                            turn_id: notification.turn_id.clone(),
                        });
                    }
                    let _ = crate::codex_notify::acknowledge_hook_event(
                        &bound.runtime_session_id,
                        &notification,
                    );
                }
                crate::codex_notify::CodexHookEvent::Stop => {
                    saw_stop = true;
                    if self.last_codex_hook_completion.as_ref() != Some(&notification) {
                        self.last_codex_hook_completion = Some(notification.clone());
                        observations.push(ObservedTurn {
                            observation: TurnObservation::Finished { succeeded: true },
                            notification_observed_at_unix_ms: Some(
                                notification.observed_at_unix_ms,
                            ),
                            turn_id: notification.turn_id.clone(),
                        });
                    }
                }
            }
        }
        if !saw_stop {
            self.last_codex_hook_completion = None;
        }
        observations
    }

    fn remember_codex_event(
        &mut self,
        notification: crate::codex_notify::CodexHookEventRecord,
    ) -> bool {
        if self.processed_codex_events.contains(&notification) {
            return false;
        }
        const MAX_PROCESSED_CODEX_EVENTS: usize = 128;
        self.processed_codex_events.push_back(notification);
        while self.processed_codex_events.len() > MAX_PROCESSED_CODEX_EVENTS {
            self.processed_codex_events.pop_front();
        }
        true
    }

    fn poll_grok_notifications(&mut self, bound: &BoundAgent) -> Vec<ObservedTurn> {
        let Ok(notifications) = crate::grok_notify::read_events(&bound.runtime_session_id) else {
            return Vec::new();
        };
        let matching = notifications
            .into_iter()
            .filter(|notification| {
                Uuid::parse_str(&notification.session_id)
                    .is_ok_and(|conversation_id| conversation_id == bound.binding.conversation_id)
            })
            .collect::<Vec<_>>();
        if matching.is_empty() {
            self.last_grok_completion = None;
            return Vec::new();
        }

        let mut observations = Vec::new();
        let mut saw_stop = false;
        for notification in matching {
            match notification.event {
                crate::grok_notify::GrokHookEvent::SessionStart => {
                    let _ = crate::grok_notify::acknowledge_event(
                        &bound.runtime_session_id,
                        &notification,
                    );
                }
                crate::grok_notify::GrokHookEvent::UserPromptSubmit => {
                    if self.remember_grok_event(notification.clone()) {
                        observations.push(TurnObservation::Started.into());
                    }
                    let _ = crate::grok_notify::acknowledge_event(
                        &bound.runtime_session_id,
                        &notification,
                    );
                }
                crate::grok_notify::GrokHookEvent::StopFailure => {
                    if self.remember_grok_event(notification.clone()) {
                        observations.push(TurnObservation::Finished { succeeded: false }.into());
                    }
                    let _ = crate::grok_notify::acknowledge_event(
                        &bound.runtime_session_id,
                        &notification,
                    );
                }
                crate::grok_notify::GrokHookEvent::Stop => {
                    saw_stop = true;
                    if self.last_grok_completion.as_ref() != Some(&notification) {
                        self.last_grok_completion = Some(notification.clone());
                        observations.push(ObservedTurn {
                            observation: TurnObservation::Finished { succeeded: true },
                            notification_observed_at_unix_ms: Some(
                                notification.observed_at_unix_ms,
                            ),
                            turn_id: None,
                        });
                    }
                }
            }
        }
        if !saw_stop {
            self.last_grok_completion = None;
        }
        observations
    }

    fn remember_grok_event(
        &mut self,
        notification: crate::grok_notify::GrokHookEventRecord,
    ) -> bool {
        if self.processed_grok_events.contains(&notification) {
            return false;
        }
        const MAX_PROCESSED_GROK_EVENTS: usize = 128;
        self.processed_grok_events.push_back(notification);
        while self.processed_grok_events.len() > MAX_PROCESSED_GROK_EVENTS {
            self.processed_grok_events.pop_front();
        }
        true
    }
}

#[cfg(test)]
fn replay_grok_turn_state(path: &Path, expected_session_id: Uuid) -> GrokTurnState {
    read_grok_replay_snapshot(path, expected_session_id)
        .map(|snapshot| snapshot.state)
        .unwrap_or_default()
}

fn grok_latest_completed_turn(
    config: &AgentRuntimeConfig,
    conversation_id: Uuid,
    not_before_unix_ms: u64,
) -> Option<u64> {
    let binding = ValidatedAgentBinding {
        provider: AgentProvider::Grok,
        conversation_id,
    };
    let path = discover_agent_watch_file(config, &binding)?;
    let snapshot = read_grok_replay_snapshot(&path, conversation_id)?;
    if snapshot.modified_at_unix_ms < not_before_unix_ms {
        return None;
    }
    matches!(
        snapshot.latest_observation,
        Some(TurnObservation::Finished { succeeded: true })
    )
    .then_some(snapshot.modified_at_unix_ms)
}

struct GrokReplaySnapshot {
    cursor: TailCursor,
    state: GrokTurnState,
    latest_observation: Option<TurnObservation>,
    modified_at_unix_ms: u64,
}

fn read_grok_replay_snapshot(path: &Path, expected_session_id: Uuid) -> Option<GrokReplaySnapshot> {
    let file = fs::File::open(path).ok()?;
    let metadata = file.metadata().ok()?;
    let length = metadata.len();
    let modified_at_unix_ms = system_time_millis(metadata.modified().unwrap_or(UNIX_EPOCH));
    let mut reader = BufReader::new(file.take(length));
    let mut state = GrokTurnState::default();
    let mut latest_observation = None;
    let mut line = Vec::new();
    let mut oversized = false;

    loop {
        let available = reader.fill_buf().ok()?;
        if available.is_empty() {
            if !oversized
                && !line.is_empty()
                && let Some(observation) = state.observe(&line, expected_session_id)
            {
                latest_observation = Some(observation);
            }
            break;
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.unwrap_or(available.len());
        if !oversized {
            if line.len().saturating_add(consumed) <= MAX_LINE_BYTES {
                line.extend_from_slice(&available[..consumed]);
            } else {
                line.clear();
                oversized = true;
            }
        }
        let completes_line = newline.is_some();
        reader.consume(consumed + usize::from(completes_line));
        if completes_line {
            if !oversized && let Some(observation) = state.observe(&line, expected_session_id) {
                latest_observation = Some(observation);
            }
            line.clear();
            oversized = false;
        }
    }

    Some(GrokReplaySnapshot {
        cursor: TailCursor {
            offset: length,
            carry: Vec::new(),
            discard_oversized_line: false,
        },
        state,
        latest_observation,
        modified_at_unix_ms,
    })
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

fn discover_unowned_conversation(
    config: &AgentRuntimeConfig,
    provider: AgentProvider,
    working_directory: &Path,
    not_before_unix_ms: u64,
    owned: &HashSet<Uuid>,
) -> Option<Uuid> {
    let root = match provider {
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
            if !metadata.is_file() {
                continue;
            }
            let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
            let modified_unix_ms = system_time_millis(modified);
            if modified_unix_ms < not_before_unix_ms {
                continue;
            }
            let candidate = match provider {
                AgentProvider::Codex => {
                    if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                        None
                    } else {
                        read_codex_root_metadata(&path)
                            .map(|metadata| (metadata.conversation_id, metadata.working_directory))
                    }
                }
                AgentProvider::Grok => {
                    if path.file_name().and_then(|value| value.to_str()) != Some("events.jsonl") {
                        None
                    } else {
                        read_grok_session_metadata(&path)
                    }
                }
            };
            let Some((conversation_id, candidate_directory)) = candidate else {
                continue;
            };
            if owned.contains(&conversation_id)
                || !same_working_directory(&candidate_directory, working_directory)
            {
                continue;
            }
            candidates.push((modified, conversation_id));
        }
        if visited > MAX_DISCOVERY_ENTRIES {
            break;
        }
    }
    candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.0));
    // A same-folder multi-pane workspace is common. Guessing the newest file
    // would silently swap conversations between panes, so only a unique
    // unowned candidate may be associated. Codex's pane-scoped notifier can
    // still resolve an ambiguous candidate exactly after a completed turn.
    (candidates.len() == 1).then(|| candidates[0].1)
}

fn codex_root_conversation_matches(
    config: &AgentRuntimeConfig,
    conversation_id: Uuid,
    working_directory: &Path,
) -> bool {
    let root = &config.codex_sessions_root;
    if !root.is_dir() {
        return false;
    }
    let id_text = conversation_id.to_string();
    let mut queue = VecDeque::from([root.clone()]);
    let mut visited = 0_usize;
    while let Some(directory) = queue.pop_front() {
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited > MAX_DISCOVERY_ENTRIES {
                return false;
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
            if !metadata.is_file()
                || path.extension().and_then(|value| value.to_str()) != Some("jsonl")
                || !path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|name| name.to_ascii_lowercase().contains(&id_text))
            {
                continue;
            }
            if read_codex_root_metadata(&path).is_some_and(|metadata| {
                metadata.conversation_id == conversation_id
                    && same_working_directory(&metadata.working_directory, working_directory)
            }) {
                return true;
            }
        }
    }
    false
}

fn codex_notified_conversation(
    config: &AgentRuntimeConfig,
    notifications: &[crate::codex_notify::CodexHookEventRecord],
    working_directory: &Path,
    not_before_unix_ms: u64,
) -> Option<(Uuid, u64)> {
    notifications
        .iter()
        .filter(|notification| notification.observed_at_unix_ms >= not_before_unix_ms)
        .filter_map(|notification| {
            Uuid::parse_str(&notification.session_id)
                .ok()
                .map(|conversation_id| (conversation_id, notification.observed_at_unix_ms))
        })
        .filter(|(conversation_id, _)| {
            codex_root_conversation_matches(config, *conversation_id, working_directory)
        })
        .max_by_key(|(_, observed_at)| *observed_at)
}

fn latest_codex_stop(
    notifications: &[crate::codex_notify::CodexHookEventRecord],
    conversation_id: Uuid,
    not_before_unix_ms: u64,
) -> Option<u64> {
    notifications
        .iter()
        .filter(|notification| {
            notification.event == crate::codex_notify::CodexHookEvent::Stop
                && notification.observed_at_unix_ms >= not_before_unix_ms
                && Uuid::parse_str(&notification.session_id).ok() == Some(conversation_id)
        })
        .map(|notification| notification.observed_at_unix_ms)
        .max()
}

fn grok_notified_conversation(
    config: &AgentRuntimeConfig,
    notifications: &[crate::grok_notify::GrokHookEventRecord],
    working_directory: &Path,
    not_before_unix_ms: u64,
) -> Option<(Uuid, Option<u64>)> {
    let cutoff = not_before_unix_ms.saturating_sub(GROK_DISCOVERY_TIME_GRACE_MS);
    let conversation_id = notifications
        .iter()
        .filter(|notification| notification.observed_at_unix_ms >= cutoff)
        .filter_map(|notification| {
            Uuid::parse_str(&notification.session_id)
                .ok()
                .map(|conversation_id| (notification.observed_at_unix_ms, conversation_id))
        })
        .max_by_key(|(observed_at, _)| *observed_at)
        .map(|(_, conversation_id)| conversation_id)?;
    if !grok_conversation_matches(config, conversation_id, working_directory) {
        return None;
    }
    Some((
        conversation_id,
        latest_grok_stop(notifications, conversation_id, not_before_unix_ms),
    ))
}

fn latest_grok_stop(
    notifications: &[crate::grok_notify::GrokHookEventRecord],
    conversation_id: Uuid,
    not_before_unix_ms: u64,
) -> Option<u64> {
    let cutoff = not_before_unix_ms.saturating_sub(GROK_DISCOVERY_TIME_GRACE_MS);
    notifications
        .iter()
        .filter(|notification| {
            notification.event == crate::grok_notify::GrokHookEvent::Stop
                && notification.observed_at_unix_ms >= cutoff
                && Uuid::parse_str(&notification.session_id)
                    .is_ok_and(|candidate| candidate == conversation_id)
        })
        .map(|notification| notification.observed_at_unix_ms)
        .max()
}

fn grok_conversation_matches(
    config: &AgentRuntimeConfig,
    conversation_id: Uuid,
    working_directory: &Path,
) -> bool {
    let binding = ValidatedAgentBinding {
        provider: AgentProvider::Grok,
        conversation_id,
    };
    discover_agent_watch_file(config, &binding)
        .and_then(|events_path| read_grok_session_metadata(&events_path))
        .is_some_and(|(candidate_id, candidate_directory)| {
            candidate_id == conversation_id
                && same_working_directory(&candidate_directory, working_directory)
        })
}

#[derive(Debug)]
struct CodexRootMetadata {
    conversation_id: Uuid,
    working_directory: PathBuf,
}

fn read_codex_root_metadata(path: &Path) -> Option<CodexRootMetadata> {
    let file = fs::File::open(path).ok()?;
    let mut line = Vec::new();
    BufReader::new(file)
        .take((MAX_LINE_BYTES + 1) as u64)
        .read_until(b'\n', &mut line)
        .ok()?;
    if line.len() > MAX_LINE_BYTES {
        return None;
    }
    let root = serde_json::from_slice::<Value>(&line).ok()?;
    if root.get("type").and_then(Value::as_str) != Some("session_meta") {
        return None;
    }
    let payload = root.get("payload").and_then(Value::as_object)?;
    let conversation_id = payload
        .get("id")
        .or_else(|| payload.get("session_id"))
        .and_then(Value::as_str)
        .and_then(|id| Uuid::parse_str(id).ok())?;
    let working_directory = payload
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|cwd| !cwd.trim().is_empty())
        .map(PathBuf::from)?;
    let source_is_subagent = payload
        .get("source")
        .and_then(Value::as_object)
        .is_some_and(|source| source.contains_key("subagent"));
    let thread_source_is_subagent = payload
        .get("thread_source")
        .and_then(Value::as_str)
        .is_some_and(|source| source.eq_ignore_ascii_case("subagent"));
    if source_is_subagent || thread_source_is_subagent {
        return None;
    }
    let source = payload.get("source");
    let is_resumable_user_thread = source.and_then(Value::as_str).is_some_and(|source| {
        source.eq_ignore_ascii_case("cli") || source.eq_ignore_ascii_case("vscode")
    }) || (source.is_none()
        && payload
            .get("originator")
            .and_then(Value::as_str)
            .is_some_and(|originator| originator.eq_ignore_ascii_case("codex-tui")));
    is_resumable_user_thread.then_some(CodexRootMetadata {
        conversation_id,
        working_directory,
    })
}

fn read_grok_session_metadata(events_path: &Path) -> Option<(Uuid, PathBuf)> {
    let session_directory = events_path.parent()?;
    let conversation_id = session_directory
        .file_name()
        .and_then(|value| value.to_str())
        .and_then(|value| Uuid::parse_str(value).ok())?;
    let summary_path = session_directory.join("summary.json");
    let file = fs::File::open(summary_path).ok()?;
    let mut bytes = Vec::new();
    file.take((MAX_LINE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > MAX_LINE_BYTES {
        return None;
    }
    let root = serde_json::from_slice::<Value>(&bytes).ok()?;
    let working_directory = root
        .get("info")
        .and_then(Value::as_object)
        .and_then(|info| info.get("cwd"))
        .and_then(Value::as_str)
        .filter(|cwd| !cwd.trim().is_empty())
        .map(PathBuf::from)?;
    Some((conversation_id, working_directory))
}

fn same_working_directory(candidate: &Path, expected: &Path) -> bool {
    let Ok(candidate) = fs::canonicalize(candidate) else {
        return false;
    };
    #[cfg(windows)]
    {
        candidate
            .to_string_lossy()
            .eq_ignore_ascii_case(&expected.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        candidate == expected
    }
}

fn system_time_millis(value: SystemTime) -> u64 {
    value
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn discover_watch_file(config: &AgentRuntimeConfig, bound: &BoundAgent) -> Option<PathBuf> {
    discover_agent_watch_file(config, &bound.binding)
}

fn discover_agent_watch_file(
    config: &AgentRuntimeConfig,
    binding: &ValidatedAgentBinding,
) -> Option<PathBuf> {
    let root = match binding.provider {
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
            if !metadata.is_file() || !watch_filename_matches(&path, binding) {
                continue;
            }
            if binding.provider == AgentProvider::Codex
                && !is_codex_root_rollout(&path, binding.conversation_id)
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
    read_codex_root_metadata(path).is_some_and(|metadata| metadata.conversation_id == expected_id)
}

fn observe_codex_turn(line: &[u8]) -> Option<ObservedTurn> {
    let Ok(value) = serde_json::from_slice::<Value>(line) else {
        return None;
    };
    if value.get("type").and_then(Value::as_str) != Some("event_msg") {
        return None;
    }
    let payload = value.get("payload")?.as_object()?;
    let observation = match payload.get("type").and_then(Value::as_str) {
        Some("task_started" | "turn_started") => TurnObservation::Started,
        Some("task_complete" | "turn_complete") => TurnObservation::Finished { succeeded: true },
        Some("turn_aborted") => TurnObservation::Finished { succeeded: false },
        _ => return None,
    };
    let turn_id = ["turn_id", "turn-id", "turnId"]
        .into_iter()
        .find_map(|key| payload.get(key).and_then(Value::as_str))
        .and_then(|value| crate::codex_notify::normalize_turn_id(value).ok());
    Some(ObservedTurn {
        observation,
        notification_observed_at_unix_ms: None,
        turn_id,
    })
}

fn read_latest_codex_completion(path: &Path) -> Option<ObservedTurn> {
    let mut file = fs::File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    if length == 0 {
        return None;
    }
    let start = length.saturating_sub(MAX_TAIL_READ_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::with_capacity((length - start) as usize);
    file.take(MAX_TAIL_READ_BYTES)
        .read_to_end(&mut bytes)
        .ok()?;
    let complete_bytes = if start == 0 {
        bytes.as_slice()
    } else {
        let first_newline = bytes.iter().position(|byte| *byte == b'\n')?;
        &bytes[first_newline + 1..]
    };
    complete_bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty() && line.len() <= MAX_LINE_BYTES)
        .filter_map(observe_codex_turn)
        .next_back()
        .filter(|observation| matches!(observation.observation, TurnObservation::Finished { .. }))
}

fn observe_codex_context(line: &[u8]) -> Option<ContextSnapshot> {
    let value = serde_json::from_slice::<Value>(line).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("event_msg") {
        return None;
    }
    let payload = value.get("payload")?.as_object()?;
    if payload.get("type").and_then(Value::as_str) != Some("token_count") {
        return None;
    }
    let info = payload.get("info")?.as_object()?;
    let used_tokens = info
        .get("last_token_usage")?
        .as_object()?
        .get("total_tokens")?
        .as_u64()?;
    let max_tokens = info.get("model_context_window")?.as_u64()?;
    ContextSnapshot::new(used_tokens, max_tokens)
}

fn observe_grok_context(bytes: &[u8]) -> Option<ContextSnapshot> {
    let value = serde_json::from_slice::<Value>(bytes).ok()?;
    let used_tokens = value.get("contextTokensUsed")?.as_u64()?;
    let max_tokens = value.get("contextWindowTokens")?.as_u64()?;
    let reported_usage = value.get("contextWindowUsage")?.as_u64()?;
    let context = ContextSnapshot::new(used_tokens, max_tokens)?;
    if reported_usage > 100 {
        return None;
    }
    let computed_usage = ((u128::from(used_tokens) * 100) / u128::from(max_tokens)) as u64;
    (reported_usage == computed_usage).then_some(context)
}

fn read_initial_context(
    events_path: Option<&Path>,
    provider: AgentProvider,
) -> (Option<ContextSnapshot>, Option<FileStamp>) {
    let Some(events_path) = events_path else {
        return (None, None);
    };
    match provider {
        AgentProvider::Codex => (read_latest_codex_context(events_path), None),
        AgentProvider::Grok => {
            let signals_path = grok_signals_path(events_path);
            let stamp = file_stamp(&signals_path);
            let context = stamp
                .as_ref()
                .and_then(|_| read_grok_context_file(&signals_path));
            (context, stamp)
        }
    }
}

fn read_latest_codex_context(path: &Path) -> Option<ContextSnapshot> {
    let mut file = fs::File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    if length == 0 {
        return None;
    }

    // A single tool result can put the latest token_count record more than the
    // normal 256 KiB live-tail window behind EOF. Scan complete JSONL records
    // backwards so restored panes still receive their already-written context
    // snapshot without loading a multi-hundred-megabyte rollout into memory.
    let lower_bound = length.saturating_sub(MAX_CONTEXT_LOOKBACK_BYTES);
    let mut position = length;
    let mut reversed_line = Vec::new();
    let mut discard_oversized_line = false;
    let mut chunk = vec![0_u8; CONTEXT_SCAN_CHUNK_BYTES];

    while position > lower_bound {
        let chunk_start = position.saturating_sub(CONTEXT_SCAN_CHUNK_BYTES as u64);
        let chunk_start = chunk_start.max(lower_bound);
        let chunk_length = (position - chunk_start) as usize;
        file.seek(SeekFrom::Start(chunk_start)).ok()?;
        file.read_exact(&mut chunk[..chunk_length]).ok()?;

        for &byte in chunk[..chunk_length].iter().rev() {
            if byte == b'\n' {
                if !discard_oversized_line && !reversed_line.is_empty() {
                    reversed_line.reverse();
                    if reversed_line.last() == Some(&b'\r') {
                        reversed_line.pop();
                    }
                    if let Some(context) = observe_codex_context(&reversed_line) {
                        return Some(context);
                    }
                }
                reversed_line.clear();
                discard_oversized_line = false;
            } else if !discard_oversized_line {
                reversed_line.push(byte);
                if reversed_line.len() > MAX_LINE_BYTES {
                    reversed_line.clear();
                    discard_oversized_line = true;
                }
            }
        }
        position = chunk_start;
    }

    // Only position zero proves the remaining bytes start at a JSONL record
    // boundary. At a bounded lookback boundary the fragment must be ignored.
    if position == 0 && !discard_oversized_line && !reversed_line.is_empty() {
        reversed_line.reverse();
        if reversed_line.last() == Some(&b'\r') {
            reversed_line.pop();
        }
        return observe_codex_context(&reversed_line);
    }
    None
}

fn grok_signals_path(events_path: &Path) -> PathBuf {
    events_path
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .join("signals.json")
}

fn file_stamp(path: &Path) -> Option<FileStamp> {
    let metadata = fs::metadata(path).ok()?;
    metadata.is_file().then(|| FileStamp {
        length: metadata.len(),
        modified: metadata.modified().unwrap_or(UNIX_EPOCH),
    })
}

fn read_grok_context_file(path: &Path) -> Option<ContextSnapshot> {
    let file = fs::File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    if length == 0 || length > MAX_TAIL_READ_BYTES {
        return None;
    }
    let mut bytes = Vec::with_capacity(length as usize);
    file.take(MAX_TAIL_READ_BYTES)
        .read_to_end(&mut bytes)
        .ok()?;
    observe_grok_context(&bytes)
}

fn poll_grok_context(
    events_path: &Path,
    previous_stamp: &mut Option<FileStamp>,
) -> Option<ContextSnapshot> {
    let signals_path = grok_signals_path(events_path);
    let current_stamp = file_stamp(&signals_path);
    if current_stamp == *previous_stamp {
        return None;
    }
    *previous_stamp = current_stamp;
    previous_stamp
        .as_ref()
        .and_then(|_| read_grok_context_file(&signals_path))
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
        assert!(codex_script.contains("$ihcAttempt -ge 3"));
        assert!(!codex_script.contains("grok --resume"));

        let grok_id = Uuid::new_v4();
        let grok = TerminalLaunchPlan::from_request(
            Some(key("grok")),
            Some(resume(AgentProvider::Grok, grok_id)),
        )
        .unwrap();
        let grok_script = decode_plan(&grok);
        assert!(grok_script.contains(&format!("grok --resume '{grok_id}'")));
        assert!(grok_script.contains("$ihcAttempt -ge 3"));
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
    fn exact_codex_notification_discovers_then_carries_completion_time() {
        let directory = TempDir::new().unwrap();
        let runtime = test_runtime(&directory);
        let runtime_session_id = Uuid::new_v4().simple().to_string();
        let conversation_id = Uuid::parse_str("01981f62-94ac-7a3b-8c12-111111111111").unwrap();
        let observed_at_unix_ms = 42_000;
        let sessions_root = directory.path().join("codex");
        fs::create_dir_all(&sessions_root).unwrap();
        let metadata = serde_json::json!({
            "type": "session_meta",
            "payload": {
                "id": conversation_id,
                "cwd": directory.path(),
                "source": "cli"
            }
        });
        fs::write(
            sessions_root.join(format!("rollout-{conversation_id}.jsonl")),
            format!("{metadata}\n"),
        )
        .unwrap();
        let discovered = runtime
            .discover_conversation(AgentDiscoveryRequest {
                runtime_session_id: runtime_session_id.clone(),
                terminal_key: key("notified"),
                provider: AgentProvider::Codex,
                working_directory: directory.path().to_path_buf(),
                not_before_unix_ms: 0,
                notified_completion: Some(crate::codex_notify::CodexCompletionRoute {
                    conversation_id: conversation_id.to_string(),
                    turn_id: None,
                    observed_at_unix_ms,
                }),
                codex_notifications: Vec::new(),
                grok_notifications: Vec::new(),
            })
            .unwrap()
            .unwrap();

        assert_eq!(
            discovered.binding.conversation_id,
            conversation_id.to_string()
        );
        assert_eq!(
            discovered.completion_observed_at_unix_ms,
            Some(observed_at_unix_ms)
        );
        assert_eq!(runtime.binding_count(), 0);
        runtime
            .bind(
                &runtime_session_id,
                key("notified"),
                resume(AgentProvider::Codex, conversation_id),
            )
            .unwrap();
        assert_eq!(runtime.binding_count(), 1);
        runtime.shutdown();
    }

    #[test]
    fn codex_session_start_hook_discovers_exact_conversation_before_completion() {
        let directory = TempDir::new().unwrap();
        let runtime = test_runtime(&directory);
        let conversation_id = Uuid::parse_str("01981f62-94ac-7a3b-8c12-222222222222").unwrap();
        let sessions_root = directory.path().join("codex");
        fs::create_dir_all(&sessions_root).unwrap();
        fs::write(
            sessions_root.join(format!("rollout-{conversation_id}.jsonl")),
            format!(
                "{}\n",
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {
                        "id": conversation_id,
                        "cwd": directory.path(),
                        "source": "cli"
                    }
                })
            ),
        )
        .unwrap();
        let discovered = runtime
            .discover_conversation(AgentDiscoveryRequest {
                runtime_session_id: Uuid::new_v4().simple().to_string(),
                terminal_key: key("codex-session-start"),
                provider: AgentProvider::Codex,
                working_directory: directory.path().to_path_buf(),
                not_before_unix_ms: 10_000,
                notified_completion: None,
                codex_notifications: vec![crate::codex_notify::CodexHookEventRecord {
                    session_id: conversation_id.to_string(),
                    event: crate::codex_notify::CodexHookEvent::SessionStart,
                    turn_id: None,
                    observed_at_unix_ms: 10_001,
                }],
                grok_notifications: Vec::new(),
            })
            .unwrap()
            .unwrap();
        assert_eq!(
            discovered.binding.conversation_id,
            conversation_id.to_string()
        );
        assert_eq!(discovered.completion_observed_at_unix_ms, None);
        runtime.shutdown();
    }

    #[test]
    fn exact_codex_notification_rebinds_same_terminal_to_new_conversation() {
        let directory = TempDir::new().unwrap();
        let runtime = test_runtime(&directory);
        let sessions_root = directory.path().join("codex");
        let working_directory = directory.path().join("workspace");
        fs::create_dir_all(&sessions_root).unwrap();
        fs::create_dir_all(&working_directory).unwrap();
        let working_directory = fs::canonicalize(working_directory).unwrap();
        let previous_conversation_id = Uuid::new_v4();
        let next_conversation_id = Uuid::new_v4();
        for conversation_id in [previous_conversation_id, next_conversation_id] {
            fs::write(
                sessions_root.join(format!("rollout-{conversation_id}.jsonl")),
                format!(
                    "{}\n",
                    serde_json::json!({
                        "type": "session_meta",
                        "payload": {
                            "id": conversation_id,
                            "cwd": working_directory,
                            "source": "cli"
                        }
                    })
                ),
            )
            .unwrap();
        }

        let runtime_session_id = Uuid::new_v4().simple().to_string();
        let terminal_key = key("codex-exact-rebind");
        runtime
            .bind(
                &runtime_session_id,
                terminal_key.clone(),
                resume(AgentProvider::Codex, previous_conversation_id),
            )
            .unwrap();

        let observed_at_unix_ms = 70_001;
        let discovered = runtime
            .discover_conversation(AgentDiscoveryRequest {
                runtime_session_id: runtime_session_id.clone(),
                terminal_key: terminal_key.clone(),
                provider: AgentProvider::Codex,
                working_directory: working_directory.clone(),
                not_before_unix_ms: 70_000,
                notified_completion: None,
                codex_notifications: vec![crate::codex_notify::CodexHookEventRecord {
                    session_id: next_conversation_id.to_string(),
                    event: crate::codex_notify::CodexHookEvent::SessionStart,
                    turn_id: None,
                    observed_at_unix_ms,
                }],
                grok_notifications: Vec::new(),
            })
            .unwrap()
            .expect("the exact hook must discover the terminal's new conversation");
        assert_eq!(
            discovered.binding.conversation_id,
            next_conversation_id.to_string()
        );
        assert_eq!(discovered.completion_observed_at_unix_ms, None);

        let rebound = runtime
            .bind_discovered(
                &runtime_session_id,
                terminal_key,
                resume(AgentProvider::Codex, next_conversation_id),
                observed_at_unix_ms,
            )
            .unwrap();
        assert_eq!(rebound.conversation_id, next_conversation_id.to_string());
        assert_eq!(runtime.binding_count(), 1);

        runtime
            .bind(
                &Uuid::new_v4().simple().to_string(),
                key("released-previous-conversation"),
                resume(AgentProvider::Codex, previous_conversation_id),
            )
            .expect("an exact rebind must release ownership of the previous conversation");
        assert!(
            runtime
                .bind(
                    &Uuid::new_v4().simple().to_string(),
                    key("still-owned-next-conversation"),
                    resume(AgentProvider::Codex, next_conversation_id),
                )
                .is_err(),
            "the rebound conversation must remain exclusively owned"
        );
        runtime.shutdown();
    }

    #[test]
    fn exact_grok_hook_discovers_without_same_folder_guessing() {
        let directory = TempDir::new().unwrap();
        let runtime = test_runtime(&directory);
        let grok_root = directory.path().join("grok");
        let working_directory = directory.path().join("workspace");
        fs::create_dir_all(&working_directory).unwrap();
        let working_directory = fs::canonicalize(working_directory).unwrap();
        let exact_id = Uuid::new_v4();
        let ambiguous_id = Uuid::new_v4();
        for conversation_id in [exact_id, ambiguous_id] {
            let session = grok_root.join(conversation_id.to_string());
            fs::create_dir_all(&session).unwrap();
            fs::write(session.join("events.jsonl"), "").unwrap();
            fs::write(
                session.join("summary.json"),
                serde_json::to_vec(&serde_json::json!({
                    "info": { "cwd": working_directory }
                }))
                .unwrap(),
            )
            .unwrap();
        }
        let observed_at_unix_ms = system_time_millis(SystemTime::now());
        let notifications = vec![
            crate::grok_notify::GrokHookEventRecord {
                session_id: exact_id.to_string(),
                event: crate::grok_notify::GrokHookEvent::SessionStart,
                observed_at_unix_ms: observed_at_unix_ms.saturating_sub(1),
            },
            crate::grok_notify::GrokHookEventRecord {
                session_id: exact_id.to_string(),
                event: crate::grok_notify::GrokHookEvent::Stop,
                observed_at_unix_ms,
            },
        ];
        let discovered = runtime
            .discover_conversation(AgentDiscoveryRequest {
                runtime_session_id: Uuid::new_v4().simple().to_string(),
                terminal_key: key("grok-hook"),
                provider: AgentProvider::Grok,
                working_directory: working_directory.clone(),
                not_before_unix_ms: observed_at_unix_ms.saturating_sub(10),
                notified_completion: None,
                codex_notifications: Vec::new(),
                grok_notifications: notifications,
            })
            .unwrap()
            .unwrap();
        assert_eq!(discovered.binding.conversation_id, exact_id.to_string());
        assert_eq!(
            discovered.completion_observed_at_unix_ms,
            Some(observed_at_unix_ms)
        );
        assert_eq!(runtime.binding_count(), 0);
        runtime.shutdown();
    }

    #[test]
    fn codex_discovery_never_persists_a_filesystem_guess_without_exact_notify() {
        let directory = TempDir::new().unwrap();
        let runtime = test_runtime(&directory);
        let sessions_root = directory.path().join("codex");
        fs::create_dir_all(&sessions_root).unwrap();
        let conversation_id = Uuid::new_v4();
        let metadata = serde_json::json!({
            "type": "session_meta",
            "payload": {
                "id": conversation_id,
                "cwd": directory.path(),
                "source": "cli"
            }
        });
        fs::write(
            sessions_root.join(format!("rollout-{conversation_id}.jsonl")),
            format!("{metadata}\n"),
        )
        .unwrap();

        assert!(
            runtime
                .discover_conversation(AgentDiscoveryRequest {
                    runtime_session_id: Uuid::new_v4().simple().to_string(),
                    terminal_key: key("no-notify"),
                    provider: AgentProvider::Codex,
                    working_directory: directory.path().to_path_buf(),
                    not_before_unix_ms: 0,
                    notified_completion: None,
                    codex_notifications: Vec::new(),
                    grok_notifications: Vec::new(),
                })
                .unwrap()
                .is_none()
        );
        assert_eq!(runtime.binding_count(), 0);
        runtime.shutdown();
    }

    #[test]
    fn filesystem_discovery_requires_one_unowned_same_folder_candidate() {
        let directory = TempDir::new().unwrap();
        let sessions_root = directory.path().join("codex");
        let working_directory = directory.path().join("workspace");
        fs::create_dir_all(&sessions_root).unwrap();
        fs::create_dir_all(&working_directory).unwrap();
        let working_directory = fs::canonicalize(working_directory).unwrap();
        let config = AgentRuntimeConfig {
            codex_sessions_root: sessions_root.clone(),
            grok_sessions_root: directory.path().join("grok"),
            poll_interval: Duration::from_secs(60),
        };
        let write_session = |name: &str, id: Uuid| {
            let path = sessions_root.join(format!("{name}.jsonl"));
            let first = serde_json::json!({
                "type": "session_meta",
                "payload": {
                    "id": id,
                    "cwd": working_directory,
                    "source": "cli"
                }
            });
            fs::write(path, format!("{first}\n")).unwrap();
        };

        let first = Uuid::new_v4();
        write_session("first", first);
        assert_eq!(
            discover_unowned_conversation(
                &config,
                AgentProvider::Codex,
                &working_directory,
                0,
                &HashSet::new(),
            ),
            Some(first)
        );

        let second = Uuid::new_v4();
        write_session("second", second);
        assert_eq!(
            discover_unowned_conversation(
                &config,
                AgentProvider::Codex,
                &working_directory,
                0,
                &HashSet::new(),
            ),
            None,
            "ambiguous same-folder sessions must never be guessed"
        );
        assert_eq!(
            discover_unowned_conversation(
                &config,
                AgentProvider::Codex,
                &working_directory,
                0,
                &HashSet::from([first]),
            ),
            Some(second)
        );
    }

    #[test]
    fn concurrent_same_folder_grok_probes_fail_closed() {
        let directory = TempDir::new().unwrap();
        let runtime = test_runtime(&directory);
        let working_directory = fs::canonicalize(directory.path()).unwrap();
        let first = Uuid::new_v4().simple().to_string();
        let second = Uuid::new_v4().simple().to_string();

        assert!(
            runtime
                .grok_discovery_probe_not_before(&first, &working_directory)
                .unwrap()
                .is_none()
        );
        assert!(
            runtime
                .grok_discovery_probe_not_before(&second, &working_directory)
                .unwrap()
                .is_none()
        );
        std::thread::sleep(GROK_DISCOVERY_SETTLE + Duration::from_millis(20));
        assert!(
            runtime
                .grok_discovery_probe_not_before(&first, &working_directory)
                .unwrap()
                .is_none()
        );
        runtime.unbind(&first);
        assert!(
            runtime
                .grok_discovery_probe_not_before(&second, &working_directory)
                .unwrap()
                .is_some()
        );
        runtime.shutdown();
    }

    #[test]
    fn codex_log_lifecycle_keeps_a_success_fallback_for_unavailable_notifiers() {
        for event_type in ["task_started", "turn_started"] {
            let line = format!(r#"{{"type":"event_msg","payload":{{"type":"{event_type}"}}}}"#);
            assert_eq!(
                observe_codex_turn(line.as_bytes()).map(|observed| observed.observation),
                Some(TurnObservation::Started)
            );
        }
        for event_type in ["task_complete", "turn_complete"] {
            let line = format!(r#"{{"type":"event_msg","payload":{{"type":"{event_type}"}}}}"#);
            assert_eq!(
                observe_codex_turn(line.as_bytes()).map(|observed| observed.observation),
                Some(TurnObservation::Finished { succeeded: true })
            );
        }
        assert_eq!(
            observe_codex_turn(br#"{"type":"event_msg","payload":{"type":"turn_aborted"}}"#)
                .map(|observed| observed.observation),
            Some(TurnObservation::Finished { succeeded: false })
        );
        assert_eq!(
            observe_codex_turn(br#"{"type":"response_item","payload":{"type":"task_started"}}"#),
            None
        );
        assert_eq!(observe_codex_turn(br#"not json"#), None);

        let observed = observe_codex_turn(
            br#"{"type":"event_msg","payload":{"type":"task_complete","turn_id":"019f7474-8d4b-7e61-8eb1-0c02538f88cb"}}"#,
        )
        .unwrap();
        assert_eq!(
            observed.turn_id.as_deref(),
            Some("019f7474-8d4b-7e61-8eb1-0c02538f88cb")
        );
    }

    #[test]
    fn completed_codex_turn_absorbs_late_stop_and_legacy_notify_signals() {
        let now = Instant::now();
        let mut lifecycle = TurnLifecycleState::default();
        let turn_id = Some("019f7474-8d4b-7e61-8eb1-0c02538f88cb".to_owned());
        let first = lifecycle.reconcile(
            vec![ObservedTurn {
                observation: TurnObservation::Started,
                notification_observed_at_unix_ms: None,
                turn_id: turn_id.clone(),
            }],
            vec![
                ObservedTurn {
                    observation: TurnObservation::Started,
                    notification_observed_at_unix_ms: None,
                    turn_id: turn_id.clone(),
                },
                ObservedTurn {
                    observation: TurnObservation::Finished { succeeded: true },
                    notification_observed_at_unix_ms: None,
                    turn_id: turn_id.clone(),
                },
            ],
            true,
            now,
        );
        assert_eq!(
            first
                .iter()
                .filter(|observed| matches!(observed.observation, TurnObservation::Finished { .. }))
                .count(),
            1
        );

        for observed_at_unix_ms in [1_000, 1_250] {
            let duplicate = lifecycle.reconcile(
                vec![ObservedTurn {
                    observation: TurnObservation::Finished { succeeded: true },
                    notification_observed_at_unix_ms: Some(observed_at_unix_ms),
                    turn_id: turn_id.clone(),
                }],
                Vec::new(),
                true,
                now + Duration::from_millis(observed_at_unix_ms),
            );
            assert!(duplicate.is_empty());
        }

        let next_turn_id = Some("019f7474-8d4b-7e61-8eb1-0c02538f88cc".to_owned());
        let next = lifecycle.reconcile(
            vec![ObservedTurn {
                observation: TurnObservation::Started,
                notification_observed_at_unix_ms: None,
                turn_id: next_turn_id.clone(),
            }],
            vec![ObservedTurn {
                observation: TurnObservation::Finished { succeeded: true },
                notification_observed_at_unix_ms: None,
                turn_id: next_turn_id,
            }],
            true,
            now + Duration::from_secs(2),
        );
        assert_eq!(
            next.iter()
                .filter(|observed| matches!(observed.observation, TurnObservation::Finished { .. }))
                .count(),
            1,
            "a genuinely new Codex turn must still notify"
        );
    }

    #[test]
    fn codex_hook_and_aborted_transcript_emit_one_failed_completion() {
        let now = Instant::now();
        let mut lifecycle = TurnLifecycleState::default();
        let observations = lifecycle.reconcile(
            vec![
                TurnObservation::Started.into(),
                ObservedTurn {
                    observation: TurnObservation::Finished { succeeded: true },
                    notification_observed_at_unix_ms: Some(11_003),
                    turn_id: None,
                },
            ],
            vec![
                TurnObservation::Started.into(),
                TurnObservation::Finished { succeeded: false }.into(),
            ],
            true,
            now,
        );

        assert_eq!(observations.len(), 2);
        assert_eq!(observations[0].observation, TurnObservation::Started);
        assert_eq!(
            observations[1],
            ObservedTurn {
                observation: TurnObservation::Finished { succeeded: false },
                notification_observed_at_unix_ms: None,
                turn_id: None,
            }
        );
    }

    #[test]
    fn completion_sources_without_a_start_merge_into_one_logical_turn() {
        let now = Instant::now();
        let mut lifecycle = TurnLifecycleState::default();

        // A failed/missed UserPromptSubmit hook means neither completion has a
        // preceding Started edge. The hook Stop and legacy notify callback are
        // still two observations of one turn and must produce one finish.
        let initial = lifecycle.reconcile(
            vec![
                ObservedTurn {
                    observation: TurnObservation::Finished { succeeded: true },
                    notification_observed_at_unix_ms: Some(21_003),
                    turn_id: None,
                },
                ObservedTurn {
                    observation: TurnObservation::Finished { succeeded: true },
                    notification_observed_at_unix_ms: Some(21_004),
                    turn_id: None,
                },
            ],
            Vec::new(),
            true,
            now,
        );
        assert!(
            initial.is_empty(),
            "hook-only completion waits for transcript settle"
        );
        assert_eq!(
            lifecycle.turns.len(),
            1,
            "both sources share one pending turn"
        );

        let completed =
            lifecycle.reconcile(Vec::new(), Vec::new(), true, now + HOOK_TRANSCRIPT_SETTLE);
        assert_eq!(
            completed,
            vec![ObservedTurn {
                observation: TurnObservation::Finished { succeeded: true },
                notification_observed_at_unix_ms: Some(21_004),
                turn_id: None,
            }]
        );
        assert!(
            lifecycle
                .reconcile(
                    Vec::new(),
                    vec![TurnObservation::Finished { succeeded: true }.into()],
                    true,
                    now + HOOK_TRANSCRIPT_SETTLE + Duration::from_millis(1),
                )
                .is_empty(),
            "a late transcript cannot create a duplicate finish"
        );
    }

    #[test]
    fn grok_failure_hook_wins_over_success_stop_and_transcript() {
        let now = Instant::now();
        let mut lifecycle = TurnLifecycleState::default();
        let observations = lifecycle.reconcile(
            vec![
                TurnObservation::Started.into(),
                ObservedTurn {
                    observation: TurnObservation::Finished { succeeded: true },
                    notification_observed_at_unix_ms: Some(12_003),
                    turn_id: None,
                },
                TurnObservation::Finished { succeeded: false }.into(),
            ],
            vec![
                TurnObservation::Started.into(),
                TurnObservation::Finished { succeeded: true }.into(),
            ],
            true,
            now,
        );

        assert_eq!(observations.len(), 2);
        assert_eq!(observations[0].observation, TurnObservation::Started);
        assert_eq!(
            observations[1].observation,
            TurnObservation::Finished { succeeded: false }
        );
        assert_eq!(observations[1].notification_observed_at_unix_ms, None);
    }

    #[test]
    fn hook_fallback_is_bounded_and_late_transcript_cannot_finish_new_prompt() {
        let now = Instant::now();
        let mut lifecycle = TurnLifecycleState::default();
        let started = lifecycle.reconcile(
            vec![
                TurnObservation::Started.into(),
                ObservedTurn {
                    observation: TurnObservation::Finished { succeeded: true },
                    notification_observed_at_unix_ms: Some(13_003),
                    turn_id: None,
                },
            ],
            Vec::new(),
            true,
            now,
        );
        assert_eq!(started.len(), 1);
        assert_eq!(started[0].observation, TurnObservation::Started);

        assert!(
            lifecycle
                .reconcile(
                    Vec::new(),
                    Vec::new(),
                    true,
                    now + HOOK_TRANSCRIPT_SETTLE - Duration::from_millis(1),
                )
                .is_empty()
        );
        let completed =
            lifecycle.reconcile(Vec::new(), Vec::new(), true, now + HOOK_TRANSCRIPT_SETTLE);
        assert_eq!(
            completed,
            vec![ObservedTurn {
                observation: TurnObservation::Finished { succeeded: true },
                notification_observed_at_unix_ms: Some(13_003),
                turn_id: None,
            }]
        );

        let next_started = lifecycle.reconcile(
            vec![TurnObservation::Started.into()],
            Vec::new(),
            true,
            now + Duration::from_secs(3),
        );
        assert_eq!(next_started.len(), 1);
        assert_eq!(next_started[0].observation, TurnObservation::Started);

        let late_prior = lifecycle.reconcile(
            Vec::new(),
            vec![
                TurnObservation::Started.into(),
                TurnObservation::Finished { succeeded: false }.into(),
            ],
            true,
            now + Duration::from_secs(12),
        );
        assert!(
            late_prior.is_empty(),
            "a transcript arriving ten seconds after hook fallback must not emit a second finish"
        );

        let current = lifecycle.reconcile(
            Vec::new(),
            vec![
                TurnObservation::Started.into(),
                TurnObservation::Finished { succeeded: true }.into(),
            ],
            true,
            now + Duration::from_secs(13),
        );
        assert_eq!(
            current,
            vec![ObservedTurn {
                observation: TurnObservation::Finished { succeeded: true },
                notification_observed_at_unix_ms: None,
                turn_id: None,
            }]
        );
    }

    #[test]
    fn following_prompt_flushes_prior_hook_completion_before_starting_new_turn() {
        let now = Instant::now();
        let mut lifecycle = TurnLifecycleState::default();
        let observations = lifecycle.reconcile(
            vec![
                TurnObservation::Started.into(),
                ObservedTurn {
                    observation: TurnObservation::Finished { succeeded: true },
                    notification_observed_at_unix_ms: Some(14_003),
                    turn_id: None,
                },
                TurnObservation::Started.into(),
            ],
            Vec::new(),
            true,
            now,
        );

        assert_eq!(observations.len(), 3);
        assert_eq!(observations[0].observation, TurnObservation::Started);
        assert_eq!(
            observations[1],
            ObservedTurn {
                observation: TurnObservation::Finished { succeeded: true },
                notification_observed_at_unix_ms: Some(14_003),
                turn_id: None,
            }
        );
        assert_eq!(observations[2].observation, TurnObservation::Started);
        let current = lifecycle
            .turns
            .back()
            .expect("the second turn stays tracked");
        assert!(current.hook_started);
        assert!(current.started_emitted);
        assert!(!current.completion_emitted);
    }

    #[test]
    fn lifecycle_events_serialize_with_finished_success_state() {
        let bound = BoundAgent {
            runtime_session_id: Uuid::new_v4().simple().to_string(),
            terminal_key: key("schema"),
            binding: ValidatedAgentBinding {
                provider: AgentProvider::Codex,
                conversation_id: Uuid::new_v4(),
            },
        };
        let started =
            serde_json::to_value(bound.lifecycle_event(TurnObservation::Started)).unwrap();
        assert_eq!(
            started.get("event").and_then(Value::as_str),
            Some("turnStarted")
        );
        assert!(started["data"].get("succeeded").is_none());

        let failed = serde_json::to_value(
            bound.lifecycle_event(TurnObservation::Finished { succeeded: false }),
        )
        .unwrap();
        assert_eq!(
            failed.get("event").and_then(Value::as_str),
            Some("turnFinished")
        );
        assert_eq!(
            failed["data"].get("succeeded").and_then(Value::as_bool),
            Some(false)
        );

        let context = serde_json::to_value(bound.context_event(ContextSnapshot {
            used_tokens: 17_847,
            max_tokens: 258_400,
        }))
        .unwrap();
        assert_eq!(
            context.get("event").and_then(Value::as_str),
            Some("contextUpdated")
        );
        assert_eq!(context["data"]["usedTokens"].as_u64(), Some(17_847));
        assert_eq!(context["data"]["windowTokens"].as_u64(), Some(258_400));
        assert_eq!(context["data"]["remainingPercent"].as_u64(), Some(93));
        assert!(
            context["data"]["observedAtUnixMs"]
                .as_u64()
                .is_some_and(|value| value > 0 && value <= MAX_SAFE_JS_INTEGER)
        );
        let data = context["data"].as_object().unwrap();
        assert_eq!(
            data.len(),
            8,
            "context IPC contains correlation and counts only"
        );
        assert!(data.get("runtimeSessionId").is_some());
        assert!(data.get("terminalKey").is_some());
        assert!(data.get("provider").is_some());
        assert!(data.get("conversationId").is_some());
        assert_eq!(ContextSnapshot::new(1, 3).unwrap().remaining_percent(), 67);
        assert_eq!(ContextSnapshot::new(2, 3).unwrap().remaining_percent(), 33);
    }

    #[test]
    fn context_events_match_only_the_exact_bound_runtime_terminal_and_conversation() {
        let bound = BoundAgent {
            runtime_session_id: Uuid::new_v4().simple().to_string(),
            terminal_key: key("context-correlation"),
            binding: ValidatedAgentBinding {
                provider: AgentProvider::Codex,
                conversation_id: Uuid::new_v4(),
            },
        };
        let event = bound.context_event(ContextSnapshot {
            used_tokens: 10,
            max_tokens: 100,
        });
        assert!(event.matches_bound_agent(&bound));

        let mut wrong_runtime = event.clone();
        let AgentEvent::ContextUpdated {
            runtime_session_id, ..
        } = &mut wrong_runtime
        else {
            unreachable!()
        };
        *runtime_session_id = Uuid::new_v4().simple().to_string();
        assert!(!wrong_runtime.matches_bound_agent(&bound));

        let mut wrong_terminal = event.clone();
        let AgentEvent::ContextUpdated { terminal_key, .. } = &mut wrong_terminal else {
            unreachable!()
        };
        terminal_key.terminal_id = "other".to_owned();
        assert!(!wrong_terminal.matches_bound_agent(&bound));

        let mut wrong_provider = event.clone();
        let AgentEvent::ContextUpdated { provider, .. } = &mut wrong_provider else {
            unreachable!()
        };
        *provider = AgentProvider::Grok;
        assert!(!wrong_provider.matches_bound_agent(&bound));

        let mut wrong_conversation = event;
        let AgentEvent::ContextUpdated {
            conversation_id, ..
        } = &mut wrong_conversation
        else {
            unreachable!()
        };
        *conversation_id = Uuid::new_v4().to_string();
        assert!(!wrong_conversation.matches_bound_agent(&bound));
    }

    #[test]
    fn codex_context_uses_last_turn_usage_and_rejects_invalid_counts() {
        let valid = serde_json::json!({
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "total_token_usage": { "total_tokens": 99_999 },
                    "last_token_usage": { "total_tokens": 17_847 },
                    "model_context_window": 258_400
                },
                "rate_limits": { "primary": { "used_percent": 50 } }
            }
        });
        assert_eq!(
            observe_codex_context(valid.to_string().as_bytes()),
            Some(ContextSnapshot {
                used_tokens: 17_847,
                max_tokens: 258_400,
            })
        );

        for invalid in [
            serde_json::json!({"type":"event_msg","payload":{"type":"token_count","info":null}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"total_tokens":0},"model_context_window":258400}}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"total_tokens":258401},"model_context_window":258400}}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"total_tokens":"17847"},"model_context_window":258400}}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"total_tokens":17847},"model_context_window":MAX_SAFE_JS_INTEGER + 1}}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"task_complete","info":{"last_token_usage":{"total_tokens":17847},"model_context_window":258400}}}),
        ] {
            assert_eq!(observe_codex_context(invalid.to_string().as_bytes()), None);
        }
    }

    #[test]
    fn grok_context_requires_consistent_bounded_signals() {
        let valid = serde_json::json!({
            "contextTokensUsed": 283_110,
            "contextWindowTokens": 500_000,
            "contextWindowUsage": 56,
            "otherPrivateSignal": "must not cross IPC"
        });
        assert_eq!(
            observe_grok_context(valid.to_string().as_bytes()),
            Some(ContextSnapshot {
                used_tokens: 283_110,
                max_tokens: 500_000,
            })
        );
        let below_one_percent = serde_json::json!({
            "contextTokensUsed": 1_000,
            "contextWindowTokens": 500_000,
            "contextWindowUsage": 0
        });
        assert_eq!(
            observe_grok_context(below_one_percent.to_string().as_bytes()),
            Some(ContextSnapshot {
                used_tokens: 1_000,
                max_tokens: 500_000,
            })
        );
        for invalid in [
            serde_json::json!({"contextTokensUsed":0,"contextWindowTokens":500000,"contextWindowUsage":0}),
            serde_json::json!({"contextTokensUsed":500001,"contextWindowTokens":500000,"contextWindowUsage":100}),
            serde_json::json!({"contextTokensUsed":283110,"contextWindowTokens":500000,"contextWindowUsage":57}),
            serde_json::json!({"contextTokensUsed":283110,"contextWindowTokens":500000,"contextWindowUsage":101}),
            serde_json::json!({"contextTokensUsed":"283110","contextWindowTokens":500000,"contextWindowUsage":56}),
            serde_json::json!({"contextTokensUsed":283110,"contextWindowTokens":0,"contextWindowUsage":56}),
        ] {
            assert_eq!(observe_grok_context(invalid.to_string().as_bytes()), None);
        }
    }

    #[test]
    fn codex_initial_context_reads_only_the_bounded_tail_and_chooses_latest() {
        let directory = TempDir::new().unwrap();
        let path = directory.path().join("rollout.jsonl");
        let mut file = fs::File::create(&path).unwrap();
        file.write_all(&vec![b'x'; MAX_TAIL_READ_BYTES as usize + 32])
            .unwrap();
        writeln!(file).unwrap();
        for used in [12_000_u64, 18_000] {
            writeln!(
                file,
                "{}",
                serde_json::json!({
                    "type":"event_msg",
                    "payload":{
                        "type":"token_count",
                        "info":{
                            "last_token_usage":{"total_tokens":used},
                            "model_context_window":258_400
                        }
                    }
                })
            )
            .unwrap();
        }
        file.flush().unwrap();
        assert_eq!(
            read_latest_codex_context(&path),
            Some(ContextSnapshot {
                used_tokens: 18_000,
                max_tokens: 258_400,
            })
        );
    }

    #[test]
    fn codex_vscode_user_thread_is_a_resumable_root_rollout() {
        let directory = TempDir::new().unwrap();
        let conversation_id = Uuid::new_v4();
        let rollout = directory
            .path()
            .join(format!("rollout-{conversation_id}.jsonl"));
        let metadata = |thread_source: &str| {
            serde_json::json!({
                "type": "session_meta",
                "payload": {
                    "id": conversation_id,
                    "cwd": directory.path(),
                    "source": "vscode",
                    "originator": "Codex Desktop",
                    "thread_source": thread_source
                }
            })
        };

        fs::write(&rollout, format!("{}\n", metadata("user"))).unwrap();
        assert!(read_codex_root_metadata(&rollout).is_some());

        fs::write(&rollout, format!("{}\n", metadata("subagent"))).unwrap();
        assert!(read_codex_root_metadata(&rollout).is_none());
    }

    #[test]
    fn restored_codex_vscode_user_binding_emits_initial_context() {
        let directory = TempDir::new().unwrap();
        let runtime = test_runtime(&directory);
        let conversation_id = Uuid::new_v4();
        let sessions = directory.path().join("codex");
        fs::create_dir_all(&sessions).unwrap();
        let rollout = sessions.join(format!("rollout-{conversation_id}.jsonl"));
        let metadata = serde_json::json!({
            "type": "session_meta",
            "payload": {
                "id": conversation_id,
                "cwd": directory.path(),
                "source": "vscode",
                "originator": "Codex Desktop",
                "thread_source": "user"
            }
        });
        let context = serde_json::json!({
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "last_token_usage": { "total_tokens": 17_847 },
                    "model_context_window": 258_400
                }
            }
        });
        fs::write(&rollout, format!("{metadata}\n{context}\n")).unwrap();

        let sink = Arc::new(RecordingSink::default());
        runtime.subscribe_sink(sink.clone()).unwrap();
        runtime
            .bind(
                &Uuid::new_v4().simple().to_string(),
                key("codex-vscode-context"),
                resume(AgentProvider::Codex, conversation_id),
            )
            .unwrap();

        assert!(matches!(
            sink.events.lock().unwrap().as_slice(),
            [AgentEvent::ContextUpdated {
                provider: AgentProvider::Codex,
                used_tokens: 17_847,
                window_tokens: 258_400,
                remaining_percent: 93,
                ..
            }]
        ));
        runtime.shutdown();
    }

    #[test]
    fn restored_codex_binding_emits_context_before_large_trailing_output() {
        let directory = TempDir::new().unwrap();
        let runtime = test_runtime(&directory);
        let conversation_id = Uuid::new_v4();
        let sessions = directory.path().join("codex");
        fs::create_dir_all(&sessions).unwrap();
        let rollout = sessions.join(format!("rollout-{conversation_id}.jsonl"));
        let context_line = |used| {
            serde_json::json!({
                "type":"event_msg",
                "payload":{
                    "type":"token_count",
                    "info":{
                        "last_token_usage":{"total_tokens":used},
                        "model_context_window":258_400
                    }
                }
            })
            .to_string()
        };
        const LARGE_ROLLOUT_LENGTH: u64 = 253 * 1024 * 1024;
        const CONTEXT_DISTANCE_FROM_EOF: u64 = 900 * 1024;
        let mut initial_rollout = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&rollout)
            .unwrap();
        writeln!(
            initial_rollout,
            "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{conversation_id}\",\"cwd\":\"C:\\\\work\",\"source\":\"cli\"}}}}"
        )
        .unwrap();
        initial_rollout.set_len(LARGE_ROLLOUT_LENGTH).unwrap();
        initial_rollout
            .seek(SeekFrom::Start(
                LARGE_ROLLOUT_LENGTH - CONTEXT_DISTANCE_FROM_EOF - 1,
            ))
            .unwrap();
        initial_rollout.write_all(b"\n").unwrap();
        writeln!(initial_rollout, "{}", context_line(17_847)).unwrap();
        initial_rollout.flush().unwrap();
        drop(initial_rollout);
        let sink = Arc::new(RecordingSink::default());
        runtime.subscribe_sink(sink.clone()).unwrap();
        let runtime_session_id = Uuid::new_v4().simple().to_string();
        runtime
            .bind(
                &runtime_session_id,
                key("codex-context"),
                resume(AgentProvider::Codex, conversation_id),
            )
            .unwrap();
        assert!(matches!(
            sink.events.lock().unwrap().as_slice(),
            [AgentEvent::ContextUpdated {
                used_tokens: 17_847,
                window_tokens: 258_400,
                remaining_percent: 93,
                ..
            }]
        ));

        let mut rollout = OpenOptions::new().append(true).open(&rollout).unwrap();
        writeln!(rollout, "{}", context_line(17_847)).unwrap();
        rollout.flush().unwrap();
        runtime.poll_once();
        runtime.poll_once();
        assert_eq!(sink.events.lock().unwrap().len(), 1);

        writeln!(rollout, "{}", context_line(19_000)).unwrap();
        rollout.flush().unwrap();
        runtime.poll_once();
        runtime.poll_once();
        let events = sink.events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert!(matches!(
            events[1],
            AgentEvent::ContextUpdated {
                provider: AgentProvider::Codex,
                used_tokens: 19_000,
                window_tokens: 258_400,
                ..
            }
        ));
        drop(events);
        runtime.shutdown();
    }

    #[test]
    fn codex_context_reverse_scan_skips_chunk_split_oversized_utf8_line() {
        let directory = TempDir::new().unwrap();
        let rollout = directory.path().join("rollout.jsonl");
        let context = serde_json::json!({
            "type":"event_msg",
            "payload":{
                "type":"token_count",
                "info":{
                    "last_token_usage":{"total_tokens":48_000},
                    "model_context_window":258_400
                }
            }
        });
        let mut file = fs::File::create(&rollout).unwrap();
        writeln!(file, "{context}").unwrap();
        let utf8_units = MAX_LINE_BYTES / "한".len() + CONTEXT_SCAN_CHUNK_BYTES;
        file.write_all("한".repeat(utf8_units).as_bytes()).unwrap();
        file.flush().unwrap();

        assert_eq!(
            read_latest_codex_context(&rollout),
            Some(ContextSnapshot {
                used_tokens: 48_000,
                max_tokens: 258_400,
            })
        );
    }

    #[test]
    fn codex_context_reverse_scan_does_not_cross_lookback_limit() {
        let directory = TempDir::new().unwrap();
        let rollout = directory.path().join("rollout.jsonl");
        let context = serde_json::json!({
            "type":"event_msg",
            "payload":{
                "type":"token_count",
                "info":{
                    "last_token_usage":{"total_tokens":48_000},
                    "model_context_window":258_400
                }
            }
        });
        let mut file = fs::File::create(&rollout).unwrap();
        writeln!(file, "{context}").unwrap();
        let context_end = file.stream_position().unwrap();
        file.set_len(context_end + MAX_CONTEXT_LOOKBACK_BYTES + 1)
            .unwrap();
        file.flush().unwrap();

        assert_eq!(read_latest_codex_context(&rollout), None);
    }

    #[test]
    fn grok_binding_reads_sibling_signals_and_dedupes_updates() {
        let directory = TempDir::new().unwrap();
        let runtime = test_runtime(&directory);
        let conversation_id = Uuid::new_v4();
        let session_directory = directory
            .path()
            .join("grok")
            .join(conversation_id.to_string());
        fs::create_dir_all(&session_directory).unwrap();
        fs::write(session_directory.join("events.jsonl"), "").unwrap();
        let signals = session_directory.join("signals.json");
        let signal_value = |used: u64| {
            serde_json::json!({
                "contextTokensUsed": used,
                "contextWindowTokens": 500_000,
                "contextWindowUsage": used * 100 / 500_000,
                "transcript": "never emitted"
            })
        };
        fs::write(&signals, signal_value(40_000).to_string()).unwrap();

        let sink = Arc::new(RecordingSink::default());
        runtime.subscribe_sink(sink.clone()).unwrap();
        let runtime_session_id = Uuid::new_v4().simple().to_string();
        runtime
            .bind(
                &runtime_session_id,
                key("grok-context"),
                resume(AgentProvider::Grok, conversation_id),
            )
            .unwrap();
        assert!(matches!(
            sink.events.lock().unwrap().as_slice(),
            [AgentEvent::ContextUpdated {
                provider: AgentProvider::Grok,
                used_tokens: 40_000,
                window_tokens: 500_000,
                remaining_percent: 92,
                ..
            }]
        ));
        runtime.poll_once();
        assert_eq!(sink.events.lock().unwrap().len(), 1);

        fs::write(&signals, signal_value(128_150).to_string()).unwrap();
        runtime.poll_once();
        runtime.poll_once();
        let events = sink.events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert!(matches!(
            events[1],
            AgentEvent::ContextUpdated {
                provider: AgentProvider::Grok,
                used_tokens: 128_150,
                window_tokens: 500_000,
                ..
            }
        ));
        drop(events);
        runtime.shutdown();
    }

    #[test]
    fn grok_requires_matching_start_before_end_and_reports_failures() {
        let session = Uuid::new_v4();
        let other = Uuid::new_v4();
        let mut state = GrokTurnState::default();
        assert_eq!(state.observe(br#"not json"#, session), None);
        assert_eq!(
            state.observe(br#"{"type":"turn_ended","outcome":"completed"}"#, session),
            None
        );
        assert_eq!(
            state.observe(
                format!(r#"{{"type":"turn_started","session_id":"{other}"}}"#).as_bytes(),
                session,
            ),
            None
        );
        assert_eq!(
            state.observe(
                format!(r#"{{"type":"turn_started","session_id":"{session}"}}"#).as_bytes(),
                session,
            ),
            Some(TurnObservation::Started)
        );
        assert_eq!(
            state.observe(
                format!(r#"{{"type":"turn_ended","session_id":"{other}","outcome":"completed"}}"#)
                    .as_bytes(),
                session,
            ),
            None
        );
        assert_eq!(
            state.observe(br#"{"type":"turn_ended","outcome":"error"}"#, session),
            Some(TurnObservation::Finished { succeeded: false })
        );
        assert_eq!(
            state.observe(br#"{"type":"turn_ended","outcome":"completed"}"#, session),
            None
        );
        assert_eq!(
            state.observe(
                format!(r#"{{"type":"turn_started","session_id":"{session}"}}"#).as_bytes(),
                session,
            ),
            Some(TurnObservation::Started)
        );
        assert_eq!(
            state.observe(br#"{"type":"turn_ended","outcome":"completed"}"#, session),
            Some(TurnObservation::Finished { succeeded: true })
        );
        assert_eq!(
            state.observe(br#"{"type":"turn_ended","outcome":"completed"}"#, session),
            None
        );
    }

    #[test]
    fn discovered_grok_replays_an_in_flight_start_before_tailing() {
        let directory = TempDir::new().unwrap();
        let events = directory.path().join("events.jsonl");
        let session = Uuid::new_v4();
        fs::write(
            &events,
            format!("{{\"type\":\"turn_started\",\"session_id\":\"{session}\"}}\n"),
        )
        .unwrap();
        assert!(replay_grok_turn_state(&events, session).turn_started);

        OpenOptions::new()
            .append(true)
            .open(&events)
            .unwrap()
            .write_all(
                format!(
                    "{{\"type\":\"turn_ended\",\"session_id\":\"{session}\",\"outcome\":\"completed\"}}\n"
                )
                .as_bytes(),
            )
            .unwrap();
        assert!(!replay_grok_turn_state(&events, session).turn_started);
    }

    #[test]
    fn grok_discovery_reports_a_fast_completed_first_turn() {
        let directory = TempDir::new().unwrap();
        let session = Uuid::new_v4();
        let session_directory = directory.path().join("grok").join(session.to_string());
        fs::create_dir_all(&session_directory).unwrap();
        let events = session_directory.join("events.jsonl");
        fs::write(
            &events,
            format!(
                "{{\"type\":\"turn_started\",\"session_id\":\"{session}\"}}\n{{\"type\":\"turn_ended\",\"session_id\":\"{session}\",\"outcome\":\"completed\"}}\n"
            ),
        )
        .unwrap();
        let config = AgentRuntimeConfig {
            codex_sessions_root: directory.path().join("codex"),
            grok_sessions_root: directory.path().join("grok"),
            poll_interval: Duration::from_secs(60),
        };
        assert!(grok_latest_completed_turn(&config, session, 0).is_some());

        OpenOptions::new()
            .append(true)
            .open(&events)
            .unwrap()
            .write_all(
                format!("{{\"type\":\"turn_started\",\"session_id\":\"{session}\"}}\n").as_bytes(),
            )
            .unwrap();
        assert_eq!(grok_latest_completed_turn(&config, session, 0), None);
    }

    #[test]
    fn discovered_grok_replays_completion_that_arrived_before_bind() {
        let directory = TempDir::new().unwrap();
        let runtime = test_runtime(&directory);
        let session = Uuid::new_v4();
        let session_directory = directory.path().join("grok").join(session.to_string());
        fs::create_dir_all(&session_directory).unwrap();
        let events = session_directory.join("events.jsonl");
        let oversized_non_lifecycle = serde_json::json!({
            "type": "message",
            "text": "x".repeat(MAX_TAIL_READ_BYTES as usize + 1),
        });
        fs::write(
            &events,
            format!(
                "{{\"type\":\"turn_started\",\"session_id\":\"{session}\"}}\n{oversized_non_lifecycle}\n{{\"type\":\"turn_ended\",\"session_id\":\"{session}\",\"outcome\":\"completed\"}}\n"
            ),
        )
        .unwrap();

        let sink = Arc::new(RecordingSink::default());
        runtime.subscribe_sink(sink.clone()).unwrap();
        let runtime_session = Uuid::new_v4().simple().to_string();
        runtime
            .bind_discovered(
                &runtime_session,
                key("grok-race"),
                resume(AgentProvider::Grok, session),
                0,
            )
            .unwrap();

        let events = sink.events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], AgentEvent::TurnStarted { .. }));
        assert!(matches!(
            events[1],
            AgentEvent::TurnFinished {
                succeeded: true,
                ..
            }
        ));
        runtime.shutdown();
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
        for event_type in [
            "task_started",
            "task_complete",
            "turn_started",
            "turn_aborted",
        ] {
            writeln!(
                file,
                "{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"{event_type}\"}}}}"
            )
            .unwrap();
        }
        runtime.poll_once();
        runtime.poll_once();
        let events = sink.events.lock().unwrap();
        assert_eq!(events.len(), 4);
        assert!(matches!(events[0], AgentEvent::TurnStarted { .. }));
        assert!(matches!(
            events[1],
            AgentEvent::TurnFinished {
                succeeded: true,
                ..
            }
        ));
        assert!(matches!(events[2], AgentEvent::TurnStarted { .. }));
        assert!(matches!(
            events[3],
            AgentEvent::TurnFinished {
                succeeded: false,
                ..
            }
        ));
        drop(events);
        runtime.shutdown();
    }

    #[test]
    fn codex_notifier_completion_is_exact_and_emitted_once_until_acknowledged() {
        let directory = TempDir::new().unwrap();
        let runtime = test_runtime(&directory);
        let conversation_id = Uuid::new_v4();
        let sessions = directory.path().join("codex");
        fs::create_dir_all(&sessions).unwrap();
        let rollout = sessions.join(format!("rollout-{conversation_id}.jsonl"));
        fs::write(
            &rollout,
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{conversation_id}\",\"cwd\":\"C:\\\\work\",\"source\":\"cli\"}}}}\n"
            ),
        )
        .unwrap();
        let sink = Arc::new(RecordingSink::default());
        runtime.subscribe_sink(sink.clone()).unwrap();
        let runtime_session_id = Uuid::new_v4().simple().to_string();
        runtime
            .bind(
                &runtime_session_id,
                key("codex-notify"),
                resume(AgentProvider::Codex, conversation_id),
            )
            .unwrap();

        let notification = crate::codex_notify::CodexCompletionRoute {
            conversation_id: conversation_id.to_string(),
            turn_id: None,
            observed_at_unix_ms: 72_345,
        };
        let route = crate::codex_notify::route_path(&runtime_session_id).unwrap();
        fs::write(
            &route,
            format!("{}\n", serde_json::to_string(&notification).unwrap()),
        )
        .unwrap();
        writeln!(
            OpenOptions::new().append(true).open(&rollout).unwrap(),
            "{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"task_complete\"}}}}"
        )
        .unwrap();
        runtime.poll_once();
        runtime.poll_once();

        let events = sink.events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert!(matches!(
            &events[0],
            AgentEvent::TurnFinished {
                provider: AgentProvider::Codex,
                conversation_id: actual_conversation_id,
                succeeded: true,
                notification_observed_at_unix_ms: Some(72_345),
                ..
            } if actual_conversation_id == &conversation_id.to_string()
        ));
        drop(events);
        crate::codex_notify::remove_route(&runtime_session_id);
        runtime.shutdown();
    }

    #[test]
    fn codex_hooks_drive_bound_started_and_successful_completion_events() {
        let directory = TempDir::new().unwrap();
        let runtime = test_runtime(&directory);
        let conversation_id = Uuid::new_v4();
        let sessions = directory.path().join("codex");
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            sessions.join(format!("rollout-{conversation_id}.jsonl")),
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{conversation_id}\",\"cwd\":\"C:\\\\work\",\"source\":\"cli\"}}}}\n"
            ),
        )
        .unwrap();
        let sink = Arc::new(RecordingSink::default());
        runtime.subscribe_sink(sink.clone()).unwrap();
        let runtime_session_id = Uuid::new_v4().simple().to_string();
        runtime
            .bind(
                &runtime_session_id,
                key("codex-hooks"),
                resume(AgentProvider::Codex, conversation_id),
            )
            .unwrap();
        let route = crate::codex_notify::hook_route_path(&runtime_session_id).unwrap();
        let records = [
            crate::codex_notify::CodexHookEventRecord {
                session_id: conversation_id.to_string(),
                event: crate::codex_notify::CodexHookEvent::SessionStart,
                turn_id: None,
                observed_at_unix_ms: 90_001,
            },
            crate::codex_notify::CodexHookEventRecord {
                session_id: conversation_id.to_string(),
                event: crate::codex_notify::CodexHookEvent::UserPromptSubmit,
                turn_id: Some("turn-1".to_owned()),
                observed_at_unix_ms: 90_002,
            },
            crate::codex_notify::CodexHookEventRecord {
                session_id: conversation_id.to_string(),
                event: crate::codex_notify::CodexHookEvent::Stop,
                turn_id: Some("turn-1".to_owned()),
                observed_at_unix_ms: 90_003,
            },
        ];
        for (index, record) in records.iter().enumerate() {
            fs::write(
                route.join(format!("{index}.event.json")),
                serde_json::to_vec(record).unwrap(),
            )
            .unwrap();
        }
        writeln!(
            OpenOptions::new()
                .append(true)
                .open(sessions.join(format!("rollout-{conversation_id}.jsonl")))
                .unwrap(),
            "{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"task_started\"}}}}\n{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"task_complete\"}}}}"
        )
        .unwrap();
        runtime.poll_once();
        runtime.poll_once();
        let events = sink.events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], AgentEvent::TurnStarted { .. }));
        assert!(matches!(
            events[1],
            AgentEvent::TurnFinished {
                succeeded: true,
                notification_observed_at_unix_ms: Some(90_003),
                ..
            }
        ));
        drop(events);
        assert_eq!(
            crate::codex_notify::read_hook_events(&runtime_session_id).unwrap(),
            vec![records[2].clone()]
        );
        assert!(
            crate::codex_notify::acknowledge_hook_event(&runtime_session_id, &records[2],).unwrap()
        );
        crate::codex_notify::remove_route(&runtime_session_id);
        runtime.shutdown();
    }

    #[test]
    fn grok_hooks_drive_bound_lifecycle_and_leave_only_success_for_durable_ack() {
        let directory = TempDir::new().unwrap();
        let runtime = test_runtime(&directory);
        let conversation_id = Uuid::new_v4();
        let session_directory = directory
            .path()
            .join("grok")
            .join(conversation_id.to_string());
        fs::create_dir_all(&session_directory).unwrap();
        fs::write(
            session_directory.join("events.jsonl"),
            format!(
                "{{\"type\":\"turn_started\",\"session_id\":\"{conversation_id}\"}}\n{{\"type\":\"turn_ended\",\"session_id\":\"{conversation_id}\",\"outcome\":\"completed\"}}\n"
            ),
        )
        .unwrap();
        fs::write(
            session_directory.join("summary.json"),
            serde_json::to_vec(&serde_json::json!({
                "info": { "cwd": directory.path() }
            }))
            .unwrap(),
        )
        .unwrap();

        let runtime_session_id = Uuid::new_v4().simple().to_string();
        let route = crate::grok_notify::route_path(&runtime_session_id).unwrap();
        let write_notification = |record: &crate::grok_notify::GrokHookEventRecord| {
            let name = format!(
                "{:020}-{}.event.json",
                record.observed_at_unix_ms,
                Uuid::new_v4().simple()
            );
            fs::write(route.join(name), serde_json::to_vec(record).unwrap()).unwrap();
        };
        let session_start = crate::grok_notify::GrokHookEventRecord {
            session_id: conversation_id.to_string(),
            event: crate::grok_notify::GrokHookEvent::SessionStart,
            observed_at_unix_ms: 80_001,
        };
        let prompt = crate::grok_notify::GrokHookEventRecord {
            session_id: conversation_id.to_string(),
            event: crate::grok_notify::GrokHookEvent::UserPromptSubmit,
            observed_at_unix_ms: 80_002,
        };
        let stop = crate::grok_notify::GrokHookEventRecord {
            session_id: conversation_id.to_string(),
            event: crate::grok_notify::GrokHookEvent::Stop,
            observed_at_unix_ms: 80_003,
        };
        write_notification(&session_start);
        write_notification(&prompt);
        write_notification(&stop);

        let sink = Arc::new(RecordingSink::default());
        runtime.subscribe_sink(sink.clone()).unwrap();
        runtime
            .bind(
                &runtime_session_id,
                key("grok-hook-watch"),
                resume(AgentProvider::Grok, conversation_id),
            )
            .unwrap();
        runtime.poll_once();
        runtime.poll_once();

        let events = sink.events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], AgentEvent::TurnStarted { .. }));
        assert!(matches!(
            events[1],
            AgentEvent::TurnFinished {
                succeeded: true,
                notification_observed_at_unix_ms: Some(80_003),
                ..
            }
        ));
        drop(events);
        assert_eq!(
            crate::grok_notify::read_events(&runtime_session_id).unwrap(),
            vec![stop.clone()],
            "session start and prompt are consumed only after the durable binding exists"
        );
        assert!(crate::grok_notify::acknowledge_event(&runtime_session_id, &stop).unwrap());
        runtime.poll_once();
        assert_eq!(sink.events.lock().unwrap().len(), 2);
        crate::grok_notify::remove_route(&runtime_session_id);
        runtime.shutdown();
    }

    #[test]
    fn grok_session_start_hook_does_not_disable_transcript_fallback() {
        let directory = TempDir::new().unwrap();
        let runtime = test_runtime(&directory);
        let conversation_id = Uuid::new_v4();
        let session_directory = directory
            .path()
            .join("grok")
            .join(conversation_id.to_string());
        fs::create_dir_all(&session_directory).unwrap();
        let transcript = session_directory.join("events.jsonl");
        fs::write(&transcript, "").unwrap();
        fs::write(
            session_directory.join("summary.json"),
            serde_json::to_vec(&serde_json::json!({
                "info": { "cwd": directory.path() }
            }))
            .unwrap(),
        )
        .unwrap();

        let runtime_session_id = Uuid::new_v4().simple().to_string();
        let route = crate::grok_notify::route_path(&runtime_session_id).unwrap();
        let session_start = crate::grok_notify::GrokHookEventRecord {
            session_id: conversation_id.to_string(),
            event: crate::grok_notify::GrokHookEvent::SessionStart,
            observed_at_unix_ms: 81_001,
        };
        fs::write(
            route.join(format!(
                "{:020}-{}.event.json",
                session_start.observed_at_unix_ms,
                Uuid::new_v4().simple()
            )),
            serde_json::to_vec(&session_start).unwrap(),
        )
        .unwrap();

        let sink = Arc::new(RecordingSink::default());
        runtime.subscribe_sink(sink.clone()).unwrap();
        runtime
            .bind(
                &runtime_session_id,
                key("grok-hook-then-transcript"),
                resume(AgentProvider::Grok, conversation_id),
            )
            .unwrap();
        assert!(
            crate::grok_notify::read_events(&runtime_session_id)
                .unwrap()
                .is_empty(),
            "the session-start hook should be consumed after the durable binding exists"
        );

        let mut transcript = OpenOptions::new().append(true).open(transcript).unwrap();
        writeln!(
            transcript,
            "{{\"type\":\"turn_started\",\"session_id\":\"{conversation_id}\"}}"
        )
        .unwrap();
        writeln!(
            transcript,
            "{{\"type\":\"turn_ended\",\"session_id\":\"{conversation_id}\",\"outcome\":\"completed\"}}"
        )
        .unwrap();
        transcript.flush().unwrap();
        runtime.poll_once();

        let events = sink.events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], AgentEvent::TurnStarted { .. }));
        assert!(matches!(
            events[1],
            AgentEvent::TurnFinished {
                provider: AgentProvider::Grok,
                succeeded: true,
                notification_observed_at_unix_ms: None,
                ..
            }
        ));
        drop(events);
        crate::grok_notify::remove_route(&runtime_session_id);
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
