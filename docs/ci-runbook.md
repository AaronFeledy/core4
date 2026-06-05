# CI runbook

Use these commands to reproduce the CI jobs locally.

## Static checks

CI pins Bun via `.bun-version`; update that file first when validating a new Bun release. The default PR gate runs `static-checks-platform` as a five-platform matrix over `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, and `win32-x64`; the stable `static-checks` summary job is the branch-protection check.

```bash
bun run typecheck
bun run lint
bun run test:unit
bun test core/test/services core/test/cli core/test/scenario
bun test core/test/recipes core/test/cli/init.canonical-recipes.test.ts
bun test core/test/library sdk/test/library
```

## Generated schema and bundled-codegen gates

CI fails if generated schema snapshots or bundled plugin/recipe tables drift. Update all generated outputs with `bun run codegen`:

```bash
bun run codegen
```

For focused local checks, CI runs `bun run codegen:schema-snapshot`, `bun run codegen:bundled-plugins`, and `bun run codegen:bundled-recipes`, then verifies the outputs with `git diff --exit-code`.

## Library API and recipe test layers

CI runs the Alpha library API and recipe layers as separate branch-protectable jobs:

```bash
bun test core/test/library sdk/test/library
bun test core/test/recipes core/test/cli/init.canonical-recipes.test.ts
```

## Platform binary builds

CI builds and smokes one binary per required PR platform:

- `build-darwin-arm64` on `macos-15` → `lando-darwin-arm64`
- `build-darwin-x64` on `macos-15-intel` → `lando-darwin-x64`
- `build-linux-arm64` on `ubuntu-24.04-arm` → `lando-linux-arm64`
- `build-linux-x64` on `ubuntu-24.04` → `lando-linux-x64`
- `build-win32-x64` on `windows-latest` → `lando-win32-x64`

```bash
bun run build
./core/dist/lando --version
./core/dist/lando --help
```

Each build job emits a `::notice title=ci-timing::...` line and has a timeout cap (30 minutes for Unix targets, 35 minutes for Windows). If a build job fails after producing the binary, inspect it from GitHub Actions at `Actions > ci > build-<platform> > Artifacts > lando-<platform>`; for example, `Actions > ci > build-linux-x64 > Artifacts > lando-linux-x64`.

## Tooling hot-path perf budget

CI runs the Linux x64 benchmark gate against the built binary artifact. The tracked warm p50 baseline and regression budget live in `scripts/bench-baselines.json`; deliberate changes to that file are reviewed like code.

```bash
bun run build
bun run bench:tooling-hot-path -- --binary core/dist/lando
```

## npm dev package publishing

The release workflow publishes `@lando/core@4.0.0-alpha.N` to npm with `--tag dev` after a successful `ci` workflow run. It uses npm trusted publishing through GitHub OIDC (`id-token: write`) and does not use a local `NPM_TOKEN` or `NODE_AUTH_TOKEN` path.

The package job builds workspace artifacts first:

```bash
bun run --filter='@lando/sdk' build
bun run --filter='@lando/core' typecheck
bun run --filter='@lando/core' build:manifest
```

Packaging plan: `@lando/sdk` remains a separate workspace package and is published to the npm `dev` tag at the same `4.0.0-alpha.N` version as an implementation dependency of `@lando/core`; end users still install the named Alpha distribution as `npm install @lando/core@dev`. The workflow rewrites `@lando/core`'s temporary checkout dependency from `workspace:*` to that exact alpha version before the dry-run and real publish.

Before publishing, CI runs dry-runs for both packages with the same `--tag dev` / `--access public` arguments. After publishing, CI asserts `@lando/core`'s `dev` dist-tag points at the alpha version and its `latest` dist-tag is unchanged.

## Provider integration

Provider integration tests intentionally stay serial because they share Docker/Podman sockets, images, ports, and app names. Use `--parallel` and `--isolate` only for focused local experiments.

Use the same Podman socket pattern as CI:

```bash
podman system service --time=0 unix:///tmp/podman.sock > /tmp/podman-service.log 2>&1 &
export LANDO_TEST_PODMAN_SOCKET=/tmp/podman.sock
export LANDO_CONFIG__default_provider_id=lando
export LANDO_TEST_DOCKER_SOCKET=/var/run/docker.sock
```

To reproduce the provider integration job:

```bash
LANDO_MVP_BINARY_PATH="$PWD/dist/lando" LANDO_TEST_PODMAN_SOCKET=/tmp/podman.sock bun test core/test/scenario
bun test plugins/provider-lando/test --filter=integration
bun test plugins/provider-docker/test --filter=integration
bun test plugins/service-lando/test --filter=integration
```

Provider integration also runs as platform-specific jobs (`provider-integration-<platform>`). Every provider job runs the provider contract layer first; `provider-integration-linux-x64` then runs the live Podman/Docker integration path above, while linux-arm64, macOS, and Windows targets stop after contract coverage so they do not require host sockets or mutate the host. Each provider job emits a `::notice title=ci-timing::...` line and has a timeout cap (25 minutes for Linux jobs, 20 minutes for macOS/Windows contract-only targets). If a provider integration job fails, download diagnostics from `Actions > ci > provider-integration-<platform> > Artifacts > provider-integration-diagnostics-<platform>`; for example, `Actions > ci > provider-integration-linux-x64 > Artifacts > provider-integration-diagnostics-linux-x64`.

## Nightly provider-lando e2e

The nightly workflow keeps host-mutating provider-lando e2e coverage out of the per-PR gate. The `provider-lando-e2e-linux-x64` job installs Podman on `ubuntu-24.04`, sets `net.ipv4.ip_unprivileged_port_start=0` for rootless low-port binds, provisions a private Podman socket, builds the Linux x64 compiled binary, then runs smoke and non-smoke scenario tests against that binary:

```bash
sudo sysctl net.ipv4.ip_unprivileged_port_start=0
podman system service --time=0 unix:///tmp/podman.sock > /tmp/podman-service.log 2>&1 &
export LANDO_TEST_PODMAN_SOCKET=/tmp/podman.sock
export LANDO_CONFIG__default_provider_id=lando
LANDO_MVP_BINARY_PATH="$PWD/core/dist/lando" LANDO_SCENARIO_E2E_BINARY="$PWD/core/dist/lando" bun test core/test/scenario --test-name-pattern="@smoke"
LANDO_MVP_BINARY_PATH="$PWD/core/dist/lando" LANDO_SCENARIO_E2E_BINARY="$PWD/core/dist/lando" bun test core/test/scenario --test-name-pattern="^(?!.*@smoke).*$"
```

Failures upload `provider-lando-e2e-diagnostics-linux-x64` with the Podman service log and recent journal output. Notification routing is intentionally limited to normal GitHub Actions failure reporting in Beta.

## Weekly provider matrix

The advisory `provider-matrix` workflow runs weekly and on manual dispatch. It covers Docker Desktop, Docker Engine, Podman Desktop, Podman, Lima, and OrbStack cells. GitHub-hosted CI only installs/runs the Linux Docker Engine and Podman cells; desktop-only engines emit a `::notice` skip so maintainers can mirror those cells on prepared self-hosted runners.

Installable cells run the shared provider contract layer:

```bash
bun test sdk/test/contract/provider.test.ts sdk/test/contract/service.test.ts
bun test plugins/provider-lando/test/contract.integration.test.ts
bun test plugins/provider-docker/test/contract.integration.test.ts
bun test plugins/provider-podman/test/contract.integration.test.ts
```

Failures upload `provider-matrix-diagnostics-<cell>` artifacts when logs are available. The weekly matrix is intentionally not listed under branch protection for Beta.

## Alpha platform scope

Historical Alpha CI was Linux x64 only: no Windows or linux-arm64 release matrix was generated in Alpha, and macOS provider-lando validation was manual QA or an explicit opt-in job. Beta PR CI now owns the broad multi-platform matrix documented above; nightly cron owns full provider-lando e2e on Linux x64; the weekly provider matrix owns advisory cross-engine coverage.

## Branch protection

Protect `main` in GitHub with required status checks enabled. All required status checks must pass before a pull request can merge to `main`:

- `static-checks`
- `schema-snapshot`
- `bundled-codegen`
- `library-api-tests`
- `recipe-tests`
- `guide-scenarios-linux-x64`
- `build-darwin-arm64`
- `build-darwin-x64`
- `build-linux-arm64`
- `build-linux-x64`
- `build-win32-x64`
- `perf-budget-linux-x64`
- `provider-integration-darwin-arm64`
- `provider-integration-darwin-x64`
- `provider-integration-linux-arm64`
- `provider-integration-linux-x64`
- `provider-integration-win32-x64`

## Bun upgrade smoke checks

After updating `.bun-version`, run these before opening a release-tooling PR:

```bash
bun --version
bun run test:unit
bun test --changed
bun run build
./core/dist/lando --version
./core/dist/lando --help
```

`BUN_INSTALL_GLOBAL_STORE=1 bun install --linker=isolated` is useful for local/CI cache experiments, but keep release builds on `bun install --frozen-lockfile` until Bun's global store is no longer experimental.
