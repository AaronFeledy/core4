# CI runbook

Use these commands to reproduce the CI jobs locally.

## Static checks

```bash
bun run typecheck
bun run lint
bun test --filter='!*.integration.test.ts'
```

## Linux x64 binary build

```bash
bun run build
./core/dist/lando --version
./core/dist/lando --help
```

If the build job fails after producing the binary, inspect it from GitHub Actions at `Actions > ci > build-linux-x64 > Artifacts > lando-linux-x64`.

## Provider integration

Start the same Podman socket pattern used by CI:

```bash
podman system service --time=0 unix:///tmp/podman.sock > /tmp/podman-service.log 2>&1 &
export LANDO_TEST_PODMAN_SOCKET=/tmp/podman.sock
export LANDO_DEFAULT_PROVIDER_ID=lando
export LANDO_TEST_DOCKER_SOCKET=/var/run/docker.sock
```

Then reproduce the provider integration job:

```bash
LANDO_MVP_BINARY_PATH="$PWD/dist/lando" LANDO_TEST_PODMAN_SOCKET=/tmp/podman.sock bun test core/test/scenario
bun test plugins/provider-lando/test --filter=integration
bun test plugins/provider-docker/test --filter=integration
```

On a failed provider integration run, download diagnostics from `Actions > ci > provider-integration-linux-x64 > Artifacts > provider-integration-diagnostics`.

## Branch protection

The `main` branch must be protected in GitHub with required status checks enabled. The required status checks are `static-checks`, `build-linux-x64`, and `provider-integration-linux-x64`; all three must pass before a pull request can merge to `main`.
