//! Manual verification harness for the native window-enumeration capability.
//!
//!   cargo run --example enumerate
//!
//! Prints the real top-level windows the `list_running_apps` command returns,
//! exercising the Win32 EnumWindows path without a WebView. Windows only.

fn main() {
    #[cfg(windows)]
    {
        let apps = contextos_lib::enumerate_windows_for_example();
        println!("Enumerated {} top-level windows:", apps.len());
        for a in apps.iter().take(20) {
            println!(
                "  [{}] \"{}\" exe={} bounds=({},{} {}x{}) elevated={}",
                a.monitor, a.window_title, a.executable, a.x, a.y, a.w, a.h, a.elevated
            );
        }
    }
    #[cfg(not(windows))]
    {
        println!("window enumeration is Windows-only");
    }
}
