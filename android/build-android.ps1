$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Tools = Join-Path $Root "tools"
$Jdk = Join-Path $Root "tools\jdk"
$Sdk = Join-Path $Root "sdk"
$Gradle = Join-Path $Root "tools\gradle\bin\gradle.bat"

if (-not (Test-Path $Jdk)) { throw "缺少本地 JDK，请先运行 tools-setup.ps1" }
if (-not (Test-Path $Gradle)) { throw "缺少本地 Gradle，请先运行 tools-setup.ps1" }
if (-not (Test-Path (Join-Path $Sdk "platforms\android-35"))) { throw "缺少 Android SDK，请先运行 tools-setup.ps1" }

$env:JAVA_HOME = $Jdk
$env:ANDROID_HOME = $Sdk
$env:ANDROID_SDK_ROOT = $Sdk
Set-Content -LiteralPath (Join-Path $Root "local.properties") -Value ("sdk.dir=" + ($Sdk -replace '\\','\\')) -Encoding ASCII

& $Gradle --no-daemon clean assembleRelease
if ($LASTEXITCODE -ne 0) { throw "Android 构建失败" }

$Release = Join-Path $Root "release"
New-Item -ItemType Directory -Force $Release | Out-Null
$Unsigned = Join-Path $Root "app\build\outputs\apk\release\app-release-unsigned.apk"
$Aligned = Join-Path $Release "Yuejian-Android-aligned.apk"
$Output = Join-Path $Release "Yuejian-Android.apk"
$Keystore = Join-Path $Tools "release.keystore"
$PasswordFile = Join-Path $Tools "release-password.txt"
if (-not (Test-Path $Keystore) -or -not (Test-Path $PasswordFile)) {
    Remove-Item -LiteralPath $Keystore -Force -ErrorAction SilentlyContinue
    $Password = ([Guid]::NewGuid().ToString("N") + [Guid]::NewGuid().ToString("N"))
    Set-Content -LiteralPath $PasswordFile -Value $Password -Encoding ASCII
    & (Join-Path $Jdk "bin\keytool.exe") -genkeypair -keystore $Keystore -storepass $Password -keypass $Password -alias yuejian -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Yuejian Android, O=Yuejian, C=CN"
    if ($LASTEXITCODE -ne 0) { throw "发布签名创建失败" }
}
$Password = (Get-Content -LiteralPath $PasswordFile -Raw).Trim()
& (Join-Path $Sdk "build-tools\35.0.0\zipalign.exe") -f -p 4 $Unsigned $Aligned
if ($LASTEXITCODE -ne 0) { throw "APK 对齐失败" }
& (Join-Path $Sdk "build-tools\35.0.0\apksigner.bat") sign --ks $Keystore --ks-key-alias yuejian --ks-pass "pass:$Password" --key-pass "pass:$Password" --out $Output $Aligned
if ($LASTEXITCODE -ne 0) { throw "APK 签名失败" }
Remove-Item -LiteralPath $Aligned -Force
& (Join-Path $Sdk "build-tools\35.0.0\apksigner.bat") verify --verbose $Output
if ($LASTEXITCODE -ne 0) { throw "APK 签名校验失败" }
Write-Host "APK: $Release\Yuejian-Android.apk"
