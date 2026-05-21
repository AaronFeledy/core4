# CI runbook

Use these commands to reproduce the CI jobs locally.

## Static checks

CI pins Bun via `.bun-version`; update that file first when validating a new Bun release.

```bash
bun run typecheck
bun run lint
bun run test:unit
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

## Linux x64 binary build

```bash
bun run build
./core/dist/lando --version
./core/dist/lando --help
```

If the build job fails after producing the binary, inspect it from GitHub Actions at `Actions > ci > build-linux-x64 > Artifacts > lando-linux-x64`.

## Provider integration

Provider integration tests intentionally stay serial because they share Docker/Podman sockets, images, ports, and app names. Use `--parallel` and `--isolate` only for focused local experiments.

Use the same Podman socket pattern as CI:

```bash
podman system service --time=0 unix:///tmp/podman.sock > /tmp/podman-service.log 2>&1 &
export LANDO_TEST_PODMAN_SOCKET=/tmp/podman.sock
export LANDO_DEFAULT_PROVIDER_ID=lando
export LANDO_TEST_DOCKER_SOCKET=/var/run/docker.sock
```

To reproduce the provider integration job:

```bash
LANDO_MVP_BINARY_PATH="$PWD/dist/lando" LANDO_TEST_PODMAN_SOCKET=/tmp/podman.sock bun test core/test/scenario
bun test plugins/provider-lando/test --filter=integration
bun test plugins/provider-docker/test --filter=integration
```

If the provider integration job fails, download diagnostics from `Actions > ci > provider-integration-linux-x64 > Artifacts > provider-integration-diagnostics`.

## Branch protection

Protect `main` in GitHub with required status checks enabled. The required checks are `static-checks`, `schema-snapshot`, `bundled-codegen`, `library-api-tests`, `recipe-tests`, `build-linux-x64`, and `provider-integration-linux-x64`; all seven must pass before a pull request can merge to `main`.

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
