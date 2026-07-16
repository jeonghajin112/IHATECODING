use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use std::{
    collections::HashMap,
    env,
    io::{Read, Write},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    thread,
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "event", content = "data")]
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
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartTerminalResponse {
    pub(crate) session_id: String,
    pub(crate) process_id: Option<u32>,
}

struct TerminalSession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    terminator: ProcessTerminator,
}

#[derive(Clone, Default)]
pub(crate) struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, Arc<TerminalSession>>>>,
}

impl TerminalManager {
    pub(crate) fn start(
        &self,
        cwd: Option<String>,
        columns: u16,
        rows: u16,
        on_event: Channel<TerminalEvent>,
    ) -> Result<StartTerminalResponse, String> {
        let cwd = validate_working_directory(cwd)?;
        let size = normalized_size(columns, rows);
        let pair = native_pty_system()
            .openpty(size)
            .map_err(|error| format!("ConPTY 생성 실패: {error}"))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("ConPTY 출력 연결 실패: {error}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("ConPTY 입력 연결 실패: {error}"))?;

        let mut command = CommandBuilder::new(resolve_powershell());
        command.args(["-NoLogo", "-NoExit"]);
        if let Some(directory) = &cwd {
            command.cwd(directory);
        }

        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("PowerShell 실행 실패: {error}"))?;
        let process_id = child.process_id();
        let terminator = match ProcessTerminator::from_child(child.as_ref()) {
            Ok(terminator) => terminator,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        drop(pair.slave);

        let session_id = Uuid::new_v4().simple().to_string();
        let session = Arc::new(TerminalSession {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            terminator,
        });

        let output_id = session_id.clone();
        let output_channel = on_event.clone();
        let (output_start_sender, output_start_receiver) = std::sync::mpsc::sync_channel(1);
        let (output_done_sender, output_done_receiver) = std::sync::mpsc::sync_channel(1);
        let output_thread = match thread::Builder::new()
            .name(format!("ihc-pty-output-{output_id}"))
            .spawn(move || {
                if output_start_receiver.recv() != Ok(true) {
                    return;
                }
                let mut decoder = Utf8StreamDecoder::default();
                let sequence = AtomicU64::new(0);
                let mut buffer = [0_u8; 16 * 1024];

                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => {
                            let tail = decoder.finish();
                            if !tail.is_empty() {
                                send_output(&output_channel, &output_id, &sequence, tail);
                            }
                            break;
                        }
                        Ok(length) => {
                            let text = decoder.push(&buffer[..length]);
                            if !text.is_empty() {
                                send_output(&output_channel, &output_id, &sequence, text);
                            }
                        }
                        Err(error) => {
                            let _ = output_channel.send(TerminalEvent::Error {
                                session_id: output_id.clone(),
                                message: format!("ConPTY 출력 읽기 실패: {error}"),
                            });
                            break;
                        }
                    }
                }
                let _ = output_done_sender.send(());
            }) {
            Ok(thread) => thread,
            Err(error) => return Err(format!("출력 스레드 시작 실패: {error}")),
        };

        let wait_id = session_id.clone();
        let wait_channel = on_event.clone();
        let sessions = Arc::clone(&self.sessions);
        let (wait_start_sender, wait_start_receiver) = std::sync::mpsc::sync_channel(1);
        let wait_thread = match thread::Builder::new()
            .name(format!("ihc-pty-wait-{wait_id}"))
            .spawn(move || {
                if wait_start_receiver.recv() != Ok(true) {
                    return;
                }
                let result = child.wait();
                let exit_code = result.as_ref().ok().map(|status| status.exit_code());
                match sessions.lock() {
                    Ok(mut sessions) => {
                        sessions.remove(&wait_id);
                    }
                    Err(poisoned) => {
                        poisoned.into_inner().remove(&wait_id);
                    }
                }
                if output_done_receiver.recv().is_err() {
                    let _ = wait_channel.send(TerminalEvent::Error {
                        session_id: wait_id.clone(),
                        message: "ConPTY output thread stopped before draining output".to_owned(),
                    });
                }
                if let Err(error) = result {
                    let _ = wait_channel.send(TerminalEvent::Error {
                        session_id: wait_id.clone(),
                        message: format!("PowerShell 종료 대기 실패: {error}"),
                    });
                }
                let _ = wait_channel.send(TerminalEvent::Exited {
                    session_id: wait_id.clone(),
                    exit_code,
                });
            }) {
            Ok(thread) => thread,
            Err(error) => {
                let _ = output_start_sender.send(false);
                let _ = session.terminator.terminate();
                drop(session);
                let _ = output_thread.join();
                return Err(format!("종료 감시 스레드 시작 실패: {error}"));
            }
        };

        let registration = self.sessions.lock().map(|mut sessions| {
            sessions.insert(session_id.clone(), Arc::clone(&session));
        });
        if registration.is_err() {
            let _ = output_start_sender.send(false);
            let _ = wait_start_sender.send(false);
            let _ = session.terminator.terminate();
            drop(session);
            let _ = output_thread.join();
            let _ = wait_thread.join();
            return Err("터미널 상태 잠금이 손상되었습니다.".to_owned());
        }

        if let Err(error) = on_event.send(TerminalEvent::Started {
            session_id: session_id.clone(),
            process_id,
        }) {
            if let Ok(mut sessions) = self.sessions.lock() {
                sessions.remove(&session_id);
            }
            let _ = output_start_sender.send(false);
            let _ = wait_start_sender.send(false);
            let _ = session.terminator.terminate();
            drop(session);
            let _ = output_thread.join();
            let _ = wait_thread.join();
            return Err(format!("터미널 시작 이벤트 전송 실패: {error}"));
        }

        let output_started = output_start_sender.send(true);
        let wait_started = wait_start_sender.send(true);
        if output_started.is_err() || wait_started.is_err() {
            if let Ok(mut sessions) = self.sessions.lock() {
                sessions.remove(&session_id);
            }
            let _ = session.terminator.terminate();
            drop(session);
            let _ = output_thread.join();
            let _ = wait_thread.join();
            return Err("터미널 작업 스레드를 시작하지 못했습니다.".to_owned());
        }

        drop(output_thread);
        drop(wait_thread);

        Ok(StartTerminalResponse {
            session_id,
            process_id,
        })
    }

    pub(crate) fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        if data.is_empty() {
            return Ok(());
        }
        let session = self.session(session_id)?;
        let mut writer = lock(&session.writer)?;
        writer
            .write_all(data)
            .and_then(|_| writer.flush())
            .map_err(|error| format!("터미널 입력 실패: {error}"))
    }

    pub(crate) fn resize(&self, session_id: &str, columns: u16, rows: u16) -> Result<(), String> {
        let session = self.session(session_id)?;
        lock(&session.master)?
            .resize(normalized_size(columns, rows))
            .map_err(|error| format!("터미널 크기 변경 실패: {error}"))
    }

    pub(crate) fn stop(&self, session_id: &str) -> Result<(), String> {
        let session = lock(&self.sessions)?.remove(session_id);
        let Some(session) = session else {
            return Ok(());
        };
        session.terminator.terminate()
    }

    pub(crate) fn stop_all(&self) {
        let sessions = match self.sessions.lock() {
            Ok(mut guard) => std::mem::take(&mut *guard),
            Err(_) => return,
        };
        for session in sessions.into_values() {
            let _ = session.terminator.terminate();
        }
    }

    fn session(&self, session_id: &str) -> Result<Arc<TerminalSession>, String> {
        lock(&self.sessions)?
            .get(session_id)
            .cloned()
            .ok_or_else(|| "터미널 세션을 찾을 수 없습니다.".to_owned())
    }
}

#[cfg(windows)]
struct ProcessTerminator {
    job: OwnedHandle,
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

        Ok(Self { job })
    }

    fn terminate(&self) -> Result<(), String> {
        let terminated = unsafe { TerminateJobObject(self.job.as_raw_handle(), 1) };
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
        .map_err(|_| "터미널 상태 잠금이 손상되었습니다.".to_owned())
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
        return Err("지정한 작업 폴더를 찾을 수 없습니다.".to_owned());
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

fn send_output(
    channel: &Channel<TerminalEvent>,
    session_id: &str,
    sequence: &AtomicU64,
    data: String,
) {
    let _ = channel.send(TerminalEvent::Output {
        session_id: session_id.to_owned(),
        sequence: sequence.fetch_add(1, Ordering::Relaxed),
        data,
    });
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

#[cfg(test)]
mod tests {
    use super::Utf8StreamDecoder;

    #[cfg(windows)]
    use super::resolve_powershell;
    #[cfg(windows)]
    use portable_pty::{CommandBuilder, PtySize, native_pty_system};
    #[cfg(windows)]
    use std::{
        io::{Read, Write},
        sync::mpsc,
        thread,
        time::Duration,
    };

    #[test]
    fn preserves_korean_split_across_chunks() {
        let source = "우리가 실험용 터미널을 확인합니다.".as_bytes();
        let mut decoder = Utf8StreamDecoder::default();
        let mut output = String::new();
        for byte in source {
            output.push_str(&decoder.push(&[*byte]));
        }
        output.push_str(&decoder.finish());
        assert_eq!(output, "우리가 실험용 터미널을 확인합니다.");
    }

    #[test]
    fn replaces_invalid_utf8_without_losing_neighbors() {
        let mut decoder = Utf8StreamDecoder::default();
        let mut output = decoder.push(b"left\xffright");
        output.push_str(&decoder.finish());
        assert_eq!(output, "left\u{fffd}right");
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
            "$line = [Console]::In.ReadLine(); [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); [Console]::WriteLine('__IHC__' + $line)",
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
        writer
            .write_all(b"\x1b[1;1R")
            .expect("terminal status response should be writable");
        writer
            .flush()
            .expect("terminal status response should flush");
        assert_eq!(
            terminal_event_receiver
                .recv_timeout(Duration::from_secs(5))
                .expect("PowerShell should finish terminal initialization"),
            "ready"
        );
        for byte in source.as_bytes() {
            writer
                .write_all(&[*byte])
                .expect("split UTF-8 input should be writable");
        }
        writer.write_all(b"\r\n").expect("line ending should write");
        writer.flush().expect("ConPTY input should flush");

        child.wait().expect("PowerShell should exit normally");
        drop(writer);
        drop(pair.master);
        let bytes = reader_thread.join().expect("reader thread should finish");
        let output = String::from_utf8_lossy(&bytes);
        assert!(
            output.contains(&format!("__IHC__{source}")),
            "ConPTY did not preserve Korean input: {output:?}"
        );
    }
}
