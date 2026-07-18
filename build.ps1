$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

$venv = Join-Path $PSScriptRoot ".venv"
$python = Join-Path $venv "Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python)) {
    if (Get-Command py -ErrorAction SilentlyContinue) {
        py -3.13 -m venv $venv
    } elseif (Get-Command python -ErrorAction SilentlyContinue) {
        $version = & python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
        if ($version -ne "3.13") {
            throw "Python 3.13 is required; current python is $version."
        }
        python -m venv $venv
    } else {
        throw "Python 3.13 was not found."
    }
}

& $python -m pip install --disable-pip-version-check --upgrade pip
& $python -m pip install --disable-pip-version-check -r requirements-build.txt
& $python -m pytest

& $python -m PyInstaller `
    --noconfirm `
    --clean `
    --onefile `
    --windowed `
    --name Yuejian-Reader-1.4.8 `
    --icon "assets\yuejian.ico" `
    --add-data "index.html;." `
    --add-data "assets;assets" `
    --hidden-import webview.platforms.edgechromium `
    --hidden-import clr_loader `
    desktop.py
if ($LASTEXITCODE -ne 0) {
    throw "Desktop packaging failed with exit code $LASTEXITCODE. Close any running Yuejian-Reader executable and retry."
}

$exe = Join-Path $PSScriptRoot "dist\Yuejian-Reader-1.4.8.exe"
$process = Start-Process -FilePath $exe -ArgumentList "--self-test" -WindowStyle Hidden -Wait -PassThru
if ($process.ExitCode -ne 0) {
    throw "Packaged self-test failed with exit code $($process.ExitCode)."
}
Write-Host "Build and self-test completed: $exe" -ForegroundColor Green
