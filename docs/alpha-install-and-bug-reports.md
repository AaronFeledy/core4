---
title: Alpha install and bug reports
description: Install the Lando 4 Alpha, run setup, and attach the right diagnostics to a bug report.
---

# Get a v4.0.0-dev.N binary and run setup

Get a `v4.0.0-dev.N` binary for your platform, then run `lando setup` and `lando doctor`. Lando v4 is an experimental Alpha.

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

On Intel Macs (`darwin-x64`), Docker is the live path. The default provider stays `lando` on every other target.

**To install:**

1. Go to the [Releases page](https://github.com/AaronFeledy/core4/releases) and find the latest `v4.0.0-dev.N` prerelease. Pick the asset for your platform.
2. Download that binary and `SHA256SUMS`.
3. Verify the checksum:

```bash
sha256sum -c SHA256SUMS
```

The checksum command must report `OK` for the platform-qualified file you downloaded (for example `lando-linux-x64: OK`). If it does not, delete the binary and `SHA256SUMS`, then download them again from the same dev prerelease.

4. On Unix, make it executable and test. On Windows, run the `.exe` instead of `chmod`.

```bash
chmod +x lando-linux-x64
./lando-linux-x64 --version
```

Replace `lando-linux-x64` with your asset name. Windows:

```powershell
.\lando-windows-x64.exe --version
```

Use `lando-windows-arm64.exe` on ARM64 Windows.

Prefer the GitHub release. If no dev prerelease exists yet, download the `lando-<platform>` artifact from a successful main CI run (GitHub login required). Extract the zip and verify the binary yourself.

### Option 2: Build from source

For contributors or when prebuilt binaries are unavailable:

```bash
git clone https://github.com/AaronFeledy/core4.git
cd core4
bun install
bun run codegen
bun run build
# Use the source CLI directly:
bun run core/src/cli/index.ts --version
```

## Run lando setup

You need a `lando` binary from the steps above.

1. Run setup. The default provider is `lando` (Lando-managed Podman). It does not need system Docker or Podman.

```bash
lando setup
```

`lando setup --yes` consents to automatic prerequisite install (uidmap on Ubuntu and Debian). It does not switch providers. Leftover `defaultProviderId` in user config does not pick Docker on setup.

Default setup may fail on Alpha. Host prerequisites (uidmap, subuid/subgid ranges, cgroups) can block the managed runtime, and the runtime may not come up. Do not treat this path as guaranteed.

2. If setup names a host prerequisite, fix it and rerun `lando setup`. Then run `lando doctor`.

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

3. If the managed runtime still cannot install and you have working system Docker, use the supported Linux fallback:

```bash
lando setup --provider=docker
```

Or:

```bash
LANDO_PROVIDER=docker lando setup
```

`--provider=docker` requires Docker to already be installed. Setup will not install Docker for you. After a successful `lando setup --provider=docker`, later `lando doctor` and `lando start` use that last-used provider. You do not need to repeat the flag.

`LANDO_PROVIDER=docker lando setup` does not persist. If you only set the env, keep it for later commands.

This is a fallback, not the default. See [Pick a container provider](./guides/setup/provider-selection.mdx).

4. Verify:

```bash
lando doctor
```

If doctor still reports issues, try `lando doctor --fix` when it offers one.

## Installers and update manifests (not yet available)

The following install paths are **not yet available** in Alpha:

- **POSIX installer script** at `https://get.lando.dev/install.sh` (referenced in `scripts/install.sh`)
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

Do not paste secrets or credentials. Lando redacts known secret-shaped values in its own diagnostics, but shell transcripts and copied logs can still contain project-specific sensitive data.
