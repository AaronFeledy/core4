# allow: SIZE_OK — downloadable bootstrap must remain standalone, including signature verification and ownership checks.
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Fail([string] $Message) {
  [Console]::Error.WriteLine($Message)
  exit 1
}

function EnvValue([string] $Name) {
  return [Environment]::GetEnvironmentVariable($Name)
}

function Download-File([string] $Url, [string] $Out) {
  if ($Url.StartsWith("file://", [StringComparison]::OrdinalIgnoreCase)) {
    Copy-Item -LiteralPath ([Uri] $Url).LocalPath -Destination $Out -Force
    return
  }
  if ([IO.Path]::IsPathRooted($Url)) {
    Copy-Item -LiteralPath $Url -Destination $Out -Force
    return
  }
  if ($Url.StartsWith("http://", [StringComparison]::OrdinalIgnoreCase) -or $Url.StartsWith("https://", [StringComparison]::OrdinalIgnoreCase)) {
    Invoke-WebRequest -Uri $Url -OutFile $Out -UseBasicParsing
    return
  }
  Fail "Unsupported download URL: $Url"
}

function Get-ManifestBinaryField($Manifest, [string] $Platform, [string] $Field) {
  $entry = $Manifest.binaries.PSObject.Properties[$Platform]
  if ($null -eq $entry) { Fail "Release manifest has no binary entry for $Platform" }
  $value = $entry.Value.PSObject.Properties[$Field]
  if ($null -eq $value -or [string]::IsNullOrWhiteSpace([string] $value.Value)) {
    Fail "Release manifest binary entry for $Platform is missing $Field"
  }
  return [string] $value.Value
}

function Get-ManifestChecksumField($Manifest, [string] $Field) {
  $checksums = $Manifest.PSObject.Properties["checksums"]
  if ($null -eq $checksums) { Fail "Release manifest is missing checksums" }
  $value = $checksums.Value.PSObject.Properties[$Field]
  if ($null -eq $value -or [string]::IsNullOrWhiteSpace([string] $value.Value)) {
    Fail "Release manifest checksums entry is missing $Field"
  }
  return [string] $value.Value
}

function Get-CosignCertificateUrl([string] $SignatureUrl) {
  $override = EnvValue "LANDO_INSTALL_COSIGN_CERTIFICATE_URL"
  if (-not [string]::IsNullOrWhiteSpace($override)) { return $override }
  if ($SignatureUrl.EndsWith(".sig", [StringComparison]::OrdinalIgnoreCase)) {
    return "$($SignatureUrl.Substring(0, $SignatureUrl.Length - 4)).crt"
  }
  Fail "Cannot derive cosign certificate URL from signature URL: $SignatureUrl"
}

function Detect-Platform {
  $arch = EnvValue "LANDO_INSTALL_WINDOWS_ARCH"
  if ([string]::IsNullOrWhiteSpace($arch)) {
    $arch = EnvValue "PROCESSOR_ARCHITECTURE"
    $hostArch = EnvValue "PROCESSOR_ARCHITEW6432"
    if ([string]::IsNullOrWhiteSpace($arch) -or $arch -eq "x86") { $arch = $hostArch }
  }
  switch -Regex ($arch) {
    "^(AMD64|x86_64|x64)$" { return "windows-x64" }
    default { Fail "Unsupported Windows architecture: $arch" }
  }
}

function Default-InstallDir {
  $installDir = EnvValue "LANDO_INSTALL_DIR"
  if (-not [string]::IsNullOrWhiteSpace($installDir)) { return $installDir }

  return (Join-Path (Default-UserDataRoot) "bin")
}

function Quote-PowerShellString([string] $Value) {
  return "'$($Value.Replace("'", "''"))'"
}

# Print commands that apply the installed, record-verified shellenv for this session and future sessions.
function Write-PathGuidance([string] $InstalledPath) {
  Write-Output ""
  Write-Output "Run this command to add Lando to PATH in this PowerShell session:"
  Write-Output "& $(Quote-PowerShellString $installedPath) shellenv --shell=powershell | Out-String | Invoke-Expression"
  Write-Output "To keep Lando on PATH in new PowerShell sessions, append its shellenv to `$PROFILE:"
  Write-Output 'New-Item -ItemType Directory -Force -Path (Split-Path -Parent $PROFILE) | Out-Null'
  Write-Output 'if (-not (Test-Path -LiteralPath $PROFILE)) { New-Item -ItemType File -Path $PROFILE | Out-Null }'
  Write-Output "& $(Quote-PowerShellString $installedPath) shellenv --shell=powershell | Add-Content -LiteralPath `$PROFILE"
}

function Invoke-PostInstallSetup([string] $InstalledPath) {
  $shouldRunSetup = (EnvValue "LANDO_INSTALL_RUN_SETUP") -eq "1"
  if (-not $shouldRunSetup) {
    $shouldSkipPrompt = (EnvValue "LANDO_INSTALL_SKIP_SETUP") -eq "1"
    if (-not $shouldSkipPrompt) { $shouldSkipPrompt = (EnvValue "LANDO_INSTALL_NONINTERACTIVE") -eq "1" }
    if (-not $shouldSkipPrompt) { $shouldSkipPrompt = [Console]::IsInputRedirected }
    if (-not $shouldSkipPrompt) {
      $answer = Read-Host "Run lando4.exe setup now? [y/N]"
      $shouldRunSetup = $answer -in @("y", "Y", "yes", "YES")
    }
  }

  if ($shouldRunSetup) {
    & $InstalledPath setup --yes
    if ($LASTEXITCODE -ne 0) { Fail "Post-install setup failed" }
    Write-Output "post-install setup: completed"
    return
  }

  Write-Output "post-install setup: skipped"
  Write-Output "Run setup later with: $(Quote-PowerShellString $InstalledPath) setup"
}

function Default-UserDataRoot {
  $userDataRoot = EnvValue "LANDO_USER_DATA_ROOT"
  if (-not [string]::IsNullOrEmpty($userDataRoot)) { return $userDataRoot }
  $localAppData = EnvValue "LOCALAPPDATA"
  if ([string]::IsNullOrEmpty($localAppData)) {
    $homeRoot = EnvValue "HOME"
    if ($null -eq $homeRoot) { $homeRoot = EnvValue "USERPROFILE" }
    if ($null -eq $homeRoot) { $homeRoot = "." }
    $localAppData = Join-Path $homeRoot "AppData/Local"
  }
  return (Join-Path $localAppData "Lando/Data")
}

function Get-InstallItem([string] $Path) {
  try { return Get-Item -LiteralPath $Path -Force -ErrorAction Stop }
  catch [System.Management.Automation.ItemNotFoundException] { return $null }
}

function Assert-OwnedDestination([string] $Destination, [string] $RecordPath) {
  $message = "Refusing to replace unowned destination $Destination. Choose a different LANDO_INSTALL_DIR."
  try {
    $item = Get-InstallItem $Destination
    if ($null -ne $item -and ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint))) { Fail $message }
    $recordItem = Get-InstallItem $RecordPath
    if ($null -ne $recordItem -and ($recordItem.PSIsContainer -or ($recordItem.Attributes -band [IO.FileAttributes]::ReparsePoint))) { Fail $message }
    if ($null -eq $item) { return }
    if ($null -eq $recordItem) { Fail $message }
    $record = Get-Content -Raw -LiteralPath $RecordPath | ConvertFrom-Json
    if (($record.version -isnot [long] -and $record.version -isnot [int]) -or $record.version -ne 1) { Fail $message }
    $owned = $record.data.executable
    if ($owned.path -isnot [string] -or -not [string]::Equals([IO.Path]::GetFullPath($owned.path), [IO.Path]::GetFullPath($Destination), [StringComparison]::Ordinal)) { Fail $message }
    if ($owned.sha256 -isnot [string] -or $owned.sha256 -cnotmatch '^[0-9a-f]{64}$') { Fail $message }
    if (($owned.size -isnot [long] -and $owned.size -isnot [int]) -or $owned.size -ne $item.Length) { Fail $message }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $Destination).Hash.ToLowerInvariant() -cne $owned.sha256) { Fail $message }
  }
  catch { Fail $message }
}

function Basename-FromUrl([string] $Url) {
  $path = $Url.Split("?")[0]
  if ($path.StartsWith("file://", [StringComparison]::OrdinalIgnoreCase)) { $path = ([Uri] $path).LocalPath }
  elseif ($path.StartsWith("http://", [StringComparison]::OrdinalIgnoreCase) -or $path.StartsWith("https://", [StringComparison]::OrdinalIgnoreCase)) { $path = ([Uri] $path).AbsolutePath }
  return [IO.Path]::GetFileName($path)
}

function Verify-Checksum([string] $Sums, [string] $Binary, [string] $Artifact) {
  $expected = $null
  foreach ($line in Get-Content -LiteralPath $Sums) {
    $parts = $line -split "\s+", 3
    if ($parts.Length -lt 2) { continue }
    $path = $parts[1]
    if ($path -eq $Artifact -or [IO.Path]::GetFileName($path) -eq $Artifact) {
      $expected = $parts[0]
      break
    }
  }
  if ([string]::IsNullOrWhiteSpace($expected)) { Fail "Checksum manifest does not contain $Artifact" }
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Binary).Hash.ToLowerInvariant()
  if ($actual -ne $expected.ToLowerInvariant()) { Fail "Checksum mismatch for $Artifact" }
}

$DefaultCosignTrustRoot = @'
{"certificateIdentityRegexp":"^https://github.com/lando-community/core4/.github/workflows/release.yml@refs/tags/.+$","certificateOidcIssuer":"https://token.actions.githubusercontent.com"}
'@

function Read-CosignTrustRoot {
  $trustRootPath = EnvValue "LANDO_INSTALL_COSIGN_TRUST_ROOT"
  try {
    if (-not [string]::IsNullOrWhiteSpace($trustRootPath)) {
      if (-not (Test-Path -LiteralPath $trustRootPath -PathType Leaf)) { Fail "Missing or malformed vendored cosign trust root" }
      $trustRoot = Get-Content -Raw -LiteralPath $trustRootPath | ConvertFrom-Json
    }
    else {
      $trustRoot = $DefaultCosignTrustRoot | ConvertFrom-Json
    }
  }
  catch {
    Fail "Missing or malformed vendored cosign trust root"
  }

  $identity = $trustRoot.PSObject.Properties["certificateIdentityRegexp"]
  $issuer = $trustRoot.PSObject.Properties["certificateOidcIssuer"]
  if ($null -eq $identity -or [string]::IsNullOrWhiteSpace([string] $identity.Value)) {
    Fail "Missing or malformed vendored cosign trust root"
  }
  if ($null -eq $issuer -or [string]::IsNullOrWhiteSpace([string] $issuer.Value)) {
    Fail "Missing or malformed vendored cosign trust root"
  }

  return @{
    CertificateIdentityRegexp = [string] $identity.Value
    CertificateOidcIssuer = [string] $issuer.Value
  }
}

function Verify-ChecksumsSignature([string] $SignatureUrl, [string] $Sums, [string] $Signature, [string] $Tmp) {
  if (-not $SignatureUrl.EndsWith(".sig", [StringComparison]::OrdinalIgnoreCase)) {
    Fail "Windows installer requires a cosign SHA256SUMS.sig signature"
  }
  $certificate = Join-Path $Tmp "SHA256SUMS.crt"
  Download-File (Get-CosignCertificateUrl $SignatureUrl) $certificate
  $cosign = EnvValue "LANDO_INSTALL_COSIGN"
  if ([string]::IsNullOrWhiteSpace($cosign)) { $cosign = "cosign" }
  $trustRoot = Read-CosignTrustRoot

  & $cosign verify-blob `
    --certificate-identity-regexp $trustRoot.CertificateIdentityRegexp `
    --certificate-oidc-issuer $trustRoot.CertificateOidcIssuer `
    --signature $Signature `
    --certificate $certificate `
    $Sums *> $null
  if ($LASTEXITCODE -ne 0) { Fail "Signature verification failed for SHA256SUMS" }
}

if ((EnvValue "LANDO_INSTALL_EXECUTION_POLICY_BLOCKED") -eq "1") {
  Fail "PowerShell execution policy blocked install.ps1. Run: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned, or invoke once with: powershell -ExecutionPolicy Bypass -File install.ps1"
}

$channel = EnvValue "LANDO_CHANNEL"
if ([string]::IsNullOrWhiteSpace($channel)) { $channel = "stable" }
if ($channel -notin @("stable", "next", "dev")) { Fail "Unsupported Lando channel: $channel" }

$platform = Detect-Platform
$baseUrl = EnvValue "LANDO_INSTALL_BASE_URL"
if ([string]::IsNullOrWhiteSpace($baseUrl)) { $baseUrl = "https://update.lando.dev/v4" }
$manifestUrl = EnvValue "LANDO_INSTALL_MANIFEST_URL"
if ([string]::IsNullOrWhiteSpace($manifestUrl)) { $manifestUrl = "$($baseUrl.TrimEnd('/'))/$channel.json" }
$installDir = [IO.Path]::GetFullPath((Default-InstallDir))
$installedPath = Join-Path $installDir "lando4.exe"
$recordPath = Join-Path ([IO.Path]::GetFullPath((Default-UserDataRoot))) "install/record.json"
Assert-OwnedDestination $installedPath $recordPath
$binaryStage = Join-Path $installDir ".lando4-$([Guid]::NewGuid().ToString('n')).tmp"
$recordStage = "$recordPath.$([Guid]::NewGuid().ToString('n')).tmp"
$tmp = Join-Path ([IO.Path]::GetTempPath()) "lando-install-$([Guid]::NewGuid().ToString('n'))"
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

try {
  $manifestPath = Join-Path $tmp "manifest.json"
  $sums = Join-Path $tmp "SHA256SUMS"
  $signature = Join-Path $tmp "SHA256SUMS.signature"
  $binary = Join-Path $tmp "lando4.exe"

  Download-File $manifestUrl $manifestPath
  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  $binaryUrl = Get-ManifestBinaryField $manifest $platform "url"
  $sumsUrl = Get-ManifestChecksumField $manifest "url"
  $signatureUrl = Get-ManifestChecksumField $manifest "signature"
  $artifact = Basename-FromUrl $binaryUrl

  Download-File $binaryUrl $binary
  Download-File $sumsUrl $sums
  Download-File $signatureUrl $signature

  Verify-ChecksumsSignature $signatureUrl $sums $signature $tmp
  Verify-Checksum $sums $binary $artifact

  New-Item -ItemType Directory -Path $installDir -Force | Out-Null
  Copy-Item -LiteralPath $binary -Destination $binaryStage
  $record = [ordered]@{
    version = 1
    data = [ordered]@{
      executable = [ordered]@{
        path = $installedPath
        sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $binaryStage).Hash.ToLowerInvariant()
        size = (Get-Item -LiteralPath $binaryStage -Force).Length
        channel = $channel
        platform = $platform
      }
      shellProfiles = @()
    }
  }
  Move-Item -LiteralPath $binaryStage -Destination $installedPath -Force
  New-Item -ItemType Directory -Path (Split-Path -Parent $recordPath) -Force | Out-Null
  [IO.File]::WriteAllText($recordStage, ($record | ConvertTo-Json -Depth 4 -Compress), (New-Object Text.UTF8Encoding $false))
  Move-Item -LiteralPath $recordStage -Destination $recordPath -Force

  Write-Output "channel: $channel"
  Write-Output "platform: $platform"
  Write-Output "installed: $installedPath"
  Write-PathGuidance $installedPath
  Invoke-PostInstallSetup $installedPath
}
finally {
  Remove-Item -LiteralPath $binaryStage, $recordStage -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
