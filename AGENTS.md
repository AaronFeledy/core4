# AGENTS.md

This file is for non-obvious repo context only. It is a living document that you should keep up to date. If you lose time to a repo quirk that should have been documented, update this file with the smallest useful note.

## Context

- Lando Core v4 is a Bun workspace for `@lando/core`, `@lando/sdk`, and bundled reference plugins under `plugins/*`.

## Commands

- Use Bun, not Node/npm/yarn/pnpm: `bun install`, `bun run typecheck`, `bun run lint`, `bun test`, `bun run build`.
- Run a focused test by path, e.g. `bun test core/test/unit/bootstrap.test.ts`.
- Root `typecheck` is `tsc -b`; it may create `dist/` and `.tsbuildinfo` despite older prose saying no emit. `bun run clean` removes generated package outputs.
- For a single workspace package, follow the repo's Bun filter style, e.g. `bun run --filter='@lando/core' typecheck`.
- After adding a new `plugins/*` workspace package, run `bun install` so root `node_modules` gets the workspace symlink before testing imports from the repo root.
- For manual `lando` CLI execution that might alter the host, enter the `lando4-dev` tmux workflow from `.local/DEV-ENV.md`; do not use host `sudo` just to enter the sandbox.

## Gotchas

- **CLI fast path:** `core/src/cli/index.ts` must not statically import OCLIF, Effect, or transitives — ESM hoists imports before `import.meta.main`. Use dynamic `import()` from a wrapper. Full CLI: `core/bin/lando.ts`.
- **Compile entry:** `bun build --compile` must target `core/bin/lando.ts`, not `core/src/cli/index.ts` (the latter silently exits 0 for `--help` and all commands).
- **Compiled binary:** Until full OCLIF routing, each CLI command needs a matching handler in `core/src/cli/run.ts` (`$bunfs`), including error `remediation` and `NotImplementedError` parity. Do not use `import.meta.url` for package metadata or install dir — use `core/src/version.ts` and `process.execPath` (`shellenv`).
- **OCLIF tests/manifest:** Fixture tests need `ignoreManifest: true` on `Config.load`. Generate manifest via `bun run codegen`, not `bunx oclif manifest` (Bun breaks on workspace TS symlinks).
- **Fresh CLI vs provider cache:** Stop/info/destroy in a new process cannot rely on in-memory applied plans — pass `AppPlan` via `AppSelector.plan` / `ServiceSelector.plan`.
- **FileSystem:** `writeAtomic` is copy-based, not crash-atomic rename. `remove` deletes files only, not directories.
- **CI codegen:** Bun version comes from `.bun-version`, not `package.json#engines.bun` (semver range broke lockfile alignment).
- **Capability gates run in the planner**, against the provider-neutral `ServicePlan` returned by `serviceType.toServicePlan(...)`, before encoding into `AppPlan`. Each gate must fail with `CapabilityError` carrying `service`, `feature`, `capability`, `providerId`, and `remediation` (see `core/src/services/planner.ts`). Provider capability matrices belong in the plugin (e.g. `plugins/provider-lando/src/capabilities.ts`) and should be derived via `Schema.decodeSync(ProviderCapabilities)` so adding a field fails loudly.
- **Bind-mount realization is a planner hint, not a runtime promise.** Planner emits `"accelerated"` on slow providers, but no provider actually accelerates yet (FileSyncEngine §10.6 is unimplemented). Provider apply layers must accept both `"passthrough"` and `"accelerated"` realizations or bind mounts will be silently dropped on slow providers (macOS, VM-Docker).
- **Endpoint capability checks must exclude unix-socket endpoints.** `endpoint.port` is `undefined` for `protocol: "unix"` endpoints with a `socketPath`; gate on `endpoint.port !== undefined` so socket-only services don't fail the `hostPortPublish` check.
- **Do not run `bun test` and `bun run build` concurrently.** Compiled-binary tests rewrite and execute `core/dist/lando`; parallel runs hit `EACCES` on the live binary.
- **Planner aggregates per-service `storage` into `appPlan.stores` automatically** (default `scope: "service"`, deduped by store name). Service types only need to emit `storage[]` mounts on the `ServicePlan`; the `DataStorePlan` rows in `AppPlan.stores` that drive provider destroy semantics are derived. Provider apply code that intends to honor `service.storage` still needs to wire those mounts into container Mounts/Binds itself — `appPlan.stores` is the destroy-side contract only.
- **Compose service type accepts `service.composeBuild` (Compose-spec `{ context, dockerfile, args, target }`), not `service.build` (Lando-style artifact/app scripts).** They are intentionally separate fields because the Lando `build:` block carries BuildScript content while the Compose `build:` block carries Compose-spec build inputs. Provider-specific overrides for compose-typed services go under `service.providers.<id>` (per-service `ProviderExtensionConfig`) and surface as `servicePlan.extensions`.
- **Landofile parser object-form list items require a space after the colon.** `- key: value` is parsed as a map item; `- 3000:3000` (Compose port mapping) and `- ./src:/app` (volume short form) MUST stay scalars. The detector requires the key to start with a letter AND demands whitespace (or end-of-line) after the `:`. Loosening this regex silently mis-parses short-form ports/volumes as `{ "3000": 3000 }` and breaks every existing fixture.
- **Beta-deferred Landofile surfaces fail as `NotImplementedError`, not `LandofileValidationError`.** `LandofileService` pre-scans content for `${...}` / `{{ ... }}` configuration expressions (spec §7.3.1) and post-parses the parsed map for top-level `includes:` (§7.7), `secrets:` (§4.2/§7.4), and `env_file:` (§7.6) BEFORE schema decode, emitting `NotImplementedError({ commandId: "landofile.parse", specSection, remediation })`. Adding a new Beta-only section means widening `BETA_TOP_LEVEL_KEYS` in `core/src/landofile/service.ts` AND the `LandofileService.discover` / `AppPlanner.plan` error unions in `sdk/src/services/index.ts` plus every CLI command alias (`StartAppError`, `StopAppError`, `DestroyAppError`, `InfoAppError`).
- **Planner-level rejections (storage `scope: "global"`, capability gates) run AFTER `RuntimeProviderRegistry.capabilities`.** End-to-end CLI verification on hosts without a configured runtime provider fails earlier with `ProviderConfigError`; rely on unit tests in `core/test/services/app-planner.test.ts` to verify planner rejections.
- **`appMount.excludes` is realized as volume shadows by the planner**, not by service types. The planner re-applies authored `service.appMount.excludes/includes/readOnly` on top of the service-type-emitted `AppMountPlan`, expands each effective exclude (skipping `!`-prefixed entries and entries in `includes`) into a service-scope `DataStorePlan` named `<appName>-<service>-<kebab(target/excludePath)>`, and appends matching `DataStoreMountPlan`s to `ServicePlan.storage`. Catalog service types may keep emitting `excludes: []` defaults without per-type plumbing. Provider apply layers must still wire those shadow mounts into actual container Mounts/Binds — the planner only surfaces the destroy-side contract.
