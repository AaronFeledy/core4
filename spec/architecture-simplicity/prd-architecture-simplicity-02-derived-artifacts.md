# PRD: ARCH-02 — Derived artifacts out of git SoT

## Introduction

Stop treating pure build outputs as git sources of truth. Schema JSON, command-schemas, many bake-time generated TS tables, and generated docs schema refs should be produced by `bun run codegen` and verified by the pure-drift gate — not hand-merged as hundreds of noisy files. Pin manifests and human-reviewed CI workflows stay committed.

## Source References

- `spec/13-testing-and-distribution.md` §13.2, §13.5
- `spec/15-binary-build-and-release.md` §17.2
- `spec/17-executable-tutorials.md` §19.6 (gitignore model)
- `sdk/AGENTS.md`

## Goals

- Classify every codegen output as **pin/committed** or **derived/untracked**.
- Clean checkout works: clone → install → codegen → typecheck/test.
- Publish and binary embed still ship schemas/manifests as **build products**.

## User Stories

### US-510: Gitignore and untrack schema artifact trees

**Description:** As a maintainer, dist/schemas, dist/command-schemas, and generated docs schema refs are gitignored and removed from the index.

**Acceptance Criteria:**
- [ ] .gitignore covers the untracked derived schema trees.
- [ ] git rm --cached applied for previously committed paths without deleting local regen ability.
- [ ] codegen:schema-snapshot still writes the trees.
- [ ] Tests pass; typecheck passes; lint passes

### US-511: Gitignore and untrack core bake-time generated TS

**Description:** As a maintainer, bootstrap layers, bundled plugin/recipe tables, compiled command manifest, and opentui stub catalog are untracked derived outputs where the catalog allows.

**Acceptance Criteria:**
- [ ] Catalog marks which core generated TS paths are untracked.
- [ ] CI workflows remain committed (human-reviewed exception).
- [ ] Tests pass; typecheck passes; lint passes

### US-512: Clean-checkout bootstrap

**Description:** As a new contributor, git clone && bun install && bun run codegen is enough before typecheck/test.

**Acceptance Criteria:**
- [ ] README or AGENTS documents the bootstrap order.
- [ ] Optional prepare/postinstall does not force network beyond bun install; codegen is explicit or documented.
- [ ] Clean CI job proves clone→install→codegen→typecheck.
- [ ] Tests pass; typecheck passes; lint passes

### US-513: Publish and pack embed regenerated schemas

**Description:** As a releaser, npm pack and the compiled binary embed schemas/manifests produced at build time without reading them from git history.

**Acceptance Criteria:**
- [ ] Release/build pipeline runs codegen before pack/compile.
- [ ] Published tarball contains required schema artifacts.
- [ ] Tests pass; typecheck passes; lint passes

### US-514: Keep pin manifests committed with offline invariants

**Description:** As a releaser, runtime-bundle and mutagen version JSON stay committed with existing offline invariant checks.

**Acceptance Criteria:**
- [ ] Pin manifests remain tracked.
- [ ] Offline invariant checks still run in codegen/staleness path.
- [ ] Tests pass; typecheck passes; lint passes

### US-515: sdk/AGENTS: no commit-dist workflow

**Description:** As an SDK author, docs say run codegen; CI catches drift; committing dist is not required.

**Acceptance Criteria:**
- [ ] sdk/AGENTS.md schema-snapshot bullet matches untracked policy.
- [ ] Tests pass; typecheck passes; lint passes

## Functional Requirements

- Semantic schema compatibility continues to compare working-tree artifacts to base ref after regen (§13.2) — it does not require committing the artifact set.
- Compose vendor pin and checksum-pinned upstream bytes stay committed.

## Non-Goals

- Deleting codegen.
- Untracking pin manifests or hand-authored specs/PRDs.
- Changing public schema **content** contracts.

## Technical Considerations

- Large initial `git rm --cached` should land with ignore rules in the same change.
- Editors and agents must run codegen after schema edits (US-512 docs).

## Success Metrics

- PR diffs no longer dominated by `dist/schemas/**` churn.
- Clone bootstrap documented and CI-proven.

## Guide Coverage

**None — internal/infra PRD.** This wave changes maintainer/CI architecture only; no new end-user CLI feature requires an executable guide.

## Open Questions

- None blocking.
