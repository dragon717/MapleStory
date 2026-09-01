param(
    [ValidateSet('start', 'stop')][string]$Action = 'start',
    [switch]$SelfTest
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Control = Join-Path $Root 'evidence/runtime/windows-3010'
$StateFile = Join-Path $Control 'server.json'
$Executable = Join-Path $Root 'server/target/debug/maplestory-server.exe'
$Url = 'http://127.0.0.1:3010'

function Same-Identity($Record, $ProcessId, $ProcessPath, $StartTicks) {
    return ($Record.pid -eq $ProcessId -and $Record.path -eq $Executable -and
        $ProcessPath -eq $Executable -and [string]$Record.startTicks -eq [string]$StartTicks)
}

function Recorded-Process {
    if (!(Test-Path -LiteralPath $StateFile)) { return $null }
    $record = Get-Content -LiteralPath $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $process = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
    if ($process -and (Same-Identity $record $process.Id $process.Path $process.StartTime.ToUniversalTime().Ticks)) {
        return $process
    }
    # A stale PID must never authorize terminating a different process.
    Remove-Item -LiteralPath $StateFile
    return $null
}

function Assert-FreePort {
    $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    if (@($listeners | Where-Object { $_.Port -eq 3010 }).Count) {
        throw 'Port 3010 is occupied. Stop its owner manually; no process was terminated.'
    }
}

function Run-Build([string]$Command, [string[]]$Arguments) {
    # Windows PowerShell 5.1 wraps native stderr (including Cargo progress) as ErrorRecord.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Command @Arguments 2>&1 | ForEach-Object {
            $line = "$_"
            Write-Host $line
            Add-Content -LiteralPath (Join-Path $Control 'build.log') -Value $line -Encoding UTF8
        }
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previous }
    if ($code -ne 0) { throw "$Command failed (exit $code). See $Control/build.log" }
}

if ($SelfTest) {
    $record = [pscustomobject]@{ pid = 42; path = $Executable; startTicks = '1234' }
    if (!(Same-Identity $record 42 $Executable 1234)) { throw 'Expected own process to match' }
    if (Same-Identity $record 43 $Executable 1234) { throw 'Foreign PID matched' }
    if (Same-Identity $record 42 'C:\other\maplestory-server.exe' 1234) { throw 'Foreign executable matched' }
    if (Same-Identity $record 42 $Executable 5678) { throw 'Reused PID matched' }
    Write-Host 'PASS: own process, foreign PID/path, and reused PID identity checks.'
    exit 0
}

$lock = $null
$started = $null
try {
    if ($env:OS -ne 'Windows_NT') { throw 'This launcher requires Windows.' }
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
    $OutputEncoding = [Console]::OutputEncoding
    Set-Location -LiteralPath $Root
    New-Item -ItemType Directory -Force -Path $Control | Out-Null
    try {
        $lock = [System.IO.File]::Open((Join-Path $Control 'control.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    } catch { throw 'Another start/stop is in progress. Wait for it to finish.' }
    $running = Recorded-Process
    if ($Action -eq 'stop') {
        if ($running) {
            Stop-Process -InputObject $running -Force
            if (!$running.WaitForExit(10000)) { throw 'Server did not stop within 10 seconds.' }
            Remove-Item -LiteralPath $StateFile
            Write-Host 'Server stopped. Account database preserved.'
        } else { Write-Host 'No recorded server is running. Other processes were not touched.' }
    } elseif ($running) {
        Write-Host "Already running (PID $($running.Id)): $Url"
        Write-Host 'To load code changes, run stop.bat then start.bat.'
    } else {
        Assert-FreePort
        $node = (Get-Command node.exe -ErrorAction Stop).Source
        $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
        $cargo = (Get-Command cargo.exe -ErrorAction Stop).Source
        $version = & $node -p 'process.versions.node'
        if ($LASTEXITCODE -ne 0 -or [version]$version -lt [version]'22.12.0') { throw 'Node.js 22.12 or newer is required (24 LTS recommended).' }
        Run-Build $node @((Join-Path $PSScriptRoot 'check_windows_resources.cjs'))
        $protocolText = Get-Content -LiteralPath (Join-Path $Root 'shared/protocol.ts') -Raw -Encoding UTF8
        $protocol = [int][regex]::Match($protocolText, 'PROTOCOL_VERSION\s*=\s*(\d+)').Groups[1].Value
        $content = [regex]::Match($protocolText, 'CONTENT_VERSION\s*=\s*[''"]([^''"]+)').Groups[1].Value
        Write-Host 'Installing dependencies and building. First run needs internet access and MSVC C++ Build Tools.'
        Run-Build $npm @('ci', '--prefix', (Join-Path $Root 'client'))
        Run-Build $cargo @('build', '--locked', '--manifest-path', (Join-Path $Root 'server/Cargo.toml'), '--target-dir', (Join-Path $Root 'server/target'))
        $stage = Join-Path $Control 'dist-next'
        Run-Build $npm @('run', 'build', '--prefix', (Join-Path $Root 'client'), '--', '--outDir', $stage)
        if (!(Test-Path -LiteralPath (Join-Path $stage 'index.html'))) { throw 'Build did not produce index.html.' }
        Assert-FreePort
        $dist = Join-Path $Root 'client/dist-tms273'
        if (Test-Path -LiteralPath $dist) { Remove-Item -LiteralPath $dist -Recurse -Force }
        Move-Item -LiteralPath $stage -Destination $dist
        New-Item -ItemType Directory -Force -Path (Join-Path $Root 'server/data') | Out-Null
        $settings = @{
            # 0.0.0.0 so the LAN can reach http://<LAN-IP>:3010/ ; health check still uses 127.0.0.1
            BIND_ADDR = '0.0.0.0:3010'
            ACCOUNT_DB = Join-Path $Root 'server/data/tms273.sqlite3'
            CLIENT_DIST = $dist
            ASSETS_DIR = Join-Path $Root 'client/public-tms273/assets'
            GAMEPLAY_FILE = Join-Path $Root 'shared/gameplay.json'
            MAP_FILE = Join-Path $Root 'shared/map.json'
            MAP_CATALOG = Join-Path $Root 'shared/maps.json'
            MAGE_SKILLS_FILE = Join-Path $Root 'shared/mage-skills.json'
            QUEST_TEXT_FILE = Join-Path $Root 'shared/quest-text.json'
            NPC_NAMES_ZH_FILE = Join-Path $Root 'shared/npc-names.json'
            CHARACTER_CREATION_FILE = Join-Path $Root 'shared/character-creation.json'
        }
        foreach ($key in $settings.Keys) { [Environment]::SetEnvironmentVariable($key, $settings[$key], 'Process') }
        $started = Start-Process -FilePath $Executable -WorkingDirectory $Root -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Control 'server.log') -RedirectStandardError (Join-Path $Control 'server-error.log')
        $record = @{ pid = $started.Id; path = $Executable; startTicks = [string]$started.StartTime.ToUniversalTime().Ticks }
        $record | ConvertTo-Json | Set-Content -LiteralPath $StateFile -Encoding UTF8
        $ready = $false
        for ($attempt = 0; $attempt -lt 40; $attempt++) {
            if ($started.HasExited) { throw "Server exited. See $Control/server-error.log" }
            try {
                $health = Invoke-RestMethod -Uri "$Url/api/health" -TimeoutSec 1
                $listener = Get-NetTCPConnection -LocalPort 3010 -State Listen -ErrorAction SilentlyContinue
                if ($health.ok -eq $true -and $health.protocolVersion -eq $protocol -and $health.contentVersion -eq $content -and $listener.OwningProcess -contains $started.Id) {
                    $ready = $true
                    break
                }
            } catch { }
            Start-Sleep -Milliseconds 250
        }
        if (!$ready -or $started.HasExited) { throw "Server health/version check failed. See $Control/server-error.log" }
        Write-Host "Ready: $Url (PID $($started.Id))"
        $lanAddresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
            Select-Object -ExpandProperty IPAddress)
        foreach ($address in $lanAddresses) { Write-Host "LAN:   http://${address}:3010/" }
        Write-Host "Logs: $Control"
        Write-Host 'Use stop.bat to stop. Account database preserved.'
        $started = $null
    }
} catch {
    if ($started) {
        if (!$started.HasExited) { Stop-Process -InputObject $started -Force -ErrorAction SilentlyContinue }
        Remove-Item -LiteralPath $StateFile -ErrorAction SilentlyContinue
    }
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Check Node/npm/Cargo PATH, MSVC C++ Build Tools, resource extraction, and the build/server logs.'
    exit 1
} finally { if ($lock) { $lock.Dispose() } }
