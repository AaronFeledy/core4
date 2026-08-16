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

## Known setup limitation

The default provider (`@lando/provider-lando`) resolves its Podman runtime bundle from a manifest whose committed entries are placeholders (404 URLs + zeroed checksums). End-to-end `lando setup` cannot complete with the default provider yet.

**Workaround:** Use system Docker as your provider:

```bash
# Set provider to docker before running setup
export LANDO_PROVIDER=docker
lando setup
# Or pass the flag each time:
lando --provider=docker start
```

Or build a local runtime bundle and point `LANDO_RUNTIME_BUNDLE_MANIFEST` at it (see `scripts/build-runtime-bundle.ts`).

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
