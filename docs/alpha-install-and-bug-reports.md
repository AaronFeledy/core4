---
title: Alpha install and bug reports
description: How to install the Lando 4 Alpha prerelease and where to file bug reports with the right diagnostic files attached.
---

# Alpha install and bug reports

Lando v4 is an **experimental Alpha**. The first-time install path is still being finalized.

## Current install options

### Option 1: GitHub dev prerelease (Linux x64 only)

The CI pipeline publishes a `v4.0.0-dev.N` GitHub prerelease after each successful `main` build. This prerelease includes:

- `lando` : the Linux x64 compiled binary
- `SHA256SUMS` : checksum manifest

**Platform support:** Linux x64 only. Windows and macOS binaries are deferred.

**To install:**

1. Go to the [Releases page](https://github.com/AaronFeledy/core4/releases) and find the latest `v4.0.0-dev.N` prerelease
2. Download both `lando` and `SHA256SUMS`
3. Verify the checksum:

```bash
sha256sum -c SHA256SUMS
```

The checksum command must report `lando: OK`. If it does not, delete the binary and `SHA256SUMS`, then download them again from the same dev prerelease.

4. Make it executable and test:

```bash
chmod +x lando
./lando --version
```

**If no dev prerelease exists yet:** CI artifacts are available from [recent workflow runs](https://github.com/AaronFeledy/core4/actions/workflows/ci.yml?query=branch%3Amain+is%3Asuccess). Download the `lando-linux-x64` artifact (requires GitHub login). The artifact is a zip containing the `lando` binary plus helper executables. Extract and verify manually.

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

## First-time setup

After the binary is on your `PATH` (or you are running the source CLI):

```bash
lando setup
lando doctor
```

`lando setup --yes` consents to automatic prerequisite install (uidmap on Ubuntu and Debian). It does not switch providers.

The default provider is `lando`: a Lando-managed Podman runtime. It does not use your system Docker or Podman. Leftover `defaultProviderId` in user config does not pick Docker on setup.

### If setup fails

Read the error. Then run `lando doctor`. Most rootless Podman host gaps (uidmap, subuid/subgid ranges, cgroups, `XDG_RUNTIME_DIR`) are auto-fixed or printed with a command you can run.

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

### Linux fallback: system Docker

If the default managed runtime still cannot install, and you already have working system Docker, use Docker as the supported Linux fallback:

```bash
lando setup --provider=docker
```

Or for one command:

```bash
LANDO_PROVIDER=docker lando start
```

`--provider=docker` requires Docker to already be installed. Setup will not install Docker for you. This is a fallback, not the default. See [Choose a provider](guides/setup/provider-selection.mdx).

### Verify

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
- The install path you used: Linux x64 dev prerelease binary or built from source.
- Host details: operating system, architecture, Bun version, and provider runtime details when the bug involves setup/start/stop/destroy.

Do not paste secrets or credentials. Lando redacts known secret-shaped values in its own diagnostics, but shell transcripts and copied logs can still contain project-specific sensitive data.
