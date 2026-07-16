use crate::agent_runtime::{
    AgentResumeBinding, AgentRuntime, StableTerminalKey, TerminalLaunchPlan,
};
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    env,
    io::{Read, Write},
    path::PathBuf,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, SyncSender},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tauri::ipc::Channel;
use uuid::Uuid;

#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject,
};

#[cfg(not(windows))]
use portable_pty::ChildKiller;

pub(crate) const MAX_TERMINAL_SESSIONS: usize = 20;

const OUTPUT_READ_BUFFER_BYTES: usize = 16 * 1024;
const OUTPUT_QUEUE_CAPACITY: usize = 32;
const OUTPUT_BATCH_MAX_BYTES: usize = 64 * 1024;
const OUTPUT_BATCH_WINDOW: Duration = Duration::from_millis(8);
const OUTPUT_MAX_UNACKED_BATCHES: usize = 32;
const OUTPUT_MAX_UNACKED_BYTES: usize = 1024 * 1024;
const GLOBAL_OUTPUT_MAX_UNACKED_BYTES: usize = 8 * 1024 * 1024;
const MAX_CONCURRENT_SPAWNS: usize = 2;
const OUTPUT_DRAIN_TIMEOUT: Duration = Duration::from_secs(3);
const OUTPUT_ABORT_DRAIN_TIMEOUT: Duration = Duration::from_millis(250);
const RESIZE_COALESCE_WINDOW: Duration = Duration::from_millis(12);
const WORKER_JOIN_TIMEOUT: Duration = Duration::from_millis(750);
const SHUTDOWN_COMMAND_TIMEOUT: Duration = Duration::from_secs(8);
const SHUTDOWN_EXIT_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "event",
    content = "data"
)]
pub(crate) enum TerminalEvent {
    Started {
        session_id: String,
        process_id: Option<u32>,
    },
    Output {
        session_id: String,
        sequence: u64,
        data: String,
    },
    Error {
        session_id: String,
        message: String,
    },
    Exited {
        session_id: String,
        exit_code: Option<u32>,
        last_sequence: Option<u64>,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartTerminalResponse {
    pub(crate) session_id: String,
    pub(crate) process_id: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalEngineStatus {
    pub(crate) active_sessions: usize,
    pub(crate) starting_sessions: usize,
    pub(crate) running_sessions: usize,
    pub(crate) stopping_sessions: usize,
    pub(crate) draining_sessions: usize,
    pub(crate) pending_output_batches: usize,
    pub(crate) pending_output_bytes: usize,
    pub(crate) pending_resizes: usize,
    pub(crate) resize_requests: u64,
    pub(crate) resize_applied: u64,
    pub(crate) resize_coalesced: u64,
    pub(crate) spawning_sessions: usize,
    pub(crate) peak_concurrent_spawns: usize,
    pub(crate) worker_threads: usize,
    pub(crate) max_sessions: usize,
    pub(crate) max_concurrent_spawns: usize,
    pub(crate) accepting_sessions: bool,
    pub(crate) output_batch_max_bytes: usize,
    pub(crate) output_max_unacked_batches: usize,
    pub(crate) output_max_unacked_bytes: usize,
    pub(crate) global_output_max_unacked_bytes: usize,
    pub(crate) peak_global_output_bytes: usize,
}

trait TerminalEventSink: Send + Sync + 'static {
    fn send(&self, event: TerminalEvent) -> Result<(), String>;
}

struct TauriEventSink(Channel<TerminalEvent>);

impl TerminalEventSink for TauriEventSink {
    fn send(&self, event: TerminalEvent) -> Result<(), String> {
        self.0.send(event).map_err(|error| error.to_string())
    }
}

#[cfg(test)]
trait StartOwnershipHook: Send + Sync + 'static {
    fn spawned_before_job_assignment(&self, process_id: Option<u32>);
}

#[cfg(test)]
struct NoopStartOwnershipHook;

#[cfg(test)]
impl StartOwnershipHook for NoopStartOwnershipHook {
    fn spawned_before_job_assignment(&self, _process_id: Option<u32>) {}
}

#[derive(Default)]
struct WorkerEventGate {
    closed: Mutex<bool>,
}

impl WorkerEventGate {
    fn send(&self, sink: &Arc<dyn TerminalEventSink>, event: TerminalEvent) -> Result<(), String> {
        let closed = lock(&self.closed)?;
        if *closed {
            return Ok(());
        }
        // Keep the gate locked through send so close() is a strict event barrier.
        sink.send(event)
    }

    fn close(&self) {
        match self.closed.lock() {
            Ok(mut closed) => *closed = true,
            Err(poisoned) => *poisoned.into_inner() = true,
        }
    }
}

struct GatedEventSink {
    sink: Arc<dyn TerminalEventSink>,
    gate: Arc<WorkerEventGate>,
}

impl TerminalEventSink for GatedEventSink {
    fn send(&self, event: TerminalEvent) -> Result<(), String> {
        self.gate.send(&self.sink, event)
    }
}

struct TerminalIo {
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
}

impl TerminalIo {
    fn write(&self, data: &[u8]) -> Result<(), String> {
        let mut writer = lock(&self.writer)?;
        let writer = writer
            .as_mut()
            .ok_or_else(|| "Terminal input is already closed.".to_owned())?;
        write_bytes(writer.as_mut(), data)
            .map_err(|error| format!("Terminal input failed: {error}"))
    }

    fn resize(&self, size: PtySize) -> Result<(), String> {
        let master = lock(&self.master)?;
        let master = master
            .as_ref()
            .ok_or_else(|| "Terminal is already closed.".to_owned())?;
        master
            .resize(size)
            .map_err(|error| format!("Terminal resize failed: {error}"))
    }

    fn close(&self) {
        match self.writer.lock() {
            Ok(mut writer) => {
                writer.take();
            }
            Err(poisoned) => {
                poisoned.into_inner().take();
            }
        }
        match self.master.lock() {
            Ok(mut master) => {
                master.take();
            }
            Err(poisoned) => {
                poisoned.into_inner().take();
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
enum SessionPhase {
    Running = 0,
    Stopping = 1,
    Draining = 2,
}

impl SessionPhase {
    fn from_raw(value: u8) -> Self {
        match value {
            1 => Self::Stopping,
            2 => Self::Draining,
            _ => Self::Running,
        }
    }
}

struct TerminalSession {
    io: Arc<TerminalIo>,
    terminator: ProcessTerminator,
    flow: Arc<OutputFlow>,
    resize: Arc<ResizeMailbox>,
    phase: AtomicU8,
}

impl TerminalSession {
    fn phase(&self) -> SessionPhase {
        SessionPhase::from_raw(self.phase.load(Ordering::Acquire))
    }

    fn ensure_running(&self) -> Result<(), String> {
        if self.phase() == SessionPhase::Running {
            Ok(())
        } else {
            Err("Terminal session is stopping.".to_owned())
        }
    }

    fn request_stop(&self) -> Result<(), String> {
        match self.phase.compare_exchange(
            SessionPhase::Running as u8,
            SessionPhase::Stopping as u8,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => {
                self.resize.close();
                self.terminator.terminate()
            }
            Err(_) => Ok(()),
        }
    }

    fn begin_draining(&self) {
        self.phase
            .store(SessionPhase::Draining as u8, Ordering::Release);
        self.resize.close();
        self.io.close();
    }

    fn abort(&self) {
        self.resize.close();
        self.flow.close();
        let _ = self.request_stop();
        self.io.close();
    }
}

trait TerminalAbortSignal: Send + Sync + 'static {
    fn abort_after_sink_failure(&self);
}

impl TerminalAbortSignal for TerminalSession {
    fn abort_after_sink_failure(&self) {
        self.flow.close();
        let _ = self.request_stop();
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ManagerLifecycle {
    Running,
    ShuttingDown,
}

enum SessionEntry {
    Starting,
    Active(Arc<TerminalSession>),
}

struct ManagerState {
    lifecycle: ManagerLifecycle,
    sessions: HashMap<String, SessionEntry>,
}

impl Default for ManagerState {
    fn default() -> Self {
        Self {
            lifecycle: ManagerLifecycle::Running,
            sessions: HashMap::new(),
        }
    }
}

#[derive(Default)]
struct SpawnLimiterState {
    active: usize,
    peak: usize,
    closed: bool,
}

#[derive(Default)]
struct SpawnLimiter {
    state: Mutex<SpawnLimiterState>,
    available: Condvar,
}

impl SpawnLimiter {
    fn acquire(self: &Arc<Self>) -> Result<SpawnPermit, String> {
        let mut state = lock(&self.state)?;
        while !state.closed && state.active >= MAX_CONCURRENT_SPAWNS {
            state = self
                .available
                .wait(state)
                .map_err(|_| "Terminal spawn limiter lock was poisoned.".to_owned())?;
        }
        if state.closed {
            return Err("Terminal engine is shutting down.".to_owned());
        }
        state.active += 1;
        state.peak = state.peak.max(state.active);
        Ok(SpawnPermit {
            limiter: Arc::clone(self),
        })
    }

    fn close(&self) {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        state.closed = true;
        self.available.notify_all();
    }

    fn snapshot(&self) -> SpawnLimiterSnapshot {
        let state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        SpawnLimiterSnapshot {
            active: state.active,
            peak: state.peak,
        }
    }
}

struct SpawnPermit {
    limiter: Arc<SpawnLimiter>,
}

impl Drop for SpawnPermit {
    fn drop(&mut self) {
        let mut state = match self.limiter.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        state.active = state.active.saturating_sub(1);
        self.limiter.available.notify_one();
    }
}

struct SpawnLimiterSnapshot {
    active: usize,
    peak: usize,
}

#[derive(Default)]
struct GlobalOutputBudgetState {
    bytes: usize,
    peak: usize,
    closed: bool,
}

struct GlobalOutputBudget {
    state: Mutex<GlobalOutputBudgetState>,
    available: Condvar,
    max_bytes: usize,
}

impl Default for GlobalOutputBudget {
    fn default() -> Self {
        Self::with_limit(GLOBAL_OUTPUT_MAX_UNACKED_BYTES)
    }
}

impl GlobalOutputBudget {
    fn with_limit(max_bytes: usize) -> Self {
        Self {
            state: Mutex::new(GlobalOutputBudgetState::default()),
            available: Condvar::new(),
            max_bytes: max_bytes.max(1),
        }
    }

    fn acquire(&self, bytes: usize, cancelled: &AtomicBool) -> bool {
        if bytes > self.max_bytes {
            return false;
        }
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        while !state.closed
            && !cancelled.load(Ordering::Acquire)
            && state.bytes.saturating_add(bytes) > self.max_bytes
        {
            state = match self.available.wait(state) {
                Ok(state) => state,
                Err(poisoned) => poisoned.into_inner(),
            };
        }
        if state.closed || cancelled.load(Ordering::Acquire) {
            return false;
        }
        state.bytes += bytes;
        state.peak = state.peak.max(state.bytes);
        true
    }

    fn release(&self, bytes: usize) {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        state.bytes = state.bytes.saturating_sub(bytes);
        self.available.notify_all();
    }

    fn close(&self) {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        state.closed = true;
        self.available.notify_all();
    }

    fn notify_all(&self) {
        self.available.notify_all();
    }

    fn snapshot(&self) -> GlobalOutputBudgetSnapshot {
        let state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        GlobalOutputBudgetSnapshot {
            bytes: state.bytes,
            peak: state.peak,
        }
    }
}

struct GlobalOutputBudgetSnapshot {
    bytes: usize,
    peak: usize,
}

#[derive(Clone)]
pub(crate) struct TerminalManager {
    state: Arc<Mutex<ManagerState>>,
    state_changed: Arc<Condvar>,
    spawn_limiter: Arc<SpawnLimiter>,
    output_budget: Arc<GlobalOutputBudget>,
    worker_threads: Arc<AtomicUsize>,
    agent_runtime: AgentRuntime,
    #[cfg(test)]
    start_ownership_hook: Arc<dyn StartOwnershipHook>,
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self {
            state: Arc::new(Mutex::new(ManagerState::default())),
            state_changed: Arc::new(Condvar::new()),
            spawn_limiter: Arc::new(SpawnLimiter::default()),
            output_budget: Arc::new(GlobalOutputBudget::default()),
            worker_threads: Arc::new(AtomicUsize::new(0)),
            agent_runtime: AgentRuntime::default(),
            #[cfg(test)]
            start_ownership_hook: Arc::new(NoopStartOwnershipHook),
        }
    }
}

impl TerminalManager {
    pub(crate) fn with_agent_runtime(agent_runtime: AgentRuntime) -> Self {
        Self {
            agent_runtime,
            ..Self::default()
        }
    }

    #[cfg(test)]
    fn with_start_ownership_hook(hook: Arc<dyn StartOwnershipHook>) -> Self {
        Self {
            start_ownership_hook: hook,
            ..Self::default()
        }
    }

    pub(crate) fn start(
        &self,
        cwd: Option<String>,
        columns: u16,
        rows: u16,
        terminal_key: Option<StableTerminalKey>,
        resume: Option<AgentResumeBinding>,
        on_event: Channel<TerminalEvent>,
    ) -> Result<StartTerminalResponse, String> {
        self.start_with_sink_request(
            cwd,
            columns,
            rows,
            terminal_key,
            resume,
            Arc::new(TauriEventSink(on_event)),
        )
    }

    #[cfg(test)]
    fn start_with_sink(
        &self,
        cwd: Option<String>,
        columns: u16,
        rows: u16,
        sink: Arc<dyn TerminalEventSink>,
    ) -> Result<StartTerminalResponse, String> {
        self.start_with_sink_request(cwd, columns, rows, None, None, sink)
    }

    fn start_with_sink_request(
        &self,
        cwd: Option<String>,
        columns: u16,
        rows: u16,
        terminal_key: Option<StableTerminalKey>,
        resume: Option<AgentResumeBinding>,
        sink: Arc<dyn TerminalEventSink>,
    ) -> Result<StartTerminalResponse, String> {
        let cwd = validate_working_directory(cwd)?;
        let launch_plan = TerminalLaunchPlan::from_request(terminal_key, resume)?;
        let size = normalized_size(columns, rows);
        let mut reservation = self.reserve_start()?;
        let binding_lease = launch_plan
            .ownership()
            .map(|(terminal_key, binding)| {
                self.agent_runtime
                    .claim_for_start(&reservation.session_id, terminal_key, binding)
            })
            .transpose()?;
        let spawn_permit = self.spawn_limiter.acquire()?;

        let pair = native_pty_system()
            .openpty(size)
            .map_err(|error| format!("ConPTY creation failed: {error}"))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("ConPTY output connection failed: {error}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("ConPTY input connection failed: {error}"))?;

        let mut command = CommandBuilder::new(resolve_powershell());
        command.args(launch_plan.arguments());
        if let Some(directory) = &cwd {
            command.cwd(directory);
        }

        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("PowerShell launch failed: {error}"))?;
        let child = SpawnedChildGuard::new(child);
        let process_id = child.child().process_id();
        #[cfg(test)]
        self.start_ownership_hook
            .spawned_before_job_assignment(process_id);
        let terminator = ProcessTerminator::from_child(child.child())?;
        drop(pair.slave);

        let session = Arc::new(TerminalSession {
            io: Arc::new(TerminalIo {
                master: Mutex::new(Some(pair.master)),
                writer: Mutex::new(Some(writer)),
            }),
            terminator,
            flow: Arc::new(OutputFlow::new(Arc::clone(&self.output_budget))),
            resize: Arc::new(ResizeMailbox::default()),
            phase: AtomicU8::new(SessionPhase::Running as u8),
        });

        if let Err(error) = self.ensure_start_pending(&reservation.session_id) {
            session.abort();
            return Err(error);
        }

        drop(spawn_permit);
        let child = child.release();

        let mut workers = spawn_workers(
            reservation.session_id.clone(),
            child,
            reader,
            Arc::clone(&session),
            Arc::clone(&sink),
            ManagerRegistry {
                state: Arc::clone(&self.state),
                state_changed: Arc::clone(&self.state_changed),
                agent_runtime: self.agent_runtime.clone(),
            },
            Arc::clone(&self.worker_threads),
        )?;

        let commit_result = self.commit_start(
            &reservation.session_id,
            Arc::clone(&session),
            &sink,
            process_id,
            &mut workers,
        );
        if let Err(error) = commit_result {
            session.abort();
            workers.abort();
            return Err(error);
        }

        reservation.committed = true;
        if let Some(binding_lease) = binding_lease {
            binding_lease.commit();
        }
        workers.release_reaper();

        Ok(StartTerminalResponse {
            session_id: reservation.session_id.clone(),
            process_id,
        })
    }

    pub(crate) fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        if data.is_empty() {
            return Ok(());
        }
        let session = self.session(session_id)?;
        session.ensure_running()?;
        session.io.write(data)
    }

    pub(crate) fn resize(&self, session_id: &str, columns: u16, rows: u16) -> Result<(), String> {
        let session = self.session(session_id)?;
        session.ensure_running()?;
        session.resize.queue(normalized_size(columns, rows))
    }

    pub(crate) fn acknowledge_output(&self, session_id: &str, sequence: u64) -> Result<(), String> {
        let session = {
            let state = lock(&self.state)?;
            match state.sessions.get(session_id) {
                Some(SessionEntry::Active(session)) => Some(Arc::clone(session)),
                _ => None,
            }
        };
        if let Some(session) = session {
            session.flow.acknowledge(sequence);
        }
        // ACKs may race the final Exited event, so an unknown session is intentionally idempotent.
        Ok(())
    }

    pub(crate) fn stop(&self, session_id: &str) -> Result<(), String> {
        let session = {
            let state = lock(&self.state)?;
            match state.sessions.get(session_id) {
                Some(SessionEntry::Active(session)) => Some(Arc::clone(session)),
                _ => None,
            }
        };
        match session {
            Some(session) => session.request_stop(),
            None => Ok(()),
        }
    }

    pub(crate) fn has_active_session(&self, session_id: &str) -> bool {
        let state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        matches!(
            state.sessions.get(session_id),
            Some(SessionEntry::Active(_))
        )
    }

    #[cfg(test)]
    fn shutdown(&self) -> Result<(), String> {
        self.shutdown_barrier(None)
    }

    pub(crate) fn shutdown_for_command(&self) -> Result<(), String> {
        self.shutdown_barrier(Some(Instant::now() + SHUTDOWN_COMMAND_TIMEOUT))
    }

    pub(crate) fn shutdown_for_exit(&self) -> Result<(), String> {
        self.shutdown_barrier(Some(Instant::now() + SHUTDOWN_EXIT_TIMEOUT))
    }

    fn shutdown_barrier(&self, deadline: Option<Instant>) -> Result<(), String> {
        {
            let mut state = match self.state.lock() {
                Ok(state) => state,
                Err(poisoned) => poisoned.into_inner(),
            };
            state.lifecycle = ManagerLifecycle::ShuttingDown;
        }

        // Closing these gates after the lifecycle flip prevents both newly reserved and
        // limiter-waiting starts from progressing into process creation.
        self.spawn_limiter.close();
        self.output_budget.close();

        let sessions = {
            let mut state = match self.state.lock() {
                Ok(state) => state,
                Err(poisoned) => poisoned.into_inner(),
            };
            while state
                .sessions
                .values()
                .any(|entry| matches!(entry, SessionEntry::Starting))
            {
                state = self.wait_for_shutdown_progress(state, deadline)?;
            }
            state
                .sessions
                .values()
                .filter_map(|entry| match entry {
                    SessionEntry::Starting => None,
                    SessionEntry::Active(session) => Some(Arc::clone(session)),
                })
                .collect::<Vec<_>>()
        };

        let mut termination_error = None;
        for session in sessions {
            if let Err(error) = session.request_stop()
                && termination_error.is_none()
            {
                termination_error = Some(error);
            }
        }

        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        while !state.sessions.is_empty() {
            state = self.wait_for_shutdown_progress(state, deadline)?;
        }
        drop(state);

        match termination_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn wait_for_shutdown_progress<'a>(
        &self,
        state: std::sync::MutexGuard<'a, ManagerState>,
        deadline: Option<Instant>,
    ) -> Result<std::sync::MutexGuard<'a, ManagerState>, String> {
        let Some(deadline) = deadline else {
            return Ok(match self.state_changed.wait(state) {
                Ok(state) => state,
                Err(poisoned) => poisoned.into_inner(),
            });
        };
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(
                "Terminal shutdown did not finish before its safety deadline; force close is now available."
                    .to_owned(),
            );
        }
        let (state, _) = match self.state_changed.wait_timeout(state, remaining) {
            Ok(result) => result,
            Err(poisoned) => poisoned.into_inner(),
        };
        Ok(state)
    }

    pub(crate) fn status(&self) -> TerminalEngineStatus {
        let (lifecycle, entries) = match self.state.lock() {
            Ok(state) => (
                state.lifecycle,
                state
                    .sessions
                    .values()
                    .map(|entry| match entry {
                        SessionEntry::Starting => None,
                        SessionEntry::Active(session) => Some(Arc::clone(session)),
                    })
                    .collect::<Vec<_>>(),
            ),
            Err(poisoned) => {
                let state = poisoned.into_inner();
                (
                    state.lifecycle,
                    state
                        .sessions
                        .values()
                        .map(|entry| match entry {
                            SessionEntry::Starting => None,
                            SessionEntry::Active(session) => Some(Arc::clone(session)),
                        })
                        .collect::<Vec<_>>(),
                )
            }
        };

        let active_sessions = entries.len();
        let starting_sessions = entries.iter().filter(|entry| entry.is_none()).count();
        let mut running_sessions = 0;
        let mut stopping_sessions = 0;
        let mut draining_sessions = 0;
        let mut pending_output_batches = 0;
        let mut pending_resizes = 0;
        let mut resize_requests = 0;
        let mut resize_applied = 0;
        let mut resize_coalesced = 0;

        for session in entries.into_iter().flatten() {
            match session.phase() {
                SessionPhase::Running => running_sessions += 1,
                SessionPhase::Stopping => stopping_sessions += 1,
                SessionPhase::Draining => draining_sessions += 1,
            }
            let output = session.flow.snapshot();
            pending_output_batches += output.batches;
            let resize = session.resize.snapshot();
            pending_resizes += usize::from(resize.pending);
            resize_requests += resize.requested;
            resize_applied += resize.applied;
            resize_coalesced += resize.coalesced;
        }

        let spawn = self.spawn_limiter.snapshot();
        let global_output = self.output_budget.snapshot();

        TerminalEngineStatus {
            active_sessions,
            starting_sessions,
            running_sessions,
            stopping_sessions,
            draining_sessions,
            pending_output_batches,
            pending_output_bytes: global_output.bytes,
            pending_resizes,
            resize_requests,
            resize_applied,
            resize_coalesced,
            spawning_sessions: spawn.active,
            peak_concurrent_spawns: spawn.peak,
            worker_threads: self.worker_threads.load(Ordering::Acquire),
            max_sessions: MAX_TERMINAL_SESSIONS,
            max_concurrent_spawns: MAX_CONCURRENT_SPAWNS,
            accepting_sessions: lifecycle == ManagerLifecycle::Running
                && active_sessions < MAX_TERMINAL_SESSIONS,
            output_batch_max_bytes: OUTPUT_BATCH_MAX_BYTES,
            output_max_unacked_batches: OUTPUT_MAX_UNACKED_BATCHES,
            output_max_unacked_bytes: OUTPUT_MAX_UNACKED_BYTES,
            global_output_max_unacked_bytes: GLOBAL_OUTPUT_MAX_UNACKED_BYTES,
            peak_global_output_bytes: global_output.peak,
        }
    }

    fn reserve_start(&self) -> Result<StartReservation, String> {
        let mut state = lock(&self.state)?;
        if state.lifecycle != ManagerLifecycle::Running {
            return Err("Terminal engine is shutting down.".to_owned());
        }
        if state.sessions.len() >= MAX_TERMINAL_SESSIONS {
            return Err(format!(
                "Terminal session limit reached ({MAX_TERMINAL_SESSIONS})."
            ));
        }
        let session_id = Uuid::new_v4().simple().to_string();
        state
            .sessions
            .insert(session_id.clone(), SessionEntry::Starting);
        drop(state);
        Ok(StartReservation {
            state: Arc::clone(&self.state),
            state_changed: Arc::clone(&self.state_changed),
            session_id,
            committed: false,
        })
    }

    fn ensure_start_pending(&self, session_id: &str) -> Result<(), String> {
        let state = lock(&self.state)?;
        if state.lifecycle == ManagerLifecycle::Running
            && matches!(state.sessions.get(session_id), Some(SessionEntry::Starting))
        {
            Ok(())
        } else {
            Err("Terminal start was cancelled during shutdown.".to_owned())
        }
    }

    fn commit_start(
        &self,
        session_id: &str,
        session: Arc<TerminalSession>,
        sink: &Arc<dyn TerminalEventSink>,
        process_id: Option<u32>,
        workers: &mut WorkerSet,
    ) -> Result<(), String> {
        let mut state = lock(&self.state)?;
        if state.lifecycle != ManagerLifecycle::Running
            || !matches!(state.sessions.get(session_id), Some(SessionEntry::Starting))
        {
            return Err("Terminal start was cancelled during shutdown.".to_owned());
        }

        state
            .sessions
            .insert(session_id.to_owned(), SessionEntry::Active(session));

        if let Err(error) = sink.send(TerminalEvent::Started {
            session_id: session_id.to_owned(),
            process_id,
        }) {
            state.sessions.remove(session_id);
            return Err(format!("Terminal started event failed: {error}"));
        }

        if let Err(error) = workers.signal_start() {
            state.sessions.remove(session_id);
            return Err(error);
        }
        Ok(())
    }

    fn session(&self, session_id: &str) -> Result<Arc<TerminalSession>, String> {
        let state = lock(&self.state)?;
        match state.sessions.get(session_id) {
            Some(SessionEntry::Active(session)) => Ok(Arc::clone(session)),
            _ => Err("Terminal session was not found.".to_owned()),
        }
    }
}

struct StartReservation {
    state: Arc<Mutex<ManagerState>>,
    state_changed: Arc<Condvar>,
    session_id: String,
    committed: bool,
}

impl Drop for StartReservation {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        match self.state.lock() {
            Ok(mut state) => {
                state.sessions.remove(&self.session_id);
            }
            Err(poisoned) => {
                poisoned.into_inner().sessions.remove(&self.session_id);
            }
        }
        self.state_changed.notify_all();
    }
}

struct WorkerSet {
    reader_start: Option<SyncSender<bool>>,
    output_start: Option<SyncSender<bool>>,
    resize_start: Option<SyncSender<bool>>,
    wait_start: Option<SyncSender<bool>>,
    reaper: Option<JoinHandle<()>>,
}

impl WorkerSet {
    fn signal_start(&mut self) -> Result<(), String> {
        send_gate(&mut self.output_start, true, "output dispatcher")?;
        send_gate(&mut self.resize_start, true, "resize worker")?;
        send_gate(&mut self.reader_start, true, "PTY reader")?;
        send_gate(&mut self.wait_start, true, "process waiter")?;
        Ok(())
    }

    fn abort(&mut self) {
        let _ = send_gate(&mut self.output_start, false, "output dispatcher");
        let _ = send_gate(&mut self.resize_start, false, "resize worker");
        let _ = send_gate(&mut self.reader_start, false, "PTY reader");
        let _ = send_gate(&mut self.wait_start, false, "process waiter");
        if let Some(handle) = self.reaper.take() {
            let _ = handle.join();
        }
    }

    fn release_reaper(mut self) {
        // The reaper owns and joins every reader/output/resize worker. Its own handle
        // cannot be joined from inside itself and is safe to release after commit.
        self.reaper.take();
    }
}

fn send_gate(
    sender: &mut Option<SyncSender<bool>>,
    value: bool,
    worker: &str,
) -> Result<(), String> {
    let Some(sender) = sender.take() else {
        return Ok(());
    };
    sender
        .send(value)
        .map_err(|_| format!("{worker} could not be started."))
}

struct WorkerThreadGuard {
    counter: Arc<AtomicUsize>,
}

impl WorkerThreadGuard {
    fn enter(counter: Arc<AtomicUsize>) -> Self {
        counter.fetch_add(1, Ordering::AcqRel);
        Self { counter }
    }
}

impl Drop for WorkerThreadGuard {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::AcqRel);
    }
}

type WorkerHandleGroup = Arc<Mutex<Option<Vec<JoinHandle<()>>>>>;
struct ManagerRegistry {
    state: Arc<Mutex<ManagerState>>,
    state_changed: Arc<Condvar>,
    agent_runtime: AgentRuntime,
}

#[derive(Default)]
struct WorkerJoinSummary {
    unfinished: usize,
    panicked: usize,
}

fn join_worker_group(group: &WorkerHandleGroup, timeout: Duration) -> WorkerJoinSummary {
    let mut handles = match group.lock() {
        Ok(mut handles) => handles.take().unwrap_or_default(),
        Err(poisoned) => poisoned.into_inner().take().unwrap_or_default(),
    };
    let deadline = Instant::now() + timeout;
    while handles.iter().any(|handle| !handle.is_finished()) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(2));
    }

    let mut summary = WorkerJoinSummary::default();
    for handle in handles.drain(..) {
        if handle.is_finished() {
            if handle.join().is_err() {
                summary.panicked += 1;
            }
        } else {
            // The event gate is closed before this path, so a tardy worker cannot emit
            // Output/Error after Exited. Dropping avoids an unbounded app-exit wait.
            summary.unfinished += 1;
        }
    }
    summary
}

fn spawn_workers(
    session_id: String,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    mut reader: Box<dyn Read + Send>,
    session: Arc<TerminalSession>,
    sink: Arc<dyn TerminalEventSink>,
    manager_registry: ManagerRegistry,
    worker_threads: Arc<AtomicUsize>,
) -> Result<WorkerSet, String> {
    let ManagerRegistry {
        state: manager_state,
        state_changed: manager_state_changed,
        agent_runtime,
    } = manager_registry;
    let (reader_start_sender, reader_start_receiver) = mpsc::sync_channel(1);
    let (output_start_sender, output_start_receiver) = mpsc::sync_channel(1);
    let (resize_start_sender, resize_start_receiver) = mpsc::sync_channel(1);
    let (wait_start_sender, wait_start_receiver) = mpsc::sync_channel(1);
    let (raw_sender, raw_receiver) = mpsc::sync_channel(OUTPUT_QUEUE_CAPACITY);
    let (output_done_sender, output_done_receiver) = mpsc::sync_channel(1);
    let event_gate = Arc::new(WorkerEventGate::default());
    let worker_sink: Arc<dyn TerminalEventSink> = Arc::new(GatedEventSink {
        sink: Arc::clone(&sink),
        gate: Arc::clone(&event_gate),
    });
    let mut handles = Vec::with_capacity(3);

    let reader_id = session_id.clone();
    let reader_counter = Arc::clone(&worker_threads);
    let reader_handle = match thread::Builder::new()
        .name(format!("ihc-pty-reader-{reader_id}"))
        .spawn(move || {
            let _worker = WorkerThreadGuard::enter(reader_counter);
            if reader_start_receiver.recv() != Ok(true) {
                return;
            }
            let mut buffer = [0_u8; OUTPUT_READ_BUFFER_BYTES];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => {
                        let _ = raw_sender.send(ReaderMessage::Eof);
                        break;
                    }
                    Ok(length) => {
                        if raw_sender
                            .send(ReaderMessage::Bytes(buffer[..length].to_vec()))
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = raw_sender.send(ReaderMessage::Error(format!(
                            "ConPTY output read failed: {error}"
                        )));
                        break;
                    }
                }
            }
        }) {
        Ok(handle) => handle,
        Err(error) => {
            session.abort();
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("PTY reader thread failed to start: {error}"));
        }
    };
    handles.push(reader_handle);

    let output_id = session_id.clone();
    let output_sink = Arc::clone(&worker_sink);
    let output_flow = Arc::clone(&session.flow);
    let output_abort: Arc<dyn TerminalAbortSignal> = session.clone();
    let output_counter = Arc::clone(&worker_threads);
    let output_handle = match thread::Builder::new()
        .name(format!("ihc-pty-output-{output_id}"))
        .spawn(move || {
            let _worker = WorkerThreadGuard::enter(output_counter);
            run_output_dispatcher(
                output_id,
                raw_receiver,
                output_start_receiver,
                output_done_sender,
                output_sink,
                output_flow,
                output_abort,
            );
        }) {
        Ok(handle) => handle,
        Err(error) => {
            let _ = reader_start_sender.send(false);
            session.abort();
            let _ = child.kill();
            let _ = child.wait();
            for handle in handles {
                let _ = handle.join();
            }
            return Err(format!("Output dispatcher thread failed to start: {error}"));
        }
    };
    handles.push(output_handle);

    let resize_id = session_id.clone();
    let resize_sink = Arc::clone(&worker_sink);
    let resize_session = Arc::clone(&session);
    let resize_mailbox = Arc::clone(&session.resize);
    let resize_io = Arc::clone(&session.io);
    let resize_counter = Arc::clone(&worker_threads);
    let resize_handle = match thread::Builder::new()
        .name(format!("ihc-pty-resize-{resize_id}"))
        .spawn(move || {
            let _worker = WorkerThreadGuard::enter(resize_counter);
            if resize_start_receiver.recv() != Ok(true) {
                return;
            }
            while let Some(size) = resize_mailbox.take_latest() {
                match resize_io.resize(size) {
                    Ok(()) => resize_mailbox.mark_applied(size),
                    Err(message) => {
                        if resize_sink
                            .send(TerminalEvent::Error {
                                session_id: resize_id.clone(),
                                message,
                            })
                            .is_err()
                        {
                            resize_session.abort_after_sink_failure();
                            break;
                        }
                    }
                }
            }
        }) {
        Ok(handle) => handle,
        Err(error) => {
            let _ = reader_start_sender.send(false);
            let _ = output_start_sender.send(false);
            session.abort();
            let _ = child.kill();
            let _ = child.wait();
            for handle in handles {
                let _ = handle.join();
            }
            return Err(format!("Resize worker thread failed to start: {error}"));
        }
    };
    handles.push(resize_handle);

    let worker_group: WorkerHandleGroup = Arc::new(Mutex::new(Some(handles)));
    let wait_worker_group = Arc::clone(&worker_group);
    let wait_id = session_id.clone();
    let wait_sink = Arc::clone(&sink);
    let wait_session = Arc::clone(&session);
    let wait_event_gate = Arc::clone(&event_gate);
    let wait_handle = match thread::Builder::new()
        .name(format!("ihc-pty-wait-{wait_id}"))
        .spawn(move || {
            if wait_start_receiver.recv() != Ok(true) {
                wait_event_gate.close();
                let _ = join_worker_group(&wait_worker_group, WORKER_JOIN_TIMEOUT);
                return;
            }

            let result = child.wait();
            let exit_code = result.as_ref().ok().map(|status| status.exit_code());
            wait_session.begin_draining();

            let first_drain = output_done_receiver.recv_timeout(OUTPUT_DRAIN_TIMEOUT);
            let mut drained = first_drain.is_ok();
            let mut last_sequence = first_drain.ok().flatten();
            if !drained {
                wait_session.flow.close();
                let _ = wait_sink.send(TerminalEvent::Error {
                    session_id: wait_id.clone(),
                    message: format!(
                        "Terminal output drain exceeded {} ms; remaining output was discarded.",
                        OUTPUT_DRAIN_TIMEOUT.as_millis()
                    ),
                });
                if let Ok(sequence) = output_done_receiver.recv_timeout(OUTPUT_ABORT_DRAIN_TIMEOUT)
                {
                    drained = true;
                    last_sequence = sequence;
                }
            }

            last_sequence = last_sequence.or_else(|| wait_session.flow.last_sent_sequence());
            wait_session.flow.close();

            // This is the strict worker-event barrier. Once closed, a tardy resize/output
            // worker cannot publish anything after the terminal's final Exited event.
            wait_event_gate.close();
            let joins = join_worker_group(&wait_worker_group, WORKER_JOIN_TIMEOUT);

            if let Err(error) = result {
                let _ = wait_sink.send(TerminalEvent::Error {
                    session_id: wait_id.clone(),
                    message: format!("PowerShell wait failed: {error}"),
                });
            }
            if !drained {
                let _ = wait_sink.send(TerminalEvent::Error {
                    session_id: wait_id.clone(),
                    message: "Terminal output worker did not stop before its deadline.".to_owned(),
                });
            }
            if joins.unfinished > 0 || joins.panicked > 0 {
                let _ = wait_sink.send(TerminalEvent::Error {
                    session_id: wait_id.clone(),
                    message: format!(
                        "Terminal worker cleanup was incomplete (unfinished: {}, panicked: {}).",
                        joins.unfinished, joins.panicked
                    ),
                });
            }
            remove_session(&manager_state, &manager_state_changed, &wait_id);
            agent_runtime.unbind(&wait_id);
            let _ = wait_sink.send(TerminalEvent::Exited {
                session_id: wait_id,
                exit_code,
                last_sequence,
            });
        }) {
        Ok(handle) => handle,
        Err(error) => {
            let _ = reader_start_sender.send(false);
            let _ = output_start_sender.send(false);
            let _ = resize_start_sender.send(false);
            event_gate.close();
            session.abort();
            let _ = join_worker_group(&worker_group, WORKER_JOIN_TIMEOUT);
            return Err(format!("Process waiter thread failed to start: {error}"));
        }
    };

    Ok(WorkerSet {
        reader_start: Some(reader_start_sender),
        output_start: Some(output_start_sender),
        resize_start: Some(resize_start_sender),
        wait_start: Some(wait_start_sender),
        reaper: Some(wait_handle),
    })
}

fn remove_session(state: &Mutex<ManagerState>, state_changed: &Condvar, session_id: &str) {
    match state.lock() {
        Ok(mut state) => {
            state.sessions.remove(session_id);
        }
        Err(poisoned) => {
            poisoned.into_inner().sessions.remove(session_id);
        }
    }
    state_changed.notify_all();
}

enum ReaderMessage {
    Bytes(Vec<u8>),
    Error(String),
    Eof,
}

fn run_output_dispatcher(
    session_id: String,
    receiver: Receiver<ReaderMessage>,
    start: Receiver<bool>,
    done: SyncSender<Option<u64>>,
    sink: Arc<dyn TerminalEventSink>,
    flow: Arc<OutputFlow>,
    abort: Arc<dyn TerminalAbortSignal>,
) {
    let mut done = OutputDoneSignal::new(done);
    if start.recv() != Ok(true) {
        return;
    }

    let mut decoder = Utf8StreamDecoder::default();
    let mut batcher = OutputBatcher::new(OUTPUT_BATCH_MAX_BYTES);
    let mut deadline: Option<Instant> = None;
    let mut sequence = 0_u64;
    let mut sink_connected = true;

    loop {
        let message = match deadline {
            Some(batch_deadline) => {
                let timeout = batch_deadline.saturating_duration_since(Instant::now());
                match receiver.recv_timeout(timeout) {
                    Ok(message) => Some(message),
                    Err(RecvTimeoutError::Timeout) => {
                        if let Some(batch) = batcher.flush() {
                            emit_output(
                                &session_id,
                                &sink,
                                &flow,
                                &abort,
                                &mut sequence,
                                &mut sink_connected,
                                batch,
                            );
                        }
                        deadline = None;
                        continue;
                    }
                    Err(RecvTimeoutError::Disconnected) => None,
                }
            }
            None => receiver.recv().ok(),
        };

        match message {
            Some(ReaderMessage::Bytes(bytes)) => {
                let pending_was_empty = batcher.is_empty();
                let text = decoder.push(&bytes);
                for batch in batcher.push(&text) {
                    emit_output(
                        &session_id,
                        &sink,
                        &flow,
                        &abort,
                        &mut sequence,
                        &mut sink_connected,
                        batch,
                    );
                }
                if batcher.is_empty() {
                    deadline = None;
                } else if pending_was_empty || deadline.is_none() {
                    deadline = Some(Instant::now() + OUTPUT_BATCH_WINDOW);
                }
            }
            Some(ReaderMessage::Error(message)) => {
                let tail = decoder.finish();
                for batch in batcher.push(&tail) {
                    emit_output(
                        &session_id,
                        &sink,
                        &flow,
                        &abort,
                        &mut sequence,
                        &mut sink_connected,
                        batch,
                    );
                }
                if let Some(batch) = batcher.flush() {
                    emit_output(
                        &session_id,
                        &sink,
                        &flow,
                        &abort,
                        &mut sequence,
                        &mut sink_connected,
                        batch,
                    );
                }
                if sink_connected
                    && sink
                        .send(TerminalEvent::Error {
                            session_id: session_id.clone(),
                            message,
                        })
                        .is_err()
                {
                    flow.close();
                    abort.abort_after_sink_failure();
                }
                break;
            }
            Some(ReaderMessage::Eof) | None => {
                let tail = decoder.finish();
                for batch in batcher.push(&tail) {
                    emit_output(
                        &session_id,
                        &sink,
                        &flow,
                        &abort,
                        &mut sequence,
                        &mut sink_connected,
                        batch,
                    );
                }
                if let Some(batch) = batcher.flush() {
                    emit_output(
                        &session_id,
                        &sink,
                        &flow,
                        &abort,
                        &mut sequence,
                        &mut sink_connected,
                        batch,
                    );
                }
                break;
            }
        }
    }
    done.complete(sequence.checked_sub(1));
}

fn emit_output(
    session_id: &str,
    sink: &Arc<dyn TerminalEventSink>,
    flow: &OutputFlow,
    abort: &Arc<dyn TerminalAbortSignal>,
    sequence: &mut u64,
    sink_connected: &mut bool,
    data: String,
) {
    if data.is_empty() || !*sink_connected {
        return;
    }
    let current_sequence = *sequence;
    if !flow.reserve(current_sequence, data.len()) {
        return;
    }
    if sink
        .send(TerminalEvent::Output {
            session_id: session_id.to_owned(),
            sequence: current_sequence,
            data,
        })
        .is_ok()
    {
        flow.mark_sent(current_sequence);
        *sequence = sequence.wrapping_add(1);
    } else {
        *sink_connected = false;
        flow.close();
        abort.abort_after_sink_failure();
    }
}

struct OutputDoneSignal {
    sender: Option<SyncSender<Option<u64>>>,
    last_sequence: Option<u64>,
}

impl OutputDoneSignal {
    fn new(sender: SyncSender<Option<u64>>) -> Self {
        Self {
            sender: Some(sender),
            last_sequence: None,
        }
    }

    fn complete(&mut self, last_sequence: Option<u64>) {
        self.last_sequence = last_sequence;
    }
}

impl Drop for OutputDoneSignal {
    fn drop(&mut self) {
        if let Some(sender) = self.sender.take() {
            let _ = sender.send(self.last_sequence);
        }
    }
}

#[derive(Clone, Copy)]
struct OutstandingBatch {
    sequence: u64,
    bytes: usize,
}

struct OutputFlowState {
    unacked: VecDeque<OutstandingBatch>,
    bytes: usize,
    last_sent_sequence: Option<u64>,
    closed: bool,
}

struct OutputFlow {
    state: Mutex<OutputFlowState>,
    available: Condvar,
    max_batches: usize,
    max_bytes: usize,
    global: Arc<GlobalOutputBudget>,
    closed: AtomicBool,
}

impl OutputFlow {
    fn new(global: Arc<GlobalOutputBudget>) -> Self {
        Self::with_limits(OUTPUT_MAX_UNACKED_BATCHES, OUTPUT_MAX_UNACKED_BYTES, global)
    }

    fn with_limits(max_batches: usize, max_bytes: usize, global: Arc<GlobalOutputBudget>) -> Self {
        Self {
            state: Mutex::new(OutputFlowState {
                unacked: VecDeque::new(),
                bytes: 0,
                last_sent_sequence: None,
                closed: false,
            }),
            available: Condvar::new(),
            max_batches: max_batches.max(1),
            max_bytes: max_bytes.max(1),
            global,
            closed: AtomicBool::new(false),
        }
    }

    fn reserve(&self, sequence: u64, bytes: usize) -> bool {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        while !state.closed
            && (state.unacked.len() >= self.max_batches
                || state.bytes.saturating_add(bytes) > self.max_bytes)
        {
            state = match self.available.wait(state) {
                Ok(state) => state,
                Err(poisoned) => poisoned.into_inner(),
            };
        }
        if state.closed {
            return false;
        }
        drop(state);

        if !self.global.acquire(bytes, &self.closed) {
            return false;
        }

        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        while !state.closed
            && (state.unacked.len() >= self.max_batches
                || state.bytes.saturating_add(bytes) > self.max_bytes)
        {
            state = match self.available.wait(state) {
                Ok(state) => state,
                Err(poisoned) => poisoned.into_inner(),
            };
        }
        if state.closed {
            drop(state);
            self.global.release(bytes);
            return false;
        }
        state
            .unacked
            .push_back(OutstandingBatch { sequence, bytes });
        state.bytes += bytes;
        true
    }

    fn acknowledge(&self, sequence: u64) {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        let mut released = 0;
        while state
            .unacked
            .front()
            .is_some_and(|batch| batch.sequence <= sequence)
        {
            if let Some(batch) = state.unacked.pop_front() {
                state.bytes = state.bytes.saturating_sub(batch.bytes);
                released += batch.bytes;
            }
        }
        self.available.notify_all();
        drop(state);
        if released > 0 {
            self.global.release(released);
        }
    }

    fn mark_sent(&self, sequence: u64) {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        state.last_sent_sequence = Some(sequence);
    }

    fn last_sent_sequence(&self) -> Option<u64> {
        match self.state.lock() {
            Ok(state) => state.last_sent_sequence,
            Err(poisoned) => poisoned.into_inner().last_sent_sequence,
        }
    }

    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        state.closed = true;
        state.unacked.clear();
        let released = state.bytes;
        state.bytes = 0;
        self.available.notify_all();
        drop(state);
        self.global.release(released);
        self.global.notify_all();
    }

    fn snapshot(&self) -> OutputFlowSnapshot {
        let state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        OutputFlowSnapshot {
            batches: state.unacked.len(),
        }
    }
}

struct OutputFlowSnapshot {
    batches: usize,
}

struct OutputBatcher {
    pending: String,
    max_bytes: usize,
}

impl OutputBatcher {
    fn new(max_bytes: usize) -> Self {
        Self {
            pending: String::new(),
            max_bytes: max_bytes.max(4),
        }
    }

    fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    fn push(&mut self, text: &str) -> Vec<String> {
        self.pending.push_str(text);
        let mut ready = Vec::new();
        while self.pending.len() >= self.max_bytes {
            let mut split = self.max_bytes;
            while !self.pending.is_char_boundary(split) {
                split -= 1;
            }
            let remainder = self.pending.split_off(split);
            ready.push(std::mem::replace(&mut self.pending, remainder));
        }
        ready
    }

    fn flush(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.pending))
        }
    }
}

#[derive(Default)]
struct ResizeState {
    pending: Option<PtySize>,
    last_applied: Option<PtySize>,
    requested: u64,
    applied: u64,
    coalesced: u64,
    closed: bool,
}

#[derive(Default)]
struct ResizeMailbox {
    state: Mutex<ResizeState>,
    changed: Condvar,
}

impl ResizeMailbox {
    fn queue(&self, size: PtySize) -> Result<(), String> {
        let mut state = lock(&self.state)?;
        if state.closed {
            return Err("Terminal resize worker is closed.".to_owned());
        }
        state.requested = state.requested.saturating_add(1);
        if state.pending.is_some() {
            state.coalesced = state.coalesced.saturating_add(1);
        }
        state.pending = Some(size);
        self.changed.notify_one();
        Ok(())
    }

    fn take_latest(&self) -> Option<PtySize> {
        loop {
            let candidate = self.take_debounced()?;
            let mut state = match self.state.lock() {
                Ok(state) => state,
                Err(poisoned) => poisoned.into_inner(),
            };
            if state
                .last_applied
                .is_some_and(|applied| same_pty_size(applied, candidate))
            {
                state.coalesced = state.coalesced.saturating_add(1);
                self.changed.notify_all();
                continue;
            }
            return Some(candidate);
        }
    }

    fn take_debounced(&self) -> Option<PtySize> {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        while state.pending.is_none() && !state.closed {
            state = match self.changed.wait(state) {
                Ok(state) => state,
                Err(poisoned) => poisoned.into_inner(),
            };
        }
        if state.closed {
            return None;
        }

        let deadline = Instant::now() + RESIZE_COALESCE_WINDOW;
        loop {
            let timeout = deadline.saturating_duration_since(Instant::now());
            if timeout.is_zero() {
                break;
            }
            let (next_state, result) = match self.changed.wait_timeout(state, timeout) {
                Ok(result) => result,
                Err(poisoned) => poisoned.into_inner(),
            };
            state = next_state;
            if state.closed || result.timed_out() {
                break;
            }
        }
        if state.closed {
            None
        } else {
            state.pending.take()
        }
    }

    fn mark_applied(&self, size: PtySize) {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        state.last_applied = Some(size);
        state.applied = state.applied.saturating_add(1);
    }

    fn snapshot(&self) -> ResizeSnapshot {
        let state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        ResizeSnapshot {
            pending: state.pending.is_some(),
            requested: state.requested,
            applied: state.applied,
            coalesced: state.coalesced,
        }
    }

    #[cfg(test)]
    fn wait_for_coalesced_at_least(&self, target: u64, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        loop {
            if state.coalesced >= target {
                return true;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            let (next_state, result) = match self.changed.wait_timeout(state, remaining) {
                Ok(result) => result,
                Err(poisoned) => poisoned.into_inner(),
            };
            state = next_state;
            if result.timed_out() && state.coalesced < target {
                return false;
            }
        }
    }

    fn close(&self) {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        state.closed = true;
        state.pending = None;
        self.changed.notify_all();
    }
}

struct ResizeSnapshot {
    pending: bool,
    requested: u64,
    applied: u64,
    coalesced: u64,
}

fn same_pty_size(left: PtySize, right: PtySize) -> bool {
    left.rows == right.rows
        && left.cols == right.cols
        && left.pixel_width == right.pixel_width
        && left.pixel_height == right.pixel_height
}

struct SpawnedChildGuard {
    child: Option<Box<dyn portable_pty::Child + Send + Sync>>,
}

impl SpawnedChildGuard {
    fn new(child: Box<dyn portable_pty::Child + Send + Sync>) -> Self {
        Self { child: Some(child) }
    }

    fn child(&self) -> &(dyn portable_pty::Child + Send + Sync) {
        self.child
            .as_deref()
            .expect("spawned child guard must own its child")
    }

    fn release(mut self) -> Box<dyn portable_pty::Child + Send + Sync> {
        self.child
            .take()
            .expect("spawned child guard must own its child")
    }
}

impl Drop for SpawnedChildGuard {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(windows)]
struct ProcessTerminator {
    job: Mutex<Option<OwnedHandle>>,
}

#[cfg(windows)]
impl ProcessTerminator {
    fn from_child(child: &dyn portable_pty::Child) -> Result<Self, String> {
        let source_handle = child
            .as_raw_handle()
            .ok_or_else(|| "PowerShell process handle is unavailable".to_owned())?;
        let raw_job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if raw_job.is_null() {
            return Err(format!(
                "PowerShell job creation failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        let job = unsafe { OwnedHandle::from_raw_handle(raw_job) };

        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&limits).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        };
        if configured == 0 {
            return Err(format!(
                "PowerShell job configuration failed: {}",
                std::io::Error::last_os_error()
            ));
        }

        let assigned = unsafe { AssignProcessToJobObject(job.as_raw_handle(), source_handle) };
        if assigned == 0 {
            return Err(format!(
                "PowerShell job assignment failed: {}",
                std::io::Error::last_os_error()
            ));
        }

        Ok(Self {
            job: Mutex::new(Some(job)),
        })
    }

    fn terminate(&self) -> Result<(), String> {
        let job = lock(&self.job)?.take();
        let Some(job) = job else {
            return Ok(());
        };
        let terminated = unsafe { TerminateJobObject(job.as_raw_handle(), 1) };
        // Dropping the last Job Object handle is a second kill path because the job was
        // configured with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
        drop(job);
        if terminated == 0 {
            Err(format!(
                "PowerShell termination failed: {}",
                std::io::Error::last_os_error()
            ))
        } else {
            Ok(())
        }
    }
}

#[cfg(not(windows))]
struct ProcessTerminator {
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

#[cfg(not(windows))]
impl ProcessTerminator {
    fn from_child(child: &dyn portable_pty::Child) -> Result<Self, String> {
        Ok(Self {
            killer: Mutex::new(child.clone_killer()),
        })
    }

    fn terminate(&self) -> Result<(), String> {
        lock(&self.killer)?
            .kill()
            .map_err(|error| format!("PowerShell termination failed: {error}"))
    }
}

fn lock<T>(mutex: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, String> {
    mutex
        .lock()
        .map_err(|_| "Terminal engine state lock was poisoned.".to_owned())
}

fn write_bytes(writer: &mut dyn Write, data: &[u8]) -> std::io::Result<()> {
    writer.write_all(data)?;
    writer.flush()
}

fn normalized_size(columns: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.clamp(1, 1_000),
        cols: columns.clamp(2, 1_000),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn validate_working_directory(cwd: Option<String>) -> Result<Option<PathBuf>, String> {
    let Some(value) = cwd.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    let path = PathBuf::from(value);
    if !path.is_dir() {
        return Err("The selected working directory was not found.".to_owned());
    }
    Ok(Some(path))
}

fn resolve_powershell() -> PathBuf {
    if let Some(system_root) = env::var_os("SystemRoot") {
        let candidate = PathBuf::from(system_root)
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        if candidate.is_file() {
            return candidate;
        }
    }
    PathBuf::from("powershell.exe")
}

#[derive(Default)]
struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut output = String::new();

        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    output.push_str(text);
                    self.pending.clear();
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    if valid > 0 {
                        let prefix = std::str::from_utf8(&self.pending[..valid])
                            .expect("UTF-8 valid prefix was rejected");
                        output.push_str(prefix);
                        self.pending.drain(..valid);
                    }
                    match error.error_len() {
                        Some(length) => {
                            self.pending.drain(..length);
                            output.push('\u{fffd}');
                        }
                        None => break,
                    }
                }
            }
        }

        output
    }

    fn finish(self) -> String {
        String::from_utf8_lossy(&self.pending).into_owned()
    }
}

pub(crate) fn phase2_initial_panes() -> u8 {
    env::var("IHC_PHASE2_INITIAL_PANES")
        .ok()
        .and_then(|value| value.parse::<u8>().ok())
        .unwrap_or(1)
        .clamp(1, MAX_TERMINAL_SESSIONS as u8)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::HashSet,
        sync::{
            Barrier,
            atomic::{AtomicBool, Ordering},
            mpsc,
        },
    };

    #[cfg(windows)]
    use windows_sys::Win32::{
        Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0},
        Storage::FileSystem::SYNCHRONIZE,
        System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, WaitForSingleObject},
    };

    struct BlockingStartOwnershipHook {
        spawned: SyncSender<Option<u32>>,
        release: Mutex<Receiver<()>>,
    }

    impl StartOwnershipHook for BlockingStartOwnershipHook {
        fn spawned_before_job_assignment(&self, process_id: Option<u32>) {
            let _ = self.spawned.send(process_id);
            let release = match self.release.lock() {
                Ok(release) => release,
                Err(poisoned) => poisoned.into_inner(),
            };
            let _ = release.recv();
        }
    }

    #[cfg(windows)]
    fn wait_for_process_exit(process_id: u32, timeout: Duration) -> Result<bool, String> {
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                0,
                process_id,
            )
        };
        if handle.is_null() {
            let error = std::io::Error::last_os_error();
            return if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
                Ok(true)
            } else {
                Err(format!("Could not inspect test child process: {error}"))
            };
        }
        let timeout_ms = timeout.as_millis().min(u128::from(u32::MAX)) as u32;
        let wait_result = unsafe { WaitForSingleObject(handle, timeout_ms) };
        unsafe {
            CloseHandle(handle);
        }
        Ok(wait_result == WAIT_OBJECT_0)
    }

    fn test_output_flow(max_batches: usize, max_bytes: usize) -> Arc<OutputFlow> {
        Arc::new(OutputFlow::with_limits(
            max_batches,
            max_bytes,
            Arc::new(GlobalOutputBudget::with_limit(max_bytes * 4)),
        ))
    }

    #[test]
    fn preserves_korean_split_across_chunks() {
        let source = "우리가 실험용 한글 입력을 확인합니다".as_bytes();
        let mut decoder = Utf8StreamDecoder::default();
        let mut output = String::new();
        for byte in source {
            output.push_str(&decoder.push(&[*byte]));
        }
        output.push_str(&decoder.finish());
        assert_eq!(output, "우리가 실험용 한글 입력을 확인합니다");
    }

    #[test]
    fn replaces_invalid_utf8_without_losing_neighbors() {
        let mut decoder = Utf8StreamDecoder::default();
        let mut output = decoder.push(b"left\xffright");
        output.push_str(&decoder.finish());
        assert_eq!(output, "left\u{fffd}right");
    }

    #[test]
    fn raw_terminal_input_preserves_all_byte_values() {
        let source = [0x00, 0x7f, 0x80, 0xff];
        let mut destination = Vec::new();
        write_bytes(&mut destination, &source).expect("raw bytes should be writable");
        assert_eq!(destination, source);
    }

    #[test]
    fn batches_without_splitting_korean_scalars() {
        let mut batcher = OutputBatcher::new(7);
        let mut batches = batcher.push("가나다라마바사");
        batches.extend(batcher.flush());
        assert_eq!(batches.concat(), "가나다라마바사");
        assert!(batches.iter().all(|batch| batch.len() <= 7));
    }

    #[test]
    fn output_flow_blocks_until_cumulative_ack() {
        let flow = test_output_flow(2, 8);
        assert!(flow.reserve(0, 4));
        assert!(flow.reserve(1, 4));

        let waiting_flow = Arc::clone(&flow);
        let (done_sender, done_receiver) = mpsc::sync_channel(1);
        let waiter = thread::spawn(move || {
            let accepted = waiting_flow.reserve(2, 4);
            let _ = done_sender.send(accepted);
        });

        assert!(
            done_receiver
                .recv_timeout(Duration::from_millis(50))
                .is_err()
        );
        flow.acknowledge(0);
        assert!(
            done_receiver
                .recv_timeout(Duration::from_secs(1))
                .expect("ACK should release output backpressure")
        );
        flow.acknowledge(2);
        assert_eq!(flow.snapshot().batches, 0);
        waiter.join().expect("flow waiter should finish");
    }

    #[test]
    fn output_flow_close_releases_waiters() {
        let flow = test_output_flow(1, 4);
        assert!(flow.reserve(0, 4));
        let waiting_flow = Arc::clone(&flow);
        let waiter = thread::spawn(move || waiting_flow.reserve(1, 4));
        thread::sleep(Duration::from_millis(20));
        flow.close();
        assert!(!waiter.join().expect("closed flow waiter should finish"));
    }

    #[test]
    fn enforces_twenty_reservations_under_concurrency() {
        let manager = TerminalManager::default();
        let barrier = Arc::new(Barrier::new(65));
        let (sender, receiver) = mpsc::channel();
        let mut threads = Vec::new();

        for _ in 0..64 {
            let manager = manager.clone();
            let barrier = Arc::clone(&barrier);
            let sender = sender.clone();
            threads.push(thread::spawn(move || {
                barrier.wait();
                sender
                    .send(manager.reserve_start())
                    .expect("reservation result should send");
            }));
        }
        barrier.wait();
        drop(sender);
        let reservations = receiver.into_iter().collect::<Vec<_>>();
        for worker in threads {
            worker.join().expect("reservation worker should finish");
        }

        assert_eq!(
            reservations.iter().filter(|result| result.is_ok()).count(),
            MAX_TERMINAL_SESSIONS
        );
        assert_eq!(manager.status().starting_sessions, MAX_TERMINAL_SESSIONS);
        drop(reservations);
        assert_eq!(manager.status().active_sessions, 0);
    }

    #[test]
    fn shutdown_waits_for_reservations_and_rejects_new_starts() {
        let manager = TerminalManager::default();
        let reservation = manager.reserve_start().expect("reservation should succeed");
        let shutdown_manager = manager.clone();
        let (done_sender, done_receiver) = mpsc::sync_channel(1);
        let shutdown = thread::spawn(move || {
            let result = shutdown_manager.shutdown();
            let _ = done_sender.send(result);
        });

        let deadline = Instant::now() + Duration::from_secs(1);
        while manager.status().accepting_sessions && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(2));
        }
        assert!(!manager.status().accepting_sessions);
        assert_eq!(manager.status().starting_sessions, 1);
        assert!(manager.reserve_start().is_err());
        assert!(
            done_receiver
                .recv_timeout(Duration::from_millis(50))
                .is_err()
        );

        drop(reservation);
        done_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("shutdown should finish after the reservation drains")
            .expect("shutdown should succeed");
        shutdown.join().expect("shutdown thread should finish");
        assert_eq!(manager.status().active_sessions, 0);
    }

    #[test]
    fn bounded_shutdown_times_out_without_reopening_the_start_gate() {
        let manager = TerminalManager::default();
        let reservation = manager.reserve_start().expect("reservation should succeed");
        let started = Instant::now();
        let error = manager
            .shutdown_barrier(Some(Instant::now() + Duration::from_millis(40)))
            .unwrap_err();

        assert!(error.contains("force close"));
        assert!(started.elapsed() >= Duration::from_millis(30));
        assert!(!manager.status().accepting_sessions);
        assert!(manager.reserve_start().is_err());
        assert_eq!(manager.status().starting_sessions, 1);

        drop(reservation);
        manager
            .shutdown()
            .expect("idempotent fallback shutdown should drain");
        assert_eq!(manager.status().active_sessions, 0);
    }

    #[test]
    fn resize_mailbox_keeps_only_latest_size() {
        let mailbox = Arc::new(ResizeMailbox::default());
        for index in 0..5_000 {
            mailbox
                .queue(normalized_size(80 + (index % 200) as u16, 20))
                .unwrap();
        }
        mailbox.queue(normalized_size(140, 40)).unwrap();
        let size = mailbox.take_latest().expect("latest resize should exist");
        assert_eq!(size.cols, 140);
        assert_eq!(size.rows, 40);
        mailbox.mark_applied(size);
        let snapshot = mailbox.snapshot();
        assert_eq!(snapshot.requested, 5_001);
        assert_eq!(snapshot.applied, 1);
        assert!(snapshot.coalesced >= 5_000);
        assert!(!mailbox.snapshot().pending);
        mailbox.close();
        assert!(mailbox.take_latest().is_none());
    }

    #[test]
    fn resize_mailbox_suppresses_an_already_applied_size() {
        let mailbox = Arc::new(ResizeMailbox::default());
        let size = normalized_size(120, 30);
        mailbox.queue(size).unwrap();
        let first = mailbox.take_latest().unwrap();
        mailbox.mark_applied(first);

        mailbox.queue(size).unwrap();
        let waiting_mailbox = Arc::clone(&mailbox);
        let worker = thread::spawn(move || waiting_mailbox.take_latest());
        assert!(
            mailbox.wait_for_coalesced_at_least(1, Duration::from_secs(1)),
            "resize worker did not observe and suppress the applied duplicate"
        );
        mailbox.close();
        assert!(worker.join().unwrap().is_none());
        let snapshot = mailbox.snapshot();
        assert_eq!(snapshot.applied, 1);
        assert!(snapshot.coalesced >= 1);
    }

    #[test]
    fn spawn_limiter_never_exceeds_two_concurrent_spawns() {
        let limiter = Arc::new(SpawnLimiter::default());
        let barrier = Arc::new(Barrier::new(17));
        let mut workers = Vec::new();
        for _ in 0..16 {
            let limiter = Arc::clone(&limiter);
            let barrier = Arc::clone(&barrier);
            workers.push(thread::spawn(move || {
                barrier.wait();
                let _permit = limiter.acquire().expect("spawn permit should be available");
                thread::sleep(Duration::from_millis(15));
            }));
        }
        barrier.wait();
        for worker in workers {
            worker.join().expect("spawn limiter worker should finish");
        }
        let snapshot = limiter.snapshot();
        assert_eq!(snapshot.active, 0);
        assert_eq!(snapshot.peak, MAX_CONCURRENT_SPAWNS);
    }

    #[test]
    fn global_output_budget_never_exceeds_its_limit() {
        let budget = Arc::new(GlobalOutputBudget::with_limit(8));
        let first = Arc::new(OutputFlow::with_limits(8, 8, Arc::clone(&budget)));
        let second = Arc::new(OutputFlow::with_limits(8, 8, Arc::clone(&budget)));
        assert!(first.reserve(0, 8));

        let waiting = Arc::clone(&second);
        let (done_sender, done_receiver) = mpsc::sync_channel(1);
        let worker = thread::spawn(move || {
            let _ = done_sender.send(waiting.reserve(0, 1));
        });
        assert!(
            done_receiver
                .recv_timeout(Duration::from_millis(50))
                .is_err()
        );
        let saturated = budget.snapshot();
        assert_eq!(saturated.bytes, 8);
        assert!(saturated.peak <= 8);

        first.acknowledge(0);
        assert!(
            done_receiver
                .recv_timeout(Duration::from_secs(1))
                .expect("global ACK should release shared budget")
        );
        second.acknowledge(0);
        worker.join().expect("global budget worker should finish");
        let finished = budget.snapshot();
        assert_eq!(finished.bytes, 0);
        assert!(finished.peak <= 8);
    }

    struct FailingSink;

    impl TerminalEventSink for FailingSink {
        fn send(&self, _event: TerminalEvent) -> Result<(), String> {
            Err("channel closed".to_owned())
        }
    }

    #[derive(Default)]
    struct DropAfterStartedSink {
        started: AtomicBool,
    }

    impl TerminalEventSink for DropAfterStartedSink {
        fn send(&self, event: TerminalEvent) -> Result<(), String> {
            if matches!(event, TerminalEvent::Started { .. }) {
                self.started.store(true, Ordering::Release);
                Ok(())
            } else {
                Err("simulated WebView channel drop".to_owned())
            }
        }
    }

    #[derive(Default)]
    struct RecordingAbort(AtomicBool);

    impl TerminalAbortSignal for RecordingAbort {
        fn abort_after_sink_failure(&self) {
            self.0.store(true, Ordering::Release);
        }
    }

    #[test]
    fn output_sink_failure_requests_session_abort() {
        let (raw_sender, raw_receiver) = mpsc::sync_channel(2);
        let (start_sender, start_receiver) = mpsc::sync_channel(1);
        let (done_sender, done_receiver) = mpsc::sync_channel(1);
        let budget = Arc::new(GlobalOutputBudget::with_limit(1024));
        let flow = Arc::new(OutputFlow::with_limits(4, 1024, budget));
        let abort = Arc::new(RecordingAbort::default());
        let abort_signal: Arc<dyn TerminalAbortSignal> = abort.clone();

        let worker = thread::spawn(move || {
            run_output_dispatcher(
                "sink-failure".to_owned(),
                raw_receiver,
                start_receiver,
                done_sender,
                Arc::new(FailingSink),
                flow,
                abort_signal,
            );
        });
        start_sender.send(true).unwrap();
        raw_sender
            .send(ReaderMessage::Bytes(b"trigger".to_vec()))
            .unwrap();
        raw_sender.send(ReaderMessage::Eof).unwrap();
        done_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("dispatcher should stop after EOF");
        worker.join().expect("dispatcher should finish");
        assert!(abort.0.load(Ordering::Acquire));
    }

    #[cfg(windows)]
    #[test]
    fn failed_started_event_rolls_back_the_entire_session() {
        let manager = TerminalManager::default();
        let result = manager.start_with_sink(None, 80, 24, Arc::new(FailingSink));
        assert!(result.is_err());
        assert_eq!(manager.status().active_sessions, 0);
        assert_eq!(manager.status().spawning_sessions, 0);
        assert_eq!(manager.status().worker_threads, 0);
    }

    #[cfg(windows)]
    #[test]
    fn shutdown_waits_across_spawn_to_job_assignment_and_leaves_no_child() {
        let (spawned_sender, spawned_receiver) = mpsc::sync_channel(1);
        let (release_sender, release_receiver) = mpsc::sync_channel(1);
        let manager =
            TerminalManager::with_start_ownership_hook(Arc::new(BlockingStartOwnershipHook {
                spawned: spawned_sender,
                release: Mutex::new(release_receiver),
            }));
        let start_manager = manager.clone();
        let starter = thread::spawn(move || {
            start_manager.start_with_sink(None, 80, 24, Arc::new(RecordingSink::default()))
        });

        let observed_process = spawned_receiver.recv_timeout(Duration::from_secs(8));
        let process_id = match observed_process {
            Ok(process_id) => process_id,
            Err(error) => {
                let _ = release_sender.send(());
                let start_result = starter.join();
                panic!("did not reach the pre-ownership hook: {error}; start={start_result:?}");
            }
        };

        let shutdown_manager = manager.clone();
        let shutdown = thread::spawn(move || shutdown_manager.shutdown());
        let lifecycle_deadline = Instant::now() + Duration::from_secs(1);
        while manager.status().accepting_sessions && Instant::now() < lifecycle_deadline {
            thread::sleep(Duration::from_millis(2));
        }
        let lifecycle_closed = !manager.status().accepting_sessions;
        thread::sleep(Duration::from_millis(75));
        let shutdown_returned_before_ownership = shutdown.is_finished();

        release_sender
            .send(())
            .expect("pre-ownership hook should release");
        let start_result = starter.join().expect("starter should not panic");
        let shutdown_result = shutdown.join().expect("shutdown should not panic");

        assert!(lifecycle_closed, "shutdown did not close the start gate");
        assert!(
            !shutdown_returned_before_ownership,
            "shutdown returned while the child was still unowned"
        );
        assert!(start_result.is_err(), "racing start should be cancelled");
        shutdown_result.expect("shutdown barrier should complete");
        let process_id = process_id.expect("PowerShell should expose its process id");
        assert!(
            wait_for_process_exit(process_id, Duration::from_secs(5))
                .expect("test child process status should be readable"),
            "shutdown left PowerShell process {process_id} running"
        );
        let status = manager.status();
        assert_eq!(status.active_sessions, 0);
        assert_eq!(status.starting_sessions, 0);
        assert_eq!(status.spawning_sessions, 0);
        assert_eq!(status.worker_threads, 0);
    }

    #[cfg(windows)]
    #[test]
    fn dropped_webview_channel_terminates_a_real_session() {
        let manager = TerminalManager::default();
        let sink = Arc::new(DropAfterStartedSink::default());
        let response = manager
            .start_with_sink(None, 80, 24, sink.clone())
            .expect("Started event should be accepted");
        assert!(sink.started.load(Ordering::Acquire));

        let deadline = Instant::now() + Duration::from_secs(8);
        while manager.status().active_sessions != 0 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            manager.status().active_sessions,
            0,
            "dropped channel orphaned session {}",
            response.session_id
        );
        assert_eq!(manager.status().worker_threads, 0);
    }

    #[derive(Default)]
    struct RecordingSink {
        events: Mutex<Vec<TerminalEvent>>,
        changed: Condvar,
    }

    impl TerminalEventSink for RecordingSink {
        fn send(&self, event: TerminalEvent) -> Result<(), String> {
            let mut events = self.events.lock().unwrap();
            events.push(event);
            self.changed.notify_all();
            Ok(())
        }
    }

    impl RecordingSink {
        fn wait_for(
            &self,
            timeout: Duration,
            predicate: impl Fn(&[TerminalEvent]) -> bool,
        ) -> bool {
            let deadline = Instant::now() + timeout;
            let mut events = self.events.lock().unwrap();
            loop {
                if predicate(&events) {
                    return true;
                }
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return false;
                }
                let (next_events, result) = self.changed.wait_timeout(events, remaining).unwrap();
                events = next_events;
                if result.timed_out() && !predicate(&events) {
                    return false;
                }
            }
        }

        fn snapshot(&self) -> Vec<TerminalEvent> {
            self.events.lock().unwrap().clone()
        }
    }

    #[cfg(windows)]
    #[test]
    fn round_trips_korean_through_real_conpty() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 100,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("ConPTY should be available on supported Windows versions");
        let mut reader = pair
            .master
            .try_clone_reader()
            .expect("ConPTY reader should open");
        let mut writer = pair
            .master
            .take_writer()
            .expect("ConPTY writer should open");

        let mut command = CommandBuilder::new(resolve_powershell());
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-Command",
            "$utf8 = New-Object System.Text.UTF8Encoding($false); [Console]::InputEncoding = $utf8; [Console]::OutputEncoding = $utf8; $line = [Console]::In.ReadLine(); [Console]::WriteLine('__IHC__' + $line)",
        ]);
        let mut child = pair
            .slave
            .spawn_command(command)
            .expect("PowerShell should start in ConPTY");
        drop(pair.slave);

        let (terminal_event_sender, terminal_event_receiver) = mpsc::sync_channel(2);
        let reader_thread = thread::spawn(move || {
            let mut bytes = Vec::new();
            let mut buffer = [0_u8; 4 * 1024];
            let mut reported_status_query = false;
            let mut reported_ready = false;
            loop {
                let length = reader
                    .read(&mut buffer)
                    .expect("ConPTY output should be readable");
                if length == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..length]);
                if !reported_status_query && bytes.windows(4).any(|part| part == b"\x1b[6n") {
                    reported_status_query = true;
                    let _ = terminal_event_sender.send("status-query");
                }
                if !reported_ready && bytes.windows(6).any(|part| part == b"\x1b[?25h") {
                    reported_ready = true;
                    let _ = terminal_event_sender.send("ready");
                }
            }
            bytes
        });

        let source = "우리가 실험용 한글을 확인합니다";
        assert_eq!(
            terminal_event_receiver
                .recv_timeout(Duration::from_secs(5))
                .expect("ConPTY should request terminal status"),
            "status-query"
        );
        write_bytes(&mut writer, b"\x1b[1;1R").expect("status response should write");
        assert_eq!(
            terminal_event_receiver
                .recv_timeout(Duration::from_secs(5))
                .expect("PowerShell should finish terminal initialization"),
            "ready"
        );
        for byte in source.as_bytes() {
            write_bytes(&mut writer, &[*byte]).expect("split UTF-8 should write");
        }
        write_bytes(&mut writer, b"\r\n").expect("line ending should write");

        child.wait().expect("PowerShell should exit normally");
        drop(writer);
        drop(pair.master);
        let bytes = reader_thread.join().expect("reader should finish");
        let output = String::from_utf8_lossy(&bytes);
        assert!(
            output.contains(&format!("__IHC__{source}")),
            "ConPTY did not preserve Korean input: {output:?}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn starts_marks_and_stops_twenty_real_sessions_without_leaks() {
        let manager = TerminalManager::default();
        let sink = Arc::new(RecordingSink::default());
        let barrier = Arc::new(Barrier::new(MAX_TERMINAL_SESSIONS + 1));
        let mut starters = Vec::new();

        for _ in 0..MAX_TERMINAL_SESSIONS {
            let manager = manager.clone();
            let sink: Arc<dyn TerminalEventSink> = sink.clone();
            let barrier = Arc::clone(&barrier);
            starters.push(thread::spawn(move || {
                barrier.wait();
                manager.start_with_sink(None, 100, 24, sink)
            }));
        }
        barrier.wait();

        let mut responses = Vec::new();
        for starter in starters {
            responses.push(
                starter
                    .join()
                    .expect("terminal starter should not panic")
                    .expect("all twenty sessions should start"),
            );
        }

        let ids = responses
            .iter()
            .map(|response| response.session_id.clone())
            .collect::<HashSet<_>>();
        assert_eq!(ids.len(), MAX_TERMINAL_SESSIONS);
        let status = manager.status();
        assert_eq!(status.active_sessions, MAX_TERMINAL_SESSIONS);
        assert!(status.peak_concurrent_spawns <= MAX_CONCURRENT_SPAWNS);
        assert_eq!(status.peak_concurrent_spawns, MAX_CONCURRENT_SPAWNS);

        for response in &responses {
            let session_id = &response.session_id;
            let saw_query = sink.wait_for(Duration::from_secs(5), |events| {
                events.iter().any(|event| {
                    matches!(
                        event,
                        TerminalEvent::Output { session_id: id, data, .. }
                            if id == session_id && data.contains("\u{1b}[6n")
                    )
                })
            });
            assert!(saw_query, "session {session_id} did not initialize");
            manager.write(session_id, b"\x1b[1;1R").unwrap();
            let marker = format!("__IHC_STRESS_{}__", &session_id[..8]);
            manager
                .write(
                    session_id,
                    format!("Write-Output '{marker}'\r\n").as_bytes(),
                )
                .unwrap();
            assert!(
                sink.wait_for(Duration::from_secs(5), |events| {
                    events.iter().any(|event| {
                        matches!(
                            event,
                            TerminalEvent::Output { session_id: id, data, .. }
                                if id == session_id && data.contains(&marker)
                        )
                    })
                }),
                "session {session_id} did not emit its marker"
            );
        }

        for session_id in &ids {
            manager.stop(session_id).unwrap();
        }
        assert!(
            sink.wait_for(Duration::from_secs(15), |events| {
                events
                    .iter()
                    .filter_map(|event| match event {
                        TerminalEvent::Exited { session_id, .. } => Some(session_id),
                        _ => None,
                    })
                    .collect::<HashSet<_>>()
                    .len()
                    == MAX_TERMINAL_SESSIONS
            }),
            "all sessions should emit exactly one terminal exit path"
        );

        let events = sink.snapshot();
        for session_id in &ids {
            let exit_positions = events
                .iter()
                .enumerate()
                .filter_map(|(index, event)| match event {
                    TerminalEvent::Exited { session_id: id, .. } if id == session_id => Some(index),
                    _ => None,
                })
                .collect::<Vec<_>>();
            assert_eq!(exit_positions.len(), 1, "one Exited event per session");
            let exit_position = exit_positions[0];
            assert!(events[exit_position + 1..].iter().all(|event| {
                !matches!(
                    event,
                    TerminalEvent::Output { session_id: id, .. }
                        | TerminalEvent::Error { session_id: id, .. }
                        if id == session_id
                )
            }));

            let sequences = events[..exit_position]
                .iter()
                .filter_map(|event| match event {
                    TerminalEvent::Output {
                        session_id: id,
                        sequence,
                        ..
                    } if id == session_id => Some(*sequence),
                    _ => None,
                })
                .collect::<Vec<_>>();
            assert!(
                sequences
                    .iter()
                    .enumerate()
                    .all(|(expected, actual)| *actual == expected as u64),
                "output sequence must be contiguous for {session_id}: {sequences:?}"
            );
            let reported_last = match &events[exit_position] {
                TerminalEvent::Exited { last_sequence, .. } => *last_sequence,
                _ => unreachable!(),
            };
            assert_eq!(reported_last, sequences.last().copied());
        }

        let final_status = manager.status();
        assert_eq!(final_status.active_sessions, 0);
        assert_eq!(final_status.pending_output_bytes, 0);
        assert_eq!(final_status.worker_threads, 0);
    }

    #[test]
    fn status_reports_starts_as_active() {
        let manager = TerminalManager::default();
        let reservations = (0..3)
            .map(|_| manager.reserve_start().unwrap())
            .collect::<Vec<_>>();
        let status = manager.status();
        assert_eq!(status.active_sessions, 3);
        assert_eq!(status.starting_sessions, 3);
        assert_eq!(status.max_sessions, 20);
        drop(reservations);
    }

    #[test]
    fn preview_pane_count_defaults_within_public_limit() {
        assert!((1..=MAX_TERMINAL_SESSIONS as u8).contains(&phase2_initial_panes()));
    }

    #[test]
    fn terminal_event_json_uses_the_frontend_camel_case_contract() {
        let value = serde_json::to_value(TerminalEvent::Exited {
            session_id: "session-1".to_owned(),
            exit_code: Some(0),
            last_sequence: Some(7),
        })
        .expect("terminal event should serialize");

        assert_eq!(value["event"], "exited");
        assert_eq!(value["data"]["sessionId"], "session-1");
        assert_eq!(value["data"]["exitCode"], 0);
        assert_eq!(value["data"]["lastSequence"], 7);
        assert!(value["data"].get("session_id").is_none());
        assert!(value["data"].get("exit_code").is_none());
        assert!(value["data"].get("last_sequence").is_none());
    }
}
