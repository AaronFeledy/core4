# PRD: Alpha-02: Distribution

## Introduction

Public Alpha 1 ships unsigned compiled binaries for all six compile targets, plus the canonical npm workspace set, as `4.0.0-dev.N` on the `dev` channel. Signing, installers, and self-update stay later.

## Source References

- [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) §13.5
- [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md) §17.1 compile stage (skip sign/notarize/self-update for this wave)
- [`scripts/prepare-npm-dev-packages.ts`](../../scripts/prepare-npm-dev-packages.ts) `releasePackageNames` / `releasePackageWorkspaces` (current Alpha path still derives `4.0.0-alpha.N`)

## User Stories

### US-593: Six-target unsigned 4.0.0-dev.N on dev

**Description:** As a user, I can get an unsigned `4.0.0-dev.N` compiled binary for each of the six compile targets from the `dev` channel.

**Acceptance Criteria:**

- [ ] Release compile produces binaries for `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `windows-x64`, and `windows-arm64`.
- [ ] Published version is `4.0.0-dev.N` on the `dev` channel. Beta/`next` is out of scope.
- [ ] The canonical full npm workspace publish set defined by `releasePackageNames` / `releasePackageWorkspaces` in `scripts/prepare-npm-dev-packages.ts` publishes unsigned `4.0.0-dev.N` packages on npm dist-tag `dev`.
- [ ] The existing Alpha preparation/release path changes from its current `4.0.0-alpha.N` behavior to unsigned `4.0.0-dev.N` on dist-tag `dev`.
- [ ] A dry-run/pack or equivalent registry-safe verification proves rewritten workspace dependency ranges and package contents without production signing, installer work, or a live publish in tests.
- [ ] Artifacts are unsigned. Signing, notarization, installers, and self-update must not block publish.
- [ ] A missing target fails the story. Compile smoke on a subset is not enough.
- [ ] Tests pass; typecheck passes; lint passes

**Failure path:** If any target is absent, published on `next`/Beta, gated on signing, or still prepared as `4.0.0-alpha.N`, the story fails and later live stories must not treat that target as shipped.

**Verification:** List all six artifacts at `4.0.0-dev.N` on `dev`. Confirm the `releasePackageNames` set is prepared as unsigned `4.0.0-dev.N` on dist-tag `dev` via dry-run/pack (rewritten workspace ranges, no live publish in tests). Confirm they are unsigned. Confirm no installer or self-update requirement.
