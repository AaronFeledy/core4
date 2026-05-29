# Lando Core v4

This repository contains the Lando v4 implementation, structured as a Bun
workspace.

## Layout

```text
.
├── core/          # @lando/core — runtime, planner, OCLIF adapter, library API
├── sdk/           # @lando/sdk — schemas, tags, types only (plugin authors import this)
├── plugins/       # Bundled reference plugins (separate packages, optional at runtime)
│   ├── service-lando/
│   ├── provider-lando/      # Lando-managed runtime (default provider)
│   ├── provider-docker/     # system Docker (opt-in)
│   ├── provider-podman/     # system Podman (opt-in)
│   ├── proxy-traefik/
│   ├── ca-mkcert/
│   ├── file-sync-mutagen/   # accelerated bind mounts on Docker-Desktop-class providers
│   ├── logger-pretty/
│   └── renderer-listr/
├── scripts/       # Codegen, release orchestrator, guide/scenario tooling
├── docs/          # CI runbook, alpha install guide, and executable guides (MDX)
├── test/          # Cross-package and generated scenario tests
├── spec/          # Implementation specification (canonical source of truth)
├── biome.json     # Lint + format config (Biome — replaces ESLint + Prettier)
├── tsconfig.base.json  # Shared strict TS settings
├── tsconfig.json  # Workspace project references
└── package.json   # Bun workspace root
```

## Toolchain

- **Runtime:** Bun (≥ 1.3.14, see `engines`). Node is not supported.
- **Package manager:** `bun install`. `package-lock.json` and `yarn.lock` are forbidden.
- **Test runner:** `bun test`. Mocha, Jest, and Vitest are forbidden in core.
- **Lint + format:** Biome.
- **Type checks:** `tsc -b` (project references; Bun runs `.ts` directly at runtime).
- **CLI framework:** OCLIF — consumed only inside `core/src/cli/oclif/`.
- **Runtime model:** Effect — every meaningful operation returns an `Effect.Effect<A, E, R>`.
- **Schema:** Effect Schema — single source of truth for every public contract.

## Quick start

```bash
# Install all workspace deps
bun install

# Type check the whole workspace
bun run typecheck

# Lint
bun run lint

# Format
bun run format

# Run tests
bun test
```

CI failures can be reproduced locally with the [CI runbook](./docs/ci-runbook.md).
Alpha testers can follow the [Alpha install and bug report guide](./docs/alpha-install-and-bug-reports.md)
for supported install paths, checksum verification, diagnostics, and report artifacts.

## Status

This is **alpha**, under active implementation. The runtime, planner, Landofile
config pipeline, build orchestrator, and a growing set of CLI commands and
subsystems (proxy, certificate authority, SSH, healthchecks, URL scanning, host
proxy, file sync) are wired up — not just empty tags. Some command bodies and
surfaces are still stubbed and throw `NotImplementedError`/`Effect.die` until
their story lands. Use the [spec](./spec/README.md) as the canonical source of
truth and the implementation roadmap.

## Known deviations

These need follow-up before GA:

- **`tsconfig.skipLibCheck: true`.** `@types/bun` and `@types/node` currently
  conflict on `stream/web` and a handful of other globals. Revisit once
  Bun's type packaging stabilizes.
- **AOT bootstrap-layer codegen has not shipped.** The `scripts/codegen.ts`
  orchestrator runs the §17.2 catalog (guide scenarios, bundled plugins,
  bundled recipes, schema snapshot, OCLIF manifest, CI/release/nightly
  workflows), but the AOT bootstrap-layer generator is not yet emitted;
  `core/src/runtime/layer.ts` still composes the runtime via runtime
  `Layer.mergeAll` chains. Tracked in spec §17.2 / §2.4.
- **`scripts/release.ts` is a partial orchestrator.** The codegen, typecheck,
  lint, test, library-bundle, and compile stages run; the schema-artifacts,
  strip, sign, notarize, manifest, provenance, and publish stages are stubs
  that exit successfully without real work. Signing/notarization, SBOM, SLSA
  provenance, and the curl|sh installer manifest land alongside the
  release-secrets infrastructure.
- **`@lando/sdk` and `@lando/core` are workspace packages only.** Both are
  marked `private` today. `@lando/sdk` is intended to be `npm publish`-able as
  a peer of `@lando/core`; the package metadata is in place and
  `scripts/prepare-npm-dev-packages.ts` exists, but the production publish
  pipeline is not yet wired.
- **Dual CLI dispatch (interim).** Source mode runs through OCLIF
  (`core/src/cli/oclif/`); the compiled `$bunfs` binary bypasses OCLIF and
  routes through a hand-rolled dispatcher (`runCompiledCli` in
  `core/src/cli/run.ts`). Many command bodies are implemented, but some
  commands and surfaces remain stubbed (`NotImplementedError`). Parity rules
  and accepted divergences are tracked in spec §8.4.1.
- **The renderer is not yet wired at the CLI command boundary.** The
  `--renderer=lando|json|plain` flag parses but does not yet reach a `Renderer`
  Live Layer; commands currently write to stdout/stderr directly. Tracked in
  spec §14.2.
