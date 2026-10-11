//! The pinned llama.cpp build (ADR 0016).
//!
//! One official build, named and hashed here: ggml-org/llama.cpp release
//! b11541, the Windows x64 Vulkan package. It runs on any GPU with a Vulkan
//! driver and falls back to the CPU. It is downloaded once, on the user's
//! click, from that release; the archive must match its SHA-256 before
//! anything is unpacked, and each runtime file must match its own SHA-256
//! before every start. A file that does not match is never run.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};

use futures_util::StreamExt;
use sha2::{Digest, Sha256};

use super::error::LocalEngineError;

pub const BUILD: &str = "b11541";
pub const COMMIT: &str = "f2918cabb";
pub const ASSET_NAME: &str = "llama-b11541-bin-win-vulkan-x64.zip";
pub const ASSET_URL: &str = "https://github.com/ggml-org/llama.cpp/releases/download/b11541/llama-b11541-bin-win-vulkan-x64.zip";
pub const ASSET_SHA256: &str = "37bba511d120222f13c3d520dd875f739a530cc124e78f7cbce0026de0173d8a";
pub const ASSET_SIZE: u64 = 33_464_528;
pub const SERVER_EXE: &str = "llama-server.exe";

/// The files the server needs, and the SHA-256 each must have. Measured
/// from the pinned archive (2026-10-10); the archive's other programs are
/// not unpacked.
pub const RUNTIME_FILES: &[(&str, &str)] = &[
    (
        "llama-server.exe",
        "3126ac987ba10c6ac8f0bfd911b74fe07a372833de214e5c677d651b8a359f8a",
    ),
    (
        "llama-server-impl.dll",
        "7d318dde316e33d9300552992db895f68ba294975df04150c81b1258d7e3363f",
    ),
    (
        "llama-common.dll",
        "a0de53be1af1163fef996e26ce9af4de74199733e2ddae0d9ed3904ec5ee72bb",
    ),
    (
        "llama.dll",
        "1cc496b95394f2fa718ab77a83f5bf64163c5ae718e024022ddf9656dc864a43",
    ),
    (
        "mtmd.dll",
        "42bc9fcb44eb6c593c2b8b4e3578ce691b6d590d7ebdec3dd8a6fb60ac98879c",
    ),
    (
        "ggml.dll",
        "7f989e4b412bb37c6fbd4560e65778875896296897eb85df62646dff1e354b70",
    ),
    (
        "ggml-base.dll",
        "4256e88c2c3c24895e94c87c4e5968f30f196d7aa292762a1f28a99547a11886",
    ),
    (
        "ggml-vulkan.dll",
        "902bbd151b4ce7829eeb816404d2736f825ed60c8aca0331548d425890f8f490",
    ),
    (
        "ggml-rpc.dll",
        "c9622f002be63868b13737a15baea823878f6719b829e5f20317d6426f7c54ee",
    ),
    (
        "libomp.dll",
        "a12116ba72d1d6820407cf30be23da04ce79d6bb8a71a5ee71759c5a1faa6f1c",
    ),
    (
        "ggml-cpu-alderlake.dll",
        "2136fad5df63ba8df1e4322cbe264e5ecc28d0b838d7d89a0fb106d6203d8ac0",
    ),
    (
        "ggml-cpu-cannonlake.dll",
        "941beee525e392aeee0048408fc8ed0193b15ed4f01be696f9e13c4b005dc1d2",
    ),
    (
        "ggml-cpu-cascadelake.dll",
        "a0bd14bf069a998ea32874f2d5f3fad324293a8140795305db9ae01a10e7fb01",
    ),
    (
        "ggml-cpu-cooperlake.dll",
        "34c0340d6c19002dd598704aa6bb2cd324779a9597f2a0287141b25aa25895fd",
    ),
    (
        "ggml-cpu-haswell.dll",
        "199804f41103c9cf0c1e98787a5b398052de1817891cdf0167a7e821c934302a",
    ),
    (
        "ggml-cpu-icelake.dll",
        "76710b6d2edb0b9872c4737485dc8b8d116426fca8f01e0b176adad3ef9c2c90",
    ),
    (
        "ggml-cpu-ivybridge.dll",
        "902e07819659a93f50b78605fa3e8ed9e904979bf8a75eb1b0ef481648625af2",
    ),
    (
        "ggml-cpu-piledriver.dll",
        "5da106c34b8788ab81004b61216b5305bd124a4e02a44df5269a4c176d96bec3",
    ),
    (
        "ggml-cpu-sandybridge.dll",
        "439dcdeb0ddc2709cbccdabc75f84cdffd3365c11240e927f82ccbca3029d0eb",
    ),
    (
        "ggml-cpu-sapphirerapids.dll",
        "434b7673cefa5525583b93f5edc638019b4ccf8c9d2534bb70bc69c4658cbc6c",
    ),
    (
        "ggml-cpu-skylakex.dll",
        "8676deed08b612a713e3bfdc6d926abf1b3690a7eb466df49c4c6a08f5997435",
    ),
    (
        "ggml-cpu-sse42.dll",
        "9dc9f6e91e78deab8e6ffa7e0fcfb850a37af7640bd2f4f04e25684a4f991383",
    ),
    (
        "ggml-cpu-x64.dll",
        "48ffe29f1ab14114fc312699e7ed20c1b7e5369a0b66026933e15a06a85a1c09",
    ),
    (
        "ggml-cpu-zen4.dll",
        "57f228e9a8d5d3c76177f24f6d2f1034a0872bd97fd200af19963bd76d5f5d15",
    ),
    ("LICENSE-LLVM-OpenMP", ""),
];

/// Hosts a release download may be redirected through. The archive's hash
/// is what is trusted; this keeps the request on GitHub all the same.
const DOWNLOAD_HOSTS: [&str; 4] = [
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "github-releases.githubusercontent.com",
];

/// The folder this build lives in: `<engine root>/llama-b11541`.
pub fn install_dir(engine_root: &Path) -> PathBuf {
    engine_root.join(format!("llama-{BUILD}"))
}

pub fn server_exe(engine_root: &Path) -> PathBuf {
    install_dir(engine_root).join(SERVER_EXE)
}

pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        digest.update(&buf[..n]);
    }
    Ok(hex::encode(digest.finalize()))
}

/// Whether the build is unpacked; says nothing about its integrity.
pub fn is_installed(engine_root: &Path) -> bool {
    server_exe(engine_root).is_file()
}

/// Check every runtime file against its pinned hash. Run before each start.
pub fn verify_install(dir: &Path) -> Result<(), LocalEngineError> {
    verify_files(dir, RUNTIME_FILES)
}

fn verify_files(dir: &Path, files: &[(&str, &str)]) -> Result<(), LocalEngineError> {
    for (name, expected) in files {
        let path = dir.join(name);
        if !path.is_file() {
            return Err(LocalEngineError::EngineMissing);
        }
        if expected.is_empty() {
            continue;
        }
        let actual = sha256_file(&path).map_err(|_| LocalEngineError::EngineCorrupt)?;
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(LocalEngineError::EngineCorrupt);
        }
    }
    Ok(())
}

fn download_client() -> Result<reqwest::Client, LocalEngineError> {
    let policy = reqwest::redirect::Policy::custom(|attempt| {
        let allowed = attempt.url().scheme() == "https"
            && attempt
                .url()
                .host_str()
                .is_some_and(|host| DOWNLOAD_HOSTS.contains(&host));
        if attempt.previous().len() > 5 || !allowed {
            attempt.stop()
        } else {
            attempt.follow()
        }
    });
    reqwest::Client::builder()
        .use_rustls_tls()
        .redirect(policy)
        .connect_timeout(std::time::Duration::from_secs(15))
        .user_agent(concat!("QutraLabs/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| LocalEngineError::DownloadFailed)
}

/// How long the download may go without a single byte before it gives up.
/// The cancel flag is read between chunks, so a stalled connection would
/// otherwise keep it from ever being seen.
const CHUNK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// The next item of `stream`, or `DownloadFailed` when none comes within
/// `limit`.
async fn next_within<S>(
    stream: &mut S,
    limit: std::time::Duration,
) -> Result<Option<S::Item>, LocalEngineError>
where
    S: futures_util::Stream + Unpin,
{
    tokio::time::timeout(limit, stream.next())
        .await
        .map_err(|_| LocalEngineError::DownloadFailed)
}

/// Download the archive to `target`, refusing anything larger than the
/// pinned size or with another hash. `progress` hears bytes so far.
pub async fn download(
    target: &Path,
    progress: &(dyn Fn(u64) + Send + Sync),
    cancel: &AtomicBool,
) -> Result<(), LocalEngineError> {
    use std::io::Write;
    let response = download_client()?
        .get(ASSET_URL)
        .send()
        .await
        .map_err(|_| LocalEngineError::DownloadFailed)?;
    if !response.status().is_success() {
        return Err(LocalEngineError::DownloadFailed);
    }
    let mut file = std::fs::File::create(target).map_err(|_| LocalEngineError::Io)?;
    let mut digest = Sha256::new();
    let mut received = 0u64;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = next_within(&mut stream, CHUNK_TIMEOUT).await? {
        if cancel.load(Ordering::Relaxed) {
            return Err(LocalEngineError::Cancelled);
        }
        let chunk = chunk.map_err(|_| LocalEngineError::DownloadFailed)?;
        received += chunk.len() as u64;
        if received > ASSET_SIZE {
            return Err(LocalEngineError::DownloadHashMismatch);
        }
        digest.update(&chunk);
        file.write_all(&chunk).map_err(|_| LocalEngineError::Io)?;
        progress(received);
    }
    file.sync_all().map_err(|_| LocalEngineError::Io)?;
    if received != ASSET_SIZE || hex::encode(digest.finalize()) != ASSET_SHA256 {
        return Err(LocalEngineError::DownloadHashMismatch);
    }
    Ok(())
}

/// Windows' own `tar.exe` (bsdtar), by its full path. It unpacks zip
/// archives and refuses absolute paths and `..` in member names.
fn system_tar() -> PathBuf {
    let root = std::env::var_os("SystemRoot")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    root.join("System32").join("tar.exe")
}

/// Unpack only the runtime files from a verified archive into `staging`,
/// then check each against its pinned hash.
pub fn unpack(archive: &Path, staging: &Path) -> Result<(), LocalEngineError> {
    if sha256_file(archive).map_err(|_| LocalEngineError::Io)? != ASSET_SHA256 {
        return Err(LocalEngineError::DownloadHashMismatch);
    }
    std::fs::create_dir_all(staging).map_err(|_| LocalEngineError::Io)?;
    let mut command = Command::new(system_tar());
    command.arg("-xf").arg(archive).arg("-C").arg(staging);
    for (name, _) in RUNTIME_FILES {
        command.arg(name);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let status = command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|_| LocalEngineError::UnpackFailed)?;
    if !status.success() {
        return Err(LocalEngineError::UnpackFailed);
    }
    verify_install(staging).map_err(|_| LocalEngineError::UnpackFailed)
}

/// Download, verify and unpack the build into `<engine root>/llama-b11541`.
/// A half-done install never takes that name: it is unpacked next to it and
/// renamed at the end.
pub async fn install(
    engine_root: &Path,
    progress: &(dyn Fn(u64) + Send + Sync),
    cancel: &AtomicBool,
) -> Result<(), LocalEngineError> {
    std::fs::create_dir_all(engine_root).map_err(|_| LocalEngineError::Io)?;
    let archive = engine_root.join(format!("{ASSET_NAME}.partial"));
    let staging = engine_root.join(format!("llama-{BUILD}.staging"));
    let _ = std::fs::remove_dir_all(&staging);
    let outcome = async {
        download(&archive, progress, cancel).await?;
        if cancel.load(Ordering::Relaxed) {
            return Err(LocalEngineError::Cancelled);
        }
        let (archive, staging) = (archive.clone(), staging.clone());
        tokio::task::spawn_blocking(move || unpack(&archive, &staging))
            .await
            .map_err(|_| LocalEngineError::UnpackFailed)?
    }
    .await;
    let _ = std::fs::remove_file(&archive);
    if let Err(err) = outcome {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(err);
    }
    let dir = install_dir(engine_root);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::rename(&staging, &dir).map_err(|_| LocalEngineError::Io)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A download whose connection goes quiet fails after a limit instead of
    /// waiting, so a cancel is read; one that keeps sending is unaffected.
    #[tokio::test]
    async fn a_stalled_download_gives_up() {
        let limit = std::time::Duration::from_millis(50);
        let mut stalled = futures_util::stream::pending::<u8>();
        assert_eq!(
            next_within(&mut stalled, limit).await,
            Err(LocalEngineError::DownloadFailed)
        );
        let mut flowing = futures_util::stream::iter([1u8, 2]);
        assert_eq!(next_within(&mut flowing, limit).await, Ok(Some(1)));
        assert_eq!(next_within(&mut flowing, limit).await, Ok(Some(2)));
        assert_eq!(next_within(&mut flowing, limit).await, Ok(None));
    }

    #[test]
    fn the_pin_names_one_official_release_asset() {
        assert!(ASSET_URL.starts_with("https://github.com/ggml-org/llama.cpp/releases/download/"));
        assert!(ASSET_URL.ends_with(&format!("/{BUILD}/{ASSET_NAME}")));
        assert_eq!(ASSET_SHA256.len(), 64);
        assert!(RUNTIME_FILES.iter().any(|(name, _)| *name == SERVER_EXE));
        for (name, hash) in RUNTIME_FILES {
            assert!(!name.contains(['/', '\\']), "{name}");
            assert!(hash.is_empty() || hash.len() == 64, "{name}");
        }
    }

    #[test]
    fn a_runtime_file_that_changed_is_never_trusted() {
        let dir = tempfile::tempdir().unwrap();
        let files = [("a.dll", ""), ("b.exe", "")];
        assert_eq!(
            verify_files(dir.path(), &files),
            Err(LocalEngineError::EngineMissing)
        );
        std::fs::write(dir.path().join("a.dll"), b"one").unwrap();
        std::fs::write(dir.path().join("b.exe"), b"two").unwrap();
        let one = sha256_file(&dir.path().join("a.dll")).unwrap();
        let two = sha256_file(&dir.path().join("b.exe")).unwrap();
        let pinned = [("a.dll", one.as_str()), ("b.exe", two.as_str())];
        assert_eq!(verify_files(dir.path(), &pinned), Ok(()));
        std::fs::write(dir.path().join("b.exe"), b"tampered").unwrap();
        assert_eq!(
            verify_files(dir.path(), &pinned),
            Err(LocalEngineError::EngineCorrupt)
        );
    }

    #[test]
    fn an_archive_with_another_hash_is_not_unpacked() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("x.zip");
        std::fs::write(&archive, b"PK not the pinned archive").unwrap();
        let staging = dir.path().join("staging");
        assert_eq!(
            unpack(&archive, &staging),
            Err(LocalEngineError::DownloadHashMismatch)
        );
        assert!(!staging.exists());
    }

    #[test]
    fn the_unpacker_is_windows_own_tar_by_full_path() {
        let tar = system_tar();
        assert!(tar.is_absolute());
        assert!(tar.ends_with("System32/tar.exe") || tar.ends_with(r"System32\tar.exe"));
    }
}
