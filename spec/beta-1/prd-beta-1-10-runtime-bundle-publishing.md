# PRD: BETA1-10 — Runtime-bundle publishing & the committed-manifest invariant

## Introduction

`@lando/provider-lando` ships inside the binary, but the runtime bundle it installs during `lando setup` is resolved from `plugins/provider-lando/runtime-bundle-versions.json` — and that committed manifest is still a **placeholder**: its URLs point at a `lando/runtime-bundles` repository that will never exist, its SHA-256 values are all-zero fakes, and its sizes are 0. Today the only working setup path is the `LANDO_RUNTIME_BUNDLE_MANIFEST` override pointed at a locally staged bundle (what CI does), which means a locally built binary — or a source run — cannot complete `lando setup` without special env vars.

The spec now resolves this (§5.8.1 committed-manifest invariant, §13.5 hosting, §17.8 runtime-bundle publishing): runtime bundles are published as **immutable assets on this repository's own GitHub Releases** under `runtime-v<version>` tags, and the committed manifest MUST always pin real, published artifacts. Once the invariant holds, every binary compiled from any commit — local dev build, dev-channel snapshot, or tagged release — resolves the runtime bundle with zero overrides, because the manifest it embeds is simply *true*. There is deliberately **no** channel-aware manifest resolution, no runtime manifest fetch, and no embedding of runtime bytes into the `lando` binary (size).

This PRD stands up the publishing pipeline, performs the first real publish, pins the manifest, and adds the gates that keep the invariant from regressing.

## Source References

- [`spec/05-runtime-providers.md`](../05-runtime-providers.md) §5.8.1 runtime-bundle source resolution, override precedence, and the committed-manifest invariant.
- [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) §13.5 bundled runtime hosting (in-repo `runtime-v*` release series) and current-commit CI verification.
- [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md) §17.2 "Runtime bundle manifest" codegen row (URL shape, placeholder prohibition, platform coverage) and §17.8 "Runtime-bundle publishing" workflow.
- [`spec/ROADMAP.md`](../ROADMAP.md) — runtime bundle download + checksum verification maturity ladder.
- `scripts/build-runtime-bundle.ts` — existing `--local` and release-mode manifest builder.
- [`prd-beta-1-04-setup-uninstall-release.md`](./prd-beta-1-04-setup-uninstall-release.md) US-387 (macOS/Windows managed-runtime path) and US-388 (release-automation posture) — adjacent, not superseded.

## Goals

- Publish real per-platform runtime bundles as immutable `runtime-v<version>` release assets **in this repository** (no separate runtime-bundles repo).
- Replace the placeholder `runtime-bundle-versions.json` with real URLs, sizes, and SHA-256 checksums so `lando setup` works from a local binary build or a source run with **zero env overrides**.
- Enforce the §5.8.1 committed-manifest invariant with CI gates (placeholder rejection, URL-shape check, `runtimeVersion` drift check) so the manifest can never silently regress to fakes.
- Keep the existing override escape hatch (`LANDO_RUNTIME_BUNDLE_MANIFEST`, paired URL/sha flags) byte-for-byte intact for bundle development and current-commit CI verification.

## User Stories

### US-410: Runtime-bundle publishing workflow (`runtime-v*` release series)

**Description:** As a maintainer, bumping `plugins/provider-lando/runtime-bundle-version` triggers a generated workflow that assembles per-platform runtime bundles from pinned upstream sources and publishes them as immutable assets on a `runtime-v<version>` GitHub Release in this repository.

**Acceptance Criteria:**

- [ ] A new generated workflow (emitted by a `scripts/build-runtime-bundle-workflow.ts`-style generator following the existing `build-release-workflow.ts` pattern; never hand-edited YAML) builds runtime bundles for every supported host platform, keyed by exactly four runtime host keys: `linux-x64`, `linux-arm64`, `darwin-arm64`, `win32-x64` (the §13.5 release platform id `windows-x64` corresponds to manifest host key `win32-x64`; both names stay in their existing domains per root `AGENTS.md`). Podman 6 drops Intel Mac support.
- [ ] Bundle contents are assembled from **pinned** upstream artifact versions declared in a committed input (not "whatever the runner's package manager installed"): the pinned Podman line is Podman 6; Linux bundles include Podman + rootless helpers (crun/conmon/netavark v2.x/aardvark-dns v2.x/gvproxy/fuse-overlayfs/passt with pasta/newuidmap/newgidmap as applicable per platform); macOS and Windows bundles include the Podman remote client + machine/gvproxy helpers. Assembly is reproducible: re-running against the same pins produces artifacts with identical SHA-256s.
- [ ] The workflow uploads the platform tarballs/zips (per the existing `RUNTIME_BUNDLE_TARGETS` naming) as assets on a `runtime-v<version>` GitHub Release in this repository, and fails — rather than re-uploads — if the tag or any asset already exists (immutability).
- [ ] `scripts/build-runtime-bundle.ts` release mode derives asset URLs from this repository's `releases/download/runtime-v<version>/` path (the dead `lando/runtime-bundles` base URL is removed).
- [ ] The workflow's final step regenerates `runtime-bundle-versions.json` against the published assets and surfaces the diff for landing (PR or same-change commit per §17.8), so a version bump and its manifest pin always travel together.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-411: Pin the committed manifest — local builds "just work"

**Description:** As a developer, I can compile the binary locally (or run from source) and complete `lando setup`'s runtime-bundle resolution with no `LANDO_RUNTIME_BUNDLE_MANIFEST`, no override flags, and no special setup — because the committed manifest pins real published artifacts.

**Acceptance Criteria:**

- [ ] `plugins/provider-lando/runtime-bundle-versions.json` contains real HTTPS URLs under this repository's `releases/download/runtime-v<version>/` path, real SHA-256 checksums, and real sizes for all four host targets; the `_comment` placeholder disclaimer is gone.
- [ ] The manifest's `runtimeVersion` equals the `runtime-bundle-version` file's content.
- [ ] A CI job (Linux) compiles the binary from the current checkout **without** `LANDO_RUNTIME_BUNDLE_MANIFEST` and runs `lando setup` end-to-end: the bundle downloads from the published `runtime-v*` asset, checksum-verifies, and installs. This is a *published-manifest* smoke check and explicitly does not replace the §13.5 current-commit override verification, which remains as-is.
- [ ] Running from source (`bun run` path) resolves the identical manifest via the existing static JSON import — asserted by a test that the embedded/imported manifest passes the production schema (`https`-only, no placeholders).
- [ ] No resolution-precedence change: env override > paired flags > committed manifest, byte-identical behavior to §5.8.1.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-412: Committed-manifest invariant gates

**Description:** As a maintainer, CI blocks any change that would regress the manifest to placeholders, off-repo URLs, or a version that drifts from the `runtime-bundle-version` file — so the "local builds just work" property, once established, cannot silently rot.

**Acceptance Criteria:**

- [ ] A check script (wired into CI like the existing `check:*` gates) validates the committed manifest: every entry is HTTPS under this repository's `releases/download/runtime-v<version>/` path, no placeholder checksums (all-zero-style SHA-256) and no `sizeBytes: 0`, the platform key set is exactly the four runtime host keys (`linux-x64`, `linux-arm64`, `darwin-arm64`, `win32-x64` — not the §13.5 release id `windows-x64`), and `runtimeVersion` matches `plugins/provider-lando/runtime-bundle-version`. Podman 6 drops Intel Mac support.
- [ ] The release pipeline (`scripts/release.ts`) gains a release-blocking stage gate that fails when the manifest violates the invariant, mirroring the placeholder-rejection pattern already used for update-manifest binaries (`isPlaceholderBinary`).
- [ ] Per-PR CI runs only the offline invariant checks (no network); the live verification that each manifest URL resolves over HTTPS to a 200 with the recorded `Content-Length` runs on the release path and a periodic job, per the §17.2 catalog row's offline/live gate split.
- [ ] Placeholder-manifest regression is covered by a test fixture proving the check fails on the pre-US-411 placeholder manifest.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

## Functional Requirements

- **FR-1:** Runtime-bundle artifacts are hosted exclusively as immutable assets on this repository's `runtime-v<version>` GitHub Releases (§13.5); no separate repository, no CDN dependency for bundle bytes.
- **FR-2:** The committed manifest MUST satisfy the §5.8.1 committed-manifest invariant at every commit on the default branch once US-411 lands.
- **FR-3:** Manifest resolution behavior in `@lando/provider-lando` is unchanged: static import, env/flag override precedence, `Downloader`-routed verification. No channel detection, no runtime manifest fetching, no runtime bytes embedded in the `lando` binary.
- **FR-4:** The publishing workflow is generated output; changes go through its generator and land with `git diff --exit-code` clean on the generated path.
- **FR-5:** Bundle assembly pins upstream versions in committed input files; a bump is an explicit, reviewable diff.

## Non-Goals

- Embedding runtime-bundle bytes into the compiled `lando` binary (rejected for size; §13.5 prohibition stands).
- Channel-aware or remote manifest resolution (rejected as unnecessary; dev and release binaries behave identically).
- The macOS/Windows managed-machine *lifecycle* (`ensureRuntime` on the bundled Podman machine path) — that is US-387's scope. This PRD only guarantees the mac/win bundle **artifacts** exist, are published, and are pinned.
- Auto-staging host Podman binaries when the manifest is unpublished — the explicit override remains the only path to unpublished bundles.
- Changing mkcert/Mutagen helper provisioning; they keep their own `*-versions.json` pattern.

## Technical Considerations

- The four-host-key assembly is the long pole; darwin/win32 bundles are "podman remote client + machine helpers" repackaging of pinned upstream release artifacts, not from-source builds. If upstream does not publish a pinned artifact for some helper, building it in the workflow from a pinned tag is acceptable as long as the SHA-256 output is stable per pin-set.
- The CI provider-integration jobs' existing "stage from apt" trick should migrate to the same pinned assembly path so the current-commit verification exercises bundle contents identical in shape to published ones (may land with US-410 or as follow-up hygiene).
- The chicken-and-egg is ordered away: publish assets first (US-410 workflow), regenerate the manifest against published bytes, land both together; the URL is deterministic from the tag.
- GitHub release-asset immutability is enforced by convention + workflow guard (fail on existing tag/asset), since GitHub itself allows deletion; the guard plus review is the control point.

## Success Metrics

- On a clean Linux machine: download or locally compile the binary → `lando setup` completes runtime-bundle install with zero env vars set.
- `git grep 0000000000000000` finds no placeholder checksums in `runtime-bundle-versions.json`.
- The invariant gate demonstrably fails a PR that reintroduces a placeholder or off-repo URL.

## Guide Coverage

- The setup guide's runtime-bundle path needs no override language for the normal case; if any guide documents `LANDO_RUNTIME_BUNDLE_MANIFEST`, it is repositioned as the bundle-development escape hatch. Run the guide gates if guide-owned setup surfaces change.

## Open Questions

- Should the published-manifest smoke check (US-411 AC-3) run per-PR, nightly, or release-only? Default assumption: nightly + release, to keep PR CI off the network for large artifacts.
- Asset-immutability enforcement beyond the workflow guard (e.g., tag protection rules) is a repo-settings concern outside the codebase; noted for the release manager runbook.
