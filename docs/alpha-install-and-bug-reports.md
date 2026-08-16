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

## Setting up the managed Podman provider

Lando v4 uses a managed Podman provider by default. On Debian/Ubuntu systems, you need to ensure rootless Podman prerequisites are met:

**Required packages:**
```bash
sudo apt-get update
sudo apt-get install -y uidmap fuse-overlayfs
```

**UID/GID subranges** (for user namespaces):
```bash
# Check if already configured
grep "^$(id -un):" /etc/subuid /etc/subgid

# If missing, add entries
echo "$(id -un):100000:65536" | sudo tee -a /etc/subuid
echo "$(id -un):100000:65536" | sudo tee -a /etc/subgid
```

**Kernel configuration:**
```bash
# Allow unprivileged port binding
sudo sysctl net.ipv4.ip_unprivileged_port_start=0

# Allow unprivileged user namespaces (if AppArmor restricts them)
if test -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns; then
  sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0
fi
```

**Cgroups v2** must be enabled (the default on Ubuntu 22.04+). Verify with:
```bash
grep cgroup2 /proc/mounts
```

**XDG directories:** Lando respects `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, and `XDG_CACHE_HOME`. If unset, it defaults to `~/.local/share/lando`, `~/.config/lando`, and `~/.cache/lando`.

Once prerequisites are met, run `lando setup` to install and configure the managed Podman runtime.

**Note on local bundle testing:** The committed runtime bundle manifest currently points at placeholder URLs. To test the full setup flow, build a local bundle with `scripts/build-runtime-bundle.ts` and point `LANDO_RUNTIME_BUNDLE_MANIFEST` at it. Users who already have Docker installed may use `--provider=docker` if they prefer, but the managed Podman provider is the primary path.

## Installers and update manifests (not yet available)

The following install paths are **not yet available** in Alpha:

- **POSIX installer script** at `https://get.lando.dev/install.sh` (referenced in `scripts/install.sh`)
- **Channel manifests** at `https://update.lando.dev/v4/{stable,next,dev}.json`

These will be stood up before Beta. For now, use the GitHub prerelease or npm install paths above.

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
