# CI runbook

Use these commands to reproduce the CI jobs locally.

## Static checks

CI pins Bun via `.bun-version`; the Beta 1 floor is `>=1.3.14`, matching root and core `package.json#engines.bun`. Update `.bun-version` first when validating a new Bun release. The default PR gate runs `static-checks-platform` as a five-platform matrix over `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, and `windows-x64`; the stable `static-checks` summary job is the branch-protection check for those portable static gates.

Every platform cell runs the fork-safe portable static gates:

```bash
bun run typecheck
bun run lint
bun run check:renderer-boundary
bun run check:managed-file-boundary
bun run check:telemetry-inventory
bun run check:redaction-boundary
bun run check:env-helper-boundary
bun run check:paths-boundary
bun run check:state-store-boundary
bun run check:probe-boundary
bun run check:network-boundary
bun run check:machine-output
```

The `unit-tests-linux-x64` job aggregates a `unit-tests-linux-x64-shard` matrix that runs the unit-test layer split into balanced shards. Shards start immediately (no `needs:` on `static-checks`) so unit failures surface in parallel with the static gate, and the aggregate job keeps a single required status check name. `scripts/test-shards.ts` owns the shard assignment; it excludes `*.integration.test.ts`, files owned by the dedicated `library-api-tests` and `recipe-tests` jobs, and nightly-tier meta-suites (see below). The static matrix emits a `static-checks-scope` notice instead of pretending path-sensitive test layers ran on every platform. Full cross-platform static test portability remains separate US-189 work.

`bun run test` prints the exact shard commands CI runs:

```bash
bun run test:unit:shard 1/3
bun run test:unit:shard 2/3
bun run test:unit:shard 3/3
```

The unsharded full pass remains available locally:

```bash
bun run test:unit
```

Heavy meta-suites that re-run generators or other test files (`core/test/scripts/codegen-ci.test.ts`, `core/test/build/linux-acceptance-criteria-10-14.test.ts`) run in the nightly `nightly-tier-unit-tests-linux-x64` job instead of per-PR shards; workflow drift they used to catch per-PR is covered by the `Verify generated workflows are current` step in `guide-scenarios-linux-x64`.

## Generated schema and bundled-codegen gates

CI fails if generated schema snapshots or bundled plugin/recipe tables drift. Update all generated outputs with `bun run codegen`:

```bash
bun run codegen
```

For focused local checks, CI runs `bun run codegen:schema-snapshot`, `bun run codegen:bundled-plugins`, `bun run codegen:bundled-recipes`, and `bun run codegen:mutagen-versions`, then verifies the outputs with `git diff --exit-code`. The `schema-snapshot` job also regenerates the command reference (`bun run codegen:oclif-manifest` then `bun run codegen:command-reference`) and verifies `docs/reference/commands.mdx` is current.

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
- `build-windows-x64` on `windows-2022` → `lando-windows-x64`

```bash
bun run build
./core/dist/lando --version
./core/dist/lando --help
./core/dist/lando shellenv
```

Each build job uploads its binary artifact with 14-day retention. Each build job emits a `::notice title=ci-timing::...` line and has a timeout cap (30 minutes for Unix targets, 35 minutes for Windows). If a build job fails after producing the binary, inspect it from GitHub Actions at `Actions > ci > build-<platform> > Artifacts > lando-<platform>`; for example, `Actions > ci > build-linux-x64 > Artifacts > lando-linux-x64`.

Release-shaped binary jobs install the locked cross-target optional packages with `bun install --frozen-lockfile --os=* --cpu=*`, regenerate and drift-check them with `bun run codegen:opentui-native-stubs`, then build through the mandatory wrapper:

```bash
bun run scripts/build-compiled-binary.ts --target=bun-${TARGET} --outfile=dist/lando-${TARGET} --minify --sourcemap=external
```

The wrapper keeps the programmatic equivalent of `--bytecode` enabled and attaches the OpenTUI native-root pruning plugin. Nightly repeats this build for `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, and `windows-x64`. Each platform job then runs the relocated acceptance with `LANDO_RELEASE_TARGET=<target> LANDO_OPENTUI_ACCEPTANCE_BINARY=<binary> bun test core/test/build/opentui-compiled-acceptance.test.ts`. The Linux x64 perf job also runs `bun run bench:opentui-startup -- --binary <binary>` against the downloaded artifact.

## Tooling hot-path perf budget

CI runs the Linux x64 benchmark gate against the built binary artifact. The tracked warm p95 baseline and regression budget live in `scripts/bench-baselines.json`; deliberate changes to that file are reviewed like code.

```bash
bun run build
bun run bench:tooling-hot-path -- --binary core/dist/lando
```

## npm alpha package publishing

The release workflow publishes `@lando/core@4.0.0-alpha.N` and the bundled workspace packages to npm with `--tag dev` after a successful `ci` workflow run. It uses npm trusted publishing through GitHub OIDC (`id-token: write`) and does not use a local `NPM_TOKEN` or `NODE_AUTH_TOKEN` path.

The package job builds workspace artifacts first:

```bash
bun run --filter='@lando/sdk' build
bun run --filter='@lando/container-runtime' build
bun run --filter='@lando/core' typecheck
bun run --filter='@lando/core' build:manifest
```

Packaging plan: `@lando/sdk`, `@lando/container-runtime`, `@lando/core`, and each bundled plugin package are published to the npm `dev` tag at the same `4.0.0-alpha.N` version. The workflow rewrites temporary checkout `workspace:*` dependency ranges to that exact alpha version before the dry-run and real publish; end users install the Alpha distribution as `npm install @lando/core@dev`.

Before publishing, CI runs dry-runs for every release package with the same `--tag dev` / `--access public` arguments. After publishing, CI asserts `@lando/core`'s `dev` dist-tag points at the alpha version and its `latest` dist-tag is unchanged.

## Provider integration

Provider integration tests intentionally stay serial because they share Docker/Podman sockets, images, ports, and app names. Use `--parallel` and `--isolate` only for focused local experiments.

`provider-integration-linux-x64` prepares the default Lando provider through `lando setup`, never a manually started `podman system service`. Linux Podman-backed jobs install the Podman 6 toolchain from the Homebrew `podman` formula (Podman >= 6.0.0 with Netavark v2 and Aardvark-dns v2 in its helper directory and `passt`/pasta, `crun`, `conmon` as dependencies) because Ubuntu 24.04 apt ships Podman 4.9.x and the OBS Kubic xUbuntu_24.04 repository does not publish Podman 6 packages yet; the shared install/assert steps live in `scripts/ci-podman-install.ts`, and every Podman-backed job asserts `podman --version` satisfies the >= 6.0.0 floor (numeric major.minor.patch, suffixes ignored) with remediation before any Podman-backed step runs. The managed runtime resolves its OCI runtime from the default system search list (`/usr/bin/crun` first) rather than the bundle or `helper_binaries_dir`, so the install step overwrites `/usr/bin/crun` with the Podman 6 toolchain `crun` — a runner's preinstalled pre-Podman-6 `crun` otherwise fails container start with `crun: unknown version specified`. The job additionally provisions the rootless runtime prerequisites the Lando-managed Podman needs (`subuid`/`subgid` ranges, the `uidmap` package for `newuidmap`/`newgidmap`, `fuse-overlayfs` for rootless overlay storage on AppArmor-constrained Linux runners, cgroups v2 delegation, and unprivileged-port binding), stages a current-commit runtime bundle under `dist/cache/runtime-bundle/`, builds a `file://` manifest with `scripts/build-runtime-bundle.ts --local`, points `LANDO_RUNTIME_BUNDLE_MANIFEST` at it, sets `CONTAINERS_STORAGE_CONF` so Podman uses the staged `fuse-overlayfs` helper instead of kernel overlay, and runs `dist/lando setup --yes --provider=lando`. Setup extracts the bundle and `ensureRuntime` brings up the Lando-managed Podman API socket at `$HOME/.local/share/lando/runtime/run/podman.sock`; the integration and contract suites resolve that managed socket from Paths/setup state instead of an exported env var, and teardown is `dist/lando poweroff`.

To reproduce the setup-driven provider preparation locally (requires a local Podman >= 6.0.0 on PATH, e.g. `brew install podman`; set `LANDO_CI_PODMAN_HELPER_DIR="$(brew --prefix)/opt/podman/libexec/podman"` so the Homebrew helper directory is staged):

```bash
mkdir -p dist/cache/runtime-bundle
STAGE="$(mktemp -d)"
cp "$(command -v podman)" "$STAGE/podman"
for helper in newuidmap newgidmap pasta passt rootlessport catatonit slirp4netns fuse-overlayfs crun runc conmon netavark aardvark-dns gvproxy; do
  src="$(command -v "$helper" 2>/dev/null || true)"
  if test -z "$src" && test -n "${LANDO_CI_PODMAN_HELPER_DIR:-}" && test -x "$LANDO_CI_PODMAN_HELPER_DIR/$helper"; then src="$LANDO_CI_PODMAN_HELPER_DIR/$helper"; fi
  if test -z "$src" && test -x "/usr/lib/podman/$helper"; then src="/usr/lib/podman/$helper"; fi
  if test -n "$src"; then cp "$src" "$STAGE/$helper"; fi
done
tar -czf dist/cache/runtime-bundle/lando-runtime-linux-x64.tar.gz -C "$STAGE" .
rm -rf "$STAGE"

MANIFEST="$(bun run scripts/build-runtime-bundle.ts --local --platform linux-x64)"
cat > dist/cache/runtime-bundle/storage.conf <<EOF
[storage]
driver = "overlay"

[storage.options.overlay]
mount_program = "$HOME/.local/share/lando/runtime/bin/fuse-overlayfs"
EOF
export CONTAINERS_STORAGE_CONF="$PWD/dist/cache/runtime-bundle/storage.conf"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
mkdir -p "$XDG_RUNTIME_DIR"
LANDO_RUNTIME_BUNDLE_MANIFEST="$MANIFEST" dist/lando setup --yes --provider=lando
LANDO_PODMAN="$HOME/.local/share/lando/runtime/bin/podman"
LANDO_PODMAN_ARGS=(--root "$HOME/.local/share/lando/runtime/storage" --runroot "$HOME/.local/share/lando/runtime/run" --config "$HOME/.local/share/lando/runtime/config")
"$LANDO_PODMAN" "${LANDO_PODMAN_ARGS[@]}" pull node:22-alpine
LANDO_MVP_BINARY_PATH="$PWD/dist/lando" bun test core/test/scenario
bun test plugins/provider-lando/test --filter=integration
bun test plugins/provider-docker/test --filter=integration
bun test plugins/service-lando/test --filter=integration
```

`LANDO_TEST_PODMAN_SOCKET` rehearsal fallback: in local or sandbox environments where rootless service launch is unavailable, point an existing Podman socket at the suites with the documented override; it takes precedence over the Paths-resolved managed socket:

```bash
podman system service --time=0 unix:///tmp/podman.sock > /tmp/podman-service.log 2>&1 &
export LANDO_TEST_PODMAN_SOCKET=/tmp/podman.sock
export LANDO_CONFIG__default_provider_id=lando
export LANDO_TEST_DOCKER_SOCKET=/var/run/docker.sock
LANDO_MVP_BINARY_PATH="$PWD/dist/lando" LANDO_TEST_PODMAN_SOCKET=/tmp/podman.sock bun test core/test/scenario
```

Provider integration also runs as platform-specific jobs (`provider-integration-<platform>`). Every provider job runs the provider contract layer; `provider-integration-linux-x64` runs the live setup-driven Podman/Docker integration path above (contract suites run after `lando setup` so the live cases resolve the managed socket), while linux-arm64, macOS, and Windows targets stop after contract coverage so they do not require host sockets or mutate the host. Each provider job emits a `::notice title=ci-timing::...` line and has a timeout cap (25 minutes for Linux jobs, 20 minutes for macOS/Windows contract-only targets). If a provider integration job fails, download diagnostics from `Actions > ci > provider-integration-<platform> > Artifacts > provider-integration-diagnostics-<platform>`; for example, `Actions > ci > provider-integration-linux-x64 > Artifacts > provider-integration-diagnostics-linux-x64`.

## Guide e2e smoke subset

The scenario-layer generated guide tests run on all five PR platforms through `guide-scenarios-<platform>` jobs. Each job regenerates guides, validates guide metadata and transcript artifacts, then runs `test/scenarios/generated/guides/**` through the source-mapped guide scenario wrapper so failures annotate the MDX source.

`bun run check:public-transcripts` is also a standalone clean-tree gate. When `dist/transcripts/public/guides` is empty after `bun run clean` or on a fresh clone, the command deterministically emits the public transcript corpus before checking its inventory. Existing or partially populated corpora are checked without regeneration, so missing-artifact diagnostics remain actionable. The generated corpus is gitignored and must not be committed.

Only `guide-scenarios-linux-x64` runs the e2e `@smoke` second pass. It downloads the Linux x64 compiled binary, provisions the same Podman socket used by provider integration, sets `LANDO_GUIDE_E2E=1`, and runs only generated tests whose names contain `@smoke` and `[e2e]`:

```bash
LANDO_GUIDE_E2E=1 \
LANDO_MVP_BINARY_PATH="$PWD/dist/lando" \
LANDO_SCENARIO_E2E_BINARY="$PWD/dist/lando" \
LANDO_TEST_PODMAN_SOCKET=/tmp/podman.sock \
bun run scripts/test-reporters/run-guide-scenarios.ts test/scenarios/generated/guides/** --test-name-pattern="@smoke.*\\[e2e\\]"
```

Failures still upload guide internal transcripts, plus `guide-e2e-provider-diagnostics-<run-id>` with the Podman service log and recent journal output.

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

## Provider matrix

The `provider-matrix` workflow runs weekly, on manual dispatch, and automatically after the runtime-bundle publisher successfully repins the committed runtime-bundle manifest on `main`. The publisher dispatch uses the GitHub Actions API (`gh workflow run provider-matrix.yml --ref main`) because its manifest-repin push is made with `github.token` and therefore does not recursively fire `push:` triggers.

Cells cover Docker Desktop, Docker Engine, Podman Desktop, Podman, Lima, and OrbStack surfaces, plus the Lando-managed Podman 6 runtime. Native machine lifecycle cells separately cover managed Lando and system Podman machines on macOS and Windows. The matrix is structured provider acceptance, not advisory contract-only coverage. Each cell writes a JSON report with a `passed`, `failed`, or `skipped` outcome; release-blocking cells fail the workflow when they fail or skip. Advisory desktop-only cells still emit a `::notice` skip on GitHub-hosted runners so maintainers can mirror them on prepared self-hosted runners.

The native machine cells are advisory because GitHub-hosted macOS and Windows runners do not provide a dependable nested-virtualization contract. Prepared runners opt in with `LANDO_TEST_PROVIDER_LANDO_MACHINE_LIFECYCLE=1` or `LANDO_TEST_PROVIDER_PODMAN_MACHINE_LIFECYCLE=1`; `LANDO_TEST_PODMAN_COMMAND` may select the prepared Podman binary. Missing opt-in, unsupported hosts, and absent Podman tooling produce structured skips. Once opted in with tooling present, start/stop/restart/destroy failures are recorded as failed cells, never passes. The Docker Engine, Lando-managed Linux, and system Podman 6 Linux cells remain release-blocking.

Release-blocking installable cells run the relevant provider contract suite plus live acceptance checks for setup readiness, app bring-up/bring-down, exec, logs, inspect/health, image resolution, and volume cleanup:

```bash
bun test plugins/provider-lando/test/contract.integration.test.ts
bun test plugins/provider-docker/test/contract.integration.test.ts
bun test plugins/provider-podman/test/contract.integration.test.ts
```

Failures upload `provider-matrix-report-<cell>` JSON and `provider-matrix-diagnostics-<cell>` artifacts when logs are available. The matrix is release-blocking for published runtime-bundle manifest acceptance even though it is not listed as a per-PR branch-protection check for Beta.

## Alpha platform scope

Historical Alpha CI was Linux x64 only: no Windows or linux-arm64 release matrix was generated in Alpha, and macOS provider-lando validation was manual QA or an explicit opt-in job. Beta PR CI now owns the broad multi-platform matrix documented above; nightly cron owns full provider-lando e2e on Linux x64; the weekly provider matrix owns cross-engine acceptance coverage.

## Branch protection

Protect `main` in GitHub with required status checks enabled. All required status checks must pass before a pull request can merge to `main`:

- `static-checks`
- `unit-tests-linux-x64`
- `schema-snapshot`
- `bundled-codegen`
- `library-api-tests`
- `recipe-tests`
- `guide-scenarios-darwin-arm64`
- `guide-scenarios-darwin-x64`
- `guide-scenarios-linux-arm64`
- `guide-scenarios-linux-x64`
- `guide-scenarios-windows-x64`
- `build-darwin-arm64`
- `build-darwin-x64`
- `build-linux-arm64`
- `build-linux-x64`
- `build-windows-x64`
- `perf-budget-linux-x64`
- `provider-integration-darwin-arm64`
- `provider-integration-darwin-x64`
- `provider-integration-linux-arm64`
- `provider-integration-linux-x64`
- `provider-integration-windows-x64`

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
