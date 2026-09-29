param([string]$DeploymentRoot = 'D:\comp\colearnx-video-local')
$ErrorActionPreference = 'Stop'
$deploymentPath = [IO.Path]::GetFullPath($DeploymentRoot)
if (-not $deploymentPath.StartsWith('D:\', [StringComparison]::OrdinalIgnoreCase) -or $deploymentPath.Length -le 3) {
    throw 'Test runtime must be in a dedicated folder on D:.'
}
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$testWork = Join-Path $deploymentPath 'runtime/queue-test'
New-Item -ItemType Directory -Path (Join-Path $testWork 'tmp') -Force | Out-Null
$env:TEMP = Join-Path $testWork 'tmp'
$env:TMP = $env:TEMP
$containerName = 'colearnx-queue-test-' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
$created = $false
try {
    # Disposable database, no exposed host port, no Internet, no cloud secrets.
    & docker --context desktop-linux run -d --rm --network none --name $containerName -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=colearnx_queue_test_batch postgres:16
    if ($LASTEXITCODE -ne 0) { throw 'Could not create isolated PostgreSQL test container.' }
    $created = $true
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        & docker --context desktop-linux exec $containerName pg_isready -U postgres *> $null
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw 'Test PostgreSQL did not become ready.' }
    & docker --context desktop-linux run --rm --init --network "container:$containerName" --read-only --cap-drop ALL --security-opt no-new-privileges:true `
        --mount "type=bind,source=$repoRoot,target=/repo,readonly" --mount "type=bind,source=$testWork,target=/work" `
        -e TMPDIR=/work/tmp -e TMP=/work/tmp -e TEMP=/work/tmp `
        -e COLEARNX_QUEUE_TEST_URL=postgresql://postgres@127.0.0.1:5432/colearnx_queue_test_batch `
        colearnx-video-worker:local-batch node --import /app/node_modules/tsx/dist/loader.mjs --test /repo/apps/video-worker/test/queue.integration.test.ts
    if ($LASTEXITCODE -ne 0) { throw 'Queue lifecycle integration test failed.' }
} finally {
    if ($created) {
        # Only this script's freshly-created exact container; never prune data.
        & docker --context desktop-linux stop $containerName | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Warning "Could not remove test container $containerName" }
    }
}
