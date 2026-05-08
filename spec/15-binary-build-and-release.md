# Lando v4 — Binary Build and Release Engineering

> **Part 15 of 16** · [Index](./README.md)

This part is the operational counterpart to §13. Where §13 tells you *what* ships, §17 tells you *how* it gets built, signed, embedded, verified, distributed, and updated. Everything here flows from the architectural decisions already made elsewhere — Bun-compiled single-binary (§2.1), two distribution forms (§1.4, §13.5), bundled-plugins and bundled-recipes static-import constraint (§2.1, §13.5), self-update behavior (§13.7) — and pins down the operational mechanics those sections only sketch.

Covered here: the ordered build pipeline and its single orchestrator script, the canonical codegen catalog (every generator, its inputs, its outputs, its staleness gate), the asset-embedding policy (hybrid: static JSON imports for small data, `Bun.embeddedFiles` for large data), per-platform signing and notarization (macOS Developer ID + notarytool, Windows Authenticode + Sigstore, Linux GPG-signed checksum manifest), supply-chain artifacts (SBOM, SLSA provenance, cosign signatures), the self-update protocol (manifest schema, channel resolution, signature verification, Windows rename, rollback), the v4.0.0 installation surface (GitHub Releases + curl|sh installer; Homebrew/scoop/winget/distro packages deferred), the CI release workflow, and the binary-shipping acceptance criteria that augment §15.C.

---

## 17. Binary Build and Release Engineering

### 17.1 Build pipeline

A release of Lando v4 produces two artifact families from one source tree at one version:

1. **Compiled binaries** — one per platform target listed in §13.5.
2. **Library package** — published to npm as `@lando/core` with the entry-point catalog from §2.7.

The pipeline that produces both is a single ordered sequence. There is **one orchestrator** — `scripts/release.ts` — that runs every stage. The orchestrator is itself a Bun program that uses Bun's two host-execution primitives in their declared roles (§3.4): **`Bun.$`** (Bun Shell) for the shell-shaped stages where pipes, redirection, glob expansion, or built-in `mv`/`rm`/`mkdir` make the code read like the §17.1 stages table on the page (sign → notarize → manifest → GPG → cosign → publish, plus the `dist/` housekeeping each stage needs), and **`Bun.spawn`** for the argv-precise tool calls where escaping ambiguity would be a hazard (`tsc`, `bun build --compile`, `signtool`, `notarytool`, `codesign`). The orchestrator and the codegen scripts under `scripts/` MAY use `Bun.$` directly without going through the `ShellRunner` service because they run outside `LandoRuntimeLive`; production source under `core/src/` still routes shell-shaped work through `ShellRunner` for redaction, lifecycle events, and pluggability (§3.4, §4.2). The release orchestrator is consumed by CI (§17.8) and by maintainers running a local rehearsal.

**Stages, in order.**

| # | Stage | Owner | Required for binary | Required for library |
|---|---|---|---|---|
| 1 | **Codegen** | `scripts/codegen.ts` | Yes | Yes |
| 2 | **Type-check** | `tsc --noEmit` | Yes | Yes |
| 3 | **Lint/format** | `bunx biome check` | Yes | Yes |
| 4 | **Test gates** | `bun test` (unit + Effect service + library API + scenario + recipe + provider contract + smoke e2e) | Yes | Yes |
| 5 | **Schema artifacts** | Generate `dist/schemas/*.json` and `dist/types/*.d.ts` per §2.7 entry point | Yes | Yes |
| 6 | **Library bundle** | `bun build` (no `--compile`) per `package.json#exports` entry; emit `dist/<entry>.js` + `.d.ts` | No | Yes |
| 7 | **Compile** | `bun build --compile --bytecode --target=bun-${T}` over `bin/lando.ts` → `dist/lando-${T}`; `--bytecode` is required (§2.1) | Yes | No |
| 8 | **Strip** | Remove debug symbols where the platform supports it; preserve external sourcemap | Yes | No |
| 9 | **Sign** | Per-platform (§17.4): macOS `codesign`, Windows `signtool`, Linux is signed at the manifest layer in stage 11 | Yes | No |
| 10 | **Notarize** | macOS only: `notarytool submit` + `stapler staple` | Yes | No |
| 11 | **Manifest** | Write `dist/SHA256SUMS`, `dist/SHA512SUMS`; GPG-sign both; write `dist/update-manifest.json` (§17.6.1) | Yes | Yes |
| 12 | **Provenance & SBOM** | Generate CycloneDX SBOM per artifact, SLSA provenance attestation, cosign signatures (§17.5) | Yes | Yes |
| 13 | **Publish** | Upload to GitHub Releases (binaries + manifests + attestations); `bun publish` for `@lando/core` | Yes | Yes |

The orchestrator MUST run stages in order. Stages MAY be skipped per artifact family (the matrix above), but no stage MAY be reordered. Failure at any stage halts the pipeline and surfaces a tagged release error (§17.8).

**Local rehearsal.** A maintainer can run any prefix of the pipeline locally without secrets. Stages 9, 10, 11 (signature), 12, and 13 require credentials and are skipped with a clear `LOCAL_REHEARSAL=1` warning if those credentials aren't present. Stage 7 (compile) works locally for the maintainer's own platform target without a cross-compile rig.

**Cold-build budget.** A full pipeline on Linux x64 — codegen through stage 12 — for one platform target on a clean cache MUST complete in under 10 minutes on the reference CI runner spec (§17.8). The all-targets matrix runs stages 1–6 once and parallelizes 7–10 across targets, then runs 11–13 once after all matrix jobs complete.

**Deprecation gate.** Immediately after stage 1 (codegen) completes and before stage 2 (type-check) begins, the orchestrator runs `scripts/check-deprecations.ts` (§18.7). The script loads every `DeprecationNotice` in the codebase and bundled plugins via the same registry walk used at runtime (§18.5), reads the version being released from `package.json`, and:

- Fails the pipeline with `DeprecationStaleError` if any notice's `removeIn` equals the version being released AND the corresponding surface is still present in the source tree.
- Fails the pipeline with `DeprecationOverdueError` if any notice's `removeIn` is *less than* the version being released (a forgotten removal from a prior major).
- Emits a "soft" warning (non-fatal) if any notice with no `removeIn` is older than 12 months by `since` date.

The deprecation gate is also part of `bun run codegen:check`, so PRs that introduce the conflict are caught before merge rather than at release time. Failures surface as tagged errors with the offending `(kind, id, removeIn)` triplets and a remediation pointer to §18.7.

### 17.2 Codegen catalog

Codegen is the largest single source of correctness drift in a build like this, so the spec lists every generator explicitly. Each generator has a single input root, a single output root, and a staleness check that fails CI if the committed output is older than the input.

| Generator | Script | Input | Output | When it runs | Staleness gate |
|---|---|---|---|---|---|
| **Bundled plugins index** | `scripts/build-bundled-plugins.ts` | `plugins/` workspace + `core/build.config.ts` (the "ship list") | `src/plugins/bundled.ts` (static `import` graph) | Build (stage 1); dev watch on plugin add/remove | `bun run build:check` re-runs the generator and `git diff --exit-code` fails if drifted |
| **Bootstrap layers** | `scripts/build-bootstrap-layers.ts` | Core service registry (§3.4 service-membership-per-level table), `BootstrapLevel` enum (§3.2), bundled-plugin contribution graph | `src/runtime/generated/layers/none.ts`, `…/minimal.ts`, `…/plugins.ts`, `…/commands.ts`, `…/tooling.ts`, `…/provider.ts`, `…/app.ts` — one prebuilt `Layer` per level with eager services constructed and lazy services wrapped in `Layer.suspend` per §2.4 | Build (stage 1); dev watch on service registry edit | Re-run + `git diff --exit-code` |
| **Bundled recipes index** | `scripts/build-bundled-recipes.ts` | `recipes/<id>/` directories | `src/recipes/bundled.ts` (id → embedded FS handle, plus a `bunScripts:` map of `{ path → sha256 }` for every `.bun.sh` file referenced by the recipe's `postInit.bunScript:` actions, §8.8.8) plus `dist/embedded/recipes-<id>.tar` (per §17.3) | Build (stage 1); dev watch on recipe edit | Same as above |
| **OCLIF manifest** | `scripts/build-oclif-manifest.ts` (wraps `oclif manifest`) | `src/cli/commands/**` + bundled plugin command metadata | `oclif.manifest.json` | Build (stage 1); pre-test | Re-run + `git diff --exit-code` |
| **Schema JSON output** | `scripts/build-schema-json.ts` | `@lando/sdk` schemas re-exported through `@lando/core/schema` | `dist/schemas/<id>.json` (one per public schema) | Build (stage 5) | Re-run + structural equality (key order normalized) |
| **Schema reference MDX** | `scripts/build-schema-docs.ts` | Same schemas + their `identifier`/`title`/`description`/example annotations | `docs/src/content/docs/reference/schemas/*.mdx` | Build (stage 5); docs build | Re-run + `git diff --exit-code` |
| **CLI command reference** | `scripts/build-command-docs.ts` | `LandoCommandSpec` registry + OCLIF manifest | `docs/src/content/docs/reference/commands/*.mdx` | Build (stage 5); docs build | Same |
| **Error catalog** | `scripts/build-error-docs.ts` | Tagged-error class registry (`src/errors/**`) | `docs/src/content/docs/reference/errors/*.mdx` | Build (stage 5); docs build | Same |
| **Event catalog** | `scripts/build-event-docs.ts` | Event payload schemas (`src/lifecycle/schema.ts`) | `docs/src/content/docs/reference/events/*.mdx` | Build (stage 5); docs build | Same |
| **TypeScript declarations** | `scripts/build-types.ts` (wraps `tsc -p tsconfig.types.json`) | `src/**/*.ts` | `dist/types/<entry>.d.ts` per §2.7 entry | Build (stage 5) | `tsc --noEmit` against the bundled `.d.ts` re-importing |
| **Public API reports** | `scripts/build-api-reports.ts` (API Extractor or equivalent) | `package.json#exports` + public entry points | `etc/api/*.api.md` | Build (stage 5); pre-test | Re-run + `git diff --exit-code` |
| **Service registry docs** | `scripts/build-service-docs.ts` | Core service tag registry (§3.4) + pluggability catalog (§4.2) | `docs/src/content/docs/reference/services/*.mdx` | Build (stage 5); docs build | Same |
| **Recipe action docs** | `scripts/build-recipe-action-docs.ts` | Recipe action registry + command metadata (`recipePostInitAllowed`) | `docs/src/content/docs/reference/recipes/actions.mdx` | Build (stage 5); docs build | Same |
| **Acceptance coverage index** | `scripts/build-acceptance-index.ts` | Acceptance checklist ids + test metadata | `dist/acceptance-index.json` | Build (stage 5); pre-test | Re-run + coverage validation |

Codegen MUST be deterministic: re-running with identical inputs produces byte-identical outputs. The staleness gate exists because Lando publishes some generated files (`oclif.manifest.json`, `dist/schemas/*.json`, schema MDX) that downstream consumers read; CI regenerates them and refuses to merge if the committed copy diverges.

A single command, `bun run codegen`, runs every generator in dependency order. A single command, `bun run codegen:check`, runs every generator into a temporary directory and fails on drift. CI runs the latter on every PR (§13.4).

### 17.3 Asset embedding

The Bun-compiled binary only embeds modules and assets that are visible to the build graph (§2.1). All build-time-known data MUST therefore be embedded into the binary at compile time. Runtime-installed plugins are the intentional exception: they are external code loaded by absolute `file://` URL from validated plugin stores (§9.7), not embedded assets. Lando uses two embedding mechanisms for build-known assets, chosen by data shape and size:

**Mechanism A — Static JSON import (small structured data).**

Use for: data that is small (under ~256 KB), structured, and read into JS objects. Examples: `oclif.manifest.json`, the bundled-plugin registry, schema-id index, default global config.

```ts
// src/cli/oclif/manifest.ts
import manifest from "../../../oclif.manifest.json" with { type: "json" };
export const oclifManifest = manifest;
```

Bun inlines the JSON value into the compiled binary as a parsed object. No filesystem read happens at runtime. The TypeScript type is inferred from the JSON literal so consumers get static typing.

**Mechanism B — `Bun.embeddedFiles` (binary blobs and large directory trees).**

Use for: data that is large (over ~256 KB), or that is a tree of files preserving file shape, or that is binary (templates, assets, fragments, archives). Examples: each canonical recipe's directory tree, large schema bundles, embedded help PDF/MDX if any.

```ts
// src/recipes/loader.ts — runtime side
import { embeddedFiles } from "bun";
import recipesIndex from "./bundled.ts"; // generated, names + handle ids only

export function readRecipeFile(recipeId: string, path: string): Effect.Effect<Uint8Array, RecipeAssetNotFoundError> {
  const entry = recipesIndex[recipeId];
  // entry.archive is a blob handle resolved via Bun.embeddedFiles
  // ...resolve and slice the entry's tar to the requested path
}
```

The generator (`scripts/build-bundled-recipes.ts`) produces:

- `src/recipes/bundled.ts` — a tiny TS module mapping `<recipe-id>` → `{ archive: <embedded handle>, manifest: <inlined recipe.yml object> }`.
- `dist/embedded/recipes-<id>.tar` — one tar per recipe, included via Bun's asset import (`import recipeTar from './recipes-foo.tar' with { type: "file" }`) so `Bun.embeddedFiles` can locate them.

The recipe loader is the only consumer that reads from these handles. It exposes a virtual filesystem API (§8.8) so `lando init --recipe <id>` can iterate, render, and write recipe files without a disk read on the source side.

**Selection rule.** When the data is below the size threshold AND is naturally JS-shaped (schemas, manifests, indices), use mechanism A. When the data is binary, large, or a tree with paths the runtime needs to enumerate, use mechanism B. The threshold is a guideline, not a gate — the orchestrator emits a build-time warning if a JSON import grows past the threshold so we can revisit.

**Loader API.** A single `EmbeddedAssetService` (added to §3.4) abstracts both mechanisms. Its tagged interface is:

```ts
export class EmbeddedAssetService extends Context.Service<EmbeddedAssetService, {
  readonly readJson: <T = unknown>(id: string) => Effect.Effect<T, EmbeddedAssetMissingError>;
  readonly readBytes: (id: string) => Effect.Effect<Uint8Array, EmbeddedAssetMissingError>;
  readonly listVirtualFs: (rootId: string) => Stream.Stream<VirtualFsEntry, EmbeddedAssetMissingError>;
}>()("@lando/core/EmbeddedAssetService") {}
```

Bundled plugin indexes, recipe loaders, schema loaders, and command-reference loaders MUST go through this service. Direct `import.meta.dir` walks against `node_modules` are forbidden in code paths that expect bundled assets inside the compiled binary. External plugin modules still load from their validated package roots through the plugin loader (§9.7).

**Library mode behavior.** When `@lando/core` is consumed as a library (not as the compiled binary), `EmbeddedAssetService` falls back to disk reads under the package directory. The interface is identical; only the implementation differs. This is the same mechanism plugins under development use to test against a non-compiled Lando.

### 17.4 Signing and notarization

Every released artifact MUST be signed. v4.0.0 commits to full per-platform signing — no "checksums only" channel.

**macOS (`darwin-x64`, `darwin-arm64`).**

- Signing certificate: Developer ID Application certificate from an Apple Developer Program account owned by the Lando project.
- Process: `codesign --sign "Developer ID Application: …" --options runtime --timestamp --entitlements scripts/lando.entitlements ./dist/lando-darwin-${arch}`.
- Hardened runtime is required (`--options runtime`).
- Entitlements file (`scripts/lando.entitlements`) is checked into the repo and ships only the entitlements Lando actually needs (no `com.apple.security.cs.allow-unsigned-executable-memory` unless a runtime-provider plugin documents the requirement; v4.0.0 does not need it).
- Notarization: after signing, the artifact is uploaded with `xcrun notarytool submit … --wait`. On success, the ticket is stapled with `xcrun stapler staple ./dist/lando-darwin-${arch}`.
- Failure to notarize fails the pipeline; we do not ship un-notarized macOS binaries.

**Windows (`windows-x64`).**

- Primary signing: Authenticode via `signtool sign /tr <RFC 3161 timestamp server> /td sha256 /fd sha256 /a ./dist/lando-windows-x64.exe`. The certificate is an OV or EV code-signing certificate held in a hardware token or HSM; the exact provider is an operational decision for the project, not a spec one.
- Secondary signing: a Sigstore (cosign) signature is produced and published alongside the Authenticode-signed binary. This gives downstream verifiers (CI tools, SBOM consumers) a keyless verification path even if the Authenticode cert ever rotates.
- Both signatures cover the same bytes; the binary on disk has the Authenticode signature embedded, the cosign `.sig` and `.crt` ride alongside in the release manifest.

**Linux (`linux-x64`, `linux-arm64`).**

- Linux binaries are not signed inline (ELF signing is not standardized across distros).
- Instead, the **manifest layer** carries authenticity. `dist/SHA256SUMS` and `dist/SHA512SUMS` contain checksums for every artifact in the release (binaries and the published library archive). Both checksum manifests are signed with a project-owned **GPG key** and a project-owned **cosign key**, producing `SHA256SUMS.asc`, `SHA256SUMS.sig`, `SHA512SUMS.asc`, `SHA512SUMS.sig`.
- The curl-pipe installer (§17.7) and `lando update` (§17.6) verify both the checksum and the signature before unpacking or replacing the binary.

**Key rotation.** The project documents a key-rotation procedure for each signing key (Apple cert, Windows cert, GPG key, cosign key) and publishes the active fingerprints on a stable URL. `lando update` pins the trust roots to a list embedded in the binary; rotation requires shipping a new binary (which is signed with the prior trust root) before the new key is used.

**No self-signed in release artifacts.** Every published binary is signed by a key whose chain is trusted by the platform's default verifiers (Apple's notary service, Windows Authenticode roots, the project's published GPG and cosign public keys for Linux). Self-signed binaries appear only in dev rehearsal builds (`LOCAL_REHEARSAL=1`).

### 17.5 Supply-chain artifacts

For every release, in addition to signed binaries:

**SBOM.** A CycloneDX-format SBOM (`dist/lando-${V}-sbom.cdx.json`) is generated from `bun.lock`, the bundled-plugin set, and the bundled-recipe set. The SBOM enumerates: every npm dependency with version + license + integrity hash, every bundled plugin (name + version + repo), every bundled recipe (id + version), the Bun runtime version compiled into the binary, and the `@lando/sdk` version. The SBOM is regenerated per release and published in the GitHub Release artifact set.

**SLSA provenance.** The CI pipeline produces a SLSA v1.0 provenance attestation for each binary, signed with cosign keyless (Sigstore OIDC against GitHub Actions). The provenance asserts: which workflow run produced the binary, which commit, which build steps were executed, which inputs (digest of `bun.lock`, digest of source tree, digest of every codegen output). v4.0.0 targets SLSA build level 3 (hosted, isolated, fully attested) on the per-platform binaries.

**cosign signatures on every binary.** In addition to the platform-native signatures (§17.4), each binary gets a keyless cosign signature using the GitHub Actions OIDC identity. This gives downstream verifiers a single uniform verification path:

```
cosign verify-blob \
  --certificate-identity-regexp "^https://github.com/lando/lando/.github/workflows/release.yml@" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  --signature dist/lando-${T}.sig \
  --certificate dist/lando-${T}.crt \
  dist/lando-${T}
```

The release publishes the signature, the certificate, and the verification command in the release notes.

**Reproducibility.** The pipeline aims for reproducible builds: given the same source commit, the same Bun version, the same plugin set, and the same generator outputs, two independent runs should produce byte-identical binaries. Reproducibility is verified weekly by the nightly CI rebuild against the latest release commit; drift triggers a release advisory but does not retroactively invalidate the published artifacts.

### 17.6 Self-update

`lando update` (canonical id `meta:update`, top-level alias `lando update`) self-updates the binary on a user's machine. The flow:

1. Resolve the user's active channel (`stable`, `next`, `dev`) from global config + env override (§7.6).
2. Fetch the **update manifest** for that channel.
3. Compare the installed binary's version against the manifest's latest. If equal, exit with "already up to date." If newer locally, exit with "ahead of channel" warning.
4. Resolve the download URL for the user's platform target. Download the binary plus its checksum manifest plus its signature (`SHA256SUMS`, `SHA256SUMS.sig`).
5. Verify the checksum and the signature against the trust roots embedded in the running binary. Failure halts the update with a tagged `UpdateVerificationError`.
6. Atomically replace the running binary (§17.6.2) and re-exec.

#### 17.6.1 Update manifest

The manifest is a JSON file published to a stable URL per channel:

- `https://update.lando.dev/v4/stable.json`
- `https://update.lando.dev/v4/next.json`
- `https://update.lando.dev/v4/dev.json`

Schema (validated by `UpdateManifestSchema` in `@lando/core/schema`):

```jsonc
{
  "channel": "stable",
  "latest": "4.2.0",
  "released": "2025-09-01T00:00:00Z",
  "minimum": "4.0.0",
  "binaries": {
    "darwin-x64":  { "url": "https://github.com/lando/lando/releases/download/v4.2.0/lando-darwin-x64",   "sha256": "…", "size": 53612880 },
    "darwin-arm64":{ "url": "https://github.com/lando/lando/releases/download/v4.2.0/lando-darwin-arm64", "sha256": "…", "size": 51234567 },
    "linux-x64":   { "url": "…", "sha256": "…", "size": 0 },
    "linux-arm64": { "url": "…", "sha256": "…", "size": 0 },
    "windows-x64": { "url": "…", "sha256": "…", "size": 0 }
  },
  "checksums": { "url": "https://github.com/lando/lando/releases/download/v4.2.0/SHA256SUMS",     "signature": "https://github.com/lando/lando/releases/download/v4.2.0/SHA256SUMS.sig" },
  "notes":     "https://github.com/lando/lando/releases/tag/v4.2.0"
}
```

`minimum` is the lowest version that should accept this manifest. A binary older than `minimum` refuses to auto-update and instructs the user to download manually (used for breaking auto-update protocol changes).

The manifest is signed: a sibling URL with `.sig` extension carries a cosign signature over the manifest bytes. The binary verifies the manifest signature before trusting any field in it. The manifest's `checksums.signature` URL is then verified against the same trust roots.

The manifest URL host (`update.lando.dev`) is a project-controlled redirector. Its DNS, TLS, and certificate are operational concerns documented in the project's release runbook, not in this spec.

#### 17.6.2 Atomic replace and rollback

**POSIX (macOS, Linux).** `rename(2)` is atomic across the same filesystem. The update writes the new binary to `<install-dir>/.lando.<version>.tmp`, `chmod 0755`s it, verifies it can launch (`./.lando.<version>.tmp --version` returns the expected version), then `rename`s it over `<install-dir>/lando`. The replaced file's prior contents are kept in `<install-dir>/.lando.<previous-version>.bak` for a single rollback. The running process re-execs into the new binary using `execve(2)` so the user does not need to retype the command.

**Windows.** A running `.exe` cannot be renamed on top of itself by the same process. The update writes `lando.${version}.exe` next to the running binary, verifies it, then schedules the swap via two paths:

1. **Preferred:** `MoveFileExW(.., MOVEFILE_DELAY_UNTIL_REBOOT)` plus an immediate spawn-and-exit pattern — the new binary is launched, the old binary exits, the new binary `MoveFileEx`'s itself over the old path on its first run.
2. **Fallback:** if scheduled-rename is not available (locked-down environments), the updater prints clear instructions to close all `lando` processes and runs `cmd.exe /c "ping … & del lando.exe & rename lando.${version}.exe lando.exe & lando.exe"`. The fallback is documented and covered by an e2e test on the Windows runner.

In both cases the prior binary's bytes are preserved at `<install-dir>/lando.${previous-version}.bak.exe` for one update cycle.

**Rollback.** If the new binary fails to launch (signature ok, but executable startup fails — corrupted download, OS incompatibility, missing platform library), the updater detects the failure within `EXEC_PROBE_TIMEOUT_MS` (default 5s), restores the `.bak` file via the same atomic primitive, and surfaces a tagged `UpdateLaunchProbeError` with remediation telling the user to file an issue with their platform details. `lando update --rollback` lets a user invoke the same flow on a previously-updated install.

**Permission preservation.** The new binary inherits the prior binary's mode bits (POSIX) or NTFS ACL (Windows). If the binary is on a path requiring elevated privileges to write (e.g., `/usr/local/bin/lando` owned by root), the updater detects the EACCES at the rename step, exits with `UpdatePermissionError`, and prints the exact `sudo` command to retry the operation manually. We do not invoke `sudo`/UAC silently.

#### 17.6.3 Telemetry of update outcomes

When telemetry is enabled (default; opt-out per §1.4), each update outcome — success, signature failure, launch-probe failure, permission failure, network failure — is reported with the binary's version, the target version, the channel, and the platform. No paths, hostnames, or user identifiers are sent. This data feeds the `meta:doctor` "update health" check (§10.9) and lets the project detect a bad release within hours.

### 17.7 Installation

v4.0.0 commits to **two** install surfaces. Everything else is deferred to a future v4.x.

**1. GitHub Releases.** The signed binaries, library archive, SBOM, provenance, and signature files are published as a GitHub Release for every tagged version. Users may download the binary directly, verify it with the published cosign command (§17.5), and place it on their PATH. This is the most general, lowest-trust path.

**Zero peer prerequisites.** The compiled `lando` binary embeds a complete Bun runtime (§2.1, §3.4 `BunSelfRunner`). A user installing only the Lando binary needs no separate Bun installation, no Node, and no system package manager. Plugin install (§9.6), recipe `bunCreate:` / `bunInstall:` (§8.8.8), `lando bun` / `lando x` (§8.2.4), and `includes:` registry materialization (§7.7) all self-spawn the running binary with `BUN_BE_BUN=1`. The `@lando/core` library form is the one exception (§1.4): it does not ship an embedded Bun and assumes the consuming Bun program already provides the runtime. The §13.1 plugin-install contract suite includes an end-to-end test that performs `lando plugin add <spec>` on a clean container with **no** prior Bun, Node, npm, or yarn installations, and the §13.6 release-blocking nightly matrix runs the `lando init` canonical-recipe set on the same clean baseline.

**2. Curl-pipe installer.** A small POSIX shell script (`scripts/install.sh`) and a Windows PowerShell script (`scripts/install.ps1`) are published at stable URLs:

- `https://get.lando.dev/install.sh`
- `https://get.lando.dev/install.ps1`

The scripts:

- Detect the platform target (OS + arch).
- Resolve the active channel (default `stable`; overridable via `LANDO_CHANNEL=…`).
- Fetch the update manifest (§17.6.1).
- Download the platform binary + checksum manifest + signature.
- Verify the checksum and the signature using a vendored copy of the project's GPG public key (POSIX) or cosign public key (Windows). The trust root is checked into the installer script source and rotated explicitly when keys rotate.
- Install to `${LANDO_INSTALL_DIR:-$HOME/.lando/bin}` by default; offer to update PATH via `lando shellenv` (§10.8).
- Optionally run `lando setup` if `LANDO_AUTO_SETUP=1` or the user passes `--setup`.

The installer scripts are themselves signed (the URL serves the script and a sibling `.sig`); the website documents how to verify the script before piping it. Yes, this is the standard "curl | sh" tradeoff. The script source is short, auditable, and covered by an e2e test that pipes the published URL into a clean container per supported OS on every release.

**Deferred (post-v4.0.0).**

- **Homebrew tap.** A `lando/lando` tap publishing a `lando` formula. Deferred because formula maintenance + bottle signing is non-trivial and adds a second update channel for users to keep in sync. Tracked as an open decision in §14.2.
- **scoop bucket.** `scoop bucket add lando https://github.com/lando/scoop-bucket; scoop install lando`. Deferred for the same reason.
- **winget manifest.** A submission to the winget community manifests repository. Deferred because the submission flow has its own review cadence we can't control.
- **Distro packages.** `.deb` (Debian/Ubuntu via `apt.lando.dev` repo), `.rpm` (Fedora/RHEL via `yum.lando.dev` repo), Arch AUR. Deferred — distro-package maintenance is its own discipline.
- **Container image.** A `lando/lando` OCI image is not in v4.0.0 scope; running Lando inside a container that itself orchestrates other containers is out of scope.

The installation surface is intentionally small for v4.0.0. The reference installer + GitHub Releases covers macOS, Linux, and Windows for every supported platform target; the deferred channels add convenience for specific user populations and can be added without spec changes.

**First-run UX.** When the binary is launched for the first time and detects no prior Lando state under `<userDataRoot>/`, it prints a single-line invitation to run `lando setup` and exits with code 0. It does not auto-run setup. Users running the installer with `--setup` get the auto-setup path.

**Uninstall.** `lando meta uninstall` (canonical id `meta:uninstall`, top-level alias `lando uninstall`) removes the binary, the user data root, and the user cache root after a confirm prompt. It does not remove any container runtime, image, or volume — those are owned by the runtime provider. Each provider's docs document its own cleanup.

### 17.8 CI release workflow

CI runs on **GitHub Actions**. The release workflow lives at `.github/workflows/release.yml` and triggers on Git tags matching the channel-to-tag mapping below.

**Channel-to-tag mapping.**

| Channel | Tag pattern | Release type |
|---|---|---|
| `stable` | `v4.X.Y` (no suffix) | Public release; full pipeline |
| `next` | `v4.X.Y-next.N` | Pre-release; full pipeline; flagged "pre-release" on GitHub |
| `dev` | `v4.X.Y-dev.N` or every push to `main` | Snapshot; full pipeline minus stage 13's npm publish (binaries only) |

**Matrix structure.** Stages 1–6 (codegen, type-check, lint, tests, schema artifacts, library bundle) run once on `ubuntu-latest-x64` and produce shared artifacts that are platform-independent. Stages 7–10 (compile, strip, sign, notarize) fan out across the platform-target matrix:

- `ubuntu-latest-x64` produces `linux-x64`
- `ubuntu-latest-arm64` (or QEMU emulation if a native ARM runner isn't available) produces `linux-arm64`
- `macos-13` (x64) produces `darwin-x64`
- `macos-14` (arm64) produces `darwin-arm64`
- `windows-2022` (x64) produces `windows-x64`

A coordinator job runs stages 11–13 (manifest, provenance & SBOM, publish) once all matrix jobs succeed.

**Reference runner spec.** The cold-build budget in §17.1 (under 10 minutes per platform) assumes 4 vCPU / 16 GB RAM Linux runners and the GitHub-hosted macOS / Windows defaults. Self-hosted runners are permitted only for stage 9 (signing) where a hardware token is required and only the maintainer team has access.

**Secrets.** Signing secrets (Apple notary credentials, Windows code-signing certificate or HSM access, GPG private key, cosign key) live in GitHub Actions encrypted secrets and are scoped to the `release.yml` workflow. The workflow runs in a protected environment requiring approval from a release manager for `stable` tags.

**npm publish.** Stage 13 publishes `@lando/core` to npm via `bun publish` (or `npm publish` if Bun's publish is unsuitable at the moment). The publish uses an npm-granular token scoped to the `@lando` org with publish-only rights.

**Artifact storage.** All artifacts are stored on GitHub Releases. The update manifest URLs (`https://update.lando.dev/v4/<channel>.json`) are static JSON files served from a project-controlled CDN; the CI publishes new manifest files as part of stage 13, and a Cloudflare Workers-style edge invalidation is triggered immediately after upload. The exact CDN provider is an operational concern.

**Pipeline tagged errors.** Each stage failure raises a tagged release error consumed by a release-bot that opens an issue (`ReleaseStageFailureError` payloads include the stage, the platform target, the commit, the workflow URL, and the maintainer remediation). The release manager has a runbook keyed by `_tag`.

### 17.9 Acceptance criteria

The binary-shipping criteria below augment §15.C. The v4.0.0 release MUST satisfy every item.

- A maintainer can run `bun run release` on a clean checkout and produce, for the local platform target, a signed (when local credentials are present), notarized (macOS only), checksum-manifested binary that launches and reports the expected version.
- The full pipeline (stages 1–13) runs to completion in CI in under 30 minutes for a single-platform release and under 60 minutes for a full-matrix release.
- Every published binary is signed: macOS Developer ID + notarized, Windows Authenticode + cosign, Linux covered by GPG-signed `SHA256SUMS` + cosign-signed `SHA256SUMS`.
- Every published binary has a CycloneDX SBOM and a SLSA v1.0 provenance attestation, both downloadable from the GitHub Release.
- `cosign verify-blob` succeeds against every published binary using the published OIDC identity and issuer.
- The update manifest at `https://update.lando.dev/v4/stable.json` is signed and verifiable by the binary's embedded trust roots.
- `lando update` against a `next` snapshot binary successfully verifies, downloads, replaces, and re-execs into the latest `next` binary on macOS, Linux, and Windows.
- A failed launch probe after replacement triggers automatic rollback to the prior `.bak` binary, and `UpdateLaunchProbeError` is surfaced with the correct remediation string.
- `lando update` over an `EACCES` install path exits with `UpdatePermissionError` and prints the exact `sudo`/UAC remediation; it does not silently elevate.
- The curl-pipe installer at `https://get.lando.dev/install.sh` succeeds on a clean Linux x64 container, installs to `${HOME}/.lando/bin/lando`, verifies signatures against the embedded GPG trust root, and runs `lando version` successfully.
- The PowerShell installer at `https://get.lando.dev/install.ps1` succeeds on a clean Windows runner with default execution policy.
- The compiled binary's `import()` graph contains no path that performs a runtime filesystem read of bundled plugins, bundled recipes, the OCLIF manifest, or any built-in schema. (Asserted by the import-boundary test in §13.4.)
- The compiled binary is built with `--bytecode` so cold start does not pay JavaScript parse cost on every invocation (§2.1, §17.1 stage 7).
- The AOT bootstrap layers (§17.2 codegen, "Bootstrap layers") are present at `src/runtime/generated/layers/<level>.ts` and imported by the imperative shells at command resolution time; runtime `Layer.merge` / `Layer.provide` chains in core source are absent outside the codegen output (asserted by lint/grep gate in §13.4).
- The compiled binary meets the §2.1 end-to-end and perceived-performance budgets at p95 on the reference runner spec (§17.8); the perf-budget suite (§13.1) is part of the release-blocking nightly matrix.
- Level-`none` invocations of the released binary do not import `@oclif/core` or construct any `Context.Service`, asserted by the `LANDO_PERF_TRACE` allowlist snapshot in the perf-budget suite.
- The compiled binary can load an external ESM plugin by absolute `file://` URL from a Lando-managed plugin store.
- The compiled binary can load an external TypeScript plugin when Bun supports that file type directly.
- The compiled binary can resolve dependencies installed under an external plugin package root.
- The compiled binary rejects plugin contribution module paths that resolve outside the plugin package root.
- A failed external plugin import marks that plugin unhealthy, reports a tagged `PluginLoadError`, and does not prevent unrelated plugins from loading.
- `bun run codegen:check` succeeds on a clean checkout with no uncommitted changes.
- Removing a bundled plugin from `core/build.config.ts` and rebuilding produces a binary that omits the plugin from `oclif.manifest.json` and `src/plugins/bundled.ts` without code edits in `src/`.
- Adding a new canonical recipe under `recipes/<id>/` with a valid `recipe.yml` requires no code change to ship — only `bun run codegen` regenerates `src/recipes/bundled.ts` and the recipe is reachable via `lando init --recipe <id>` in the next built binary.

---
