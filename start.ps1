$ErrorActionPreference = 'Stop'
$bridgeRoot = $PSScriptRoot
$runtimePath = Join-Path $bridgeRoot '.runtime'
New-Item -ItemType Directory -Force -Path $runtimePath | Out-Null
$listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 38765 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    Write-Output 'Port 38765 is already listening. Run node src/call.mjs mc_observe to verify the bridge.'
    exit 0
}
$nodePath = (Get-Command node.exe).Source
$serverPath = Join-Path $bridgeRoot 'src/server.mjs'
$bridgeProcess = Start-Process -FilePath $nodePath -ArgumentList ('"' + $serverPath + '"') -WorkingDirectory $bridgeRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimePath 'stdout.log') -RedirectStandardError (Join-Path $runtimePath 'stderr.log') -PassThru
Set-Content -LiteralPath (Join-Path $runtimePath 'pid') -Value $bridgeProcess.Id
Write-Output "Started bridge process $($bridgeProcess.Id). Verify with node src/call.mjs mc_observe."
