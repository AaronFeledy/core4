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
│   ├── provider-docker/
│   ├── proxy-traefik/
│   ├── ca-mkcert/
│   ├── logger-pretty/
│   └── renderer-listr/
├── spec/          # Implementation specification (canonical source of truth)
├── biome.json     # Lint + format config (Biome — replaces ESLint + Prettier)
├── tsconfig.base.json  # Shared strict TS settings
├── tsconfig.json  # Workspace project references
└── package.json   # Bun workspace root
```

## Toolchain

- **Runtime:** Bun (≥ 1.2). Node is not supported.
- **Package manager:** `bun install`. `package-lock.json` and `yarn.lock` are forbidden.
- **Test runner:** `bun test`. Mocha, Jest, and Vitest are forbidden in core.
- **Lint + format:** Biome.
- **Type checks:** `tsc --noEmit` (no emit; Bun runs `.ts` directly).
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

This is **scaffolding-only**. Service tags and interfaces exist but are not
implemented (`Effect.die("not implemented")`). Use the [spec](./spec/README.md)
as the implementation roadmap.

## Known deviations

These need follow-up before GA:

- **`tsconfig.skipLibCheck: true`.** `@types/bun` and `@types/node` currently
  conflict on `stream/web` and a handful of other globals. Revisit once
  Bun's type packaging stabilizes.
- **Codegen is partial.** `scripts/build-bundled-plugins.ts` and the
  `scripts/codegen.ts` orchestrator scaffold the §17.2 catalog, but several
  generators (bootstrap layers, bundled recipes, bundled plugin templates,
  schema JSON, OCLIF manifest wrapper) are stubs that print "skip" until
  they land.
- **`scripts/release.ts` is a partial orchestrator.** Stages 1–4 and 6–7
  (codegen, typecheck, lint, test, library bundle, compile) run; stages 8–13
  (strip, sign, notarize, manifest, provenance, publish) are stubs. Real
  signing/notarization, SBOM, SLSA provenance, and the curl|sh installer
  manifest land alongside the release-secrets infrastructure.
- **`@lando/sdk` is currently a workspace package only.** It is intended to
  be `npm publish`-able as a peer of `@lando/core`. The package metadata is
  in place; only the publish pipeline is missing.
- **CLI command bodies are not yet wired.** Every command file under
  `core/src/cli/oclif/commands/` declares its canonical namespace-prefixed
  id (`app:start`, `meta:config`, …) and top-level alias per spec §8.1.1
  and §8.2, but the underlying `LandoCommandBase.runEffect` integration is
  a stub — invoking any command currently throws "not yet implemented".
