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

function Resolve-ConfigFileRoot {
  $override = EnvValue "LANDO_CONFIG__user_conf_root"
  if (-not [string]::IsNullOrWhiteSpace($override)) { return $override }

  $userConfRoot = EnvValue "LANDO_USER_CONF_ROOT"
  if (-not [string]::IsNullOrWhiteSpace($userConfRoot)) { return $userConfRoot }

  $appData = EnvValue "APPDATA"
  if (-not [string]::IsNullOrWhiteSpace($appData)) { return (Join-Path $appData "Lando") }

  return (Join-Path (Get-Location).Path ".lando")
}

function Read-ConfigUserDataRoot([string] $ConfRoot) {
  $config = Join-Path $ConfRoot "config.yml"
  if (-not (Test-Path -LiteralPath $config -PathType Leaf)) { return $null }

  $value = $null
  $depth = 0
  $indentStack = New-Object 'int[]' 64
  $rootStack = New-Object 'bool[]' 64
  $indentStack[0] = -1
  $rootStack[0] = $true
  foreach ($rawLine in Get-Content -LiteralPath $config) {
    $line = ($rawLine -replace "[ \t]+#.*$", "").TrimEnd()
    $trimmedLine = $line.Trim()
    if ([string]::IsNullOrWhiteSpace($trimmedLine) -or $trimmedLine.StartsWith("#")) { continue }
    if ($trimmedLine -notmatch "^([A-Za-z0-9_-]+)\s*:\s*(.*)$") { return $null }

    $indentMatch = [regex]::Match($line, "[^ ]")
    $indent = if ($indentMatch.Success) { $indentMatch.Index } else { 0 }
    while ($depth -gt 0 -and $indent -le $indentStack[$depth]) { $depth-- }
    if ($indent -le $indentStack[$depth]) { return $null }

    $key = $Matches[1]
    $parentIsRoot = $rootStack[$depth]
    $candidate = $Matches[2].Trim()
    if ([string]::IsNullOrWhiteSpace($candidate)) {
      if ($parentIsRoot -and $key -eq "userDataRoot") { $value = $null }
      $depth++
      $indentStack[$depth] = $indent
      $rootStack[$depth] = $false
      continue
    }
    if (-not $parentIsRoot -or $key -ne "userDataRoot") { continue }

    if (($candidate.StartsWith('"') -and $candidate.EndsWith('"')) -or ($candidate.StartsWith("'") -and $candidate.EndsWith("'"))) {
      $candidate = $candidate.Substring(1, $candidate.Length - 2)
    }
    if ([string]::IsNullOrWhiteSpace($candidate)) { $value = $null; continue }
    if ($candidate -in @("null", "true", "false")) { $value = $null; continue }
    if ($candidate.StartsWith("[") -or $candidate.StartsWith("{")) { $value = $null; continue }
    $value = $candidate
  }

  return $value
}

function Default-InstallDir {
  $installDir = EnvValue "LANDO_INSTALL_DIR"
  if (-not [string]::IsNullOrWhiteSpace($installDir)) { return $installDir }

  $userDataRoot = EnvValue "LANDO_USER_DATA_ROOT"
  if (-not [string]::IsNullOrWhiteSpace($userDataRoot)) { return (Join-Path $userDataRoot "bin") }

  $configured = Read-ConfigUserDataRoot (Resolve-ConfigFileRoot)
  if (-not [string]::IsNullOrWhiteSpace($configured)) { return (Join-Path $configured "bin") }

  $localAppData = EnvValue "LOCALAPPDATA"
  if (-not [string]::IsNullOrWhiteSpace($localAppData)) { return (Join-Path $localAppData "Lando\Data\bin") }

  $userProfile = EnvValue "USERPROFILE"
  if (-not [string]::IsNullOrWhiteSpace($userProfile)) { return (Join-Path $userProfile "AppData\Local\Lando\Data\bin") }

  return (Join-Path (Get-Location).Path ".lando\bin")
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

function Verify-ChecksumsSignature([string] $SignatureUrl, [string] $Sums, [string] $Signature, [string] $Tmp) {
  if (-not $SignatureUrl.EndsWith(".sig", [StringComparison]::OrdinalIgnoreCase)) {
    Fail "Windows installer requires a cosign SHA256SUMS.sig signature"
  }
  $certificate = Join-Path $Tmp "SHA256SUMS.crt"
  Download-File (Get-CosignCertificateUrl $SignatureUrl) $certificate
  $cosign = EnvValue "LANDO_INSTALL_COSIGN"
  if ([string]::IsNullOrWhiteSpace($cosign)) { $cosign = "cosign" }
  $certificateIdentity = EnvValue "LANDO_INSTALL_COSIGN_CERTIFICATE_IDENTITY_REGEXP"
  if ([string]::IsNullOrWhiteSpace($certificateIdentity)) {
    $certificateIdentity = "^https://github.com/lando-community/core4/.github/workflows/release.yml@refs/tags/.+$"
  }
  $certificateIssuer = EnvValue "LANDO_INSTALL_COSIGN_CERTIFICATE_OIDC_ISSUER"
  if ([string]::IsNullOrWhiteSpace($certificateIssuer)) { $certificateIssuer = "https://token.actions.githubusercontent.com" }

  & $cosign verify-blob `
    --certificate-identity-regexp $certificateIdentity `
    --certificate-oidc-issuer $certificateIssuer `
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
$installDir = Default-InstallDir
$tmp = Join-Path ([IO.Path]::GetTempPath()) "lando-install-$([Guid]::NewGuid().ToString('n'))"
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

try {
  $manifestPath = Join-Path $tmp "manifest.json"
  $sums = Join-Path $tmp "SHA256SUMS"
  $signature = Join-Path $tmp "SHA256SUMS.signature"
  $binary = Join-Path $tmp "lando.exe"

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
  $installedPath = Join-Path $installDir "lando.exe"
  Copy-Item -LiteralPath $binary -Destination $installedPath -Force

  Write-Output "channel: $channel"
  Write-Output "platform: $platform"
  Write-Output "installed: $installedPath"
}
finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
