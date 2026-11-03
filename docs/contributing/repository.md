---
title: Contributor source map
description: Find Lando's package boundaries, source-build instructions, and validation tools.
---

# Contributor source map

Use this page to find the code and checks for a Lando change. To run an app rather
than work on Lando itself, use the [Alpha install guide](../alpha-install-and-bug-reports.md).
Read the root [repository instructions](../../AGENTS.md) and any package-specific
`AGENTS.md` before editing.

## Build from source

You need Git and Bun. Use the version pinned in [`.bun-version`](../../.bun-version); the current minimum is Bun 1.4.3. Node is not a supported host runtime. Use Bun for dependency installation, scripts, and tests.

Follow the [source-build steps](../alpha-install-and-bug-reports.md#option-2-build-from-source)
to clone the repository, install dependencies, and generate sources. Before
building the container helper, configure a working provider using the
[platform-specific setup instructions](../alpha-install-and-bug-reports.md#choose-setup-for-your-platform).
For source-mode setup, substitute `bun core/bin/lando.ts` for `lando`; keep the
provider flag required by your platform.

The static Go helper in `core/container-helper/` builds inside a Lando container,
so you do not need Go on the host. Linux's full test suite needs the helper, and
CLI compilation needs it on every host. Rebuild it after changing helper sources
or the root `.lando.yml`; compilation rejects a stale helper. The
[helper build instructions](./ci.md#in-container-helper) cover prerequisites and verification.

## Find the owning package

| Path | Responsibility |
| --- | --- |
| `core/` | CLI, library API, generated bootstrap layers, and bundled-plugin wiring |
| `sdk/` | Public Effect Schemas, service contracts, event types, and errors used by plugin authors |
| `engine/` | Orchestration runtime and implementations of app operations |
| `container-runtime/` | Provider-independent container-runtime helpers |
| `plugins/` | Providers, services, proxy, certificates, file sync, renderers, and template engines |
| `recipes/` | Public recipe sources and their executable walkthroughs |
| `docs/` | User guides, generated reference pages, and contributor runbooks |
| `scripts/` | Code generation, validation, build, and release tools |
| `test/` | Cross-package and generated scenario tests |

Other private workspace packages own paths, persisted state, Landofile loading,
redaction, HTTP, managed files, data movement, telemetry, rendering, and MCP.
See [package boundaries](../../AGENTS.md#architecture-boundaries) for the detailed ownership rules.
Import public plugin contracts from `@lando/sdk`, not an internal implementation.
The [SDK instructions](../../sdk/AGENTS.md) describe its compatibility checks.

App operations use Effect and schema-defined contracts. The planner validates
provider capabilities before applying a plan. Provider plugins implement the
same `RuntimeProvider` contract; the runtime selects a provider for the app's plan.
The host-level global app owns shared services such as the proxy. App startup
starts required shared services rather than asking the user to launch them.

Foreground scratch apps have scoped cleanup; detached scratch apps have their
own lifecycle. Do not assume every scratch app disappears when a command exits.
The implementation lives in [`engine/src/scratch-app/`](../../engine/src/scratch-app/).

### Work on the optional GitHub Actions package

[`plugins/github-actions/`](../../plugins/github-actions/) is the optional
`@lando/github-actions` plugin. It is not bundled with Lando and is not
published to npm; a user builds and links its artifact from a source checkout, as described in
[Inspect GitHub Actions workflows with Lando](../guides/plugins/github-actions-inspection.mdx).
It contributes one command, `github-actions:list`, and exports the public
inspection operation `listWorkflows` from `@lando/github-actions/operations`,
with its input and report schemas under `/schema` and its tagged error under
`/errors`.

Inspection is offline and read-only. It reads bounded workflow files under
`.github/workflows/`, reports source-located facts and diagnostics, and never
executes a workflow, evaluates expressions, fetches a reusable workflow, reads a
Landofile, or uses a provider or the network. Keep that boundary when changing
the package: reports carry names, identities, positions and declared requirements;
errors carry safe codes and remediation, never scripts, environment/input values
or raw upstream messages. Review essential metadata before sharing it. `assessment` stays
`execution-unassessed`; a clean report is not a compatibility verdict.

After the repository bootstrap, run the package's focused checks from the root:

```sh
bun test plugins/github-actions/test
bun run --filter='@lando/github-actions' typecheck
bun run dev:guides docs/guides/plugins/github-actions-inspection.mdx --once
```

The guide scenarios call `listWorkflows` directly against fixtures. To exercise
the linked command, build the distribution with
`bun run --filter='@lando/github-actions' build:artifact` and set
`LANDO_ACTIONS_TEST_BINARY` to that binary before running the package tests.

Running Lando commands inside GitHub-hosted CI is a separate, existing workflow;
follow [Run Lando in GitHub Actions](../guides/install/ci-github-actions.mdx).

## Work on the CLI or compiled binary

Source and compiled entries share one native dispatcher in `core/src/cli/run.ts`.
Command declarations belong in `core/src/cli/command-specs/`, spec machinery in
`core/src/cli/spec/`, and invocation/render helpers in `core/src/cli/commands/`.
The built-in registry records whether each command is implemented or deferred.
Do not introduce a second dispatch path. See [CLI dispatch](../../core/AGENTS.md#cli-dispatch-single-native-engine).

Bootstrap layers are generated under `core/src/runtime/generated/layers/`.
Change the generator rather than those outputs, and update the runtime-service
type union when adding a service. A command's declaration selects its bootstrap tier.

Standalone compilation targets `core/bin/lando.ts`, not the library entry point.
The build uses Bun compilation with bytecode for all six release targets.
Windows release binaries must be compiled on Windows to embed their icon and
version metadata. See the [Bun compiler decision](./decisions.md#bun-floor-decision)
and [release platform requirements](./release.md#platform-scope).

## Choose the checks for your change

Run commands from the repository root after installing dependencies, generating
sources, and building the helper when the selected tests need it.

| Command | Purpose |
| --- | --- |
| `bun run gate:pr` | Typecheck, lint, generated-output drift, test ownership, boundaries, and guide drift against `origin/main` |
| `bun test` | Full test suite; live tests may have additional prerequisites |
| `bun run test:unit` | Unsharded execution of the CI unit file set, including reviewed local integration suites and excluding dedicated suites |
| `bun run format` | Write Biome formatting changes |
| `bun run codegen` | Regenerate catalog-owned sources and artifacts |
| `bun run lint:guides` | Validate executable-guide structure and Landofile examples |
| `bun run docs:check` / `bun run docs:test` | Check and test the Astro-owned docs tree |
| `bun run docs:dev` / `bun run docs:build` | Preview or build the documentation site |

The pre-PR gate does not replace tests. Root typechecking covers source and
non-docs test trees; the docs checks are separate. Fetch `origin/main` before
checking guide drift. Use the [CI runbook](./ci.md) to reproduce a specific job,
including focused tests, guide checks, and provider integration tests.

Executable guides check reader-facing workflows, while integration tests check
behavior against external systems. To write or debug one scenario, follow
[author an executable guide scenario](./guide-authoring.md). Guide fixtures
and `provider: test` can model operations without starting containers. They do
not prove live runtime behavior or produce a real transcript of every displayed
command. Use real-provider e2e scenarios for that evidence. Keep regressions
with no documentation purpose in tests rather than inventing a guide to hold them.

## Keep development and release artifacts distinct

The checked-in `@lando/core` and `@lando/sdk` packages are private at version
`0.0.0`. Package preparation rewrites versions and workspace dependency ranges
for publication. Do not treat those working-tree versions as published versions.
See [`scripts/prepare-npm-dev-packages.ts`](../../scripts/prepare-npm-dev-packages.ts)
and the [release runbook](./release.md).

The default managed-runtime manifest pins published assets. To test an unpublished
runtime bundle, build it with `scripts/build-runtime-bundle.ts` and use
`LANDO_RUNTIME_BUNDLE_MANIFEST` to select that manifest. This override is a
development tool, not a prerequisite for ordinary Alpha setup.

Public Alpha 1 is the current milestone. Earlier internal phases are pre-alpha;
Beta follows Alpha. The `dev` channel ships unsigned `4.0.0-dev.N` artifacts.
Signing, installers, and self-update are later milestones, not Alpha delivery
claims. The manual signed Beta pipeline is a separate release path.

Compiling six binaries is not Alpha acceptance: the
[platform criteria](./ci.md#alpha-platform-scope) require live setup, doctor,
and canonical Drupal and Rails journeys across all six targets. A roadmap
rewrite does not satisfy these criteria.

The public Rails recipe uses an executable `README.mdx` in `recipes/rails/`.
Extend its existing built-in implementation rather than adding a duplicate recipe.

TypeScript currently uses `skipLibCheck` because the Bun and Node declaration
packages conflict on globals such as `stream/web`. The reason is recorded beside
the setting in [`tsconfig.base.json`](../../tsconfig.base.json).
