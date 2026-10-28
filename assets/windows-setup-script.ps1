$ErrorActionPreference = 'Stop'

$controller = 'qa-autoqa-controller'
$controllerIp = (Resolve-DnsName -Name $controller -Type A).IPAddress
$userHome = 'C:\Users\qauser'
$workerScript = Join-Path $userHome 'ControlTowerWorker.ps1'
$pwsh = 'C:\Program Files\PowerShell\7\pwsh.exe'
$autologon = 'C:\Program Files\Sysinternals\Autologon64.exe'
$logDir = 'C:\ProgramData\ControlTower\logs'
[IO.Directory]::CreateDirectory($logDir) | Out-Null

# Lines go to stdout (Google's runner forwards them to serial port 1 and the
# Application event log) and to a file readable later over SAC.
function Log([string]$Message) {
    $line = "$([DateTime]::UtcNow.ToString('u')) setup: $Message"
    Write-Output $line
    Add-Content -LiteralPath (Join-Path $logDir 'setup.log') -Value $line
}
trap { Log "FAILED: $($_.Exception.Message)"; break }

if (-not (Test-Path -LiteralPath $pwsh)) { throw "Missing PowerShell 7: $pwsh" }
if (-not (Test-Path -LiteralPath $autologon)) { throw "Missing Autologon: $autologon" }
if (-not (Get-LocalUser -Name qauser -ErrorAction SilentlyContinue)) { throw 'Missing qauser' }

Log 'opening firewall for observatory on port 5678'
New-NetFirewallRule -DisplayName 'qbt observatory' -Direction Inbound -Protocol TCP -LocalPort 5678 `
    -RemoteAddress $controllerIp -Action Allow | Out-Null

Log 'installing Friendzone machine CA'
$ca = Join-Path $env:TEMP 'friendzone-machine-ca.ps1'
& curl.exe --noproxy '*' -fsS --connect-timeout 5 --max-time 30 `
    "http://${controller}:8082/bootstrap/windows-ca.ps1" -o $ca
if ($LASTEXITCODE -ne 0) { throw 'Certificate bootstrap download failed' }
& $ca

# Script block literal: $env:* and friends are evaluated by qauser at logon, not here.
$payload = {
    $ErrorActionPreference = 'Stop'
    $PSNativeCommandArgumentPassing = 'Standard'
    $controller = 'qa-autoqa-controller'

    function Native([string]$Exe, [string[]]$Arguments) {
        & $Exe @Arguments
        if ($LASTEXITCODE -ne 0) { throw "$Exe $($Arguments -join ' ') failed with exit $LASTEXITCODE" }
    }

    function Metadata([string]$Name) {
        $temp = [IO.Path]::GetTempFileName()
        try {
            Native curl.exe @('--noproxy', '*', '-fsS', '--connect-timeout', '5', '--max-time', '15',
                '-H', 'Metadata-Flavor: Google',
                "http://169.254.169.254/computeMetadata/v1/instance/attributes/$Name", '-o', $temp)
            return [IO.File]::ReadAllText($temp, [Text.Encoding]::UTF8)
        } finally { Remove-Item -LiteralPath $temp -Force }
    }

    # Force the checkout to the tracking branch; it is rebased and force-pushed.
    function Sync-Repo([string]$Path, [string]$Branch) {
        Native git.exe @('-C', $Path, 'fetch', '--prune', 'origin')
        Native git.exe @('-C', $Path, 'checkout', '--force', '-B', $Branch, "origin/$Branch")
        Native git.exe @('-C', $Path, 'clean', '-fd')   # keep ignored build caches
        Native git.exe @('-C', $Path, 'log', '-1', '--oneline')
    }

    if ($env:USERNAME -ne 'qauser' -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) {
        throw 'Run this payload in the qauser interactive desktop'
    }

    $runs = Join-Path $env:USERPROFILE 'control-tower-runs'
    [IO.Directory]::CreateDirectory($runs) | Out-Null
    Start-Transcript -LiteralPath (Join-Path $runs ('launcher-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '.log')) | Out-Null

    $jobId = ([Guid](Metadata 'control-tower-job-id').Trim()).ToString('D')
    $guest = 'ct-' + $jobId.Replace('-', '')
    $workerUrl = (Metadata 'control-tower-worker-url').Trim().TrimEnd('/')
    $prompt = Metadata 'control-tower-prompt'
    if ([string]::IsNullOrWhiteSpace($prompt)) { throw 'Empty CT prompt' }

    $jobRoot = Join-Path $runs $jobId
    [IO.Directory]::CreateDirectory($jobRoot) | Out-Null
    # Refuse automatic replay after another logon, crash, or reboot.
    [IO.File]::Open((Join-Path $jobRoot 'started'), 'CreateNew', 'Write', 'None').Dispose()
    Write-Output "job $jobId guest $guest root $jobRoot"

    $bootstrap = "http://${controller}:8082"
    $ready = $false
    $deadline = [DateTime]::UtcNow.AddMinutes(10)
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $reply = Invoke-RestMethod -NoProxy -TimeoutSec 10 -Uri "$bootstrap/bootstrap/hello?container=$guest"
            if ($reply.approved -eq $true) { $ready = $true; break }
            Write-Output "waiting for Friendzone approval: approved=$($reply.approved)"
        } catch { Write-Warning $_.Exception.Message }
        Start-Sleep -Seconds 2
    }
    if (-not $ready) { throw 'Friendzone approval timed out' }

    $setup = Join-Path $jobRoot 'friendzone-setup.ps1'
    Native curl.exe @('--noproxy', '*', '-fsS', '--connect-timeout', '5', '--max-time', '30',
        "$bootstrap/bootstrap/setup?shell=powershell&container=$guest", '-o', $setup)

    $env:CLINE_DIR = Join-Path $env:USERPROFILE '.cline'
    Remove-Item Env:CLINE_DATA_DIR, Env:CLINE_PROVIDER_SETTINGS_PATH -ErrorAction SilentlyContinue
    & $setup
    . (Join-Path $env:APPDATA 'friendzone\friendzone-proxy-env.ps1')

    $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
    Set-ItemProperty -LiteralPath $key -Name CertificateRevocation -Value 0 -Type DWord
    if (-not ('Friendzone.WinInet' -as [type])) {
        Add-Type -TypeDefinition @'
namespace Friendzone {
    using System;
    using System.Runtime.InteropServices;
    public static class WinInet {
        [DllImport("wininet.dll", SetLastError=true)]
        public static extern bool InternetSetOption(IntPtr handle, int option, IntPtr buffer, int length);
    }
}
'@
    }
    foreach ($option in @(39, 37)) {
        if (-not [Friendzone.WinInet]::InternetSetOption([IntPtr]::Zero, $option, [IntPtr]::Zero, 0)) {
            throw "WinINet notification failed: option $option"
        }
    }

    $qwanban = Join-Path $env:USERPROFILE 'qwanban'
    $cline = Join-Path $env:USERPROFILE 'cline'
    Sync-Repo $qwanban 'main'
    Native cargo.exe @('install', '--locked', '--path', (Join-Path $qwanban 'qbt'))
    Sync-Repo $cline 'dpc/computer-use'
    Push-Location $cline
    try {
        Native bun.exe @('install', '--frozen-lockfile')
        try {
            Native bun.exe @('-F', '@cline/cli', 'build:platforms:single')
        } catch {
            # build.ts deletes dist before building and copies cline.exe into it
            # before the smoke tests, so a binary here means compilation succeeded
            # and only a later check (hub smoke test, package.json) failed.
            if (-not (Test-Path -LiteralPath $clineExe)) { throw }
            Write-Warning "using $clineExe despite: $($_.Exception.Message)"
            Native $clineExe @('--version')
        }
    } finally { Pop-Location }

    # Preserve Friendzone plugins/config; isolate runtime data per job.
    $state = Join-Path $jobRoot 'cline-data'
    $settings = Join-Path $state 'settings'
    [IO.Directory]::CreateDirectory($settings) | Out-Null
    Copy-Item -LiteralPath (Join-Path $env:CLINE_DIR 'data\settings\providers.json') -Destination $settings

    $qbt = Join-Path $env:USERPROFILE '.cargo\bin\qbt.exe'
    $clineExe = Join-Path $cline 'apps\cli\dist\cli-windows-x64\bin\cline.exe'
    $artifacts = Join-Path $jobRoot 'artifacts'
    $env:CLINE_COMPUTER_USE_HOST = '127.0.0.1'
    $env:CLINE_COMPUTER_USE_PORT = '1234'
    $env:CLINE_COMPUTER_USE_BACKEND_COMMAND = '"' + $qbt + '" serve 1234 5678 --artifact-root "' + $artifacts + '"'
    $env:CLINE_LOG_PATH = Join-Path $jobRoot 'cline.log'
    $env:CLINE_HOOKS_LOG_PATH = Join-Path $jobRoot 'hooks.jsonl'
    $env:CONTROL_TOWER_JOB_ID = $jobId
    $env:CONTROL_TOWER_WORKER_URL = $workerUrl
    $env:CONTROL_TOWER_JOB_ROOT = $jobRoot

    Set-DisplayResolution -Width 1280 -Height 960 -Force

    # Agent-controlled completion, not completion inferred from Cline exiting.
    # CT retains only what reaches /artifact before /complete, and qbt flushes its
    # journal only on shutdown_backend, so the order is: stop qbt, pack, upload, complete.
    # Self-contained: it is written to a file and run in a fresh pwsh by the agent.
    $finish = {
        param([Parameter(Mandatory)][ValidateSet('completed', 'failed')][string]$Outcome)
        $ErrorActionPreference = 'Stop'
        $PSNativeCommandArgumentPassing = 'Standard'
        $PSNativeCommandUseErrorActionPreference = $false   # exit codes are checked by hand

        foreach ($name in 'CONTROL_TOWER_JOB_ROOT', 'CONTROL_TOWER_WORKER_URL', 'CONTROL_TOWER_JOB_ID', 'CLINE_COMPUTER_USE_PORT') {
            if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
                throw "Missing $name in the environment; run this from the Cline session"
            }
        }
        $jobRoot = $env:CONTROL_TOWER_JOB_ROOT
        $jobUrl = "$env:CONTROL_TOWER_WORKER_URL/jobs/$env:CONTROL_TOWER_JOB_ID"
        $qbtPort = [int]$env:CLINE_COMPUTER_USE_PORT
        $tar = Join-Path $env:SystemRoot 'System32\tar.exe'

        function Test-Port([int]$Port) {
            $client = [Net.Sockets.TcpClient]::new()
            try { return ($client.ConnectAsync('127.0.0.1', $Port).Wait(1000) -and $client.Connected) }
            catch { return $false }
            finally { $client.Dispose() }
        }

        # Direct to CT: source IP is identity, so never through the Friendzone proxy.
        function Post([string]$Url, [string[]]$Body) {
            $replyFile = [IO.Path]::GetTempFileName()
            try {
                $status = & curl.exe --noproxy '*' --silent --show-error --max-time 300 --request POST `
                    --output $replyFile --write-out '%{http_code}' @Body $Url
                $code = 0
                if ($LASTEXITCODE -eq 0) { $code = [int]("$status".Trim()) }
                return @{ Code = $code; Body = [IO.File]::ReadAllText($replyFile) }
            } finally { Remove-Item -LiteralPath $replyFile -Force }
        }

        function Retry([string]$What, [int[]]$Accept, [scriptblock]$Request) {
            $delay = 1
            for ($attempt = 1; $attempt -le 5; $attempt++) {
                $reply = & $Request
                if ($Accept -contains $reply.Code) { return $reply }
                Write-Warning "$What attempt ${attempt}: HTTP $($reply.Code) $($reply.Body)"
                Start-Sleep -Seconds $delay
                $delay = [Math]::Min($delay * 2, 10)
            }
            throw "CT rejected $What after 5 attempts"
        }

        if (Test-Port $qbtPort) {
            Write-Output 'stopping qbt so its journal is flushed'
            $client = [Net.Sockets.TcpClient]::new('127.0.0.1', $qbtPort)
            try {
                $stream = $client.GetStream()
                $stream.ReadTimeout = 5000
                $request = [Text.Encoding]::UTF8.GetBytes('{"id":1,"action":"shutdown_backend"}' + "`n")
                $stream.Write($request, 0, $request.Length)
                $line = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8).ReadLine()
                if ([string]::IsNullOrWhiteSpace($line)) { throw 'qbt closed the connection without acknowledging shutdown_backend' }
                if (($line | ConvertFrom-Json).ok -ne $true) { throw "qbt rejected shutdown_backend: $line" }
            } finally { $client.Dispose() }
            $deadline = [DateTime]::UtcNow.AddSeconds(10)
            while ((Test-Port $qbtPort) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
            if (Test-Port $qbtPort) { throw "qbt port $qbtPort still open after shutdown_backend" }
        }
        $journalTemp = Join-Path $jobRoot 'artifacts\journal\events.tmp'
        $deadline = [DateTime]::UtcNow.AddSeconds(5)
        while ((Test-Path -LiteralPath $journalTemp) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
        if (Test-Path -LiteralPath $journalTemp) { throw "qbt journal left an uncommitted $journalTemp" }

        # Built once; retries reuse the same bytes so a 204 on re-upload is a true duplicate.
        $package = Join-Path $jobRoot 'package'
        $archive = Join-Path $package 'results.tar.zst'
        if (-not (Test-Path -LiteralPath $archive)) {
            [IO.Directory]::CreateDirectory($package) | Out-Null
            # Everything in the job root except the packet itself and provider settings.
            $entries = @(Get-ChildItem -LiteralPath $jobRoot -Name | Where-Object { $_ -notin 'package', 'cline-data' })
            $clineData = Join-Path $jobRoot 'cline-data'
            if (Test-Path -LiteralPath $clineData) {
                $entries += @(Get-ChildItem -LiteralPath $clineData -Name | Where-Object { $_ -ne 'settings' } |
                    ForEach-Object { "cline-data/$_" })
            }
            $temp = "$archive.tmp"
            & $tar --zstd -cf $temp -C $jobRoot @entries
            if ($LASTEXITCODE -ne 0) { throw "tar exited $LASTEXITCODE" }
            $listing = & $tar -tf $temp
            if ($LASTEXITCODE -ne 0) { throw "tar listing exited $LASTEXITCODE" }
            if ($listing -match 'providers\.json') { throw 'Packet would include providers.json' }
            $magic = [byte[]]::new(4)
            $stream = [IO.File]::OpenRead($temp)
            try { $read = $stream.Read($magic, 0, 4) } finally { $stream.Dispose() }
            if ($read -ne 4 -or [BitConverter]::ToString($magic) -ne '28-B5-2F-FD') { throw 'Packet is not a zstd frame' }
            Move-Item -LiteralPath $temp -Destination $archive
        }
        Write-Output "packet $archive ($((Get-Item -LiteralPath $archive).Length) bytes, $($entries.Count) entries)"

        $upload = Retry 'artifact upload' @(201, 204) {
            Post "$jobUrl/artifact" @('--header', 'Content-Type: application/zstd', '--data-binary', "@$archive")
        }
        Write-Output "CT stored the packet: HTTP $($upload.Code)"
        Retry 'completion' @(202) {
            Post "$jobUrl/complete" @('--header', 'Content-Type: application/json', '--data', ('{"outcome":"' + $Outcome + '"}'))
        } | Out-Null
        Write-Output 'CT accepted completion. This worker will be deleted.'
    }
    $finishPath = Join-Path $jobRoot 'Complete-Job.ps1'
    [IO.File]::WriteAllText($finishPath, $finish.ToString(), [Text.UTF8Encoding]::new($false))

    $instructions = @"
$prompt

Worker lifecycle:
Remain available for Friendzone steering until the job is finished.
Resolve outstanding Friendzone requests and save your final report in '$jobRoot'.

To finish, run PowerShell 7:
& '$finishPath' -Outcome completed

Use -Outcome failed if you cannot complete the task.
The helper stops qbt, packages everything under '$jobRoot' (except package and
cline-data\settings) into one archive, uploads it to CT, and only then reports
the outcome. Save the final report and any files worth keeping under '$jobRoot'
BEFORE running it. Check that CT accepts both the packet and the completion.

Completion authorizes immediate VM and disk deletion.

If the operator asks to retain this worker for inspection, do not call
completion until released. CT's deadline still applies.
Exiting Cline or finishing a turn does not complete the job.
"@
    $promptPath = Join-Path $jobRoot 'prompt.txt'
    [IO.File]::WriteAllText($promptPath, $instructions, [Text.UTF8Encoding]::new($false))

    Set-Location $env:USERPROFILE
    Write-Output 'starting cline'
    # No pipeline: the interactive TUI needs real terminal handles.
    Native $clineExe @('--tui', '--auto-approve', 'true', '--data-dir', $state, '--',
        "Read and carry out the task and lifecycle instructions in $promptPath")
}

Log "writing $workerScript"
[IO.File]::WriteAllText($workerScript, $payload.ToString(), [Text.UTF8Encoding]::new($true))

# The account is named without the computer name: specialize renames this machine.
Log 'registering QAUserLogon'
$action = New-ScheduledTaskAction -Execute $pwsh -WorkingDirectory $userHome `
    -Argument ('-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $workerScript + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User 'qauser'
$principal = New-ScheduledTaskPrincipal -UserId 'qauser' -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'QAUserLogon' -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null

# Sysprep generalize strips the saved autologon, so arm it here with a password
# unique to this VM. It exists only in the account and in the LSA DefaultPassword
# secret Autologon writes for winlogon; neither the image nor metadata knows it.
# For on-machine debugging comment out this block and reset the password with gcloud.
Log 'setting qauser password and autologon'
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$password = -join $(foreach ($alphabet in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz', '0123456789') {
    $bytes = New-Object byte[] 10
    $rng.GetBytes($bytes)
    foreach ($b in $bytes) { $alphabet[$b % $alphabet.Length] }
})
Set-LocalUser -Name qauser -Password (ConvertTo-SecureString $password -AsPlainText -Force) -PasswordNeverExpires $true
& net.exe user qauser /logonpasswordchg:no | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'net user qauser /logonpasswordchg:no failed' }
# Domain '.' means the local machine, whatever name the pending rename gives it.
$autologonRun = Start-Process -FilePath $autologon -ArgumentList @('/accepteula', 'qauser', '.', $password) `
    -Wait -PassThru -WindowStyle Hidden
if ($autologonRun.ExitCode -ne 0) { throw "Autologon64 exited $($autologonRun.ExitCode)" }
Remove-Variable password

$winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
# No countdown, and no plaintext copy to shadow the LSA secret.
Remove-ItemProperty -LiteralPath $winlogon -Name AutoLogonCount, DefaultPassword -ErrorAction SilentlyContinue
$armed = Get-ItemProperty -LiteralPath $winlogon
if ($armed.AutoAdminLogon -ne '1' -or $armed.DefaultUserName -ne 'qauser') {
    throw "Autologon not armed: AutoAdminLogon=$($armed.AutoAdminLogon) DefaultUserName=$($armed.DefaultUserName)"
}
if (-not (Test-Path -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\SECURITY\Policy\Secrets\DefaultPassword')) {
    throw 'LSA DefaultPassword secret missing after Autologon'
}
Log "autologon armed for $($armed.DefaultDomainName)\$($armed.DefaultUserName)"

Log 'finished'
