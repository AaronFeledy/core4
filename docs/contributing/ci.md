---
title: CI runbook
description: Reproduce CI checks locally and inspect their failure artifacts.
---

# CI runbook

Use this runbook to reproduce a failing CI job and find its diagnostics. Run commands from the repository root with the Bun version pinned in `.bun-version`. A clean checkout needs `bun install` and `bun run codegen`; tests that compile or run the container helper also need the [helper build](#in-container-helper).

For a pre-PR check, use `bun run gate:pr` as described in the root repository instructions. To investigate a specific failure, go directly to [static checks](#static-checks), [generated schema checks](#generated-schema-and-bundled-codegen-gates), [guide scenarios](#guide-e2e-smoke-subset), or the [docs build](#docs-build). Live provider sections have additional host prerequisites; do not run their setup commands as part of a static-only check.

## Record PR evidence

Attach this checklist and the evidence tables below to every PR description or a linked PR evidence report. This is a human review record. The selected `ci` check must pass, and the broader acceptance requirements below must also be satisfied before merge. A green selected profile establishes only the work that profile executed. This checklist does not override CI selection or authorize a branch-protection bypass.

Record immutable full Git object IDs, not branch names alone:

| Revision field | Value |
| --- | --- |
| PR head commit and tree | |
| Target base commit and tree | |
| Merge-base commit | |
| Tested commit and tree for each run | |
| Combined head-plus-base tested commit and tree | |
| Clean working tree before and after each run | |

Test the combined head and target base in a clean checkout and identify both the resulting commit and tree, even if they equal the head. Record how that combination was produced. If a conflict or unavailable environment prevents testing it, record `blocked` and the reason. Head-only evidence does not establish that the combined result passes. Refresh the record and rerun affected checks whenever the head or base changes; explain any reused evidence against the new combined tree. Dirty-tree results cannot establish acceptance for the recorded commit.

For every command, platform cell, and conditional requirement, add a row. Expand grouped suites into the actual commands executed. Link retained logs, reports, binary artifacts and checksums where produced, and CI run/job URLs when available. Manual or agent executions may supply equivalent evidence when they execute the required scope against the identified tree with the same prerequisites. Identify the executor and environment; do not claim a missing runner, native run, or live-provider run occurred.

| Requirement / command and arguments | Mandatory, conditional, or advisory; applicability reason | Host OS/version and architecture; compile target; provider/runtime | Tested commit and tree | Outcome; exit code; positive test count | Skips and reasons | Evidence artifacts / logs | Blocker and next action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | not run | | | |

Use only `pass`, `fail`, `not run`, `blocked`, or `not applicable` for outcomes. `pass` requires a successful command and, for test commands, a positive executed test count. Record passed, failed, and skipped counts separately. A zero-test filter, cancellation, unexplained skip, absent row, or missing log is never green. Use `not run` for unexecuted work, `blocked` for a named impediment, and `not applicable` only for a conditional requirement whose trigger is absent, with a reason. For non-test commands, record the test count as `not applicable` and verify the expected output or artifact. A skipped mandatory suite remains unmet even if its wrapper exits successfully.

Keep host OS and architecture separate from the compile target: cross-compiling on Linux proves a target build, not native execution on that target. Portable static checks, builds, relocated-binary smoke, and scenario guides on all six targets do not establish full native unit-suite or live-provider coverage.

Complete these mandatory per-PR requirements, with a row for each platform where required:

- [ ] Selected CI profile, selection reason, selected jobs, and required `ci` result recorded and passing.
- [ ] Portable static gates, compiled builds, relocated-binary smoke, and scenario guides pass for `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `windows-x64`, and `windows-arm64`.
- [ ] Scenario and recipe suites pass on every per-PR platform.
- [ ] Linux x64 unit tests, e2e smoke, and gating performance suites pass. Performance evidence includes startup and first-paint budgets plus compiled renderer whole-process exit duration, piped and under a PTY; the TTY median must not exceed the piped median by more than 150 ms.
- [ ] Separately measured Linux x64 compiled tooling against an actual running app meets the end-to-end budgets of < 600 ms cold and < 250 ms hot, including provider exec. Record the command, app, provider, binary identity, cold/hot timings, and provider request counts. A host-only tooling benchmark pass does not satisfy this row.
- [ ] Tests, TypeScript typecheck, Biome/lint, codegen pure drift, schema compatibility, schema/docs generation, and docs build pass. Pure drift success does not establish semantic gate success.
- [ ] Provider, plugin-abstraction, library API, machine-output, deprecation, redaction, managed-file, coexistence, scenario, recipe, and executable-guide contracts pass.
- [ ] Guide lint, coverage, public transcripts, source-mapper, and guide component-schema gates pass.
- [ ] Shared boundary gates and command, service, event, deprecation, export, and package-DAG registry drift checks pass.
- [ ] Setup verification passes against a current-commit local runtime-bundle manifest with checksum validation enabled.

Record each conditional requirement as `pass` or explain why it is `not applicable`; unresolved required work is `fail`, `not run`, or `blocked`:

- [ ] Applicable renderer/OpenTUI contracts pass.
- [ ] Compiled-decoder parity passes when the [decoder target list](../../core/src/cli/compiled-decoder-targets.ts), a schema on that list, the decoder generator, or the Effect version changes. Run `bun test core/test/cli/compiled-decoders.test.ts`.
- [ ] New CLI or library behavior has passing scenario coverage; new CLI behavior also has passing e2e coverage.
- [ ] New recipes have passing recipe and e2e smoke coverage; new schemas have annotations and passing round-trip coverage.
- [ ] Public `@lando/core` or `@lando/sdk` additions have documentation and passing corresponding library/schema tests.
- [ ] Install/update/uninstall/shellenv changes pass side-by-side coexistence; network-sensitive changes pass offline-after-build coverage.

Record per-PR macOS and Windows performance results as advisory. Nightly performance failures block release. Scheduled nightly and weekly provider/runtime evidence adds live coverage; it does not replace per-PR requirements. Compilation and relocated-binary smoke do not establish live setup/doctor readiness.

Finish the report with separate conclusions for **selected CI** and **broader acceptance**, each using the outcome vocabulary above. List every outstanding mandatory or applicable conditional row and its blocker or next action. Broader acceptance is `pass` only when all required evidence is current and passing; absent evidence must remain visible even when selected CI passes.

## Choose the CI tier

Pull requests select the highest profile needed by their changed paths:

| Profile | Changes | Work |
| --- | --- | --- |
| `docs` | Markdown/MDX under `docs/`, except `docs/guides/`; static files under `docs/public/` and `docs/src/assets/` | Linux static checks and the docs build |
| `guides` | Anything under `docs/guides/`, including fixtures | Docs work plus Linux and Windows x64 guide scenarios, live Linux `@smoke`, and their build prerequisites |
| `runtime` | Other code, recipes, tests, configuration, lockfiles, and unknown paths | Guide work plus the complete unit shards, isolation regressions, and performance budgets |
| `providers` | Provider and container-runtime paths, service-lando, provider contracts, or the CI selection and generation files | Runtime work plus live Linux x64 provider integration |

Mixed changes select the highest profile: `docs`, `guides`, `runtime`, then `providers`. An empty comparison selects `runtime`; unavailable comparison history selects `providers`. A Git command failure fails selection. Deleted and renamed paths count too. The path rules live in `scripts/ci-selection.ts`. `bun test --changed` is a local convenience, not the merge gate.

Pushes to `main`, manual `ci` dispatches, and pull requests changing the root `.bun-version` run broad hosted coverage, including all six binary artifacts required by the release workflow. The toolchain rule applies even when the PR also changes other paths. Nightly and the scheduled evidence workflows own deep live suites and platform journeys. Use manual `ci` dispatch when another PR needs the broad hosted checks before merge.

General Linux tests run on Ubuntu 26.04. Portable Linux x64 binaries still build on Ubuntu 24.04 for their older glibc baseline. The focused install/use/uninstall lifecycle also keeps Ubuntu 24.04 coverage without duplicating the broad test suite.

## Static checks

CI pins Bun via `.bun-version` at 1.4.3; the Beta 1 floor is `>=1.4.3`, matching workspace `package.json#engines.bun`. Update `.bun-version` first when validating a new Bun release. Workflows read that file rather than embedding a compiler version.

Non-broad pull requests run portable static checks once on Linux x64. Broad runs, including PRs changing the root `.bun-version`, retain the six-platform static matrix. The stable `static-checks` summary feeds the required `ci` check.

Every platform cell runs the fork-safe portable static gates:

```bash
bun run codegen:check
bun run lint
bun run check:boundaries
bun run check:telemetry-inventory
bun run check:compose-coverage
bun run check:runtime-bundle-manifest
```

`bun run codegen:check` regenerates the full ordered codegen catalog and checks catalog-owned outputs, including committed workflows, for drift. Deprecation checks run through `bun run lint`. Root typecheck runs with the Linux static gate even when guide jobs are not selected. Dependency audits run separately and never block pull requests.

Run typecheck separately:

```bash
bun run typecheck
```

`bun run check:boundaries` runs every boundary rule with one file walk and one TypeScript parse per file shared across rules; module edges come from that same parse, while rules may run their own AST visitors. Rule definitions remain in `scripts/boundary/rules/`. Debug one rule with `bun run scripts/check-boundaries.ts <rule-id>`. The per-rule `scripts/check-*.ts` shims remain programmatic test APIs, not package scripts. Replace `<rule-id>` with a rule from the [boundary inventory](../../scripts/boundary/README.md).

The `unit-tests-linux-x64` job aggregates a `unit-tests-linux-x64-shard` matrix on `ubuntu-26.04`. The selected profile controls whether those shards run; each selected suite still runs in full. Library, recipe, Linux guide, and provider test jobs also use Ubuntu 26.04 rather than running twice on different Ubuntu releases. Builds stay on `ubuntu-24.04` for the older glibc reference.

`scripts/test-shards.ts` collects the unit file set and runs `bun --no-orphans test --shard=i/3 --timings=.bun-test-timings.json`. It excludes integration files except the fake-client contract suites for `provider-lando`, `provider-docker`, and `provider-podman`. Those suites run in PR shards; their socket-dependent cases may skip when no live engine is available. Dedicated library and recipe suites, plus nightly-tier meta-suites, stay outside the shards. Shard balance comes from the committed timings file.

Bun 1.4 `--parallel --no-isolate` was tried on the shard runtime and rejected because compiled-binary tests race on a shared outfile. The static matrix emits a `static-checks-scope` notice instead of pretending path-sensitive test layers ran on every platform. Full cross-platform static test portability is outside this matrix.

`bun run test` prints the exact shard commands CI runs:

```bash
bun run test:unit:shard 1/3
bun run test:unit:shard 2/3
bun run test:unit:shard 3/3
```

Refresh the committed `.bun-test-timings.json` after a suite-shape change:

```bash
bun run scripts/update-test-timings.ts
```

Nightly runs the same refresh in `refresh-test-timings-linux-x64` and uploads the timings file; commit the artifact when the split has drifted. `NIGHTLY_TIER_TESTS` stay out of both the PR shards and the timings refresh.

The ordinary unsharded unit suite remains available locally. It excludes integration files, including the fake-client contracts added to PR shards:

```bash
bun run test:unit
```

To match the added provider-contract coverage, also run `bun test plugins/provider-lando/test/contract.integration.test.ts plugins/provider-docker/test/contract.integration.test.ts plugins/provider-podman/test/contract.integration.test.ts`.

For a local review of which shard-eligible tests may relate to your changes, run:

```bash
bun run test:affected
```

This prints selected test paths, counts, a changed-file-to-test import path for each selection, fixture-reference matches, unmatched changed paths, and uncertain imports. It does not run tests unless you add `--run`. A dry run with zero matches prints `selected=0`; `--run` with zero matches exits nonzero without starting a test process. The default comparison uses the merge base with `origin/main` plus staged, unstaged, and untracked files. Use `--base <ref>` for another comparison or repeat `--file <path>` to inspect explicit repository paths. For example:

```bash
bun run test:affected --file sdk/src/schema/landofile.ts --file sdk/src/schema/json-schema.ts --run
```

Even with `--file`, selection walks imports from every shard-eligible test. Its time and memory use depend on the repository graph and the machine.

The selector also follows the test preloads configured in `bunfig.toml` as shared dependencies of every eligible test. A changed preload or one of its static imports can therefore select the full set. If a configured preload cannot be resolved inside the repository, the selector reports the uncertainty and selects the full eligible set.

The selector follows static and statically evaluable imports, re-exports, and `require` calls through workspace exports. It also uses fixture path references as a heuristic, including sibling files in a fixture app directory. Changes to package manifests, TypeScript configuration, Bun configuration, the lockfile, or the Bun version select every shard-eligible test, preserving the shard exclusions. Computed imports, unresolved local modules, runtime file reads, and other generated or configuration effects can leave gaps; import paths through barrels can also select extra tests. Prior import edges are reconstructed only for the changed source paths supplied. If you use `--file` for a deleted module but omit a rewritten importer, that historical edge may be missing. Review the uncertain and unmatched lists before relying on a narrow result. The CI profile still runs its full selected shards.

Heavy meta-suites that re-run generators or other test files (`core/test/scripts/codegen-ci.test.ts`, `core/test/build/linux-acceptance-criteria-10-14.test.ts`) run in the nightly `nightly-tier-unit-tests-linux-x64` job instead of per-PR shards; per-PR workflow drift is covered by `bun run codegen:check` in `static-checks-platform`.

## Dependency maintenance

Dependabot checks Bun dependencies and GitHub Actions weekly. Minor and patch updates are grouped per ecosystem; major updates get separate pull requests. Actions workflows are generated, so an Actions update PR must also update its owning generator or action-pin source and regenerate YAML before merge.

The daily `dependency-audit` workflow runs `bun run scripts/dependency-audit.ts` from the trusted default branch. It can also be dispatched there manually. It is not a pull-request check. Bun version-update PRs do not replace Bun vulnerability detection; Dependabot does not currently support Bun security-update PRs.

The audit maintains one bot-owned issue titled `Dependency audit findings`. New findings create it, changed findings update it, a clean audit closes it, and recurring findings reopen the same issue. Unchanged findings do not rewrite the issue. Ignore policy comes from the existing `audit` command in `package.json`. Registry errors, malformed output, and inconsistent audit exits fail the scheduled job without marking the issue resolved.

Only the trusted audit reporting job receives `issues: write`. Serialized runs prevent competing issue creation. `bun run audit:fix` remains a local command and is never applied automatically in CI.

## Tell a skipped gate from a failed one

Some maintainers run this repository through a workspace-local looper harness whose loop includes a `Drift Audit` step. That step is not a repository gate. It belongs to the harness, is configured per workspace by a gitignored `.local/looper/looper.yaml` (the repository `.gitignore` ignores `.local/`), and is owned by the maintainer running the loop. Nothing in this repository defines, schedules, or can fix it. Do not edit that automation from this repository. The scheduled dependency audit is unrelated to that harness step.

Do not confuse it with the three repository scripts whose names look similar:

| Script | What it checks |
| --- | --- |
| `check:codegen-drift` | Pure drift over the catalog-owned generated outputs; wrapped by `codegen:check`. |
| `check:guide-drift` | Semantic gate that fires when a covered source path changed and no owned guide was touched. |
| `bun audit` (the `audit` script) | Dependency vulnerability advisories. Nothing to do with drift. |

The harness gate script exits 0 to run the step and exits 1 to skip it because its thresholds were not met. A line reading `[looper] gate skipped Drift Audit: gate: script exited with code 1` is therefore a by-design skip, not a failure. The gate does still fire: a `.drift-gate-US-660` state file holding `3 828 6 0` sits beside a real `US-660 Drift Audit` progress-log entry from 2026-09-20 02:02. The defect is that one exit code carries two meanings, so a false predicate and a failed evaluation look identical in the log. That is what let a skip read as a failure across roughly a dozen stories. When you read loop output, treat `gate skipped` as a skip and treat only a step reported as failed as a failure.

## Generated schema and bundled-codegen gates

CI fails if the generated schema artifact set or bundled plugin/recipe tables drift. Update all generated outputs with `bun run codegen`:

```bash
bun run codegen
```

For focused local checks, CI regenerates the HEAD schemas with `bun run codegen:schema-snapshot`, checks only the committed bundled-plugin manifest fixture at `sdk/test/fixtures/bundled-plugin-manifests.json` with path-scoped `git status --porcelain`, then runs `bun run check:schema-compatibility` against `origin/main`. The checkout needs full git history (`fetch-depth: 0`) because the checker resolves the base ref.

The checker creates a detached temporary worktree at that commit, installs its dependencies from `bun.lock` with `bun install --frozen-lockfile`, runs its `codegen:schema-snapshot` to materialize the base schemas, then removes the worktree and underlying OS temp directory.

Set `LANDO_SCHEMA_COMPATIBILITY_BASE_REF=<ref>` to compare against another base locally. There is no fallback to committed artifacts, so any failure materializing the base schemas fails the gate closed. The checker fails on unaccepted `breaking` or `unknown` findings, with exact reviewed exceptions recorded in `sdk/compatibility-exceptions.json`. The only accepted skip is a base commit that predates `scripts/build-schema-snapshot.ts` and therefore has no generator; the summary reports the exact per-family counts skipped for that reason instead of comparing against a nonexistent generator.

That fixture is the job's only porcelain path; modifying, deleting, or regenerating it as untracked fails the gate. The SDK schema and command-result schema trees, including both indexes, are ignored derived outputs validated by regeneration and semantic comparison rather than by git status. The job regenerates the command reference (`bun run codegen:command-registry-manifest` then `bun run codegen:command-reference`) and verifies `docs/reference/commands.mdx` with `git diff --exit-code`. It then regenerates the Compose key matrix (`bun run codegen:compose-key-matrix`) and applies the same check to `docs/reference/compose-key-matrix.mdx`. Other focused codegen checks run `bun run codegen:bundled-plugins`, `bun run codegen:bundled-recipes`, and `bun run codegen:mutagen-versions`.

## Update the paired Tomcat catalog

Run the explicit network updater from the repository root:

```bash
bun run update:tomcat
```

It resolves the public Docker Hub `9-jre21`, `10-jre21`, and `11-jre21` indexes without a container daemon, verifies manifest/config bytes and both Linux architectures, checks a consistent Tomcat version and distribution environment, and verifies that each exact version tag resolves to the same index. Registry blob redirects are restricted to Docker's `production.cloudfront.docker.com` storage host, with no pull token forwarded. It fetches `server.xml` from the matching Apache release tag's immutable commit. All three candidates must validate before any pin or baseline is written. Same-version image rebuilds count as updates. Network or validation failures leave the previous files untouched.

Review `plugins/service-lando/tomcat/pins.json` and all three `server-*.xml` files together. Keep the Apache notices. The report separates upstream baseline changes from Lando's single intentional HTTP-port substitution. Comments-only classification requires byte-identical active text; formatting changes still require review. A new active config shape fails closed until the local template contract is reviewed.

Regenerate and run the focused checks:

```bash
bun run codegen:tomcat-catalog
bun run codegen:service-type-reference
bun test plugins/service-lando/test/tomcat.test.ts plugins/service-lando/test/tomcat-port.test.ts core/test/scripts/tomcat-update.test.ts core/test/scripts/tomcat-catalog.test.ts core/test/build/tomcat-bump-workflow.test.ts
LANDO_TEST_PODMAN_SOCKET=/path/to/podman.sock bun test plugins/service-lando/test/tomcat-config.integration.test.ts
```

Replace `/path/to/podman.sock` with a running Podman-compatible provider socket. The live test builds and starts each major at the default and nondefault ports, checks ROOT content and authored startup, and verifies the old port is closed. A skipped live test is not compatibility evidence.

Normal codegen is offline: it checks local hashes and template invariants and derives the ignored embedded TypeScript catalog. Commit only paired inputs and the generated workflow, not the derived catalog. The daily/dispatch `tomcat-bump` workflow merges `main` into its rolling branch, prepares candidates, runs focused unit checks before proposing, then explicitly dispatches `ci.yml` on the proposal branch. That CI run includes service-lando live integration tests; the workflow does not auto-merge.

## Extend the internal maintenance workflows

`scripts/maintenance-workflow.ts` renders the shared envelope used by `build-tomcat-bump-workflow.ts` and `build-compose-vendor-bump-workflow.ts`. It owns schedule/manual dispatch, concurrency, the `main` guard, reviewed action pins, frozen install, bot authentication, merge-based rolling-branch reconciliation, owned-path no-op detection and staging, commit/push, PR create-or-edit, explicit `ci.yml` dispatch, and exact-title failure issues scoped by `GH_REPO`. It never force-pushes or auto-merges.

Each consumer supplies its identity, schedule, branch, owned paths, and two trusted repository-authored shell hooks. `prepare` runs after branch reconciliation and may exit successfully when discovery finds nothing to do. The envelope then checks both working-tree and pending-branch owned-path differences. `checkAndReport` runs before any publication and must set `TITLE` (also the commit message) and `BODY_FILE`. Hook failures stop publication.

Owned-path detection includes staged and untracked outputs. Commits include only owned paths, even when a hook stages an unrelated file.

Tomcat keeps paired candidate validation in `update:tomcat`, captures the `main` baseline, runs codegen and focused candidate checks, and reports baseline changes. Compose keeps stable-tag selection through `selectNewerComposeGoTag`, skips schema fetching when current without a pending bump, reconciles pending bumps even without a newer tag, and reports schema-key differences with a versioned title. Compose does not run `check:compose-coverage` before proposing or classify new keys automatically. PR CI and human review own classification.

To add another internal consumer, keep discovery, updating, checks, and reporting in its generator's local hooks; declare only paths it owns. Reuse the envelope rather than adding pipeline modes or a public configuration surface. Keep each real generator in `scripts/codegen-catalog.ts`; the shared renderer is not a generator entry. Regenerate YAML through the consumer generator, never by hand.

Run the bounded shell coverage with:

```bash
bun test core/test/build/maintenance-workflow.test.ts core/test/build/maintenance-workflow-renderer.test.ts core/test/build/tomcat-bump-workflow.test.ts core/test/build/compose-vendor-bump-workflow.test.ts
```

The POSIX behavioral tests use Bash, Git, and jq. `core/test/build/support/maintenance-workflow-harness.ts` exports isolated real-Git/local-bare-remote fixtures with fake GitHub and domain I/O, plus extracted generated scripts for driver or PTY checks. It changes no global Git configuration or process cwd. Native shell cases skip Windows; YAML checks remain portable.

## Library API and recipe test layers

CI runs the Alpha library API and recipe layers as separate branch-protectable jobs:

```bash
bun test core/test/library sdk/test/library
bun test core/test/recipes core/test/cli/init.canonical-recipes.test.ts
```

## In-container helper

Every compiled `lando` embeds a static Go helper for `linux-x64` and `linux-arm64`. Inside a container it is the host-proxy `lando` client and the reader behind `lando logs --source`. You don't need Go installed: the helper builds with Lando itself, in the pinned `golang` image from `core/container-helper/.lando.yml`.

Before building, run `bun install` and `bun run codegen` on a clean checkout and configure a working provider with `lando setup`. If default setup fails on Linux, use `lando setup --provider=docker` with a working system Docker. No host Go installation is needed.

Build the helper before `bun test` on Linux or compiling `lando` on any host:

```bash
bun run --filter='@lando/core' build:container-helper
```

That starts the `lando-container-helper` builder app with the source-mode CLI, writes `core/container-helper/dist/linux-{x64,arm64}/lando-container-helper` plus the source digest they were built from, and destroys the builder. Every checkout shares that app name, so builds in several git worktrees work one after another, not at the same time. Pass `--test` (`bun run scripts/build-container-helper.ts --test`) to run `go vet` and `go test` first. `bun run build` doesn't run it: compiling embeds the helper already in `dist/` and refuses a missing or stale one, so rerun the helper build after editing `core/container-helper/` sources or `core/container-helper/.lando.yml`. To embed prebuilt binaries instead, set `LANDO_CONTAINER_HELPER_DIR` to a directory laid out the same way.

Verify the host-architecture helper on Linux:

```bash
bun test core/test/container-helper/helper.integration.test.ts
```

In CI, the `container-helper` job sets up Lando with the Docker provider and no router, builds both architectures, runs the integration suite on x64, and uploads the `container-helper` artifact. The `container-helper-arm64` job downloads it and runs the same suite on `ubuntu-24.04-arm` without Lando or Docker setup. The arm64 helper check runs in broad CI. A selected helper check must succeed; its expected exclusion from a smaller PR profile is not a failure. Every job that compiles `lando` or runs live provider tests downloads that artifact into `core/container-helper/dist`.

## Platform binary builds

Broad `main` and manual CI runs build and smoke all six binaries. A PR that selects `guides`, `runtime`, or `providers` builds Linux x64 only:

- `build-darwin-arm64` on `macos-15` → `lando-darwin-arm64`
- `build-darwin-x64` on `macos-15-intel` → `lando-darwin-x64`
- `build-linux-arm64` on `ubuntu-24.04-arm` → `lando-linux-arm64`
- `build-linux-x64` on `ubuntu-24.04` → `lando-linux-x64`
- `build-windows-x64` on `windows-2022` → `lando-windows-x64`
- `build-windows-arm64` on `windows-11-arm` → `lando-windows-arm64` (`lando update` on win-arm64 still maps to the published `windows-x64` update-manifest key; the 5-key schema is unchanged)

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

The wrapper keeps the programmatic equivalent of `--bytecode` enabled for every target, including Windows cross-compilation, and attaches the OpenTUI native-root pruning plugin. The pinned Bun version includes the cross-platform bytecode fix from 1.4.1; do not disable bytecode to work around an older compiler. The wrapper also enables `--disallow-code-generation-from-strings=strict`. Nightly repeats this build for `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `windows-x64`, and `windows-arm64`. Each platform job then runs the relocated acceptance with `LANDO_RELEASE_TARGET=<target> LANDO_OPENTUI_ACCEPTANCE_BINARY=<binary> bun test core/test/build/opentui-compiled-acceptance.test.ts`.

## Local Bun profiling

Keep these off the default PR gate. Use them locally when hunting cold-start or compile-graph regressions against the `core/test/cli/fast-path.test.ts` budget.

```bash
bun --cpu-prof-md ./core/bin/lando.ts --version
bun --heap-prof-md ./core/bin/lando.ts --version
BUN_CPU_PROFILE=1 bun ./core/bin/lando.ts --version
```

The compiled-binary wrapper can also emit Bun's markdown module graph without changing default compile flags:

```bash
LANDO_COMPILE_METAFILE=1 bun run scripts/build-compiled-binary.ts --target bun-linux-x64 --outfile ./dist/lando --minify --sourcemap=external
bun run scripts/build-compiled-binary.ts --target bun-linux-x64 --outfile ./dist/lando --minify --sourcemap=external --metafile-md ./dist/lando.metafile.md
```

Do not commit profile dumps or `*.metafile.md` artifacts.

## Startup and tooling perf budgets

The `perf-budget-linux-x64` job runs for `runtime` and `providers` PRs and broad CI. It runs `bun run bench:opentui-startup -- --binary <binary>` and the tooling hot-path benchmark against the `build-linux-x64` binary artifact. The tracked budgets live in `scripts/bench-baselines.json`; deliberate changes to that file are reviewed like code. `openTuiStartup` keeps the 50 ms startup and first-output p95 budgets for `lando --version`. `ttyRendererOverhead` runs `lando version --renderer=lando` 20 times piped and 20 times under a Bun PTY, then requires the TTY median to stay within 150 ms of the piped median. The explicit renderer flag bypasses the app-free `version` fast path so every sample constructs the default renderer. This catches renderer work that keeps the process alive after output. The tooling gate checks its warm p95 baseline and regression budget separately.

The tooling hot-path benchmark runs a host-only fixture with no provider exec. The CI gate enforces a 25% allowance over its current 900 ms warm p95 baseline; the listed 150 ms warm target is an optimization target, not the pass threshold. Separately measure a compiled tooling command against an actual running app through provider exec. Record same-toolchain cold and hot end-to-end timings (< 600 ms and < 250 ms), the app and provider, binary identity, provider request counts, timing method, and logs in the PR evidence table. A skipped or missing live measurement leaves broader acceptance unmet even when the selected `ci` check passes.

```bash
bun run build
bun run bench:opentui-startup -- --binary core/dist/lando
bun run bench:tooling-hot-path -- --binary core/dist/lando
```

To compare two Linux x64 compiled binaries on the same host, pass the candidate to `--binary` and the reference to `--compare-binary`:

```bash
bun run bench:opentui-startup -- --binary /path/to/candidate/lando --compare-binary /path/to/reference/lando --json
```

Replace both example paths with your compiled binaries. The runner starts fresh processes in adjacent alternating pairs: candidate then reference, followed by reference then candidate. `--runs` counts samples **per binary** (20 by default). JSON reports every timed sample in order, each binary's p95, and signed candidate-minus-reference differences. Only the candidate must pass the existing strict 50 ms startup and first-output budgets. The reference's budget status is diagnostic; a reference that fails to run or produces no output invalidates the comparison. The candidate alone runs the TTY overhead gate after startup passes. A failed startup budget skips that TTY phase but still reports all scheduled startup samples.

The JSON identifies each binary by path, byte size, and SHA-256 after timing finishes. It also records the runner's Bun version, host OS, architecture and kernel, and before/after CPU load and available Linux cgroup or pressure readings. Record the Bun compiler version used to build each binary separately; the runner cannot infer that provenance. Processes use isolated Lando roots without warmups or retries. The OS page cache remains unmanaged, so these are not cold-disk measurements. Inspect load and pressure evidence before attributing a difference to code.

## npm dev package publishing

The generated GitHub release workflow does **not** publish npm. It only publishes unsigned `v4.0.0-dev.N` GitHub prerelease binaries. `scripts/prepare-npm-dev-packages.ts` rewrites checkout versions to `4.0.0-dev.N` and the `dev` tag. Live npm dev package publishing is the manual `scripts/release.ts` orchestrator. That orchestrator uses npm trusted publishing through GitHub OIDC (`id-token: write`) and does not use a local `NPM_TOKEN` or `NODE_AUTH_TOKEN` path.

The package job builds workspace artifacts first:

```bash
bun run --filter='@lando/sdk' build
bun run --filter='@lando/paths' build
bun run --filter='@lando/container-runtime' build
bun run --filter='@lando/state-store' build
bun run --filter='@lando/landofile' build
bun run --filter='@lando/core' typecheck
bun run --filter='@lando/core' build:manifest
```

Packaging plan: `@lando/sdk`, `@lando/container-runtime`, `@lando/state-store`, `@lando/landofile`, `@lando/core`, and each bundled plugin package are published to the npm `dev` tag at the same `4.0.0-dev.N` version. The manual orchestrator rewrites temporary checkout `workspace:*` dependency ranges to that exact dev version before the dry-run and real publish.

Before publishing, the orchestrator runs dry-runs for every release package with the same `--tag dev` / `--access public` arguments. After publishing, it asserts `@lando/core`'s `dev` dist-tag points at the dev version and its `latest` dist-tag is unchanged.

## Provider integration

Provider integration tests intentionally stay serial because they share Docker/Podman sockets, images, ports, and app names. Use `--parallel` and `--isolate` only for focused local experiments.

`provider-integration-linux-x64` prepares the default Lando provider through `lando setup`, never a manually started `podman system service`.

Linux Podman-backed jobs install the Podman 6 toolchain from the Homebrew `podman` formula (Podman >= 6.0.0 with Netavark v2 and Aardvark-dns v2 in its helper directory and `passt`/pasta, `crun`, `conmon` as dependencies) because Ubuntu 24.04 apt ships Podman 4.9.x and the OBS Kubic xUbuntu_24.04 repository does not publish Podman 6 packages yet; the shared install/assert steps live in `scripts/ci-podman-install.ts`, and every Podman-backed job asserts `podman --version` satisfies the >= 6.0.0 floor (numeric major.minor.patch, suffixes ignored) with remediation before any Podman-backed step runs.

The managed runtime resolves its OCI runtime from the default system search list (`/usr/bin/crun` first) rather than the bundle or `helper_binaries_dir`, so the install step overwrites `/usr/bin/crun` with the Podman 6 toolchain `crun`. A runner's preinstalled pre-Podman-6 `crun` otherwise fails container start with `crun: unknown version specified`.

The job additionally provisions the rootless runtime prerequisites the Lando-managed Podman needs (`subuid`/`subgid` ranges, the `uidmap` package for `newuidmap`/`newgidmap`, `fuse-overlayfs` for rootless overlay storage on AppArmor-constrained Linux runners, cgroups v2 delegation, and unprivileged-port binding), stages a current-commit runtime bundle under `dist/cache/runtime-bundle/`, builds a `file://` manifest with `scripts/build-runtime-bundle.ts --local`, points `LANDO_RUNTIME_BUNDLE_MANIFEST` at it, sets `CONTAINERS_STORAGE_CONF` so Podman uses the staged `fuse-overlayfs` helper instead of kernel overlay, and runs `dist/lando setup --yes --provider=lando`.

Setup extracts the bundle and `ensureRuntime` brings up the Lando-managed Podman API socket at `$HOME/.local/share/lando/runtime/run/podman.sock`. Managed-CLI live suites require an explicit, answering `LANDO_TEST_PODMAN_SOCKET` that matches their Paths-resolved managed socket; a different socket does not enable them. Teardown is `dist/lando poweroff`.

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
bun test core/test/live
bun test plugins/provider-lando/test --filter=integration
bun test plugins/provider-docker/test --filter=integration
bun test plugins/service-lando/test --filter=integration
```

### Run the database journey spot checks

After setup, retain the prepared runtime's Lando roots and opt in to its managed
socket. Use the same compiled binary that performed setup; the example uses the
integration job's `dist/lando` artifact:

```bash
export LANDO_TEST_PODMAN_SOCKET="$(bun -e 'import { makeLandoPaths } from "@lando/paths"; console.log(makeLandoPaths().providerSocketPath)')"
LANDO_TEST_USE_REAL_ROOTS=1 \
LANDO_SCENARIO_E2E_BINARY="$PWD/dist/lando" \
bun test core/test/live/mssql-transfer-roundtrip-live.integration.test.ts \
  core/test/live/mssql-transfer-failure-live.integration.test.ts \
  core/test/live/postgres-transfer-gzip-live.integration.test.ts
```

Require five passing scenarios, not a skipped run. They cover SQL Server 2019
and 2022, projected consumer credentials, gzip roundtrips, immediate warm reads,
creation records, failure receipts, and PostgreSQL authentication/export
atomicity. Each scenario purges only its unique app's volumes and snapshots.
Set `LANDO_TEST_ARTIFACT_ROOT` to an existing caller-owned directory to retain
sanitized per-command evidence after app teardown; remove that directory after
review.

### Run the bounded service journeys

The `service-listeners-linux-x64` nightly job runs four serial journeys against
the current compiled CLI: Mailpit with default and moved listeners, and MinIO
with default and independently moved API/console ports. These tests use the
explicit Podman API socket with isolated app roots; they do not require that
socket to match the managed-CLI gate used by the database suites above.

On Linux amd64, prepare an answering socket, a freshly built CLI, `curl`, and
`tar`. The MinIO fixture builds pinned official source and a checksum-verified
official `mc` inside a pinned Go container. It does not install host Go and is
not a Lando product image or a recommended MinIO distribution.

```bash
export LANDO_TEST_PODMAN_SOCKET="$(bun -e 'import { makeLandoPaths } from "@lando/paths"; console.log(makeLandoPaths().providerSocketPath)')"
export LANDO_SCENARIO_E2E_BINARY="$PWD/core/dist/lando"
export LANDO_TEST_MINIO_IMAGE="localhost/lando-listener-minio:qa-$(date +%s)"
bun scripts/build-service-listener-qa-image.ts "$LANDO_TEST_MINIO_IMAGE"
LANDO_TEST_LISTENERS_STRICT=1 bun test \
  plugins/service-lando/test/service-listener-journeys.integration.test.ts \
  --max-concurrency=1
```

Require four passing cases and the four-of-four completion summary, not just a
successful test-runner exit. The mail journeys send a unique message from a
second container and retrieve it through the inbox API. The object-storage
journeys roundtrip non-text bytes, reach the console, and check that startup
scans use the API health path rather than treating its unauthenticated root `403`
as a failed service.

Missing explicit prerequisites skip ordinary local collection; strict mode fails
them. Once execution is configured, image, startup, protocol, scan, and teardown
failures fail the run rather than becoming skips. Each case removes only its
unique apps, volumes and temporary roots. The image builder leaves the explicit
test tag for reuse; remove that tag, not shared images, when finished:

```bash
IMAGE_PATH="$(bun -e 'console.log(encodeURIComponent(process.env.LANDO_TEST_MINIO_IMAGE ?? ""))')"
test -n "$IMAGE_PATH" && curl --fail --noproxy '*' \
  --unix-socket "$LANDO_TEST_PODMAN_SOCKET" -X DELETE \
  "http://localhost/images/$IMAGE_PATH"
```

### Run the MCP completion spot check

With the same prepared roots and explicit managed socket, exercise the compiled
CLI rather than a synthetic producer:

```bash
LANDO_TEST_USE_REAL_ROOTS=1 \
LANDO_GUIDE_E2E=1 \
LANDO_SCENARIO_E2E_BINARY="$PWD/dist/lando" \
bun test core/test/live/mcp-command-completion-live.integration.test.ts
```

Require a positive passing test count. The journey covers final output with and
without progress subscriptions, exact exec arguments, process failure status,
redaction, bounded output tails, and quiet log followers canceled through the
protocol, stdin EOF, and SIGTERM. Missing prerequisites fail this explicitly
requested run. Tests create and destroy only their uniquely named app; they do
not run setup or reset the host. `LANDO_TEST_ARTIFACT_ROOT` also retains sanitized
protocol and shutdown evidence for this journey.

`LANDO_TEST_PODMAN_SOCKET` rehearsal fallback: provider-port suites can target a
different existing answering Podman socket with the override. This does not
enable the managed-CLI suites under `core/test/live`:

```bash
podman system service --time=0 unix:///tmp/podman.sock > /tmp/podman-service.log 2>&1 &
export LANDO_TEST_PODMAN_SOCKET=/tmp/podman.sock
export LANDO_CONFIG__default_provider_id=lando
export LANDO_TEST_DOCKER_SOCKET=/var/run/docker.sock
LANDO_TEST_PODMAN_SOCKET=/tmp/podman.sock bun test plugins/service-lando/test/postgres-config.integration.test.ts
```

The `providers` PR profile runs Linux x64 provider integration. Other platform-specific provider jobs remain part of broad CI. Fake-client provider contracts also run in the ordinary PR unit shards, independently of live socket availability.

Provider integration also runs as platform-specific jobs (`provider-integration-<platform>`). Every provider job runs the provider contract layer; `provider-integration-linux-x64` runs the live setup-driven Podman/Docker integration path above (contract suites run after `lando setup` so the live cases resolve the managed socket), while linux-arm64, macOS, and Windows targets stop after contract coverage so they do not require host sockets or mutate the host. Each provider job emits a `::notice title=ci-timing::...` line. Linux x64 splits live coverage into two required lanes, `providers` and `services`, each with a 35-minute timeout. Both lanes must pass. Linux arm64 has a 25-minute cap; macOS and Windows contract-only targets have 20-minute caps. Linux x64 diagnostic artifacts use `provider-integration-diagnostics-linux-x64-<runner>-<suite>` so each lane keeps its own results. If a provider integration job fails, download diagnostics from `Actions > ci > provider-integration-<platform> > Artifacts > provider-integration-diagnostics-<platform>`; for example, `Actions > ci > provider-integration-linux-x64 > Artifacts > provider-integration-diagnostics-linux-x64`.

## Lint guide YAML and negative fixtures

Run `bun run lint:guides` to validate identifiable Landofile fences and fixture files.
Full `.lando.yml` documents keep full authoring requirements, including native
`!reset` and `!override` placement checks. `.lando.*.yml` files are fragments.
Unrelated YAML, such as Actions workflows, Kubernetes resources, recipe manifests,
and command envelopes, is not validated as a Landofile. Unknown siblings do not
exclude a document that has a Landofile-specific key such as `services` or `tooling`.

For an intentionally invalid fixture, put `# lando-lint: expect-invalid REASON`
on its first physical line. A UTF-8 BOM before the comment and CRLF line endings
are accepted. Leading blank lines or license comments make the marker misplaced
and produce `guide.fixture.landofile-marker-placement`. Every marker asserts a
native authoring failure; its reason never selects another dialect, even when it
starts with `lando3`. A body that validates produces
`guide.fixture.landofile-unexpected-valid`. Keep the negative body invalid rather
than hiding it behind a skip.

Only a standalone `nolint` fence metadata token opts out. A title such as
`title="nolint-example.yaml"` or a quoted value containing `nolint` does not.

## Guide e2e smoke subset

The `guides`, `runtime`, and `providers` PR profiles run generated guide scenarios on Linux x64 and Windows x64. Broad CI runs them on all six platforms through `guide-scenarios-<platform>` jobs. Each job runs the full `bun run codegen` (there is no standalone guide-scenario codegen step; `core/test/build/ci-workflow.test.ts` asserts one is absent), validates guide metadata and transcript artifacts, then runs `test/scenarios/generated/guides/**` through the source-mapped guide scenario wrapper so failures annotate the MDX source.

CI sets `LANDO_GUIDE_SCENARIO_LIVE_OUTPUT=1` on both guide-scenario run steps. With it set, the wrapper tees the child's raw stdout and stderr as they arrive, between two banner lines, and still prints the source-mapped document after the child exits. The source-mapped document stays the authoritative output: the mapper is a whole-document transform that rewrites earlier lines from later stack frames, so it cannot be streamed line by line. That is why the live region is raw and unmapped, and why it repeats what the mapped document later shows. Without the variable, a local run keeps the single mapped document it prints today. Reproduce the CI shape locally:

```bash
LANDO_GUIDE_SCENARIO_LIVE_OUTPUT=1 bun run scripts/test-reporters/run-guide-scenarios.ts test/scenarios/generated/guides/**
```

The live region exists so a hung job leaves evidence of where it stopped; see the [windows-arm64 stall record](./guide-scenarios-windows-arm64-stall.md).

`bun run check:public-transcripts` is also a standalone clean-tree gate. When `dist/transcripts/public/guides` is empty after `bun run clean` or on a fresh clone, the command deterministically emits the public transcript corpus before checking its inventory. Existing or partially populated corpora are checked without regeneration, so missing-artifact diagnostics remain actionable. The generated corpus is gitignored and must not be committed.

Only `guide-scenarios-linux-x64` runs the e2e `@smoke` second pass. It downloads the Linux x64 compiled binary, provisions the same Podman socket used by provider integration, sets `LANDO_GUIDE_E2E=1`, and runs only generated tests whose names contain `@smoke` and `[e2e]`. E2e guide scenarios without the `@smoke` tag are not part of the PR gate; the nightly job below runs every `[e2e]` scenario:

```bash
LANDO_GUIDE_E2E=1 \
LANDO_SCENARIO_E2E_BINARY="$PWD/dist/lando" \
LANDO_TEST_PODMAN_SOCKET=/tmp/podman.sock \
bun run scripts/test-reporters/run-guide-scenarios.ts test/scenarios/generated/guides/** --test-name-pattern="@smoke.*\\[e2e\\]"
```

Failures still upload guide internal transcripts, plus `guide-e2e-provider-diagnostics-<run-id>` with the Podman service log and recent journal output.

## Nightly provider-lando e2e

The nightly workflow keeps host-mutating provider-lando e2e coverage out of the per-PR gate. The `provider-lando-e2e-linux-x64` job runs `bun run codegen`, installs Podman on `ubuntu-24.04`, sets `net.ipv4.ip_unprivileged_port_start=0` for rootless low-port binds, provisions a private Podman socket, builds the Linux x64 compiled binary, then runs every generated `[e2e]` guide scenario (smoke or not) against that binary, followed by the `core/test/live` integration suites:

```bash
sudo sysctl net.ipv4.ip_unprivileged_port_start=0
podman system service --time=0 unix:///tmp/podman.sock > /tmp/podman-service.log 2>&1 &
export LANDO_TEST_PODMAN_SOCKET=/tmp/podman.sock
export LANDO_CONFIG__default_provider_id=lando
LANDO_GUIDE_E2E=1 LANDO_GUIDE_SCENARIO_LIVE_OUTPUT=1 LANDO_SCENARIO_E2E_BINARY="$PWD/core/dist/lando" bun run scripts/test-reporters/run-guide-scenarios.ts test/scenarios/generated/guides/** --max-concurrency=1 --test-name-pattern="\[e2e\]"
LANDO_TEST_PODMAN_SOCKET=/tmp/podman.sock bun test core/test/live
```

Failures upload `provider-lando-e2e-diagnostics-linux-x64` with the Podman service log, the guide internal transcripts, and recent journal output. Notification routing is intentionally limited to normal GitHub Actions failure reporting in Beta.

## Provider matrix

The `provider-matrix` workflow runs weekly, on manual dispatch, on pull request when provider-matrix or Docker exec paths change, and automatically after the runtime-bundle publisher successfully repins the committed runtime-bundle manifest on `main`. The publisher dispatch uses the GitHub Actions API (`gh workflow run provider-matrix.yml --ref main`) because its manifest-repin push uses `github.token` and does not trigger another `push:` workflow.

Pull requests build the container helper and run `provider-contracts-docker-latest`, not the full matrix. That job selects the `docker-engine-linux-latest` cell to test exec file permissions against the current Docker Engine. The job-level `if` filters by event name, not `matrix.cell`, because GitHub evaluates it before expanding the matrix.

Cells cover Docker Desktop, Docker Engine, Podman Desktop, Podman, Lima, and OrbStack surfaces, plus the Lando-managed Podman 6 runtime. Native machine lifecycle cells separately cover managed Lando and system Podman machines on macOS and Windows. The matrix is structured provider acceptance, not advisory contract-only coverage. Each cell writes a JSON report with a `passed`, `failed`, or `skipped` outcome; release-blocking cells fail the workflow when they fail or skip. Advisory desktop-only cells still emit a `::notice` skip on GitHub-hosted runners so maintainers can mirror them on prepared self-hosted runners.

The native machine cells are advisory because GitHub-hosted macOS and Windows runners do not provide a dependable nested-virtualization contract. Prepared runners opt in with `LANDO_TEST_PROVIDER_LANDO_MACHINE_LIFECYCLE=1` or `LANDO_TEST_PROVIDER_PODMAN_MACHINE_LIFECYCLE=1`; `LANDO_TEST_PODMAN_COMMAND` may select the prepared Podman binary. Missing opt-in, unsupported hosts, and absent Podman tooling produce structured skips. Once opted in with tooling present, start/stop/restart/destroy failures are recorded as failed cells, never passes. The Docker Engine, Lando-managed Linux, and system Podman 6 Linux cells remain release-blocking.

Every cell regenerates derived sources before acceptance so plugin tests can import generated bundled modules. The `docker-engine-linux-latest` cell runs on `ubuntu-26.04` and installs unpinned `docker-ce` from Docker's apt repository. It then asserts that `exec-umask-mode` passed: a missing, skipped, or failed check fails the job even though the cell is not marked release-blocking. Keep this cell out of required status checks until it has a record of passing on `main`.

Release-blocking installable cells run the relevant provider contract suite plus live acceptance checks for setup readiness, app bring-up/bring-down, exec, logs, inspect/health, image resolution, and volume cleanup:

```bash
bun test plugins/provider-lando/test/contract.integration.test.ts
bun test plugins/provider-docker/test/contract.integration.test.ts
bun test plugins/provider-podman/test/contract.integration.test.ts
```

Failures upload `provider-matrix-report-<cell>` JSON and `provider-matrix-diagnostics-<cell>` artifacts when logs are available. The matrix is release-blocking for published runtime-bundle manifest acceptance even though it is not listed as a per-PR branch-protection check for Beta.

## Platform readiness

Compile smoke and relocated-binary smoke do not satisfy live `lando setup` or `lando doctor`. Live host readiness is a separate gate.

The generated workflow is `.github/workflows/platform-readiness.yml`, produced by `scripts/build-platform-readiness-workflow.ts`. Do not hand-edit the YAML.

`platform-readiness` runs on its schedule and manual dispatch, not on pull requests. Linux x64 uses Ubuntu 26.04; Linux arm64 uses `ubuntu-24.04-arm`. Both use the default provider `lando`.

Linux current-commit assemble uses the same Go, Rust, and Ubuntu snapshot source-build prerequisites as `runtime-bundle`.

Current-commit assembly (`scripts/assemble-runtime-bundle.ts`) downloads each pinned component through `fetchOverHttps` in `scripts/runtime-bundle-fetch.ts`. A network failure, a body-read failure, or an HTTP 429/5xx gets four attempts with 250, 500, and 1000 ms delays between them. Any other HTTP failure (404, 403, and so on) fails on the first attempt. After the final transport or body-read failure, the error includes the pinned URL and underlying error message. A SHA-256 mismatch fails closed and is not retried.

This is separate from the product setup downloader that `lando setup` uses against the published manifest; that has its own cache, offline, and retry behavior. When assembly fails after exhausting retries, inspect the named component artifact upstream and the runner's connectivity. Do not change a pin just to make the job pass.

On `schedule` and `workflow_dispatch`, darwin and windows cells run on self-hosted labels `[self-hosted, lando-virt, <OS>, <ARCH>]`. These cells accept only `main`; manually dispatching another branch cannot run its code on a self-hosted runner. A missing runner is a job error, not a skip.

darwin-x64 already has Docker installed on the runner. The job must not install Docker Desktop. Use `--provider=docker` on that cell.

windows-x64 requires Hyper-V and WSL2. The live path does not structured-skip when those are missing.

windows-arm64 assembles the current-commit `win32-arm64` runtime bundle. Missing `lando-virt` runners still fail the job rather than skip.

The doctor gate is `scripts/platform-readiness-doctor.ts`, not jq. Isolate `LANDO_USER_CONF_ROOT`, `LANDO_USER_DATA_ROOT`, and `LANDO_USER_CACHE_ROOT` for that run.

`provider-integration-*` jobs on darwin, linux-arm64, and windows-arm64 remain contract-only. They are not this live setup/doctor path.

CI/release platform id `windows-x64` is not the runtime host key `win32-x64`. Keep both names in their existing domains.

## Drupal journey

The live Drupal recipe path is a separate gate from compile smoke and from linux-x64 guide e2e `@smoke`.

The generated workflow is `.github/workflows/drupal-journey.yml`, produced by `scripts/build-drupal-journey-workflow.ts`. Do not hand-edit the YAML. The gate script is `scripts/drupal-journey.ts`.

The live path is `lando init --recipe drupal`, `lando start`, `lando info`, README scaffold plus Drush (`drupal-scaffold` then `drush`), then `lando destroy -y`. It runs on all six compile targets.

The journey runs on its schedule and manual dispatch, not on pull requests. Linux x64 uses Ubuntu 26.04; Linux arm64 uses `ubuntu-24.04-arm`. Darwin and Windows use self-hosted labels `[self-hosted, lando-virt, <OS>, <ARCH>]`, restricted to `main`. A missing runner is a job error, not a skip.

darwin-x64 uses `--provider=docker`. The job must not install Docker Desktop. Other cells use the default provider `lando`.

Isolate `LANDO_USER_CONF_ROOT`, `LANDO_USER_DATA_ROOT`, and `LANDO_USER_CACHE_ROOT` for that run. Timeout is 90 minutes. The path is Composer-heavy.

## Rails journey

The live Rails recipe path is a separate gate from compile smoke and from linux-x64 guide e2e `@smoke`.

The generated workflow is `.github/workflows/rails-journey.yml`, produced by `scripts/build-rails-journey-workflow.ts`. Do not hand-edit the YAML. The gate script is `scripts/rails-journey.ts`.

The live path is `lando init --recipe rails`, `lando start`, `lando info`, README tooling (`lando rails` / `lando bundle`), then `lando destroy -y`. It runs on all six compile targets.

The journey runs on its schedule and manual dispatch, not on pull requests. Linux x64 uses Ubuntu 26.04; Linux arm64 uses `ubuntu-24.04-arm`. Darwin and Windows use self-hosted labels `[self-hosted, lando-virt, <OS>, <ARCH>]`, restricted to `main`. A missing runner is a job error, not a skip.

darwin-x64 uses `--provider=docker`. The job must not install Docker Desktop. Other cells use the default provider `lando`.

Isolate `LANDO_USER_CONF_ROOT`, `LANDO_USER_DATA_ROOT`, and `LANDO_USER_CACHE_ROOT` for that run. Timeout is 90 minutes. The path is not Composer-heavy.

## Install, use, and uninstall on compatibility hosts

The scheduled/manual `install-lifecycle` workflow runs one lifecycle on Ubuntu 24.04 and one on `[self-hosted, lando-virt, Windows, X64]`. Both accept only `main`. Windows needs a dedicated fresh WSL-capable runner with no existing `podman-lando` machine; missing virtualization is a failure, not a skip.

The scenario installs the current compiled payload outside the checkout through the real installer, checks checksum and installer ownership, runs setup, starts nginx, checks its HTTP response through `lando exec`, destroys the app, and runs `uninstall --yes --purge`. It verifies removal of the executable, install record, runtime directory, and Windows machine registration. Each run uploads its JSON evidence, including failures.

Distribution signatures use an explicitly labeled test-only verifier fixture. This checks installer publication and ownership with real SHA256, not release-signature validity. Signature trust remains covered independently by installer tests.

Do not run this purge scenario on a workstation or shared runtime. Isolated Lando roots do not contain host-global socket-proxy/cgroups integration or all provider cleanup. The script requires `LANDO_LIFECYCLE_FRESH_RUNNER=1` and rejects existing host integration and Lando resources before installation. Inspect the command and prerequisites with `bun run scripts/install-lifecycle-journey.ts --help`.

## Alpha platform scope

Public Alpha 1 live evidence is six compile targets, not Linux x64 only. Compile smoke is not an Alpha exit. Live `lando setup` and `lando doctor` run in `platform-readiness`. The Drupal canonical journey runs in `drupal-journey`. The Rails canonical journey runs in `rails-journey`. Each generated workflow covers all six compile targets. Darwin and Windows cells are fail-closed self-hosted `lando-virt` jobs; a missing runner is an error, not a skip. Main, manual CI, and PRs changing the root `.bun-version` run the broad hosted matrix; other PRs select their smaller path-based profile. Nightly cron owns full provider-lando e2e on Linux x64; the weekly provider matrix owns cross-engine acceptance coverage.

## Docs build

The `docs-build` job runs on Linux x64 for every PR profile and broad CI. Its result is enforced by the required `ci` check. Reproduce it locally:

```bash
bun run docs:check
bun run docs:test
bun run docs:build
test -f docs/dist/reference/schemas/app-plan/index.html
```

| Job | Commands |
| --- | --- |
| `docs-build` | `bun run docs:check`, `bun run docs:test`, `bun run docs:build`, then confirm `docs/dist/reference/schemas/app-plan/index.html` |

## Branch protection

Protect `main` in GitHub with required status checks enabled. Require this single status check before a pull request can merge to `main`:

- `ci`

When adopting this workflow, replace the previous per-job required status checks with `ci` in the repository's branch protection or ruleset. Workflow edits do not change GitHub settings. Legacy job names remain visible, but an intentionally skipped legacy check is not proof that the selection passed.

The final `ci` job always runs. It requires successful selection and every selected gate; a selected job that fails, is cancelled, or is unexpectedly skipped fails `ci`. Only policy-excluded jobs may be skipped. The dependency-audit workflow and scheduled self-hosted evidence workflows are not PR merge gates.

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

The default developer and CI install remains hoisted `bun install --frozen-lockfile`. Do not commit `linker = "isolated"` and do not make the global store the local default. `bun run dedupe` and `bun run prune` are maintainer recipes; prune is destructive and must not run in CI. `bun dedupe` is not a no-op on the current lockfile, so it is not scheduled.

A non-blocking linux-x64 experiment job (`bun-install-isolated-experiment`, `continue-on-error: true`) runs:

```bash
BUN_INSTALL_GLOBAL_STORE=1 bun install --linker=isolated --frozen-lockfile
```

That command succeeds against this lockfile without rewriting it. The hoisted frozen install stays the merge gate until the isolated global store is no longer experimental.
