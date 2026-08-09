# Registers job-agent as a Windows Scheduled Task so it runs on its own.
#
#   Install:   powershell -ExecutionPolicy Bypass -File scripts\install-schedule.ps1
#   Remove:    powershell -ExecutionPolicy Bypass -File scripts\install-schedule.ps1 -Uninstall
#
# Defaults to twice a day (08:30 and 18:30). Job postings don't expire in hours,
# so this is plenty — and it deliberately does NOT wake the machine.

param(
  [string[]] $At = @('08:30', '18:30'),
  [switch]   $Uninstall,
  [string]   $TaskName = 'job-agent'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
  } else {
    Write-Host "No scheduled task named '$TaskName'." -ForegroundColor Yellow
  }
  return
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node was not found on PATH.' }

$cli = Join-Path $root 'src\cli.js'
if (-not (Test-Path $cli)) { throw "Could not find $cli" }

$action = New-ScheduledTaskAction `
  -Execute $node `
  -Argument "--no-warnings `"$cli`" run" `
  -WorkingDirectory $root

$triggers = foreach ($t in $At) { New-ScheduledTaskTrigger -Daily -At $t }

# Run only when there's a network, don't fight the battery, and never wake the box.
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -DontStopIfGoingOnBatteries `
  -AllowStartIfOnBatteries `
  -RunOnlyIfNetworkAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $triggers `
  -Settings $settings `
  -Description 'Fetches and scores job/freelance opportunities matching your profile.' `
  -Force | Out-Null

Write-Host "Scheduled task '$TaskName' installed." -ForegroundColor Green
Write-Host "  Runs daily at: $($At -join ', ')"
Write-Host "  Command:       node --no-warnings `"$cli`" run"
Write-Host ""
Write-Host "Run it right now to check it works:" -ForegroundColor Cyan
Write-Host "  Start-ScheduledTask -TaskName $TaskName"
Write-Host "Then browse results with:  yarn web"
