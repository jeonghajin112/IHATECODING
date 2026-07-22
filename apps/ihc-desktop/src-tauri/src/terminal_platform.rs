use crate::agent_runtime::AgentProvider;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fmt;

const CF_BITMAP_FORMAT: u32 = 2;
const CF_TIFF_FORMAT: u32 = 6;
const CF_DIB_FORMAT: u32 = 8;
const CF_UNICODE_TEXT_FORMAT: u32 = 13;
const CF_HDROP_FORMAT: u32 = 15;
const CF_DIBV5_FORMAT: u32 = 17;
const REGISTERED_CLIPBOARD_FORMAT_MIN: u32 = 0xC000;
const MAX_CLIPBOARD_FORMATS: usize = 4_096;
const MAX_CLIPBOARD_FILES: u32 = 4_096;
const MAX_CLIPBOARD_PATH_UTF16_UNITS: u32 = 32_768;
const MAX_CLIPBOARD_TEXT_BYTES: usize = 8 * 1024 * 1024;
const CLIPBOARD_OPEN_ATTEMPTS: usize = 4;
const CLIPBOARD_OPEN_RETRY_DELAY_MS: u64 = 12;
const MAX_PROCESS_TREE_DEPTH: usize = 12;
const MAX_PROCESS_SNAPSHOT_ENTRIES: usize = 50_000;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum ClipboardSnapshot {
    Image,
    Text { text: String },
    Empty,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ClipboardSnapshotError {
    Unavailable,
    FormatReadFailed,
    DataReadFailed,
    TextTooLarge,
    InvalidText,
    #[cfg(not(windows))]
    Unsupported,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ClipboardWriteError {
    Unavailable,
    ClearFailed,
    AllocationFailed,
    DataWriteFailed,
    TextTooLarge,
    InvalidText,
    InvalidOwner,
    #[cfg(not(windows))]
    Unsupported,
}

impl fmt::Display for ClipboardSnapshotError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Unavailable => "Windows clipboard is temporarily unavailable.",
            Self::FormatReadFailed => "Clipboard formats could not be read.",
            Self::DataReadFailed => "Clipboard data could not be read.",
            Self::TextTooLarge => "Clipboard text is too large to paste.",
            Self::InvalidText => "Clipboard text is not valid Unicode text.",
            #[cfg(not(windows))]
            Self::Unsupported => "Native clipboard snapshots are unavailable on this platform.",
        })
    }
}

impl fmt::Display for ClipboardWriteError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Unavailable => "Windows clipboard is temporarily unavailable.",
            Self::ClearFailed => "Windows clipboard could not be prepared for copying.",
            Self::AllocationFailed => "Clipboard text memory could not be allocated.",
            Self::DataWriteFailed => "Clipboard text could not be copied.",
            Self::TextTooLarge => "The selected terminal text is too large to copy.",
            Self::InvalidText => {
                "The selected terminal text contains an unsupported null character."
            }
            Self::InvalidOwner => "The clipboard owner window is unavailable.",
            #[cfg(not(windows))]
            Self::Unsupported => "Native clipboard writes are unavailable on this platform.",
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ProcessRecord {
    process_id: u32,
    parent_process_id: u32,
    executable_name: String,
}

pub(crate) fn read_clipboard_snapshot() -> Result<ClipboardSnapshot, ClipboardSnapshotError> {
    read_clipboard_snapshot_platform()
}

pub(crate) fn write_clipboard_text(
    owner_window: usize,
    text: &str,
) -> Result<(), ClipboardWriteError> {
    let encoded = encode_clipboard_unicode_text(text)?;
    write_clipboard_text_platform(owner_window, &encoded)
}

pub(crate) fn detect_terminal_agent(root_process_id: u32) -> Option<AgentProvider> {
    detect_terminal_agent_platform(root_process_id)
}

pub(crate) fn terminal_process_tree_ids(root_process_id: u32) -> HashSet<u32> {
    process_tree_ids(root_process_id, &process_snapshot_platform())
}

fn classify_agent_process_name(process_name: &str) -> Option<AgentProvider> {
    let file_name = process_name
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(process_name);
    if file_name.eq_ignore_ascii_case("codex.exe") {
        return Some(AgentProvider::Codex);
    }
    let lower = file_name.to_ascii_lowercase();
    if lower.starts_with("grok") && lower.ends_with(".exe") {
        return Some(AgentProvider::Grok);
    }
    None
}

fn clipboard_format_is_image(format: u32, registered_name: Option<&str>) -> bool {
    matches!(
        format,
        CF_BITMAP_FORMAT | CF_TIFF_FORMAT | CF_DIB_FORMAT | CF_DIBV5_FORMAT
    ) || registered_name.is_some_and(registered_clipboard_format_is_image)
}

fn registered_clipboard_format_is_image(format_name: &str) -> bool {
    matches!(
        format_name.trim().to_ascii_lowercase().as_str(),
        "png"
            | "image/png"
            | "jpeg"
            | "image/jpeg"
            | "image/jpg"
            | "jfif"
            | "image/webp"
            | "image/gif"
            | "image/tiff"
    )
}

fn clipboard_file_is_image(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [
        ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff",
    ]
    .iter()
    .any(|extension| lower.ends_with(extension))
}

fn validate_clipboard_text_byte_len(byte_len: usize) -> Result<usize, ClipboardSnapshotError> {
    if byte_len > MAX_CLIPBOARD_TEXT_BYTES {
        return Err(ClipboardSnapshotError::TextTooLarge);
    }
    if byte_len == 0 || !byte_len.is_multiple_of(std::mem::size_of::<u16>()) {
        return Err(ClipboardSnapshotError::DataReadFailed);
    }
    Ok(byte_len / std::mem::size_of::<u16>())
}

fn decode_clipboard_unicode_text(
    units: &[u16],
) -> Result<ClipboardSnapshot, ClipboardSnapshotError> {
    let end = units
        .iter()
        .position(|unit| *unit == 0)
        .ok_or(ClipboardSnapshotError::InvalidText)?;
    if end == 0 {
        return Ok(ClipboardSnapshot::Empty);
    }
    let text =
        String::from_utf16(&units[..end]).map_err(|_| ClipboardSnapshotError::InvalidText)?;
    Ok(ClipboardSnapshot::Text { text })
}

fn encode_clipboard_unicode_text(text: &str) -> Result<Vec<u16>, ClipboardWriteError> {
    // Reserve one UTF-16 unit for the CF_UNICODETEXT terminator. Build the buffer
    // incrementally so an oversized IPC value cannot trigger another unbounded allocation.
    let max_text_units = MAX_CLIPBOARD_TEXT_BYTES
        .checked_div(std::mem::size_of::<u16>())
        .and_then(|units| units.checked_sub(1))
        .ok_or(ClipboardWriteError::TextTooLarge)?;
    let mut encoded = Vec::with_capacity(text.len().min(max_text_units).saturating_add(1));
    for unit in text.encode_utf16() {
        if unit == 0 {
            return Err(ClipboardWriteError::InvalidText);
        }
        if encoded.len() >= max_text_units {
            return Err(ClipboardWriteError::TextTooLarge);
        }
        encoded.push(unit);
    }
    encoded.push(0);
    Ok(encoded)
}

fn detect_agent_in_processes(
    root_process_id: u32,
    processes: &[ProcessRecord],
) -> Option<AgentProvider> {
    let mut children = HashMap::<u32, Vec<&ProcessRecord>>::new();
    for process in processes {
        children
            .entry(process.parent_process_id)
            .or_default()
            .push(process);
    }

    let mut current_level = vec![root_process_id];
    let mut visited = HashSet::from([root_process_id]);
    for _ in 0..MAX_PROCESS_TREE_DEPTH {
        if current_level.is_empty() {
            break;
        }
        let mut next_level = Vec::new();
        let mut found_codex = false;
        let mut found_grok = false;
        for parent_process_id in current_level {
            let Some(entries) = children.get(&parent_process_id) else {
                continue;
            };
            for process in entries {
                match classify_agent_process_name(&process.executable_name) {
                    Some(AgentProvider::Grok) => found_grok = true,
                    Some(AgentProvider::Codex) => found_codex = true,
                    None => {}
                }
                if visited.insert(process.process_id) {
                    next_level.push(process.process_id);
                }
            }
        }
        if found_grok {
            return Some(AgentProvider::Grok);
        }
        if found_codex {
            return Some(AgentProvider::Codex);
        }
        current_level = next_level;
    }
    None
}

fn process_tree_ids(root_process_id: u32, processes: &[ProcessRecord]) -> HashSet<u32> {
    let mut children = HashMap::<u32, Vec<u32>>::new();
    for process in processes {
        children
            .entry(process.parent_process_id)
            .or_default()
            .push(process.process_id);
    }
    let mut current_level = vec![root_process_id];
    let mut visited = HashSet::from([root_process_id]);
    for _ in 0..MAX_PROCESS_TREE_DEPTH {
        if current_level.is_empty() {
            break;
        }
        let mut next_level = Vec::new();
        for parent_process_id in current_level {
            let Some(entries) = children.get(&parent_process_id) else {
                continue;
            };
            for process_id in entries {
                if visited.insert(*process_id) {
                    next_level.push(*process_id);
                }
            }
        }
        current_level = next_level;
    }
    visited
}

#[cfg(windows)]
fn read_clipboard_snapshot_platform() -> Result<ClipboardSnapshot, ClipboardSnapshotError> {
    use std::ptr::null_mut;
    use windows_sys::Win32::{
        Foundation::{GetLastError, SetLastError},
        System::DataExchange::{
            CloseClipboard, EnumClipboardFormats, GetClipboardData, GetClipboardFormatNameW,
            OpenClipboard,
        },
        System::Memory::{GlobalLock, GlobalSize, GlobalUnlock},
        UI::Shell::DragQueryFileW,
    };

    struct ClipboardGuard;
    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            // SAFETY: This guard is created only after OpenClipboard succeeds on this thread.
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }

    let mut opened = false;
    for attempt in 0..CLIPBOARD_OPEN_ATTEMPTS {
        // SAFETY: A null owner is explicitly supported. No clipboard handle escapes this function.
        if unsafe { OpenClipboard(null_mut()) } != 0 {
            opened = true;
            break;
        }
        if attempt + 1 < CLIPBOARD_OPEN_ATTEMPTS {
            std::thread::sleep(std::time::Duration::from_millis(
                CLIPBOARD_OPEN_RETRY_DELAY_MS,
            ));
        }
    }
    if !opened {
        return Err(ClipboardSnapshotError::Unavailable);
    }
    let _guard = ClipboardGuard;
    let mut format = 0;
    let mut has_file_drop = false;
    let mut has_unicode_text = false;
    let mut enumeration_finished = false;
    for _ in 0..MAX_CLIPBOARD_FORMATS {
        // SAFETY: The clipboard is open and format is either zero or a value returned by Win32.
        unsafe { SetLastError(0) };
        format = unsafe { EnumClipboardFormats(format) };
        if format == 0 {
            // SAFETY: EnumClipboardFormats documents ERROR_SUCCESS as the normal end marker.
            if unsafe { GetLastError() } != 0 {
                return Err(ClipboardSnapshotError::FormatReadFailed);
            }
            enumeration_finished = true;
            break;
        }
        if format == CF_HDROP_FORMAT {
            has_file_drop = true;
            continue;
        }
        if format == CF_UNICODE_TEXT_FORMAT {
            has_unicode_text = true;
            continue;
        }
        let registered_name = if format >= REGISTERED_CLIPBOARD_FORMAT_MIN {
            let mut buffer = [0_u16; 256];
            // SAFETY: buffer is writable for its declared length and remains alive for the call.
            let length = unsafe {
                GetClipboardFormatNameW(format, buffer.as_mut_ptr(), buffer.len() as i32)
            };
            if length <= 0 {
                return Err(ClipboardSnapshotError::FormatReadFailed);
            }
            Some(String::from_utf16_lossy(&buffer[..length as usize]))
        } else {
            None
        };
        if clipboard_format_is_image(format, registered_name.as_deref()) {
            return Ok(ClipboardSnapshot::Image);
        }
    }

    if !enumeration_finished {
        return Err(ClipboardSnapshotError::FormatReadFailed);
    }

    if has_file_drop {
        // SAFETY: The clipboard remains open and the returned handle stays owned by the clipboard.
        let drop_handle = unsafe { GetClipboardData(CF_HDROP_FORMAT) };
        if drop_handle.is_null() {
            return Err(ClipboardSnapshotError::DataReadFailed);
        }
        // SAFETY: CF_HDROP guarantees an HDROP-compatible handle while the clipboard is open.
        let file_count = unsafe { DragQueryFileW(drop_handle, u32::MAX, null_mut(), 0) };
        if file_count > MAX_CLIPBOARD_FILES {
            return Err(ClipboardSnapshotError::DataReadFailed);
        }
        for index in 0..file_count {
            // SAFETY: Querying with a null buffer returns the required UTF-16 character count.
            let length = unsafe { DragQueryFileW(drop_handle, index, null_mut(), 0) };
            if length == 0 {
                continue;
            }
            if length > MAX_CLIPBOARD_PATH_UTF16_UNITS {
                return Err(ClipboardSnapshotError::DataReadFailed);
            }
            let mut buffer = vec![0_u16; length as usize + 1];
            // SAFETY: The buffer includes room for the trailing null and is valid for the call.
            let written = unsafe {
                DragQueryFileW(drop_handle, index, buffer.as_mut_ptr(), buffer.len() as u32)
            };
            if written == 0 {
                return Err(ClipboardSnapshotError::DataReadFailed);
            }
            if clipboard_file_is_image(&String::from_utf16_lossy(&buffer[..written as usize])) {
                return Ok(ClipboardSnapshot::Image);
            }
        }
    }

    if !has_unicode_text {
        return Ok(ClipboardSnapshot::Empty);
    }

    // SAFETY: CF_UNICODETEXT is backed by a global-memory handle owned by the open clipboard.
    let text_handle = unsafe { GetClipboardData(CF_UNICODE_TEXT_FORMAT) };
    if text_handle.is_null() {
        return Err(ClipboardSnapshotError::DataReadFailed);
    }
    // SAFETY: The clipboard owns this valid HGLOBAL for the duration of the open clipboard.
    let byte_len = unsafe { GlobalSize(text_handle) };
    let unit_len = validate_clipboard_text_byte_len(byte_len)?;
    // SAFETY: GlobalLock returns a stable pointer while the clipboard remains open and locked.
    let text_pointer = unsafe { GlobalLock(text_handle) };
    if text_pointer.is_null() {
        return Err(ClipboardSnapshotError::DataReadFailed);
    }
    struct GlobalUnlockGuard(windows_sys::Win32::Foundation::HGLOBAL);
    impl Drop for GlobalUnlockGuard {
        fn drop(&mut self) {
            // SAFETY: This guard exists only after GlobalLock succeeded for the same HGLOBAL.
            unsafe {
                let _ = GlobalUnlock(self.0);
            }
        }
    }
    let _unlock_guard = GlobalUnlockGuard(text_handle);
    // SAFETY: GlobalSize bounded the allocation, the pointer is locked, and u16 is the documented
    // element type for CF_UNICODETEXT.
    let units = unsafe { std::slice::from_raw_parts(text_pointer.cast::<u16>(), unit_len) };
    decode_clipboard_unicode_text(units)
}

#[cfg(not(windows))]
fn read_clipboard_snapshot_platform() -> Result<ClipboardSnapshot, ClipboardSnapshotError> {
    Err(ClipboardSnapshotError::Unsupported)
}

#[cfg(windows)]
fn write_clipboard_text_platform(
    owner_window: usize,
    encoded: &[u16],
) -> Result<(), ClipboardWriteError> {
    use std::ptr::copy_nonoverlapping;
    use windows_sys::Win32::{
        Foundation::{GlobalFree, HGLOBAL},
        System::{
            DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData},
            Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock},
        },
    };

    if owner_window == 0 {
        return Err(ClipboardWriteError::InvalidOwner);
    }
    let byte_len = encoded
        .len()
        .checked_mul(std::mem::size_of::<u16>())
        .filter(|length| *length <= MAX_CLIPBOARD_TEXT_BYTES)
        .ok_or(ClipboardWriteError::TextTooLarge)?;

    // SetClipboardData requires GMEM_MOVEABLE storage and takes ownership only on success.
    // Keep an armed guard until then so every failure path releases the allocation.
    let allocation = unsafe { GlobalAlloc(GMEM_MOVEABLE, byte_len) };
    if allocation.is_null() {
        return Err(ClipboardWriteError::AllocationFailed);
    }
    struct GlobalAllocationGuard(Option<HGLOBAL>);
    impl GlobalAllocationGuard {
        fn release(&mut self) {
            self.0 = None;
        }
    }
    impl Drop for GlobalAllocationGuard {
        fn drop(&mut self) {
            if let Some(allocation) = self.0.take() {
                // SAFETY: The guard is disarmed as soon as SetClipboardData accepts ownership.
                unsafe {
                    let _ = GlobalFree(allocation);
                }
            }
        }
    }
    let mut allocation_guard = GlobalAllocationGuard(Some(allocation));
    let destination = unsafe { GlobalLock(allocation) }.cast::<u16>();
    if destination.is_null() {
        return Err(ClipboardWriteError::AllocationFailed);
    }
    // SAFETY: GlobalAlloc reserved byte_len bytes, encoded occupies exactly byte_len bytes,
    // and the allocation remains locked for this non-overlapping copy.
    unsafe {
        copy_nonoverlapping(encoded.as_ptr(), destination, encoded.len());
        let _ = GlobalUnlock(allocation);
    }

    let owner = owner_window as windows_sys::Win32::Foundation::HWND;
    let mut opened = false;
    for attempt in 0..CLIPBOARD_OPEN_ATTEMPTS {
        // SAFETY: owner is the live main Tauri window and no clipboard handle escapes this call.
        if unsafe { OpenClipboard(owner) } != 0 {
            opened = true;
            break;
        }
        if attempt + 1 < CLIPBOARD_OPEN_ATTEMPTS {
            std::thread::sleep(std::time::Duration::from_millis(
                CLIPBOARD_OPEN_RETRY_DELAY_MS,
            ));
        }
    }
    if !opened {
        return Err(ClipboardWriteError::Unavailable);
    }
    struct ClipboardGuard;
    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            // SAFETY: This guard is created only after OpenClipboard succeeds on this thread.
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }
    let _clipboard_guard = ClipboardGuard;

    // EmptyClipboard makes the window passed to OpenClipboard the current owner.
    if unsafe { EmptyClipboard() } == 0 {
        return Err(ClipboardWriteError::ClearFailed);
    }
    // SAFETY: allocation is unlocked GMEM_MOVEABLE memory containing terminated UTF-16 text.
    // A non-null return transfers allocation ownership to the system clipboard.
    if unsafe { SetClipboardData(CF_UNICODE_TEXT_FORMAT, allocation) }.is_null() {
        return Err(ClipboardWriteError::DataWriteFailed);
    }
    allocation_guard.release();
    Ok(())
}

#[cfg(not(windows))]
fn write_clipboard_text_platform(
    _owner_window: usize,
    _encoded: &[u16],
) -> Result<(), ClipboardWriteError> {
    Err(ClipboardWriteError::Unsupported)
}

#[cfg(windows)]
fn detect_terminal_agent_platform(root_process_id: u32) -> Option<AgentProvider> {
    detect_agent_in_processes(root_process_id, &process_snapshot_platform())
}

#[cfg(windows)]
fn process_snapshot_platform() -> Vec<ProcessRecord> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
            TH32CS_SNAPPROCESS,
        },
    };

    struct SnapshotGuard(windows_sys::Win32::Foundation::HANDLE);
    impl Drop for SnapshotGuard {
        fn drop(&mut self) {
            // SAFETY: The guard owns a valid snapshot handle.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    // SAFETY: The flags request a read-only system process snapshot.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Vec::new();
    }
    let _guard = SnapshotGuard(snapshot);
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    // SAFETY: entry has the required size and snapshot remains valid for the enumeration.
    if unsafe { Process32FirstW(snapshot, &mut entry) } == 0 {
        return Vec::new();
    }
    let mut processes = Vec::new();
    loop {
        let name_length = entry
            .szExeFile
            .iter()
            .position(|character| *character == 0)
            .unwrap_or(entry.szExeFile.len());
        processes.push(ProcessRecord {
            process_id: entry.th32ProcessID,
            parent_process_id: entry.th32ParentProcessID,
            executable_name: String::from_utf16_lossy(&entry.szExeFile[..name_length]),
        });
        if processes.len() >= MAX_PROCESS_SNAPSHOT_ENTRIES {
            break;
        }
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        // SAFETY: entry and snapshot remain valid; zero also denotes normal end of enumeration.
        if unsafe { Process32NextW(snapshot, &mut entry) } == 0 {
            break;
        }
    }
    processes
}

#[cfg(not(windows))]
fn detect_terminal_agent_platform(_root_process_id: u32) -> Option<AgentProvider> {
    None
}

#[cfg(not(windows))]
fn process_snapshot_platform() -> Vec<ProcessRecord> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_process_names_are_classified_case_insensitively_and_narrowly() {
        assert_eq!(
            classify_agent_process_name("C:\\Tools\\CODEX.EXE"),
            Some(AgentProvider::Codex)
        );
        assert_eq!(
            classify_agent_process_name("grok-0.2.93.EXE"),
            Some(AgentProvider::Grok)
        );
        assert_eq!(
            classify_agent_process_name("grokPreview.exe"),
            Some(AgentProvider::Grok)
        );
        assert_eq!(
            classify_agent_process_name("grok.exe"),
            Some(AgentProvider::Grok)
        );
        assert_eq!(classify_agent_process_name("codex-helper.exe"), None);
        assert_eq!(classify_agent_process_name("grok.ps1"), None);
    }

    #[test]
    fn process_tree_detection_is_bounded_to_descendants_and_prefers_nearest_grok() {
        let processes = vec![
            ProcessRecord {
                process_id: 2,
                parent_process_id: 1,
                executable_name: "cmd.exe".to_owned(),
            },
            ProcessRecord {
                process_id: 3,
                parent_process_id: 2,
                executable_name: "codex.exe".to_owned(),
            },
            ProcessRecord {
                process_id: 4,
                parent_process_id: 2,
                executable_name: "grok-1.0.exe".to_owned(),
            },
            ProcessRecord {
                process_id: 99,
                parent_process_id: 98,
                executable_name: "codex.exe".to_owned(),
            },
        ];
        assert_eq!(
            detect_agent_in_processes(1, &processes),
            Some(AgentProvider::Grok)
        );
        assert_eq!(
            detect_agent_in_processes(98, &processes),
            Some(AgentProvider::Codex)
        );
        assert_eq!(detect_agent_in_processes(50, &processes), None);
        assert_eq!(process_tree_ids(1, &processes), HashSet::from([1, 2, 3, 4]));
        assert_eq!(process_tree_ids(98, &processes), HashSet::from([98, 99]));
    }

    #[test]
    fn clipboard_image_formats_and_file_extensions_match_windows_sources() {
        for format in [
            CF_BITMAP_FORMAT,
            CF_TIFF_FORMAT,
            CF_DIB_FORMAT,
            CF_DIBV5_FORMAT,
        ] {
            assert!(clipboard_format_is_image(format, None));
        }
        assert!(!clipboard_format_is_image(CF_HDROP_FORMAT, None));
        for name in [
            "PNG",
            "image/png",
            "IMAGE/JPEG",
            "JFIF",
            "image/webp",
            "image/gif",
            "image/tiff",
        ] {
            assert!(clipboard_format_is_image(0xC001, Some(name)));
        }
        assert!(!clipboard_format_is_image(0xC001, Some("text/html")));
        assert!(clipboard_file_is_image(r"C:\\capture.JPG"));
        assert!(clipboard_file_is_image("screen.webp"));
        assert!(!clipboard_file_is_image("notes.txt"));
    }

    #[test]
    fn clipboard_snapshot_wire_contract_is_tagged_and_text_is_not_logged_in_errors() {
        assert_eq!(
            serde_json::to_value(ClipboardSnapshot::Image).expect("serialize image snapshot"),
            serde_json::json!({ "kind": "image" })
        );
        assert_eq!(
            serde_json::to_value(ClipboardSnapshot::Text {
                text: "한글 clipboard".to_owned(),
            })
            .expect("serialize text snapshot"),
            serde_json::json!({ "kind": "text", "text": "한글 clipboard" })
        );
        assert_eq!(
            serde_json::to_value(ClipboardSnapshot::Empty).expect("serialize empty snapshot"),
            serde_json::json!({ "kind": "empty" })
        );
        assert_eq!(
            ClipboardSnapshotError::Unavailable.to_string(),
            "Windows clipboard is temporarily unavailable."
        );
        let sensitive_sample = "C:\\Users\\someone\\private-project\\secret.txt";
        for error in [
            ClipboardSnapshotError::Unavailable,
            ClipboardSnapshotError::FormatReadFailed,
            ClipboardSnapshotError::DataReadFailed,
            ClipboardSnapshotError::TextTooLarge,
            ClipboardSnapshotError::InvalidText,
        ] {
            assert!(!error.to_string().contains(sensitive_sample));
        }
    }

    #[test]
    fn unicode_clipboard_text_is_bounded_decoded_and_empty_aware() {
        assert_eq!(
            validate_clipboard_text_byte_len(MAX_CLIPBOARD_TEXT_BYTES),
            Ok(MAX_CLIPBOARD_TEXT_BYTES / std::mem::size_of::<u16>())
        );
        assert_eq!(
            validate_clipboard_text_byte_len(MAX_CLIPBOARD_TEXT_BYTES + 2),
            Err(ClipboardSnapshotError::TextTooLarge)
        );
        assert_eq!(
            validate_clipboard_text_byte_len(0),
            Err(ClipboardSnapshotError::DataReadFailed)
        );
        assert_eq!(
            validate_clipboard_text_byte_len(3),
            Err(ClipboardSnapshotError::DataReadFailed)
        );

        let mut korean = "한글".encode_utf16().collect::<Vec<_>>();
        korean.extend([0, u16::from(b'x')]);
        assert_eq!(
            decode_clipboard_unicode_text(&korean),
            Ok(ClipboardSnapshot::Text {
                text: "한글".to_owned()
            })
        );
        assert_eq!(
            decode_clipboard_unicode_text(&[0]),
            Ok(ClipboardSnapshot::Empty)
        );
        assert_eq!(
            decode_clipboard_unicode_text(&[u16::from(b'x')]),
            Err(ClipboardSnapshotError::InvalidText)
        );
        assert_eq!(
            decode_clipboard_unicode_text(&[0xD800, 0]),
            Err(ClipboardSnapshotError::InvalidText)
        );
    }

    #[test]
    fn unicode_clipboard_write_is_terminated_bounded_and_rejects_interior_nulls() {
        assert_eq!(
            encode_clipboard_unicode_text("한글 😀\nterminal").unwrap(),
            "한글 😀\nterminal\0".encode_utf16().collect::<Vec<_>>()
        );
        assert_eq!(encode_clipboard_unicode_text("").unwrap(), vec![0]);
        assert_eq!(
            encode_clipboard_unicode_text("private\0project"),
            Err(ClipboardWriteError::InvalidText)
        );

        let max_units = MAX_CLIPBOARD_TEXT_BYTES / std::mem::size_of::<u16>() - 1;
        let maximum = "x".repeat(max_units);
        assert_eq!(
            encode_clipboard_unicode_text(&maximum).unwrap().len(),
            max_units + 1
        );
        let too_large = "x".repeat(max_units + 1);
        assert_eq!(
            encode_clipboard_unicode_text(&too_large),
            Err(ClipboardWriteError::TextTooLarge)
        );
    }

    #[test]
    fn clipboard_write_errors_never_include_selected_terminal_text() {
        let sensitive_sample = "C:\\Users\\someone\\private-project\\secret.txt";
        let errors = [
            ClipboardWriteError::Unavailable,
            ClipboardWriteError::ClearFailed,
            ClipboardWriteError::AllocationFailed,
            ClipboardWriteError::DataWriteFailed,
            ClipboardWriteError::TextTooLarge,
            ClipboardWriteError::InvalidText,
            ClipboardWriteError::InvalidOwner,
        ];
        for error in errors {
            assert!(!error.to_string().contains(sensitive_sample));
            assert!(!format!("{error:?}").contains(sensitive_sample));
        }
    }
}
