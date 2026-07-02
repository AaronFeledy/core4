# Lando Core v4

> **Experimental proof of concept.** This repository is a ground-up, from-scratch
> reimagining of [Lando](https://lando.dev) Core for v4 — an experiment in
> rebuilding the tool on Bun + Effect. It is not an official release and is not
> production-ready. Treat it as a research prototype, not the Lando you install
> today.

Lando v4 is a local development environment and DevOps tool that defines your
whole stack — services, proxy, certificates, file sync, and tooling — from a
single `.lando.yml` Landofile, then realizes it on a container runtime you
control (Lando-managed Podman by default, or system Docker/Podman).

This repository is the v4 implementation, structured as a [Bun](https://bun.sh)
workspace. The runtime is built on [Effect](https://effect.website): every
meaningful operation returns a typed `Effect.Effect<A, E, R>`, and every public
contract is an Effect Schema. Plugins are the unit of extension — providers,
services, the proxy, the certificate authority, file sync, loggers, renderers,
and template engines all ship as separate packages.

> **Work in progress.** This codebase is actively changing and unstable. APIs,
> command behavior, generated artifacts, and install flows may change without
> migration support while the experiment is still being shaped.

## Status & roadmap

Development follows the phase ladder in [`spec/ROADMAP.md`](./spec/ROADMAP.md):
**MVP → Alpha 1 → Alpha 2 → Alpha 3 → Alpha 4 → Beta 1 → Beta 2 → RC → 4.0 GA**.

- **Done:** MVP through **Alpha 4** ("governance + the last feature surface") —
  Alpha 4 closed the feature surface: release machinery, signing, supply chain,
  telemetry, schema publication, the plugin authoring toolkit, and the
  `lando setup` / `lando uninstall` lifecycle. Alphas publish `4.0.0-alpha.N`
  on the `dev` channel. PRD sets live under `spec/mvp/` and `spec/alpha-{1..4}/`.
- **Current: Beta 1** ("contract-completion remediation") — no new feature
  surface; an audit-driven pass that closes every gap between what the Alpha 4
  PRDs promised (and the spec requires) and what actually shipped. Stories
  US-372..US-395 in [`spec/beta-1/`](./spec/beta-1/prd-beta-1-00-index.md).
  The first signed `4.0.0-beta.N` ships on the `next` channel at the end of
  Beta 1, and **feature freeze is entered**.
- **After:** Beta 2 (bug burn-down), RC (all-platform §17.9 acceptance), GA.

The spec in [`spec/`](./spec/README.md) is the compatibility contract — when
code and spec disagree, the spec wins.

## Layout

```text
.
├── core/              # @lando/core — runtime, planner, OCLIF adapter, library API, CLI
├── sdk/               # @lando/sdk — schemas, tags, types only (plugin authors import this)
├── container-runtime/ # @lando/container-runtime — private provider-agnostic runtime helpers
├── plugins/           # Bundled reference plugins (separate packages, optional at runtime)
│   ├── service-lando/        # opinionated `lando` service base (env, packages, mounts, healthchecks, certs, SSH, hooks)
│   ├── provider-lando/       # Lando-managed Podman runtime (default provider)
│   ├── provider-docker/      # system Docker (opt-in)
│   ├── provider-podman/      # system / rootless Podman (opt-in)
│   ├── proxy-traefik/        # Traefik-backed ProxyService (the global `traefik` service)
│   ├── ca-mkcert/            # mkcert-backed CertificateAuthority
│   ├── file-sync-mutagen/    # Mutagen-accelerated bind mounts on slow-bind-mount providers
│   ├── template-handlebars/  # Handlebars whole-file Landofile template engine
│   ├── template-mustache/    # Mustache whole-file Landofile template engine
│   ├── logger-pretty/        # pretty-printed Logger
│   └── renderer-lando/       # bundled default Lando Renderer plugin
├── recipes/           # Bundled recipes (drupal, drupal-cms, lamp, lemp, wordpress)
├── spec/              # The v4 specification (compatibility contract) + ROADMAP + per-phase PRD sets
├── scripts/           # Codegen, release orchestrator, guide/scenario + CI workflow tooling
├── docs/              # CI runbook, install guide, embedding guide, executable guides (MDX)
├── test/              # Cross-package and generated scenario tests
├── biome.json         # Lint + format config (Biome — replaces ESLint + Prettier)
├── tsconfig.base.json # Shared strict TS settings
├── tsconfig.json      # Workspace project references
└── package.json       # Bun workspace root
```

## Architecture at a glance

- **`@lando/sdk`** is a types-and-contracts-only package. Plugin authors import
  it for schemas, service tags, the event taxonomy, and error types. Its public
  surface is compatibility-locked (see `sdk/AGENTS.md`).
- **`@lando/core`** owns the runtime: it discovers and validates a Landofile,
  *plans* it into an `AppPlan`, and hands that plan to a `RuntimeProvider` to
  apply. It exposes two imperative shells — the CLI and the embeddable
  [library API](./docs/embedding.md).
- **Providers** (`provider-lando`, `provider-docker`, `provider-podman`)
  implement the same `RuntimeProvider` contract and declare capabilities
  (e.g. `bindMountPerformance`, `sharedCrossAppNetwork`) that the planner and
  subsystems adapt to.
- **The global app** is a reserved, host-level Lando app that hosts
  cross-cutting services (the Traefik proxy today). User apps that need a global
  service auto-start it on `lando start`.
- **Scratch apps** are short-lived apps whose lifetime is bound to an Effect
  `Scope` — their state is purged when the scope closes.
- **Bootstrap layers** are code-generated per bootstrap level under
  `core/src/runtime/generated/layers/` so the runtime composes only the services
  a given command tier needs (the CLI cold-start / first-byte path stays free of
  Effect/OCLIF/plugin imports).

## Toolchain

- **Runtime:** Bun (>=1.3.14, see `engines` and `.bun-version`). Node is not supported.
- **Package manager:** `bun install`. `package-lock.json` and `yarn.lock` are forbidden.
- **Test runner:** `bun test`. Mocha, Jest, and Vitest are forbidden in core.
- **Lint + format:** Biome.
- **Type checks:** `tsc -b` (project references; Bun runs `.ts` directly at runtime).
- **CLI framework:** OCLIF — consumed only inside `core/src/cli/oclif/`.
- **Runtime model:** Effect — every meaningful operation returns an `Effect.Effect<A, E, R>`.
- **Schema:** Effect Schema — single source of truth for every public contract.

## Quick start

```bash
# Install all workspace deps (creates the workspace symlinks)
bun install

# Type check the whole workspace
bun run typecheck

# Lint
bun run lint

# Format
bun run format

# Run the full test suite
bun test
```

> The combined CI gate is `bun run typecheck` **and** `bun test` — root `tsc -b`
> does not typecheck `sdk/test/`, so run both. Run a focused test by path, e.g.
> `bun test core/test/unit/bootstrap.test.ts`.

### Common scripts

| Script | What it does |
| --- | --- |
| `bun run typecheck` | `tsc -b` across the workspace |
| `bun run lint` / `bun run format` | Biome check / format-write |
| `bun test` | Full test suite (`bun run test:unit` skips integration tests) |
| `bun run build` | Build every workspace package |
| `bun run codegen` | Run all code generators |
| `bun run dev:guides` | TDD driver for executable guides (regenerate + typecheck + re-run affected scenarios on change) |
| `bun run lint:guides` | Lint executable-guide MDX |
| `bun run check:renderer-boundary` | Renderer-boundary gate — no direct `console.*` / `process.std*.write` under `core/src/**`, `plugins/**` |
| `bun run check:guide-coverage` / `check:guide-drift` | Guide coverage matrix + drift gates |
| `bun run release` | 13-stage release orchestrator (compile, sign, SBOM, provenance, publish) |

CI failures can be reproduced locally with the [CI runbook](./docs/ci-runbook.md).
Embedding `@lando/core` as a library? See the [embedding guide](./docs/embedding.md).
Installing an alpha build or filing bug reports? See [alpha install and bug
reports](./docs/alpha-install-and-bug-reports.md).

## CLI surface

The CLI is grouped into app, multi-app, scratch, and meta namespaces. A sample:

- **Per-app:** `lando start`, `stop`, `restart`, `rebuild`, `destroy`, `info`,
  `logs`, `exec`, `ssh`, `shell`, `config`, `config:lint`, `config:translate`,
  `includes:update`, `includes:verify`, `cache:refresh`
- **Multi-app:** `lando init`, `apps:list`, `apps:poweroff`
- **Scratch apps:** `lando scratch start`/`stop`/`list`/`info`/`logs`/`destroy`/`gc`
- **Host integration:** `lando setup`, `lando uninstall`, `lando shellenv`,
  `lando update`, `lando doctor`
- **Meta:** `meta:config` (incl. `config telemetry`), `meta:bun`, `meta:x`,
  plugin management (`plugin:add`/`remove`/`trust`) plus the authoring toolkit
  (`plugin:new`/`test`/`build`/`link`/`unlink`/`publish`), and the global app
  lifecycle (`meta:global:install`/`start`/`stop`/`status`/`config`/`destroy`/`uninstall`)

All command output flows through the `Renderer` service; pick a mode with
`--renderer=lando|json|plain|verbose` (default `lando`; precedence: flag >
`LANDO_RENDERER` env > config > default).

## Building from source

The compiled binary is produced with `bun build --compile --bytecode` targeting
`core/bin/lando.ts` (not `index.ts`). The release pipeline compiles for five
platforms — `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, and
`windows-x64`. The source CLI dispatches through OCLIF; the compiled `$bunfs`
binary uses a hand-rolled dispatcher (`runCompiledCli` in `core/src/cli/run.ts`)
because `@oclif/core`'s `execute()` cannot dispatch inside a compiled Bun binary.
Both paths share one source of truth per behavior and are kept in lockstep by the
dispatch parity test layer — this dual dispatch is **permanent by design**, not
an interim workaround.

## Contributing

Repo-specific quirks and conventions that agents and contributors must follow
live in [`AGENTS.md`](./AGENTS.md) and the per-package `AGENTS.md` files.

## Known limitations

This repository is unstable by design. A few practical caveats:

- **The default provider's runtime bundle is a placeholder.** `@lando/provider-lando`
  resolves its Podman runtime bundle from a per-platform manifest whose committed
  entries are placeholders (404 URLs + zeroed checksums). End-to-end
  default-provider `lando setup` cannot complete against real bundles yet; build a local bundle with
  `scripts/build-runtime-bundle.ts` and point `LANDO_RUNTIME_BUNDLE_MANIFEST` at
  it to exercise the path.
- **Installer trust roots are placeholders.** The embedded GPG public key
  and cosign identity/issuer used by the installers are verification-test
  placeholders, not production release keys.
- **`tsconfig.skipLibCheck: true`.** `@types/bun` and `@types/node` currently
  conflict on `stream/web` and a few other globals. Revisit once Bun's type
  packaging stabilizes.
- **`@lando/sdk` and `@lando/core` are `private` in-repo.** Both are pinned to
  version `0.0.0` in the working tree; the publish pipeline
  (`scripts/prepare-npm-dev-packages.ts` + the release workflow) rewrites
  versions and `workspace:*` ranges before publishing.
- **Some command surfaces are not implemented.** A subset of commands still
  throw `NotImplementedError`/`Effect.die`; deferred ids are tracked in
  `core/src/cli/deferred-commands.ts`.

## License

MIT © Lando Alliance
