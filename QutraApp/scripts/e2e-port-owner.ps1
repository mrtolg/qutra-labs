# Frees the e2e port for the gate, or refuses. Dot-source, then call
# Clear-E2ePort -Port <n> -AppRoot <QutraApp>; it returns Code (0 or 1) and Message.
#
# Ownership is by record, not by reading a command line. Vite writes
# .qutra-dev-server.json (scripts/dev-server-owner.ts) when it listens: PID,
# port, start time, time of writing. The gate stops a holder of the port only
# when all of these match the record:
#   - same PID and same port;
#   - the OS start time of that PID is within 5 s of the recorded start
#     (Node's timeOrigin trails process creation by about 15 ms);
#   - and it is not later than the moment the record was written. A recycled
#     PID belongs to a process created after ours exited, so after the record.
# Any other holder is printed with its command line and left running.

function Get-ListeningPids([int]$Port) {
    $pattern = ":${Port}\s+"
    return @(
        netstat -ano |
            Select-String $pattern |
            ForEach-Object {
                if ($_.Line -match "^\s*TCP\s+\S+:${Port}\s+\S+\s+LISTENING\s+(\d+)\s*$") { [int]$Matches[1] }
            } |
            Where-Object { $_ -gt 0 } |
            Select-Object -Unique
    )
}

function Get-ProcessCommandLine([int]$ProcessId) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
    if (-not $proc) { return "" }
    return [string]$proc.CommandLine
}

# Unix milliseconds, or $null when the process is gone or unreadable.
function Get-ProcessStartMs([int]$ProcessId) {
    try {
        $start = (Get-Process -Id $ProcessId -ErrorAction Stop).StartTime
    } catch {
        return $null
    }
    if ($null -eq $start) { return $null }
    return ([DateTimeOffset]$start.ToUniversalTime()).ToUnixTimeMilliseconds()
}

# A record field counts only as a whole JSON number inside its bounds; text, a
# fraction, a negative, an overflow, null or true reads as $null. Never cast an
# unchecked field: gate.ps1 runs with $ErrorActionPreference = "Continue", so a
# failed cast inside an `if` skips that check and the next statement runs.
function ConvertTo-RecordInteger($Value, [int64]$Min, [int64]$Max) {
    if (-not ($Value -is [int] -or $Value -is [long])) { return $null }
    if ($Value -lt $Min -or $Value -gt $Max) { return $null }
    return [int64]$Value
}

function Read-DevServerOwner([string]$AppRoot) {
    $file = Join-Path $AppRoot ".qutra-dev-server.json"
    if (-not (Test-Path -LiteralPath $file)) { return $null }
    try {
        $raw = Get-Content -LiteralPath $file -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    } catch {
        return $null
    }
    if ($raw -isnot [System.Management.Automation.PSCustomObject]) { return $null }
    $latestMs = 253402300799999  # the last millisecond of year 9999
    $record = [pscustomobject]@{
        pid          = ConvertTo-RecordInteger $raw.pid 1 4294967295
        port         = ConvertTo-RecordInteger $raw.port 1 65535
        startedAtMs  = ConvertTo-RecordInteger $raw.startedAtMs 0 $latestMs
        recordedAtMs = ConvertTo-RecordInteger $raw.recordedAtMs 0 $latestMs
    }
    foreach ($field in "pid", "port", "startedAtMs", "recordedAtMs") {
        if ($null -eq $record.$field) { return $null }
    }
    return $record
}

function Test-RecordedOwner([int]$ProcessId, [int]$Port, $Record) {
    # Only a proven match says yes; any error on the way says no.
    try {
        if ($null -eq $Record) { return $false }
        if ($Record.pid -ne $ProcessId -or $Record.port -ne $Port) { return $false }
        $startMs = Get-ProcessStartMs $ProcessId
        if ($null -eq $startMs) { return $false }
        if ([math]::Abs($startMs - $Record.startedAtMs) -gt 5000) { return $false }
        return [bool]($startMs -le $Record.recordedAtMs)
    } catch {
        return $false
    }
}

function Clear-E2ePort([int]$Port, [string]$AppRoot) {
    $held = @(Get-ListeningPids $Port)
    if ($held.Count -eq 0) {
        return [pscustomobject]@{ Code = 0; Message = "Port $Port is free" }
    }
    $record = Read-DevServerOwner $AppRoot
    # Decide for every holder before touching any: one stranger fails the gate.
    foreach ($heldPid in $held) {
        if (-not (Test-RecordedOwner $heldPid $Port $record)) {
            $commandLine = Get-ProcessCommandLine $heldPid
            $shown = if ($commandLine) { $commandLine } else { "(no command line)" }
            return [pscustomobject]@{
                Code = 1
                Message = "Port $Port is held by PID $heldPid, which is not the Vite recorded by $AppRoot. Command: $shown. This gate will not stop it."
            }
        }
    }
    foreach ($heldPid in $held) {
        try {
            Stop-Process -Id $heldPid -Force -ErrorAction Stop
            Wait-Process -Id $heldPid -Timeout 10 -ErrorAction SilentlyContinue
        } catch {
            return [pscustomobject]@{
                Code = 1
                Message = "Port $Port is held by PID $heldPid and cannot be freed: $($_.Exception.Message)"
            }
        }
    }
    Remove-Item -LiteralPath (Join-Path $AppRoot ".qutra-dev-server.json") -ErrorAction SilentlyContinue
    return [pscustomobject]@{
        Code = 0
        Message = "Port $Port was held by this checkout's recorded Vite (PID $($held -join ', ')); stopped so the gate can start a fresh Vite"
    }
}
