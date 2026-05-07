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

## Status

This is **scaffolding-only**. Service tags and interfaces exist but are not
implemented (`Effect.die("not implemented")`). Use the [spec](./spec/README.md)
as the implementation roadmap.

## Known deviations

These need follow-up before GA:

- **`tsconfig.skipLibCheck: true`.** `@types/bun` and `@types/node` currently
  conflict on `stream/web` and a handful of other globals. Revisit once
  Bun's type packaging stabilizes.
- **No CI matrix yet.** The existing `.github/workflows/*.yml` files are
  inherited from the `oclif init` Node-based scaffold and need a full
  rewrite to a Bun matrix (macOS x64+arm64, Linux x64+arm64, Windows x64;
  weekly provider matrix).
- **No `bun build --compile` step yet.** The
  `core/scripts/build-bundled-plugins.ts` generator and the cross-platform
  binary packaging both need to be wired up.
- **`@lando/sdk` is currently a workspace package only.** It is intended to
  be `npm publish`-able as a peer of `@lando/core`. The package metadata is
  in place; only the publish pipeline is missing.
