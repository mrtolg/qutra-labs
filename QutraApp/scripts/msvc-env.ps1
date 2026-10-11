# Imports the Visual Studio 2022 Build Tools (vcvars64) environment into the
# current PowerShell session so cargo/tauri can find cl.exe, link.exe, and
# rc.exe (Windows SDK). Also puts the user cargo bin on PATH.
#
#   . .\scripts\msvc-env.ps1
#
# Dot-source it only in the process that needs cl.exe / link.exe / rc.exe.
# `npm run gate` loads this in a child PowerShell for the cargo step so
# Node steps never inherit vcvars. Direct `cargo` / `tauri` use still
# dotsource it in the current session.

$ErrorActionPreference = "Stop"

$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
# vcvars `set` can truncate a long PATH (cmd's 8191-char cap). Remember what
# we had so Node/npm directories are prepended back if they disappear.
$pathBeforeVcvars = $env:Path

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) { throw "vswhere not found; install VS Build Tools" }
$vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
$vcvars = Join-Path $vsPath "VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path $vcvars)) { throw "vcvars64.bat not found at $vcvars" }

# Capture the environment produced by vcvars64 and apply it here.
cmd /c "`"$vcvars`" >nul 2>&1 && set" | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') {
        Set-Item -Path ("Env:" + $matches[1]) -Value $matches[2]
    }
}

$after = @($env:Path -split ';' | Where-Object { $_ })
$dropped = @($pathBeforeVcvars -split ';' | Where-Object { $_ } | Where-Object { $after -notcontains $_ })
if ($dropped.Count -gt 0) {
    $env:Path = (($dropped + $after) -join ';')
}
