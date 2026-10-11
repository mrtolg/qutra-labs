# Builds the NSIS installer from this checkout and installs it per-user, so
# the "Qutra Labs" entry in the Start menu runs exactly this commit.
#
#   npm run install:local             # refuses while Qutra Labs is running
#   npm run install:local -- -Force   # closes the running app first
#                                     # (its live terminal sessions end)
#
# Settings -> About then shows the commit the build came from
# (src/lib/buildInfo.ts). App data is never touched: install and uninstall
# both leave %APPDATA%\app.contextos.desktop alone.
#
# Run it from a normal terminal (Windows Terminal). It refuses to run
# where AppData writes are virtualized, because the install would land in
# another app's private store instead of the real Start menu.

param([switch]$Force)

$ErrorActionPreference = "Stop"
$appRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $appRoot

$installDir = Join-Path $env:LOCALAPPDATA "Qutra Labs"
$installedExe = Join-Path $installDir "Qutra Labs.exe"

# 0. Some sandboxed hosts virtualize AppData: they run their shells so
#    that new folders under %LOCALAPPDATA% land in a private package store.
#    An install from there "succeeds" but the real Start menu never runs it.
#    Measure it directly rather than trusting an API: create a folder and see
#    whether it appeared inside a package's LocalCache.
$probe = "qutra-install-probe-$PID"
$probePath = Join-Path $env:LOCALAPPDATA $probe
[void](New-Item -ItemType Directory -Path $probePath)
$redirectedTo = @(Get-ChildItem (Join-Path $env:LOCALAPPDATA "Packages") -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "LocalCache\Local\$probe") } |
    ForEach-Object { $_.Name })
Remove-Item -LiteralPath $probePath -Recurse -Force
if ($redirectedTo.Count -gt 0) {
    Write-Host "INSTALL STOP: this shell's AppData writes are redirected into $($redirectedTo -join ', '). Run npm run install:local from a normal terminal (Windows Terminal)."
    exit 1
}

# Cargo honours CARGO_TARGET_DIR (a sandboxed shell sets it to a cache folder),
# so the build does not always land in src-tauri\target.
$targetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $appRoot "src-tauri\target" }
if (-not [System.IO.Path]::IsPathRooted($targetDir)) { $targetDir = Join-Path $appRoot "src-tauri\$targetDir" }
$builtExe = Join-Path $targetDir "release\Qutra Labs.exe"
$bundleDir = Join-Path $targetDir "release\bundle\nsis"

# 1. Never replace the binary under a running app.
$running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $installedExe })
if ($running.Count -gt 0) {
    if (-not $Force) {
        Write-Host "INSTALL STOP: Qutra Labs is running (PID $($running.Id -join ', ')). Close it, or rerun with -Force to close it (its live terminal sessions end)."
        exit 1
    }
    $running | Stop-Process -Force
    $running | ForEach-Object { [void]$_.WaitForExit(10000) }
}

$commit = (git rev-parse --short=12 HEAD).Trim()
# Same rule as vite.config.ts: e2e screenshots are rewritten by every gate run
# and are not part of the build.
$dirty = [bool](git status --porcelain --untracked-files=no -- . ":(exclude)e2e/screenshots")
$label = if ($dirty) { "$commit-dirty" } else { $commit }
Write-Host "Building $label ..."

# 2. Build. vcvars is loaded into this process only; nothing after the
#    build here needs the Node PATH that vcvars can truncate.
. (Join-Path $PSScriptRoot "msvc-env.ps1")
$buildStart = (Get-Date).AddSeconds(-2)
cmd.exe /c "npx tauri build --bundles nsis"
if ($LASTEXITCODE -ne 0) {
    Write-Host "INSTALL FAIL: tauri build exited $LASTEXITCODE"
    exit 1
}

$installer = Get-ChildItem -LiteralPath $bundleDir -Filter "*-setup.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
# A stale installer from an earlier build must never be installed as if it
# were this one: both the exe and the installer must postdate this build.
if (-not $installer -or $installer.LastWriteTime -lt $buildStart -or
    -not (Test-Path -LiteralPath $builtExe) -or (Get-Item -LiteralPath $builtExe).LastWriteTime -lt $buildStart) {
    Write-Host "INSTALL FAIL: the build left no new installer and exe under $targetDir. Is CARGO_TARGET_DIR pointing somewhere else?"
    exit 1
}

# 3. Install silently for the current user.
$proc = Start-Process -FilePath $installer.FullName -ArgumentList "/S" -Wait -PassThru
if ($proc.ExitCode -ne 0) {
    Write-Host "INSTALL FAIL: installer exited $($proc.ExitCode)"
    exit 1
}

# 4. Prove the Start-menu binary is the one just built. Tauri stamps the
#    bundle type into the exe it packs (__TAURI_BUNDLE_TYPE_VAR_NSS) and
#    resets the copy in target\ to _UNK afterwards, so the two files differ
#    in exactly those three bytes. Hash both with the marker normalised.
function Get-NormalizedExeHash([string]$Path) {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $latin1 = [System.Text.Encoding]::GetEncoding(28591)
    $text = $latin1.GetString($bytes)
    $marker = "__TAURI_BUNDLE_TYPE_VAR_"
    $unk = $latin1.GetBytes("UNK")
    $at = $text.IndexOf($marker, [System.StringComparison]::Ordinal)
    while ($at -ge 0) {
        [Array]::Copy($unk, 0, $bytes, $at + $marker.Length, 3)
        $at = $text.IndexOf($marker, $at + $marker.Length, [System.StringComparison]::Ordinal)
    }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "")
}
$builtHash = Get-NormalizedExeHash $builtExe
$installedHash = Get-NormalizedExeHash $installedExe
if ($builtHash -ne $installedHash) {
    Write-Host "INSTALL FAIL: installed exe ($installedHash) differs from the build ($builtHash)"
    exit 1
}

# 5. Start shows one entry per AppUserModelID. Any other shortcut carrying
#    this app's id (an old ContextOS install) hides "Qutra Labs" from search.
$programs = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$shell = New-Object -ComObject Shell.Application
$folder = $shell.Namespace($programs)
$ours = $folder.ParseName("Qutra Labs.lnk")
if (-not $ours) {
    Write-Host "INSTALL FAIL: no Qutra Labs shortcut in $programs"
    exit 1
}
# A shortcut that exists can still open an older copy somewhere else.
$target = (New-Object -ComObject WScript.Shell).CreateShortcut($ours.Path).TargetPath
$want = [System.IO.Path]::GetFullPath($installedExe)
if (-not $target -or [System.IO.Path]::GetFullPath($target) -ne $want) {
    Write-Host "INSTALL FAIL: the Qutra Labs shortcut opens '$target', not the verified exe '$want'"
    exit 1
}
$aumid = $ours.ExtendedProperty("System.AppUserModel.ID")
$rivals = @(Get-ChildItem -LiteralPath $programs -Filter "*.lnk" -Recurse |
    Where-Object { $_.Name -ne "Qutra Labs.lnk" } |
    Where-Object {
        $item = $shell.Namespace($_.DirectoryName).ParseName($_.Name)
        $item -and $item.ExtendedProperty("System.AppUserModel.ID") -eq $aumid
    })
if ($rivals.Count -gt 0) {
    Write-Host "INSTALL WARN: these shortcuts share AppUserModelID $aumid and can hide Qutra Labs in Start:"
    $rivals | ForEach-Object { Write-Host "  $($_.FullName)" }
}

Write-Host "INSTALLED $label -> $installedExe (normalised sha256 $installedHash, built in $targetDir)"
Write-Host "Settings -> About should show build $label"
