---
title: Get a v4.0.0-dev.N binary and run setup
description: Install the Lando 4 Alpha, run setup, and attach the right diagnostics to a bug report.
---

# Get a v4.0.0-dev.N binary and run setup

Install an unsigned `v4.0.0-dev.N` binary, set up its container provider, and check the result with `lando doctor`. Lando v4 is an experimental Alpha, not a production-ready release.

The recommended path is the GitHub prerelease below. Source builds and troubleshooting follow the installation and setup steps.

## Current install options

### Option 1: GitHub dev prerelease (all six platforms)

The GitHub prerelease ships unsigned `v4.0.0-dev.N` binaries for every compile target. Pick the asset for your host:

- `lando-linux-x64`
- `lando-linux-arm64`
- `lando-darwin-x64`
- `lando-darwin-arm64`
- `lando-windows-x64.exe`
- `lando-windows-arm64.exe`
- `SHA256SUMS`

Targets: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `windows-x64`, `windows-arm64`.

Lando's managed runtime does not require Docker or a system Podman installation. On Intel Macs (`darwin-x64`), the managed runtime is not supported: install and start Docker Desktop before setup, then choose Docker when setup asks.

**To install:**

1. Go to the [Releases page](https://github.com/AaronFeledy/core4/releases) and find the latest `v4.0.0-dev.N` prerelease. Pick the asset for your platform.
2. Download that binary and `SHA256SUMS`.
3. Verify the checksum:

```bash
grep ' lando-linux-x64$' SHA256SUMS | sha256sum -c
```

Replace `lando-linux-x64` with the asset you downloaded. `SHA256SUMS` lists every platform; checking the whole file fails when the other binaries are not in this directory. The piped command must report `OK` for that file (for example `lando-linux-x64: OK`). If it does not, delete the binary and `SHA256SUMS`, then download them again from the same dev prerelease.

On Windows, check the downloaded asset in PowerShell before renaming it:

```powershell
$asset = 'lando-windows-x64.exe'
$expected = (Get-Content .\SHA256SUMS | Where-Object { $_ -match "\s$([regex]::Escape($asset))$" }).Split()[0]
$actual = (Get-FileHash ".\$asset" -Algorithm SHA256).Hash
if (-not $expected -or $actual -ne $expected) { throw "SHA-256 mismatch for $asset" }
```

Use `lando-windows-arm64.exe` for ARM64 Windows. The command exits with an error if the downloaded binary does not match its `SHA256SUMS` entry.

4. On Unix, make it executable and test. On Windows, run the `.exe` instead of `chmod`.

```bash
chmod +x lando-linux-x64
./lando-linux-x64 --version
```

Replace `lando-linux-x64` with your asset name. Windows:

```powershell
.\lando-windows-x64.exe --version
```

Rename the verified Windows binary to `lando.exe` and put it on PATH before setup. Verify that `Get-Command lando` points to the Alpha binary, especially if Lando 3 is already installed. See [Put lando on PATH and run setup](./guides/install/path-and-setup.mdx).

Prefer the GitHub release. If no dev prerelease exists yet, download the `lando-<platform>` artifact from a successful main CI run (GitHub login required). Extract the zip and verify the binary yourself.

## Run lando setup

Put the verified Alpha binary on PATH before continuing. Check that `lando` resolves to that binary, not an existing Lando 3 installation. See [Put lando on PATH and run setup](./guides/install/path-and-setup.mdx).

### Choose setup for your platform

Run setup in your terminal and follow the prompts. On supported hosts, choose the recommended Lando-managed runtime; it does not require Docker or system Podman. On an Intel Mac (`darwin-x64`), install and start Docker Desktop first, then choose Docker when setup asks. Setup does not install Docker for you.

```bash
lando setup
```

Setup saves your choice for later commands. If you already have a saved provider or an environment override, setup keeps that selection instead of showing the provider menu. See [Switch providers](./guides/setup/provider-selection.mdx#switch-providers) when you need to change it.

`lando setup --yes` consents to automatic prerequisite installation, including uidmap on Ubuntu and Debian. It does not switch providers. Alpha setup can still fail if host prerequisites or the managed runtime cannot start; follow the reported diagnosis rather than assuming setup completed.

### Verify setup

After setup, run:

```bash
lando doctor
```

Review any reported issues before starting an app. If doctor offers a fix, use `lando doctor --fix` when appropriate. Once setup is working, continue with [Start, inspect, and tear down an app](./guides/tutorial/app-lifecycle.mdx).

### Fix Linux host prerequisites

Use these steps only when setup identifies the corresponding missing prerequisite. They change host configuration and may need administrator privileges. After fixing the reported problem, rerun `lando setup`, then `lando doctor`.

**uidmap (Fedora/RHEL and unrecognized distros):**

```bash
sudo dnf install shadow-utils
lando setup
```

**Missing subuid/subgid ranges:**

```bash
sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $USER
lando setup
```

**cgroups v2 delegation:**

```bash
sudo mkdir -p /etc/systemd/system/user@.service.d
echo -e "[Service]\nDelegate=cpu cpuset io memory pids" | sudo tee /etc/systemd/system/user@.service.d/delegate.conf
sudo systemctl daemon-reload
lando setup
```

**Missing `XDG_RUNTIME_DIR`:** log out and back in. If it is still missing, your session manager needs a distro-specific fix.

### Use Docker as a Linux fallback

If the managed runtime still cannot install and system Docker is already working, use the fallback below. If you already have apps on another provider, follow [Switch providers](./guides/setup/provider-selection.mdx#switch-providers) first.

```bash
lando setup --provider=docker
```

Setup saves Docker as your provider. Run `lando doctor` to verify the result. Docker is the supported path on Intel Mac and a fallback on Linux, not the default on other targets. See [Override the provider for one command](./guides/setup/provider-selection.mdx#override-the-provider-for-one-command) for temporary overrides.

### Option 2: Build from source

Use this alternative if you are contributing or prebuilt binaries are unavailable. You need Git and the repository-supported Bun version. Run the following in your terminal:

```bash
git clone https://github.com/AaronFeledy/core4.git
cd core4
bun install
bun run codegen
bun run core/bin/lando.ts setup
bun run --filter='@lando/core' build:container-helper
bun run build
# Use the source CLI directly:
bun run core/bin/lando.ts --version
```

The in-container helper is built with Lando itself, so run setup first. You don't need Go installed.

## Installers and update manifests (not yet available)

The following install paths are **not yet available** in Alpha:

- **POSIX installer script** at `https://get.lando.dev/install.sh` (referenced in `scripts/install.sh`)
- **PowerShell installer script** at `https://get.lando.dev/install.ps1` (referenced in `scripts/install.ps1`)
- **Channel manifests** at `https://update.lando.dev/v4/{stable,next,dev}.json`

These will be stood up before Beta. For now, use the GitHub prerelease or build from source paths above.

## Bug report checklist

Before filing an Alpha bug, run diagnostics and include the output:

```bash
lando doctor
```

Include these artifacts when available:

- The command you ran, its full stdout/stderr, and its exit code.
- `lando doctor` output.
- Any diagnostic `logsDir` and `cacheDir` paths printed in the failure report.
- The install path you used: six-target unsigned binary or built from source.
- Host details: operating system, architecture, Bun version, and provider runtime details when the bug involves setup/start/stop/destroy.

Do not paste secrets or credentials. Lando's own diagnostics redact secret-shaped values plus any secret value Lando resolved during that command, but shell transcripts and logs you copy from other tools or your project can still contain sensitive data.
