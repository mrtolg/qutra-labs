# One-command gate. Run from QutraApp via `npm run gate`.
# Prints a pass/fail summary with real counts. Exit 1 if any step fails.
# Continues after a red step so the summary is complete.
#
# MSVC/vcvars is loaded only in a child process for the cargo step. Node
# steps keep this process's PATH, so nested `cmd /c` can still find npm,
# node and vite. Applying vcvars to the whole gate was how `node` vanished
# mid-run and the gate went red for an environmental reason.

$ErrorActionPreference = "Continue"

$AppRoot = Split-Path -Parent $PSScriptRoot
Set-Location $AppRoot

if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    Write-Host "GATE FAIL: npm.cmd is not on PATH"
    exit 1
}

# A sandboxed shell injects PLAYWRIGHT_BROWSERS_PATH into a per-session sandbox cache.
# A new session does not have that tree, so e2e fails with a missing
# chrome-headless-shell.exe. Pin to a stable machine path and install
# Chromium there when it is absent. Respect an explicit non-sandbox path.
function Resolve-PlaywrightBrowsersPath {
    $current = $env:PLAYWRIGHT_BROWSERS_PATH
    if ($current -and $current -ne "0" -and ($current -notlike "*sandbox-cache*")) {
        return $current
    }
    $root = $env:LOCALAPPDATA
    if (-not $root) { $root = $env:USERPROFILE }
    return (Join-Path $root "qutra-playwright")
}

function Test-PlaywrightChromiumPresent {
    param([string]$BrowsersRoot)
    if (-not (Test-Path -LiteralPath $BrowsersRoot)) { return $false }
    $dirs = Get-ChildItem -LiteralPath $BrowsersRoot -Directory -ErrorAction SilentlyContinue
    foreach ($dir in $dirs) {
        if ($dir.Name -notlike "chromium*") { continue }
        $marker = Join-Path $dir.FullName "INSTALLATION_COMPLETE"
        if (Test-Path -LiteralPath $marker) { return $true }
    }
    return $false
}

function Ensure-PlaywrightChromium {
    $env:PLAYWRIGHT_BROWSERS_PATH = Resolve-PlaywrightBrowsersPath
    Write-Host "PLAYWRIGHT_BROWSERS_PATH=$($env:PLAYWRIGHT_BROWSERS_PATH)"
    if (Test-PlaywrightChromiumPresent $env:PLAYWRIGHT_BROWSERS_PATH) {
        return 0
    }
    Write-Host "Playwright Chromium missing; installing into $($env:PLAYWRIGHT_BROWSERS_PATH)"
    $npx = (Get-Command npx.cmd -ErrorAction SilentlyContinue).Source
    if (-not $npx) {
        Write-Host "GATE FAIL: npx.cmd is not on PATH"
        return 1
    }
    # npx.cmd is a batch file. `cmd /c npx ...` without `call` returns
    # before the download finishes — that is how the first pin attempt
    # marked e2e FAIL at 20% of Chromium. Start-Process -Wait owns the job.
    $install = Start-Process -FilePath $npx -ArgumentList "--yes","playwright","install","chromium" `
        -WorkingDirectory $AppRoot -Wait -PassThru -NoNewWindow
    $code = $install.ExitCode
    if ($null -eq $code) { return 1 }
    if ($code -ne 0) { return [int]$code }
    if (-not (Test-PlaywrightChromiumPresent $env:PLAYWRIGHT_BROWSERS_PATH)) {
        Write-Host "GATE FAIL: Chromium still missing after playwright install"
        return 1
    }
    return 0
}

$env:PLAYWRIGHT_BROWSERS_PATH = Resolve-PlaywrightBrowsersPath

function Resolve-E2ePort {
    $raw = $env:QUTRA_E2E_PORT
    if (-not $raw) { return 5174 }
    $port = 0
    $parsed = [int]::TryParse($raw, [ref]$port)
    if (-not $parsed -or $raw -notmatch '^[0-9]+$' -or $port -lt 1 -or $port -gt 65535) {
        Write-Host "GATE FAIL: QUTRA_E2E_PORT must be an integer from 1 to 65535, got '$raw'"
        exit 1
    }
    return $port
}

# Frees the e2e port only from this checkout's recorded Vite; see the file.
. (Join-Path $PSScriptRoot "e2e-port-owner.ps1")

$E2ePort = Resolve-E2ePort
$env:QUTRA_E2E_PORT = "$E2ePort"
Write-Host "QUTRA_E2E_PORT=$E2ePort"

function Invoke-CmdToLog {
    param(
        [string]$CommandLine,
        [string]$LogPath
    )
    cmd.exe /c "$CommandLine > `"$LogPath`" 2>&1"
    $code = $LASTEXITCODE
    if (Test-Path -LiteralPath $LogPath) {
        Get-Content -LiteralPath $LogPath | ForEach-Object { Write-Host $_ }
    }
    if ($null -eq $code) { return 1 }
    return [int]$code
}

function Invoke-CargoInMsvcChild {
    param([string]$LogPath)

    $msvc = Join-Path $PSScriptRoot "msvc-env.ps1"
    $child = Join-Path $env:TEMP ("qutra-gate-cargo-" + $PID + ".ps1")
    @'
param($AppRoot, $MsvcEnv, $LogPath)
Set-Location -LiteralPath $AppRoot
$ErrorActionPreference = "Continue"
. $MsvcEnv
cmd.exe /c ('cargo test --manifest-path src-tauri/Cargo.toml > "' + $LogPath + '" 2>&1')
exit $LASTEXITCODE
'@ | Set-Content -LiteralPath $child -Encoding ASCII

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $child -AppRoot $AppRoot -MsvcEnv $msvc -LogPath $LogPath
    $code = $LASTEXITCODE
    Remove-Item -LiteralPath $child -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $LogPath) {
        Get-Content -LiteralPath $LogPath | ForEach-Object { Write-Host $_ }
    }
    if ($null -eq $code) { return 1 }
    return [int]$code
}

$steps = @(
    @{ Name = "typecheck"; Kind = "npm";   Command = "npm run typecheck" },
    @{ Name = "lint";      Kind = "npm";   Command = "npm run lint" },
    @{ Name = "unit";      Kind = "npm";   Command = "npm test" },
    @{ Name = "cargo";     Kind = "cargo" },
    @{ Name = "build";     Kind = "npm";   Command = "npm run build" },
    @{ Name = "e2e";       Kind = "e2e";   Command = "npm run test:e2e" }
)

$results = @()
$failed = 0

function Get-CountDetail([string]$Name, [string]$Log) {
    switch ($Name) {
        "typecheck" {
            if ($Log -match "error TS") { return ($Log | Select-String -Pattern "error TS").Count.ToString() + " tsc diagnostics" }
            return "tsc -b --force --noEmit, no diagnostics"
        }
        "lint" {
            if ($Log -match "(\d+) problems? \((\d+) errors?, (\d+) warnings?\)") { return $Matches[2] + " errors, " + $Matches[3] + " warnings (eslint)" }
            return "eslint --max-warnings 0, no problems"
        }
        "unit" {
            if ($Log -match "Tests\s+(\d+)\s+passed") { return $Matches[1] + " passed (vitest)" }
            if ($Log -match "(\d+) passed") { return $Matches[1] + " passed" }
            return "could not parse vitest counts"
        }
        "cargo" {
            $passed = 0
            $failedCargo = 0
            $ignored = 0
            foreach ($m in [regex]::Matches($Log, 'test result:\s+\S+\.\s+(\d+) passed;\s+(\d+) failed;\s+(\d+) ignored')) {
                $passed += [int]$m.Groups[1].Value
                $failedCargo += [int]$m.Groups[2].Value
                $ignored += [int]$m.Groups[3].Value
            }
            if ($passed -eq 0 -and $failedCargo -eq 0 -and $ignored -eq 0) {
                return "could not parse cargo counts"
            }
            return "$passed passed / $failedCargo failed / $ignored ignored"
        }
        "build" {
            if ($Log -match '"gzipBytes":(\d+).*"budgetBytes":(\d+)') {
                return "gzip $($Matches[1]) / budget $($Matches[2])"
            }
            return "vite production build + bundle:check"
        }
        "e2e" {
            if ($Log -match "Port (\d+) is held") { return "$($Matches[1]) occupied; cannot start a fresh Vite" }
            if ($Log -match "Chromium is not installed") { return "chromium missing at pinned PLAYWRIGHT_BROWSERS_PATH" }
            if ($Log -match "(\d+) passed") { return $Matches[1] + " passed (playwright)" }
            return "could not parse playwright counts"
        }
        default { return "" }
    }
}

foreach ($step in $steps) {
    Write-Host ""
    Write-Host "======== $($step.Name) ========"
    $logPath = Join-Path $env:TEMP ("qutra-gate-" + $step.Name + "-" + $PID + ".log")
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    if ($step.Kind -eq "cargo") {
        $code = Invoke-CargoInMsvcChild $logPath
    }
    else {
        $skipCommand = $false
        if ($step.Kind -eq "e2e") {
            $env:QUTRA_GATE = "1"
            $clear = Clear-E2ePort -Port $E2ePort -AppRoot $AppRoot
            Write-Host $clear.Message
            if ($clear.Code -ne 0) {
                $clear.Message | Set-Content -LiteralPath $logPath -Encoding UTF8
                $code = 1
                $skipCommand = $true
            }
            if (-not $skipCommand) {
                $browserCode = Ensure-PlaywrightChromium
                if ($browserCode -ne 0) {
                    "Playwright Chromium is not installed at $env:PLAYWRIGHT_BROWSERS_PATH" |
                        Set-Content -LiteralPath $logPath -Encoding UTF8
                    $code = $browserCode
                    $skipCommand = $true
                }
            }
        }
        if (-not $skipCommand) {
            $code = Invoke-CmdToLog $step.Command $logPath
        }
    }
    $sw.Stop()
    $log = ""
    if (Test-Path -LiteralPath $logPath) {
        $log = Get-Content -LiteralPath $logPath -Raw -ErrorAction SilentlyContinue
        if ($null -eq $log) { $log = "" }
    }
    $status = if ($code -eq 0) { "PASS" } else { "FAIL" }
    if ($code -ne 0) { $failed += 1 }
    $results += [pscustomobject]@{
        Step    = $step.Name
        Status  = $status
        Exit    = $code
        Seconds = [math]::Round($sw.Elapsed.TotalSeconds, 2)
        Detail  = Get-CountDetail $step.Name $log
    }
}

Write-Host ""
Write-Host "======== gate summary ========"
$results | Format-Table -AutoSize | Out-String | Write-Host
if ($failed -gt 0) {
    Write-Host "GATE FAIL ($failed / $($steps.Count) steps)"
    exit 1
}
Write-Host "GATE PASS ($($steps.Count) / $($steps.Count) steps)"
exit 0
