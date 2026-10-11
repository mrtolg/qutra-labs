//! Harmless native fixture used to verify Qutra Labs process supervision.
//!
//! Compile this file directly with `rustc`; do not ship the resulting binary.

use std::{
    env, fs,
    path::PathBuf,
    process::{self, Command},
    thread,
    time::Duration,
};

fn option(args: &[String], name: &str) -> Option<String> {
    args.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].clone())
}

fn number(args: &[String], name: &str, default: u64) -> u64 {
    option(args, name)
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(default)
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let mode = option(&args, "--mode").unwrap_or_else(|| "echo".into());

    match mode.as_str() {
        "echo" => {
            println!("fixture stdout");
            eprintln!("fixture stderr");
            for (index, value) in args.iter().enumerate() {
                println!("argv[{index}]={value}");
            }
        }
        "sleep" => {
            let millis = number(&args, "--ms", 30_000).min(300_000);
            println!("sleeping_ms={millis}");
            thread::sleep(Duration::from_millis(millis));
            println!("sleep_complete");
        }
        "spawn-child" => {
            let millis = number(&args, "--ms", 30_000).min(300_000);
            let executable = env::current_exe().expect("fixture executable path");
            let child = Command::new(executable)
                .args(["--mode", "child-sleep", "--ms", &millis.to_string()])
                .spawn()
                .expect("spawn harmless fixture child");
            println!("child_pid={}", child.id());
            thread::sleep(Duration::from_millis(millis));
        }
        "child-sleep" => {
            let millis = number(&args, "--ms", 30_000).min(300_000);
            println!("child_ready");
            thread::sleep(Duration::from_millis(millis));
        }
        "flood" => {
            let bytes = number(&args, "--bytes", 128 * 1024).min(16 * 1024 * 1024);
            let line = "x".repeat(1024);
            let mut written = 0;
            while written < bytes {
                println!("{line}");
                eprintln!("{line}");
                written += line.len() as u64 + 1;
            }
        }
        "exit" => {
            let code = number(&args, "--code", 7).min(255) as i32;
            eprintln!("exit_code={code}");
            process::exit(code);
        }
        "artifact" => {
            let path = option(&args, "--path")
                .map(PathBuf::from)
                .expect("--path is required for artifact mode");
            fs::write(&path, b"Qutra Labs synthetic fixture artifact\n")
                .expect("write synthetic fixture artifact");
            println!("artifact={}", path.display());
        }
        other => {
            eprintln!("unsupported fixture mode: {other}");
            process::exit(64);
        }
    }
}
