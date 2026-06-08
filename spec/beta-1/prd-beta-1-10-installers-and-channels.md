# PRD: BETA1-10 — Installers & distribution channels

## Introduction

Beta 1 limits v4.0.0 distribution to exactly two install surfaces: GitHub Releases and curl-pipe installers. GitHub Releases publishes the signed artifact set from PRD-08 and PRD-09. The installer scripts at `get.lando.dev` detect the platform, resolve a channel, verify downloads against vendored trust roots, install the compiled binary, and optionally run setup.

This PRD covers §17.7 distribution channels and first-run install behavior. It deliberately defers package-manager channels until after GA.

## Source References

- [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md) §17.7 v4.0.0 install surface and deferred channels.
- [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md) §17.5 supply-chain artifacts consumed by GitHub Releases.
- [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md) §17.6 update manifest and channel resolution reused by installers.
- [`spec/11-subsystems.md`](../11-subsystems.md) §10.8 setup and host integration.
- [`spec/beta-1/prd-beta-1-00-index.md`](./prd-beta-1-00-index.md) PRD-10 range, dependency on PRD-09, and verification contract.

## Goals

- Ship exactly GitHub Releases and curl-pipe installers for v4.0.0.
- Publish the complete signed artifact set on GitHub Releases.
- Provide POSIX and Windows installer scripts at stable `get.lando.dev` URLs.
- Verify binaries, checksums, and signatures before install.
- Install to `LANDO_INSTALL_DIR` or `<userDataRoot>/bin` and create the directory when absent.
- Offer PATH setup through `lando shellenv` and optional post-install `lando setup`.
- Sign the installer scripts themselves.

## User Stories

### US-266: GitHub Releases publishes the complete signed artifact set

**Description:** As a user who downloads manually, I can get every binary, library archive, SBOM, provenance file, checksum, and signature from GitHub Releases.

**Acceptance Criteria:**
- [ ] GitHub Releases publishes signed binaries for every Beta 1 platform target.
- [ ] The release includes the library archive, SBOM files, provenance attestations, checksum manifests, signature files, certificates, and verification instructions.
- [ ] The compiled binary embeds Bun, so binary-only installs require no separate Bun, Node, or package manager.
- [ ] Mutagen is not embedded in the binary and remains acquired by `lando setup`.
- [ ] Release tests fail if any required artifact family is missing from the GitHub Releases manifest.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-267: `install.sh` detects POSIX platforms and installs verified binaries

**Description:** As a POSIX user, I can run the published shell installer and receive a verified Lando binary in my chosen install directory.

**Acceptance Criteria:**
- [ ] `https://get.lando.dev/install.sh` detects OS, architecture, and libc constraints needed for the release platform id.
- [ ] The script resolves `stable`, `next`, or `dev` channel manifests.
- [ ] The script downloads the binary, checksum manifest, and signature for the detected platform.
- [ ] The script verifies checksum and signature before installing.
- [ ] The script installs to `${LANDO_INSTALL_DIR:-<userDataRoot>/bin}` and creates the directory if absent.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-268: `install.ps1` handles Windows installs and execution policy guidance

**Description:** As a Windows user, I can run the published PowerShell installer and get a verified `lando.exe` with clear execution policy instructions.

**Acceptance Criteria:**
- [ ] `https://get.lando.dev/install.ps1` detects Windows architecture and maps it to the `windows-x64` release artifact.
- [ ] The script resolves `stable`, `next`, or `dev` channel manifests.
- [ ] The script downloads `lando.exe`, checksum manifest, and signature for Windows.
- [ ] The script verifies checksum and signature before installing.
- [ ] The script documents the default execution policy path and prints exact remediation when policy blocks execution.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-269: Installer verification uses vendored trust roots

**Description:** As a security-conscious user, I can inspect the installer trust roots and know they are not fetched from the same network path as the binary.

**Acceptance Criteria:**
- [ ] `install.sh` verifies artifacts with a vendored GPG trust root.
- [ ] `install.ps1` verifies artifacts with a vendored cosign trust root.
- [ ] Trust roots are versioned with the installer scripts and not downloaded from the update manifest.
- [ ] Verification fails closed if the trust root is missing, malformed, expired, or mismatched.
- [ ] Tests cover trust-root selection, missing trust root, wrong signer, and tampered artifact cases.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-270: Installers support PATH integration and optional post-install setup

**Description:** As a first-time user, I can install Lando, get PATH guidance, and choose whether to run setup immediately.

**Acceptance Criteria:**
- [ ] Both installers offer to run `lando setup` after the binary is installed and verified.
- [ ] Non-interactive installer mode can skip post-install setup without prompting.
- [ ] Both installers print `lando shellenv` guidance for adding the install directory to PATH.
- [ ] PATH guidance matches the `lando shellenv` output from PRD-01.
- [ ] Installer tests cover setup opt-in, setup skip, non-interactive mode, and PATH guidance rendering.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-271: Installer scripts are signed and published at stable URLs

**Description:** As a user running a curl-pipe installer, I can verify the script itself before trusting it.

**Acceptance Criteria:**
- [ ] `install.sh` and `install.ps1` are signed before publication.
- [ ] Detached script signatures are published next to the stable installer URLs.
- [ ] Release notes include installer script verification commands.
- [ ] Publishing fails if a script, signature, or trust-root artifact is missing.
- [ ] Tests cover script signing, stable URL manifest entries, and missing-signature failure.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

## Functional Requirements

- FR-1: v4.0.0 MUST ship exactly two install surfaces: GitHub Releases and curl-pipe installers.
- FR-2: Homebrew, scoop, winget, distro package, and OCI install channels MUST remain deferred post-GA.
- FR-3: GitHub Releases MUST publish signed binaries, the library archive, SBOMs, provenance attestations, checksum manifests, signature files, certificates, and verification instructions.
- FR-4: The compiled binary MUST embed Bun and require no separate Bun, Node, or package manager for binary-only installs.
- FR-5: `BUN_BE_BUN=1` self-spawn MUST remain available for plugin install, recipe `bun` verbs, `lando bun`, `lando x`, and includes materialization.
- FR-6: Mutagen MUST NOT be embedded in the binary and MUST remain acquired by `lando setup`.
- FR-7: `install.sh` MUST be published at `https://get.lando.dev/install.sh` and use a vendored GPG trust root.
- FR-8: `install.ps1` MUST be published at `https://get.lando.dev/install.ps1` and use a vendored cosign trust root.
- FR-9: Installers MUST detect platform, resolve channel, fetch manifest, download binary plus checksum plus signature, verify, and install to `${LANDO_INSTALL_DIR:-<userDataRoot>/bin}`.
- FR-10: Installers MUST create the install directory when absent.
- FR-11: Installers SHOULD offer PATH updates through `lando shellenv` guidance.
- FR-12: Installers SHOULD offer optional post-install `lando setup`.
- FR-13: Installer scripts themselves MUST be signed and published with detached signatures.

## Non-Goals

- Shipping Homebrew, scoop, winget, distro package, or OCI install channels in Beta 1.
- Embedding Mutagen into the compiled binary.
- Installing a separate Bun runtime for binary-only users.
- Auto-editing shell profiles without user consent.
- Replacing `lando update`; installers may use the same manifest model but do not become the self-update mechanism.

## Technical Considerations

- Keep installer scripts small, auditable, and dependency-light because users may read them before execution.
- Treat channel resolution and signature verification as shared concepts with self-update, but keep scripts portable enough to run before Lando exists.
- Publish trust roots with the installer script source and release artifacts so rotations are visible in diffs.
- Ensure `LANDO_INSTALL_DIR` handling works when the path contains spaces.
- Keep binary-only installs separate from setup so users can install first and prepare providers later.

## Success Metrics

- A manual GitHub Releases install can verify a binary with the published commands and run `lando version` without Bun or Node installed.
- `install.sh` installs the verified linux-x64 binary into a temp `LANDO_INSTALL_DIR` in tests.
- `install.ps1` renders execution policy remediation and verifies the Windows artifact path in tests.
- Release publication fails if either installer script or its detached signature is missing.

## Guide Coverage

Per [Beta 1 index verification](./prd-beta-1-00-index.md) and the §19 guide convention, this PRD owns the executable guides listed below. Each guide exercises the happy path of its mapped user story; failure modes remain covered by unit and integration tests in the named packages. PRs that touch the listed surface paths MUST also touch the corresponding guide(s), or use the `Guide-Coverage-Skip:` escape hatch.

**Guides owned by this PRD:**

| User Story | Feature | Guide Path | Acceptance |
|---|---|---|---|
| US-266 | Manual GitHub Releases install | `docs/guides/install/github-releases.mdx` | Required at story acceptance |
| US-267, US-269 | POSIX curl-pipe installer | `docs/guides/install/posix-installer.mdx` | Required at story acceptance |
| US-268, US-269 | Windows PowerShell installer | `docs/guides/install/windows-installer.mdx` | Required at story acceptance |
| US-270 | PATH and setup after install | `docs/guides/install/path-and-setup.mdx` | Required at story acceptance |
| US-271 | Verifying installer scripts | `docs/guides/install/verify-installer-scripts.mdx` | Required at story acceptance |

**CLI / source surface paths covered (drift gate input):**

- `scripts/install/**`
- `scripts/release.ts`
- `scripts/release/**`
- `core/src/cli/commands/shellenv*`
- `core/src/cli/commands/meta/setup*`
- `core/src/self-update/**`
- `core/src/bun-self/**`
- `core/bin/lando.ts`
- `docs/guides/install/**`

## Open Questions

- Should the installer default channel be `stable` or match the release page that linked it? Default: `stable`, with explicit channel flags for `next` and `dev`.
- Should installers prompt for `lando setup` by default on TTY installs? Default: yes on TTY, no in non-interactive mode.
- Should PATH updates be automatic when the shell profile has a clear Lando block? Default: no, print `lando shellenv` guidance and let setup handle managed shell integration.
- How are installer trust roots rotated after compromise or expiry? Default: ship a new signed installer version and document old-root revocation in release notes.
