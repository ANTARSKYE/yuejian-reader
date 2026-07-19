$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$VersionInfo = Get-Content -LiteralPath (Join-Path (Split-Path $Root -Parent) "version.json") -Raw | ConvertFrom-Json
$AndroidVersion = [string]$VersionInfo.android
Set-Location -LiteralPath $Root
$Tools = Join-Path $Root "tools"
$Jdk = Join-Path $Root "tools\jdk"
$Sdk = Join-Path $Root "sdk"
$Gradle = Join-Path $Root "tools\gradle\bin\gradle.bat"

if (-not (Test-Path $Jdk)) { throw "缺少本地 JDK，请先运行 tools-setup.ps1" }
if (-not (Test-Path $Gradle)) { throw "缺少本地 Gradle，请先运行 tools-setup.ps1" }
if (-not (Test-Path (Join-Path $Sdk "platforms\android-35"))) { throw "缺少 Android SDK，请先运行 tools-setup.ps1" }

$Keystore = Join-Path $Tools "release.keystore"
$PasswordFile = Join-Path $Tools "release-password.txt"
$FingerprintFile = Join-Path $Tools "release-keystore.sha256"
if (-not (Test-Path $Keystore)) { throw "Missing release.keystore. Restore the original signing key from a secure backup." }
$Password = [string]$env:YUEJIAN_KEYSTORE_PASSWORD
if ([string]::IsNullOrWhiteSpace($Password) -and (Test-Path $PasswordFile)) { $Password = (Get-Content -LiteralPath $PasswordFile -Raw).Trim() }
if ([string]::IsNullOrWhiteSpace($Password)) { throw "Missing signing password. Set YUEJIAN_KEYSTORE_PASSWORD or restore release-password.txt." }
if (-not (Test-Path $FingerprintFile)) { throw "Missing release-keystore.sha256. Restore it from a secure backup." }
$ExpectedKeystoreHash = (Get-Content -LiteralPath $FingerprintFile -Raw).Trim().ToLowerInvariant()
$ActualKeystoreHash = (Get-FileHash -LiteralPath $Keystore -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ExpectedKeystoreHash -ne $ActualKeystoreHash) { throw "Release keystore fingerprint mismatch. Build stopped to protect update continuity." }

$env:JAVA_HOME = $Jdk
$env:ANDROID_HOME = $Sdk
$env:ANDROID_SDK_ROOT = $Sdk
Set-Content -LiteralPath (Join-Path $Root "local.properties") -Value ("sdk.dir=" + ($Sdk -replace '\\','\\')) -Encoding ASCII

& $Gradle --no-daemon clean testReleaseUnitTest lintRelease assembleRelease bundleRelease
if ($LASTEXITCODE -ne 0) { throw "Android 构建失败" }

$Release = Join-Path $Root "release"
New-Item -ItemType Directory -Force $Release | Out-Null
$Unsigned = Join-Path $Root "app\build\outputs\apk\release\app-release-unsigned.apk"
$Aligned = Join-Path $Release "Yuejian-Android-aligned.apk"
$Output = Join-Path $Release "Yuejian-Android.apk"
& (Join-Path $Sdk "build-tools\35.0.0\zipalign.exe") -f -p 4 $Unsigned $Aligned
if ($LASTEXITCODE -ne 0) { throw "APK 对齐失败" }
& (Join-Path $Sdk "build-tools\35.0.0\apksigner.bat") sign --ks $Keystore --ks-key-alias yuejian --ks-pass "pass:$Password" --key-pass "pass:$Password" --out $Output $Aligned
if ($LASTEXITCODE -ne 0) { throw "APK 签名失败" }
Remove-Item -LiteralPath $Aligned -Force
& (Join-Path $Sdk "build-tools\35.0.0\apksigner.bat") verify --verbose $Output
if ($LASTEXITCODE -ne 0) { throw "APK 签名校验失败" }
$UnsignedBundle = Join-Path $Root "app\build\outputs\bundle\release\app-release.aab"
$BundleOutput = Join-Path $Release "Yuejian-Android-$AndroidVersion.aab"
& (Join-Path $Jdk "bin\jarsigner.exe") -keystore $Keystore -storepass $Password -keypass $Password -signedjar $BundleOutput $UnsignedBundle yuejian
if ($LASTEXITCODE -ne 0) { throw "Android App Bundle 签名失败" }
& (Join-Path $Jdk "bin\jarsigner.exe") -verify $BundleOutput
if ($LASTEXITCODE -ne 0) { throw "Android App Bundle 签名校验失败" }
Write-Host "APK: $Release\Yuejian-Android.apk"
Write-Host "AAB: $BundleOutput"
