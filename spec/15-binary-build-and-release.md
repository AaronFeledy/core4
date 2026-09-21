# Lando v4 — Binary Build and Release Engineering

> **Part 15 of 18** · [Index](./README.md)
> **Read next:** [16 Deprecation and Surface Evolution](./16-deprecation-and-surface-evolution.md)

This part specifies how the §13 distribution artifacts are built, signed, published, installed, and updated.

---

## 17. Binary Build and Release Engineering

### 17.1 Build pipeline

Each release produces the compiled binaries in §13.5 and the `@lando/core` library package from one source tree at one version. `scripts/release.ts` is the single orchestrator and MUST run these stages in order:

| # | Stage | Binary | Library |
|---|---|---|---|
| 1 | Codegen through `scripts/codegen.ts` | Yes | Yes |
| 2 | Deprecation gate from §18.7 | Yes | Yes |
| 3 | Type-check | Yes | Yes |
| 4 | Lint and format checks | Yes | Yes |
| 5 | Test gates from §13 | Yes | Yes |
| 6 | Public schema and type artifacts | Yes | Yes |
| 7 | Library bundle for every `package.json#exports` entry | No | Yes |
| 8 | Main-binary compile through `scripts/build-compiled-binary.ts` with bytecode | Yes | No |
| 9 | Platform-supported symbol stripping with external sourcemaps retained | Yes | No |
| 10 | Platform signing | Yes | No |
| 11 | macOS notarization | macOS only | No |
| 12 | Checksum and update manifests | Yes | Yes |
| 13 | SBOM, provenance, and cosign signatures | Yes | Yes |
| 14 | GitHub Release upload and npm publish | Yes | Yes |

Stages MAY be skipped only where the artifact-family columns permit and MUST NOT be reordered. Any failure halts the pipeline and surfaces a tagged release error with stage, target, commit, workflow, and remediation.

The orchestrator MAY use `Bun.$` for shell-shaped work and `Bun.spawn` for argv-precise tools (§3.4). Every release-shaped main-binary compile MUST use `scripts/build-compiled-binary.ts`; helper binaries without OpenTUI MAY use plain programmatic `Bun.build({ compile })`.

Local rehearsal MUST support any pipeline prefix without publishing credentials. Credentialed stages are skipped with a clear warning; local compilation supports the host target. Platform compile, sign, and notarize jobs run in parallel after shared stages, then manifest and publish stages reconverge.

The full single-target pipeline through supply-chain artifacts MUST complete in under 10 minutes on the §17.8 reference Linux runner. A full release MUST complete within the §17.9 limits.

The deprecation gate runs immediately after codegen. It MUST fail if a `removeIn` surface remains in the release that removes it or if a notice is overdue, and MUST warn when an unscheduled notice is older than 12 months (§18.7).

### 17.2 Codegen catalog

`scripts/codegen-catalog.ts` is the machine-readable ordered catalog consumed by `scripts/codegen.ts`. Every entry has exactly one ownership class: `committed-pin`, `committed-workflow`, or `derived`. Identical inputs MUST produce byte-identical outputs.

| Generator | Inputs | Outputs | Gate |
|---|---|---|---|
| `build-guide-scenarios` | Executable-guide MDX and guide cases | Generated guide scenarios and index | Derived regeneration, typecheck, tests |
| `build-recipe-readmes` | `recipes/*/README.mdx` | Prose-only scaffold READMEs | Derived regeneration and scaffold validation |
| `bundled-plugins` | Plugin workspace and ship list | Static bundled-plugin and renderer indexes | Derived drift and import-boundary tests |
| `mutagen-versions` | Mutagen version and pinned artifact metadata | `mutagen-versions.json` | Committed-pin offline invariants; live publish verification |
| `provider-images` | Pinned provider image table | Generated provider-image table | Derived drift and provider tests |
| `compose-fixture-manifest` | Compose fixtures | Fixture rejection manifest | Derived drift and fixture tests |
| `bundled-recipes` | Recipe ship list and manifests | Static recipe index; target embedded recipe assets | Derived drift and recipe tests |
| `bootstrap-layers` | Service registry, bootstrap ranks, plugin contributions | One generated Layer per bootstrap level | Derived drift, boundary, and perf gates |
| `schema-snapshot` | Public schema, command-result, and bundled-manifest registries | Schema artifacts, references, fixtures, package mirrors | Derived regeneration and schema compatibility |
| `setup-plugin-flags` | Ship list and setup contributions | Setup flag metadata | Derived drift and command tests |
| `mcp-allowlist` | Command registry metadata | MCP command allowlist | Derived drift and registry tests |
| `host-proxy-allowlist` | Command registry metadata | Host-proxy command allowlist | Derived drift and contract tests |
| `command-registry-manifest` | Built-in command registry and topics | Embedded manifest and command-id list | Derived drift and registry completeness |
| `command-reference` | Command registry and manifest | CLI command reference | Derived regeneration and docs build |
| `compose-key-matrix` | Compose dispositions | Compose compatibility reference | Derived regeneration and docs build |
| `opentui-native-stubs` | Native-root catalog, release targets, installed OpenTUI metadata, lockfile | Target mapping and non-target stubs | Derived drift and per-target relocated smoke |
| `php-base-images` | PHP prerequisites and supported versions | Versioned PHP Dockerfiles | Derived drift and image tests |
| `ci-workflow` | CI platform and supply-chain configuration | PR CI workflow | Committed-workflow regeneration and diff |
| `nightly-workflow` | Shared CI configuration | Nightly workflow | Committed-workflow regeneration and diff |
| `release-workflow` | Release stages and targets | Release workflow | Committed-workflow regeneration and diff |
| `provider-matrix-workflow` | Provider matrix configuration | Provider-matrix workflow | Committed-workflow regeneration and diff |
| `runtime-bundle-workflow` | Runtime-bundle release configuration | Runtime-bundle workflow | Committed-workflow regeneration and diff |
| `php-base-workflow` | PHP image release configuration | PHP image workflow | Committed-workflow regeneration and diff |
| `compose-vendor-bump-workflow` | Compose vendor helpers | Compose vendor-bump workflow | Committed-workflow regeneration and diff |

Network-dependent maintenance generators for runtime bundles, Compose vendor bytes, and upstream Compose fixtures remain outside `bun run codegen`; their dedicated workflows or maintainer commands own pin updates and live verification. Planned error, event, service, recipe-action, API-report, acceptance-index, Mutagen-client, and plugin-template generators remain deferred until corresponding scripts exist.

Pin manifests and generated workflows remain committed. Pure build products are derived and need not be Git sources of truth. `bun run codegen` runs the catalog in dependency order; `bun run codegen:check` is the pure-drift gate. Semantic gates such as schema compatibility, guide coverage, public transcripts, and boundaries remain separate.

### 17.3 Asset embedding

Build-known assets MUST be embedded and runtime-installed plugins remain external validated modules (§9.7). Small JS-shaped data uses static JSON or generated TypeScript imports; binary data and file trees use `Bun.embeddedFiles`. `EmbeddedAssetService` presents the same JSON, byte, and virtual-filesystem contract in compiled and library modes, with library mode reading package assets from disk. Runtime code MUST NOT walk `node_modules` or rely on `import.meta.dir` for assets expected inside the compiled binary.

The main-binary build applies a target-specific OpenTUI rule: exactly one of the eight catalog native packages resolves normally for each of the five release targets, while the other seven exact package-root imports resolve to generated throwing stubs. `@opentui/core/testing`, relative imports, and unknown imports MUST remain untouched. The relocated binary MUST embed only the matching shared library in `$bunfs`, with no native sidecar or adjacent `node_modules`; the native asset remains lazy behind the default TTY renderer path. Musl roots stay in the catalog but are not release targets.

### 17.4 Signing and notarization

Every released artifact MUST be signed; self-signed artifacts are limited to local rehearsal.

| Platform | Required mechanism |
|---|---|
| macOS | Developer ID Application signing with hardened runtime, followed by `notarytool` notarization and stapling. Notarization failure blocks release. |
| Windows | Authenticode with trusted timestamping plus a cosign signature over the same bytes. |
| Linux | GPG- and cosign-signed SHA-256 and SHA-512 checksum manifests; ELF binaries are not signed inline. |

Installers and self-update MUST verify checksums and signatures. Trust roots are embedded or vendored as appropriate, active fingerprints are published, and rotation MUST be bootstrapped by a release trusted by the previous roots.

### 17.5 Supply-chain artifacts

Every release publishes a CycloneDX SBOM, SLSA v1.0 provenance for each binary, and keyless cosign signatures and certificates for every binary. The SBOM covers dependencies, bundled plugins and recipes, Bun, and `@lando/sdk`; provenance identifies the source commit, workflow, build inputs, and generated artifacts. v4.0 targets SLSA build level 3.

The pipeline SHOULD produce reproducible binaries from identical source, Bun version, plugin set, and codegen outputs. Weekly independent rebuild drift triggers a release advisory but does not retroactively invalidate signed artifacts.

### 17.6 Self-update

`lando update` MUST:

1. Resolve `stable`, `next`, or `dev` using the §7.6 precedence rules.
2. Fetch and verify the signed channel manifest before trusting any field.
3. Compare installed, latest, and minimum compatible versions.
4. Select the current platform artifact and fetch its binary, checksum manifest, and signature.
5. Verify all signatures and checksums against embedded trust roots before replacement.
6. Replace only the v4-owned executable atomically, probe the new version, and re-exec.
7. Restore the single prior backup if launch probing fails; `lando4 update --rollback` invokes the same rollback path.

#### 17.6.1 Update manifest

`UpdateManifestSchema` is published by `@lando/sdk/schema`. Its load-bearing fields are `channel`, `latest`, `released`, `minimum`, per-platform binary URL/checksum/size records, checksum URLs and signature, and release notes. Stable URLs live under `https://update.lando.dev/v4/<channel>.json`; each manifest has a cosign signature. Binaries older than `minimum` MUST refuse auto-update and direct the user to manual installation.

#### 17.6.2 Atomic replace and rollback

The updater MUST resolve the v4 install record and reject foreign ownership. On POSIX it uses a same-filesystem atomic replacement while retaining one backup. On Windows, where the running executable cannot replace itself, it MUST stage a versioned sibling and complete the rename after process exit or reboot; a documented close-process fallback is required. Both paths preserve existing permissions and ACLs.

Updater operations MUST touch only `lando4` or `lando4.exe` and their recorded siblings. They MUST NOT alter `lando` or `lando.exe`, Lando 3 state, or unrelated PATH entries. Permission failure MUST surface explicit manual elevation instructions; Lando MUST NOT invoke `sudo` or UAC silently.

Update telemetry, when enabled, records only outcome, versions, channel, and platform. It MUST NOT include paths, hostnames, or user identifiers.

### 17.7 Installation

v4.0 ships exactly two install surfaces: signed GitHub Release artifacts and signed POSIX/PowerShell installers from `get.lando.dev`. Homebrew, scoop, winget, distro packages, and a Lando OCI image are deferred post-v4.0.

During Alpha and Beta the installed executable and npm bin name MUST be `lando4` (`lando4.exe` on Windows); the GA name is decided at RC. Release asset names remain in the `lando-v4-<version>-<platform>` family. Installer, update, uninstall, and shellenv MUST operate only on the v4 install record, reject foreign-owned destinations, preserve unrelated PATH entries, and leave Lando 3 binaries and state byte-for-byte untouched.

The compiled binary has no Bun, Node, or package-manager prerequisite. Runtime bundles and helper binaries such as Mutagen remain verified on-demand downloads under Lando-owned data paths, not embedded main-binary assets. The library package assumes a consuming Bun runtime.

Installers MUST resolve platform and channel, verify the signed manifest and artifact, install into the configured or Lando user-data bin directory, and offer matching `lando4 shellenv` output. Setup runs only on explicit `--setup` or `LANDO_AUTO_SETUP=1`; first launch otherwise invites `lando4 setup` and exits successfully. `lando4 uninstall` MUST be confirmed, idempotent, ownership-bounded, and MUST NOT remove provider-owned runtimes or resources.

### 17.8 CI release workflow

GitHub Actions owns release automation. The generated release workflow runs shared validation once, fans compile/sign/notarize across targets, then reconverges for manifests, supply-chain artifacts, and publication.

| Channel | Tag | Policy |
|---|---|---|
| `stable` | `v4.X.Y` | Public release; full pipeline |
| `next` | `v4.X.Y-next.N` | GitHub prerelease; full pipeline |
| `dev` | `v4.X.Y-dev.N` or `main` | Snapshot binaries; no npm publish |

The target matrix covers `linux-x64`, `linux-arm64`, `darwin-arm64`, `darwin-x64`, and `windows-x64`. The reference Linux runner is 4 vCPU and 16 GB RAM. Signing secrets are workflow-scoped; stable publication requires protected-environment approval. Runtime bundles publish independently as immutable `runtime-v*` assets in this repository, and binary releases MUST fail closed on placeholder, missing, mutable, or off-repository bundle pins.

### 17.9 Acceptance criteria

The following augment §15.C and are release-blocking for v4.0:

- `bun run release` produces a launchable local artifact with all credential-available signing steps.
- The full pipeline completes within 30 minutes for one platform and 60 minutes for the full matrix.
- Every binary has the §17.4 platform signature, CycloneDX SBOM, SLSA v1.0 provenance, and verifiable cosign signature.
- The stable update manifest is signed and verifiable by embedded trust roots.
- `next` self-update succeeds on macOS, Linux, and Windows; launch failure rolls back; permission failure never silently elevates.
- POSIX and PowerShell installers succeed on clean hosts, verify trust, install the v4-owned name, and agree with `lando4 shellenv`.
- Install, update, uninstall, and shellenv leave hostile or valid Lando 3 binaries and state unchanged.
- A relocated binary reads bundled plugins, recipes, command metadata, schemas, and its one OpenTUI native asset without build-tree or sidecar files.
- Each target's relocated PTY smoke loads exactly its matching OpenTUI native package; non-TTY, JSON, and level-`none` paths do not load it.
- The binary contains Mutagen client code and its manifest but no Mutagen executable; setup downloads verified helpers only when provider capabilities require them.
- The binary uses bytecode, generated bootstrap layers, the single native dispatcher, and meets the §2.1 performance budgets.
- External plugins load from contained package roots, may use Bun-supported ESM or TypeScript, resolve local dependencies, and fail in isolation with tagged errors.
- `bun run codegen:check` detects committed and newly untracked catalog drift while gitignored derived trees pass their consumer gates.
- Bundled plugin and recipe membership changes are generator-driven; built-in command metadata remains owned only by the native command registry.
