//! Win32 integration: window enumeration + repositioning.
//! Metadata only (titles, bounds, executables) — never window contents.

use crate::validation::clamp_bounds;
use crate::{RunningApp, WindowBoundsDto};
use windows::core::PWSTR;
use windows::Win32::Foundation::{BOOL, HANDLE, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, MonitorFromWindow, HDC, HMONITOR, MONITORINFO,
    MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::System::Threading::{
    OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowLongW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetWindowPos, ShowWindow, GWL_EXSTYLE,
    SWP_NOACTIVATE, SWP_NOZORDER, SW_RESTORE, WS_EX_TOOLWINDOW,
};

pub enum RepositionResult {
    Done,
    AccessDenied,
    WindowNotFound,
    Failed(String),
}

struct EnumState {
    windows: Vec<(HWND, u32, String)>, // hwnd, pid, title
}

unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let state = &mut *(lparam.0 as *mut EnumState);
    if !IsWindowVisible(hwnd).as_bool() {
        return BOOL(1);
    }
    let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    if ex_style & WS_EX_TOOLWINDOW.0 != 0 {
        return BOOL(1);
    }
    let len = GetWindowTextLengthW(hwnd);
    if len <= 0 {
        return BOOL(1);
    }
    let mut buf = vec![0u16; (len + 1) as usize];
    let read = GetWindowTextW(hwnd, &mut buf);
    if read <= 0 {
        return BOOL(1);
    }
    let title = String::from_utf16_lossy(&buf[..read as usize]);
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 {
        return BOOL(1);
    }
    state.windows.push((hwnd, pid, title));
    BOOL(1)
}

fn process_image_path(pid: u32) -> Option<String> {
    unsafe {
        let handle: HANDLE = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = vec![0u16; 1024];
        let mut size = buf.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut size,
        );
        let _ = windows::Win32::Foundation::CloseHandle(handle);
        result.ok()?;
        Some(String::from_utf16_lossy(&buf[..size as usize]))
    }
}

fn process_is_elevated(pid: u32) -> bool {
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            // Cannot even query — treat as elevated so we never overclaim.
            return true;
        };
        let mut token = HANDLE::default();
        let opened = OpenProcessToken(handle, TOKEN_QUERY, &mut token);
        let _ = windows::Win32::Foundation::CloseHandle(handle);
        if opened.is_err() {
            return true;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut ret = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut _),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut ret,
        );
        let _ = windows::Win32::Foundation::CloseHandle(token);
        if ok.is_err() {
            return true;
        }
        elevation.TokenIsElevated != 0
    }
}

fn monitor_index(hmon: HMONITOR) -> i32 {
    struct MonState {
        list: Vec<HMONITOR>,
    }
    unsafe extern "system" fn mon_proc(
        hmon: HMONITOR,
        _hdc: HDC,
        _rect: *mut RECT,
        lparam: LPARAM,
    ) -> BOOL {
        let state = &mut *(lparam.0 as *mut MonState);
        state.list.push(hmon);
        BOOL(1)
    }
    let mut state = MonState { list: Vec::new() };
    unsafe {
        let _ = EnumDisplayMonitors(
            HDC::default(),
            None,
            Some(mon_proc),
            LPARAM(&mut state as *mut _ as isize),
        );
    }
    state
        .list
        .iter()
        .position(|m| *m == hmon)
        .map(|i| i as i32)
        .unwrap_or(0)
}

/// Enumerate visible, titled, non-tool top-level windows.
pub fn enumerate_windows() -> Vec<RunningApp> {
    let mut state = EnumState {
        windows: Vec::new(),
    };
    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut state as *mut _ as isize));
    }
    let own_pid = std::process::id();
    let mut out = Vec::new();
    for (hwnd, pid, title) in state.windows {
        if pid == own_pid {
            continue;
        }
        let executable = process_image_path(pid).unwrap_or_default();
        let mut rect = RECT::default();
        unsafe {
            let _ = GetWindowRect(hwnd, &mut rect);
        }
        let hmon = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
        let name = std::path::Path::new(&executable)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| title.clone());
        out.push(RunningApp {
            name,
            executable,
            window_title: title,
            monitor: monitor_index(hmon),
            x: rect.left,
            y: rect.top,
            w: rect.right - rect.left,
            h: rect.bottom - rect.top,
            elevated: process_is_elevated(pid),
        });
    }
    out
}

fn find_main_window(pid: u32) -> Option<HWND> {
    let mut state = EnumState {
        windows: Vec::new(),
    };
    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut state as *mut _ as isize));
    }
    state
        .windows
        .into_iter()
        .find(|(_, wpid, _)| *wpid == pid)
        .map(|(hwnd, _, _)| hwnd)
}

fn work_area_for(hwnd: HWND) -> (i32, i32, i32, i32) {
    unsafe {
        let hmon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(hmon, &mut info).as_bool() {
            let r = info.rcWork;
            (r.left, r.top, r.right, r.bottom)
        } else {
            (0, 0, 1920, 1080)
        }
    }
}

/// Wait for a process to create its main window, then restore+reposition
/// it with bounds clamped into the current monitor work area.
pub fn reposition_process_window(
    pid: u32,
    bounds: &WindowBoundsDto,
    timeout_ms: u64,
) -> RepositionResult {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    let hwnd = loop {
        if let Some(h) = find_main_window(pid) {
            break h;
        }
        if std::time::Instant::now() >= deadline {
            return RepositionResult::WindowNotFound;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    };

    if process_is_elevated(pid) {
        return RepositionResult::AccessDenied;
    }

    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
    }
    // Monitor-topology fallback: clamp captured bounds into the work area
    // of whichever monitor the window is on now.
    let area = work_area_for(hwnd);
    let (x, y, w, h) = clamp_bounds(bounds.x, bounds.y, bounds.w, bounds.h, area);
    let result = unsafe {
        SetWindowPos(
            hwnd,
            HWND::default(),
            x,
            y,
            w,
            h,
            SWP_NOZORDER | SWP_NOACTIVATE,
        )
    };
    match result {
        Ok(()) => RepositionResult::Done,
        Err(e) => {
            if e.code() == windows::Win32::Foundation::E_ACCESSDENIED {
                RepositionResult::AccessDenied
            } else {
                RepositionResult::Failed(e.message().to_string())
            }
        }
    }
}

/// Takes the lock that keeps a second copy of the app from running: a named
/// mutex that lives until the process ends. `false` when another copy holds
/// it. Two copies would each load, then rewrite, the same JSON stores in the
/// app data folder, and the later write would drop the other's changes.
/// When the lock cannot be asked for at all the app starts: refusing to run
/// is the worse mistake.
pub fn acquire_instance_lock(name: &str) -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
    use windows::Win32::System::Threading::CreateMutexW;

    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: `wide` is NUL-terminated and outlives the call.
    let handle = unsafe { CreateMutexW(None, false, PCWSTR(wide.as_ptr())) };
    match handle {
        Ok(handle) => {
            // SAFETY: read straight after the call that set it.
            if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
                unsafe {
                    let _ = CloseHandle(handle);
                }
                false
            } else {
                // Held on purpose until the process ends.
                true
            }
        }
        Err(_) => true,
    }
}

/// Brings the window titled `title` (the running copy's) to the front.
pub fn focus_window_titled(title: &str) {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, SetForegroundWindow};

    let wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: `wide` is NUL-terminated and outlives the call.
    unsafe {
        if let Ok(hwnd) = FindWindowW(PCWSTR::null(), PCWSTR(wide.as_ptr())) {
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            let _ = SetForegroundWindow(hwnd);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_copy_does_not_get_the_lock() {
        let name = format!("Local\\qutra-labs-test-{}", std::process::id());
        assert!(acquire_instance_lock(&name), "the first copy takes it");
        assert!(!acquire_instance_lock(&name), "the second finds it taken");
    }
}
