---
title: Alpha install and bug reports
description: How to install the Lando 4 Alpha prerelease and where to file bug reports with the right diagnostic files attached.
---

# Alpha install and bug reports

Lando v4 is an **experimental Alpha**. The first-time install path is still being finalized.

## Current install options

### Option 1: GitHub dev prerelease (Linux x64 only)

The CI pipeline publishes a `v4.0.0-dev.N` GitHub prerelease after each successful `main` build. This prerelease includes:

- `lando` — the Linux x64 compiled binary
- `SHA256SUMS` — checksum manifest

**Platform support:** Linux x64 only. Windows binaries are deferred. macOS users should use the npm install path until macOS binary promotion lands in Beta.

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

### Option 2: npm dev install (Linux/macOS)

The CI pipeline publishes `@lando/core@dev` to npm after each successful `main` build.

**To install:**

```bash
npm install -g @lando/core@dev
npx lando --version
```

**If the `dev` tag does not exist yet:** The release workflow runs automatically after CI completes on `main`. Check the [release workflow runs](https://github.com/AaronFeledy/core4/actions/workflows/release.yml) for status. The `npm-alpha-packages` job publishes the `dev` tag.

### Option 3: Build from source

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

After installing the binary or npm package, run:

```bash
lando setup
```

This installs and configures the managed Podman runtime. If setup encounters issues, run:

```bash
lando doctor
```

`lando doctor` diagnoses common first-time issues and suggests fixes. Most rootless Podman prerequisites (uidmap, subuid/subgid ranges, cgroups, kernel settings) are handled automatically by setup or flagged with remediation by doctor.

**Note on local bundle testing:** The committed runtime bundle manifest currently points at placeholder URLs. To test the full setup flow, build a local bundle with `scripts/build-runtime-bundle.ts` and point `LANDO_RUNTIME_BUNDLE_MANIFEST` at it. Users who already have Docker installed may use `--provider=docker` if they prefer.

## Installers and update manifests (not yet available)

The following install paths are **not yet available** in Alpha:

- **POSIX installer script** at `https://get.lando.dev/install.sh` (referenced in `scripts/install.sh`)
- **Channel manifests** at `https://update.lando.dev/v4/{stable,next,dev}.json`

These will be stood up before Beta. For now, use the GitHub prerelease or npm install paths above.

## Provider setup

After installing Lando, run setup to provision the container runtime provider:

```bash
lando setup
```

The default provider is the **Lando-managed Podman runtime**. This bundles a rootless Podman installation that runs independently of any system Docker or Podman.

### Setup requirements for managed Podman

The managed Podman provider requires:

- **Linux x64 or arm64** (Ubuntu, Debian, Fedora, or compatible distributions)
- **Subordinate UID/GID ranges** configured in `/etc/subuid` and `/etc/subgid`
- **uidmap helper tools** (`newuidmap` and `newgidmap`)
- **cgroups v2 controller delegation** (requires systemd on most distributions)
- **XDG_RUNTIME_DIR** set for your user session

#### Installing uidmap tools

On **Ubuntu 26.04**, Lando can automatically install the `uidmap` package if you consent with `lando setup --yes`. On other distributions, you must install uidmap tools manually before running setup:

**Debian/Ubuntu:**
```bash
sudo apt-get install uidmap
```

**Fedora/RHEL:**
```bash
sudo dnf install shadow-utils
```

After installing uidmap, rerun `lando setup` to complete the provider configuration.

#### Configuring cgroups v2 delegation

If setup fails with a cgroups v2 delegation error, enable systemd user cgroup delegation. Create `/etc/systemd/system/user@.service.d/delegate.conf` with:

```ini
[Service]
Delegate=cpu cpuset io memory pids
```

Then reload systemd and rerun setup:

```bash
sudo systemctl daemon-reload
lando setup
```

#### Configuring subordinate UIDs/GIDs

If setup fails with a subuid/subgid error, ensure your user has subordinate UID and GID ranges. Check `/etc/subuid` and `/etc/subgid` for an entry like:

```
yourusername:100000:65536
```

If missing, add entries manually (requires root), then rerun `lando setup`.

#### XDG_RUNTIME_DIR

If setup fails with an XDG_RUNTIME_DIR error, ensure your user session sets this variable. Most modern distributions with systemd set this automatically. Verify with:

```bash
echo $XDG_RUNTIME_DIR
```

If empty, log out and back in, or configure your session manager to set it.

After setup completes, verify the runtime is ready:

```bash
lando doctor
```

Advanced users who prefer system Docker can specify `--provider=docker` when running setup.

## Bug report checklist

Before filing an Alpha bug, run diagnostics and include the output:

```bash
lando doctor
```

Include these artifacts when available:

- The command you ran, its full stdout/stderr, and its exit code.
- `lando doctor` output.
- Any diagnostic `logsDir` and `cacheDir` paths printed in the failure report.
- The install path you used: Linux x64 dev prerelease binary or `npm install @lando/core@dev`.
- Host details: operating system, architecture, Bun version, and provider runtime details when the bug involves setup/start/stop/destroy.

Do not paste secrets or credentials. Lando redacts known secret-shaped values in its own diagnostics, but shell transcripts and copied logs can still contain project-specific sensitive data.
