$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Root = $PSScriptRoot
$Tools = Join-Path $Root "tools"
$Sdk = Join-Path $Root "sdk"
$Downloads = Join-Path $Tools "downloads"
New-Item -ItemType Directory -Force $Tools, $Sdk, $Downloads | Out-Null

function Download-File([string]$Uri, [string]$Destination) {
    Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
    & node (Join-Path $Root "download.mjs") $Uri $Destination
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $Destination)) { throw "下载失败: $Uri" }
}

function Expand-SingleRoot([string]$Archive, [string]$Destination) {
    $temporary = "$Destination.tmp"
    Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force $temporary | Out-Null
    Expand-Archive -LiteralPath $Archive -DestinationPath $temporary -Force
    $children = @(Get-ChildItem -LiteralPath $temporary -Force)
    $source = if ($children.Count -eq 1 -and $children[0].PSIsContainer) { $children[0].FullName } else { $temporary }
    Remove-Item -LiteralPath $Destination -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item -LiteralPath $source -Destination $Destination
    if (Test-Path $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}

$Jdk = Join-Path $Tools "jdk"
if (-not (Test-Path (Join-Path $Jdk "bin\java.exe"))) {
    Write-Host "Downloading local JDK 17..."
    $archive = Join-Path $Downloads "jdk17.zip"
    Download-File "https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse" $archive
    Expand-SingleRoot $archive $Jdk
}
$env:JAVA_HOME = $Jdk

$GradleHome = Join-Path $Tools "gradle"
if (-not (Test-Path (Join-Path $GradleHome "bin\gradle.bat"))) {
    Write-Host "Downloading local Gradle 8.11.1..."
    $archive = Join-Path $Downloads "gradle.zip"
    Download-File "https://downloads.gradle.org/distributions/gradle-8.11.1-bin.zip" $archive
    Expand-SingleRoot $archive $GradleHome
}

$Cmdline = Join-Path $Sdk "cmdline-tools\latest"
if (-not (Test-Path (Join-Path $Cmdline "bin\sdkmanager.bat"))) {
    Write-Host "Downloading Android command-line tools..."
    $archive = Join-Path $Downloads "commandlinetools.zip"
    Download-File "https://dl.google.com/android/repository/commandlinetools-win-14742923_latest.zip" $archive
    $temporary = Join-Path $Sdk "cmdline-tools-temp"
    Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive -LiteralPath $archive -DestinationPath $temporary -Force
    New-Item -ItemType Directory -Force (Split-Path $Cmdline) | Out-Null
    Move-Item -LiteralPath (Join-Path $temporary "cmdline-tools") -Destination $Cmdline
    Remove-Item -LiteralPath $temporary -Recurse -Force
}

$env:ANDROID_HOME = $Sdk
$env:ANDROID_SDK_ROOT = $Sdk
$proxyValue = $env:HTTPS_PROXY
if ($proxyValue) {
    try {
        $proxyUri = [Uri]$proxyValue
        $env:JAVA_TOOL_OPTIONS = "-Dhttps.proxyHost=$($proxyUri.Host) -Dhttps.proxyPort=$($proxyUri.Port) -Dhttp.proxyHost=$($proxyUri.Host) -Dhttp.proxyPort=$($proxyUri.Port)"
    } catch {}
}
$SdkManager = Join-Path $Cmdline "bin\sdkmanager.bat"
Write-Host "Accepting Android SDK licenses..."
$previousErrorAction = $ErrorActionPreference
$ErrorActionPreference = "Continue"
(1..200 | ForEach-Object { "y" }) | & $SdkManager --sdk_root=$Sdk --licenses
$ErrorActionPreference = $previousErrorAction
Write-Host "Installing Android SDK packages..."
& $SdkManager --sdk_root=$Sdk "platform-tools" "platforms;android-35" "build-tools;35.0.0"
if ($LASTEXITCODE -ne 0) { throw "Android SDK 安装失败" }
Write-Host "Android build tools are ready."
