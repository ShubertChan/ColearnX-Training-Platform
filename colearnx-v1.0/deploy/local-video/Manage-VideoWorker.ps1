param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Build', 'Start', 'Stop', 'Status')]
    [string]$Action,
    [string]$DeploymentRoot = 'D:\comp\colearnx-video-local'
)
$ErrorActionPreference = 'Stop'
$deploymentPath = [IO.Path]::GetFullPath($DeploymentRoot)
if (-not $deploymentPath.StartsWith('D:\', [StringComparison]::OrdinalIgnoreCase) -or $deploymentPath.Length -le 3) {
    throw 'Use a dedicated folder on D: for all local video runtime data.'
}
$env:COLEARNX_VIDEO_ROOT = $deploymentPath.Replace('\', '/')
$env:TEMP = Join-Path $deploymentPath 'runtime/host-tmp'
$env:TMP = $env:TEMP
$env:npm_config_cache = Join-Path $deploymentPath 'runtime/npm-cache'
foreach ($relativePath in @('runtime/host-tmp', 'runtime/npm-cache', 'runtime/work/tmp', 'runtime/work/cache')) {
    New-Item -ItemType Directory -Path (Join-Path $deploymentPath $relativePath) -Force | Out-Null
}
$composeFile = Join-Path $PSScriptRoot 'compose.yaml'
$containerName = 'colearnx-video-worker'
$imageName = 'colearnx-video-worker:local-batch'
# A crashed Docker IPC service can leave even `docker info` hanging forever.
# Bound this read-only probe and terminate only the child CLI we created.
$probeInfo = [Diagnostics.ProcessStartInfo]::new()
$probeInfo.FileName = (Get-Command docker -ErrorAction Stop).Source
$probeInfo.Arguments = '--context desktop-linux info --format {{.DockerRootDir}}'
$probeInfo.UseShellExecute = $false
$probeInfo.CreateNoWindow = $true
$probeInfo.RedirectStandardOutput = $true
$probeInfo.RedirectStandardError = $true
$probe = [Diagnostics.Process]::Start($probeInfo)
try {
    $probeOutput = $probe.StandardOutput.ReadToEndAsync()
    $probeError = $probe.StandardError.ReadToEndAsync()
    if (-not $probe.WaitForExit(15000)) {
        $probe.Kill()
        throw 'Docker did not respond within 15 seconds. Resolve the Docker Desktop startup error first; no container was changed.'
    }
    if ($probe.ExitCode -ne 0) { throw 'Start Docker Desktop first.' }
} finally { $probe.Dispose() }

if ($Action -eq 'Build') {
    # Does not read cloud credentials or start a worker.
    $buildContext = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../apps/video-worker'))
    & docker --context desktop-linux build --tag $imageName $buildContext
    if ($LASTEXITCODE -ne 0) { throw 'Worker image build failed.' }
    Write-Host 'Batch worker image prepared; no worker was started.'
    return
}

$containerList = & docker --context desktop-linux ps -a --filter "name=^/$containerName`$" --format '{{.Names}}'
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect Docker containers.' }
$exists = @($containerList) -contains $containerName
$running = $false
if ($exists) {
    # Do not signal/recreate an unrelated container that happens to share a name.
    $project = & docker --context desktop-linux inspect $containerName --format '{{index .Config.Labels "com.docker.compose.project"}}'
    if ($LASTEXITCODE -ne 0 -or $project -ne 'colearnx-video-local') { throw 'Container name is used by another project.' }
    $running = (& docker --context desktop-linux inspect $containerName --format '{{.State.Running}}') -eq 'true'
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect worker state.' }
}

switch ($Action) {
    'Start' {
        if ($running) {
            Write-Host 'Worker is already running or draining. Wait for it to stop before starting another batch.'
            return
        }
        $secretFile = Join-Path $deploymentPath 'config/private/worker.env'
        if (-not (Test-Path -LiteralPath $secretFile)) { throw 'Missing config/private/worker.env. Configure restricted worker credentials first.' }
        $secretText = Get-Content -LiteralPath $secretFile -Raw
        if ($secretText -match 'REPLACE_ME|neondb_owner|colearnx_migrator') { throw 'Use real, worker-only credentials, never an owner or migration role.' }
        $secretText = $null
        & docker --context desktop-linux image inspect $imageName --format '{{.Id}}' *> $null
        if ($LASTEXITCODE -ne 0) { throw 'Run the Build action before starting the batch worker.' }
        & docker --context desktop-linux compose -f $composeFile up -d --no-build video-worker
        if ($LASTEXITCODE -ne 0) { throw 'Could not start the batch worker.' }
        Write-Host 'Batch started. It exits after 120 seconds idle with no pending jobs. Keep this PC awake while processing.'
    }
    'Stop' {
        if (-not $running) { Write-Host 'Worker is already stopped.'; return }
        # Signal only; do NOT use docker stop's short default SIGKILL deadline.
        # Node is the container command, behind init, so SIGTERM reaches it.
        & docker --context desktop-linux kill --signal=SIGTERM $containerName
        if ($LASTEXITCODE -ne 0) { throw 'Could not request graceful shutdown.' }
        Write-Host 'Drain requested, not yet stopped: current transcodes/uploads finish first. Check Status; do not close Docker or shut down the PC until exited.'
    }
    'Status' {
        if (-not $exists) { Write-Host 'Worker has not been created.'; return }
        & docker --context desktop-linux inspect $containerName --format 'State={{.State.Status}} ExitCode={{.State.ExitCode}} OOMKilled={{.State.OOMKilled}} RestartPolicy={{.HostConfig.RestartPolicy.Name}}'
        if ($LASTEXITCODE -ne 0) { throw 'Could not inspect worker status.' }
        Write-Host 'Recent logs (review before sharing publicly):'
        & docker --context desktop-linux logs --tail 30 $containerName
    }
}
