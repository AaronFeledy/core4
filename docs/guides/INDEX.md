# Beta Feature Coverage Matrix

This matrix maps each user-facing Beta PRD feature to the executable guide(s) that
exercise it. The first table is the union of every PRD's `## Guide Coverage` section;
internal/infra PRD 13 declares no guides and is intentionally absent. The
supplementary sections at the end list capability guides that are **not owned by a Beta
PRD** (core service types and end-to-end tutorials that predate the Beta milestone) — they
carry no PRD or User Story and exist purely as capability documentation plus tests.

`Status` is `Shipped` when the guide file exists on disk and `Planned` when the owning
story has not yet landed its guide. `bun run check:guide-coverage` validates that every
guide path declared in a PRD's `## Guide Coverage` section appears below and that every
`Shipped` row references a real `docs/guides/<path>.mdx` file.

| PRD | User Story | Feature | Guide Path | Status |
|---|---|---|---|---|
| PRD-01 | US-074 | provider-lando Windows VM lifecycle | `docs/guides/setup/provider-lando-windows.mdx` | Shipped |
| PRD-01 | US-077 | provider-docker on Windows (Docker Desktop) | `docs/guides/setup/provider-docker-windows.mdx` | Shipped |
| PRD-01 | US-078 | @lando/provider-podman opt-in on Linux | `docs/guides/setup/provider-podman-linux.mdx` | Shipped |
| PRD-01 | US-079 | @lando/provider-podman on macOS via Podman Desktop | `docs/guides/setup/provider-podman-macos.mdx` | Shipped |
| PRD-01 | US-079 | @lando/provider-podman on Windows via Podman Desktop | `docs/guides/setup/provider-podman-windows.mdx` | Shipped |
| PRD-01 | US-082 | provider selection precedence + conflict diagnostics | `docs/guides/setup/provider-selection.mdx` | Shipped |
| PRD-01 | US-205, US-206 | safe uninstall and purge choices | `docs/guides/setup/uninstall-and-purge.mdx` | Shipped |
| PRD-01 | US-207 | source and compiled setup parity | `docs/guides/setup/compiled-binary-setup-parity.mdx` | Shipped |
| PRD-02 | US-210 | Provider setup default UX | `docs/guides/setup/provider-auto-setup.mdx` | Shipped |
| PRD-02 | US-211 | Compose subset compatibility matrix | `docs/guides/config/compose-compatibility.mdx` | Shipped |
| PRD-02 | US-213 | Plugin trust commands and postinstall gating | `docs/guides/plugins/trust-postinstall.mdx` | Shipped |
| PRD-02 | US-214 | Trust list/revoke and scope decision | `docs/guides/plugins/trust-management.mdx` | Shipped |
| PRD-06 | US-240 | CLI default-on and library default-off telemetry behavior | `docs/guides/telemetry/defaults-and-precedence.mdx` | Shipped |
| PRD-06 | US-241 | Telemetry opt-out controls | `docs/guides/telemetry/disable-telemetry.mdx` | Shipped |
| PRD-06 | US-242 | Update outcome and deprecation telemetry visibility | `docs/guides/telemetry/update-and-deprecation-events.mdx` | Shipped |
| PRD-03 | US-221 | CLI deprecation warnings and suppression | `docs/guides/deprecations/cli-warnings-and-suppression.mdx` | Shipped |
| PRD-03 | US-219 | Plugin manifest and globalServices deprecations | `docs/guides/plugins/deprecating-plugin-surfaces.mdx` | Shipped |
| PRD-04 | US-224 | JSON Schema artifacts for public schemas | `docs/guides/schemas/json-schema-artifacts.mdx` | Shipped |
| PRD-04 | US-225 | `@lando/sdk/schema` registry and metadata index | `docs/guides/schemas/schema-registry.mdx` | Shipped |
| PRD-04 | US-227 | Generated schema reference pages | `docs/guides/schemas/generated-reference-docs.mdx` | Shipped |
| PRD-05 | US-230 | Scaffold a plugin from a bundled template | `docs/guides/plugins/authoring-new-plugin.mdx` | Shipped |
| PRD-05 | US-231, US-232 | Test and build an authored plugin | `docs/guides/plugins/test-and-build-plugin.mdx` | Shipped |
| PRD-05 | US-233, US-234 | Link and unlink a local plugin | `docs/guides/plugins/link-local-plugin.mdx` | Shipped |
| PRD-05 | US-235 | Dry-run publish a plugin artifact | `docs/guides/plugins/publish-plugin.mdx` | Shipped |
| PRD-07 | US-243 | Public reader-scenario transcripts | `docs/guides/authoring/public-transcripts.mdx` | Shipped |
| PRD-07 | US-245 | Library-mode guides | `docs/guides/embedding/library-mode-guide-scenarios.mdx` | Shipped |
| PRD-07 | US-246 | E2e guide-scenario smoke layer | `docs/guides/authoring/e2e-smoke-scenarios.mdx` | Shipped |
| PRD-07 | US-250 | canonical recipe guide acceptance path | `docs/guides/recipes/canonical-public-transcript.mdx` | Shipped |
| PRD-08 | US-251, US-252 | Release orchestrator rehearsal | `docs/guides/release/local-rehearsal.mdx` | Shipped |
| PRD-08 | US-253 | Deprecation gate in release | `docs/guides/release/deprecation-gate.mdx` | Shipped |
| PRD-08 | US-254, US-255, US-256 | Platform signing overview | `docs/guides/release/signing-artifacts.mdx` | Shipped |
| PRD-08 | US-257 | Bytecode compile and budget | `docs/guides/release/compiled-bytecode-budget.mdx` | Shipped |
| PRD-09 | US-258, US-259, US-260 | Verifying release artifacts | `docs/guides/release/verify-supply-chain-artifacts.mdx` | Shipped |
| PRD-09 | US-261 | Update channels and signed manifests | `docs/guides/update/channels-and-manifests.mdx` | Shipped |
| PRD-09 | US-265 | Update permission remediation | `docs/guides/update/permission-errors.mdx` | Shipped |
| PRD-10 | US-266 | Manual GitHub Releases install | `docs/guides/install/github-releases.mdx` | Shipped |
| PRD-10 | US-267, US-269 | POSIX curl-pipe installer | `docs/guides/install/posix-installer.mdx` | Shipped |
| PRD-10 | US-268, US-269 | Windows PowerShell installer | `docs/guides/install/windows-installer.mdx` | Shipped |
| PRD-10 | US-270 | PATH and setup after install | `docs/guides/install/path-and-setup.mdx` | Shipped |
| PRD-10 | US-271 | Verifying installer scripts | `docs/guides/install/verify-installer-scripts.mdx` | Shipped |
| PRD-02 | US-083 | go service type | `docs/guides/services/go.mdx` | Shipped |
| PRD-02 | US-084 | mongodb service type | `docs/guides/services/mongodb.mdx` | Shipped |
| PRD-02 | US-085 | memcached service type | `docs/guides/services/memcached.mdx` | Shipped |
| PRD-02 | US-086 | valkey service type (dual-scheme emission) | `docs/guides/services/valkey.mdx` | Shipped |
| PRD-02 | US-087 | solr service type | `docs/guides/services/solr.mdx` | Shipped |
| PRD-02 | US-088 | elasticsearch service type | `docs/guides/services/elasticsearch.mdx` | Shipped |
| PRD-02 | US-089 | opensearch service type | `docs/guides/services/opensearch.mdx` | Shipped |
| PRD-02 | US-090 | meilisearch service type | `docs/guides/services/meilisearch.mdx` | Shipped |
| PRD-02 | US-093 | static service type | `docs/guides/services/static.mdx` | Shipped |
| PRD-02 | US-094 | raw Compose passthrough service | `docs/guides/services/compose-passthrough.mdx` | Shipped |
| PRD-03 | US-097 | Mutagen host CLI + agent download via `lando setup` | `docs/guides/setup/file-sync-mutagen.mdx` | Shipped |
| PRD-03 | US-099 | exclude patterns (volume-shadow + Mutagen ignores) | `docs/guides/setup/file-sync-excludes.mdx` | Shipped |
| PRD-04 | US-101 | ProxyService + Traefik via global app | `docs/guides/subsystems/proxy-traefik.mdx` | Shipped |
| PRD-04 | US-102 | CertificateAuthority via @lando/ca-mkcert | `docs/guides/subsystems/certificates-mkcert.mdx` | Shipped |
| PRD-04 | US-103 | SshService sidecar (default) | `docs/guides/subsystems/ssh-sidecar.mdx` | Shipped |
| PRD-04 | US-104 | HealthcheckService (tcp/http/cmd probes) | `docs/guides/subsystems/healthcheck-runner.mdx` | Shipped |
| PRD-04 | US-105 | ScannerService endpoint discovery + port-collision detection | `docs/guides/subsystems/scanner-service.mdx` | Shipped |
| PRD-04 | US-106 | HostProxyService (`lndo.site`-style hostnames) | `docs/guides/subsystems/host-proxy.mdx` | Shipped |
| PRD-04 | US-108 | `lando doctor` subsystem walkthrough | `docs/guides/subsystems/doctor-walkthrough.mdx` | Shipped |
| PRD-05 | US-111 | GlobalAppService + reserved id `global` | `docs/guides/global/install-and-bundled-services.mdx` | Shipped |
| PRD-05 | US-116 | `meta:global:*` CLI namespace incl. uninstall | `docs/guides/global/uninstall-and-purge.mdx` | Shipped |
| PRD-05 | US-119 | global-app integration with `lando doctor` | `docs/guides/global/doctor-walkthrough.mdx` | Shipped |
| PRD-06 | US-122 | fork mode (`apps:scratch:start --fork=<app>`) | `docs/guides/scratch/fork-existing-app.mdx` | Shipped |
| PRD-06 | US-123 | scratch mode (`apps:scratch:start --recipe=<id>`) | `docs/guides/scratch/scratch-from-recipe.mdx` | Planned |
| PRD-06 | US-126 | scratch registry garbage collection (`apps:scratch:gc`) | `docs/guides/scratch/scratch-gc.mdx` | Shipped |
| PRD-06 | US-127 | `--mount-cwd` + `--share-global-storage` flags | `docs/guides/scratch/mount-and-share-flags.mdx` | Shipped |
| PRD-06 | US-128 | `apps:scratch:list` + `apps:scratch:info` | `docs/guides/scratch/list-and-info.mdx` | Shipped |
| PRD-07 | US-129 | remote recipe sources (git, tarball, npm, registry) | `docs/guides/recipes/remote-sources.mdx` | Shipped |
| PRD-07 | US-134 | `runs:` allowlist + ctx.run | `docs/guides/recipes/authoring-runs-allowlist.mdx` | Shipped |
| PRD-07 | US-135 | `fetchAllowlist:` + ctx.fetch | `docs/guides/recipes/authoring-fetch-allowlist.mdx` | Shipped |
| PRD-07 | US-136 | programmatic recipe.ts | `docs/guides/recipes/programmatic-recipe.mdx` | Shipped |
| PRD-08 | US-139 | `includes:` + .lando.lock.yml | `docs/guides/landofile/includes-and-lockfile.mdx` | Shipped |
| PRD-08 | US-142 | configuration expressions (parser + evaluator) | `docs/guides/landofile/expressions.mdx` | Planned |
| PRD-08 | US-144 | bundled template engines — Handlebars + Mustache | `docs/guides/landofile/template-engines.mdx` | Shipped |
| PRD-08 | US-145 | env overrides | `docs/guides/landofile/env-overrides.mdx` | Shipped |
| PRD-08 | US-148 | `app:config:translate` command | `docs/guides/landofile/config-translate.mdx` | Shipped |
| PRD-08 | US-195 | `app:config:lint` command (IDE / standalone) | `docs/guides/landofile/config-lint.mdx` | Shipped |
| PRD-10 | US-159 | tooling bootstrap level + cache-only app-plan read | `docs/guides/tooling/composer-php.mdx` | Shipped |
| PRD-10 | US-163 | service-mode `lando shell` | `docs/guides/tooling/lando-shell.mdx` | Shipped |
| PRD-10 | US-164 | tooling output via renderer task tree | `docs/guides/tooling/output-streaming.mdx` | Shipped |
| PRD-11 | US-165 | `meta:plugin:add` against npm | `docs/guides/plugins/install-from-npm.mdx` | Shipped |
| PRD-11 | US-167 | postinstall trust gating (incl. wildcards) | `docs/guides/plugins/trust-and-wildcards.mdx` | Planned |
| PRD-11 | US-168 | system / user / app plugin discovery scopes | `docs/guides/plugins/discovery-scopes.mdx` | Shipped |
| PRD-11 | US-173 | library-mode defaults | `docs/guides/library/embedding-defaults.mdx` | Shipped |
| PRD-11 | US-272 | Testing API and deterministic TestRuntime | `docs/guides/library/testing-runtime.mdx` | Shipped |
| PRD-11 | US-273, US-274, US-289, US-290, US-291, US-292 | Library entry points, `makeLandoRuntime`, `openLandoRuntime`, and App handles | `docs/guides/library/embedding-runtime.mdx` | Shipped |
| PRD-11 | US-275 | Plugin SDK compatibility declaration | `docs/guides/plugins/sdk-compatibility.mdx` | Shipped |
| PRD-11 | US-276, US-277, US-278, US-279 | Linux-x64 §17.9 acceptance rehearsal | `docs/guides/release/linux-acceptance-rehearsal.mdx` | Shipped |
| PRD-12 | US-280, US-281, US-283 | Bundled default terminal renderer visual language | `docs/guides/cli/terminal-ui-polish.mdx` | Shipped |
| PRD-12 | US-282 | OpenTUI-backed interactive prompts | `docs/guides/cli/interactive-prompts.mdx` | Shipped |
| PRD-12 | US-284 | Terminal renderer visual QA | `docs/guides/contributing/terminal-renderer-visual-qa.mdx` | Shipped |
| PRD-12 | US-425, US-426, US-427, US-428, US-429 | `lando logs` with declared file sources and `--source` | `docs/guides/cli/service-logs.mdx` | Shipped |
| PRD-15 | US-329 | Driving Lando from JSON / an agent | `docs/guides/scripting-with-json.mdx` | Shipped |
| BETA1-PRD-14 | US-451 | Host-proxy doctor transport reachability and bounded persisted-worker diagnostics | `docs/guides/subsystems/doctor-walkthrough.mdx` | Shipped |
| BETA1-PRD-15 | US-455, US-456, US-458 | OpenTUI substrate, split-footer live region, degradation, and foreground desktop notifications (future ownership; not yet landed in this guide's body) | `docs/guides/cli/terminal-ui-polish.mdx` | Planned |
| BETA1-PRD-15 | US-457 | Prompt chrome polish and the frame-snapshot harness (future ownership; not yet landed in this guide's body) | `docs/guides/cli/interactive-prompts.mdx` | Planned |
| BETA1-PRD-15 | US-457 | Frame-snapshot / visual-QA coverage for the renderer substrate (future ownership; not yet landed in this guide's body) | `docs/guides/contributing/terminal-renderer-visual-qa.mdx` | Planned |

## Core service catalog (capability guides — no PRD mapping)

These service types shipped before the Beta milestone, so they are not owned by a Beta PRD
and carry no User Story. Their guides run on the same `provider: test` scenario harness as
the Beta guides above.

| PRD | User Story | Feature | Guide Path | Status |
|---|---|---|---|---|
| — | — | php service type (runtime + framework presets) | `docs/guides/services/php.mdx` | Shipped |
| — | — | node service type | `docs/guides/services/node.mdx` | Shipped |
| — | — | python service type | `docs/guides/services/python.mdx` | Shipped |
| — | — | ruby service type | `docs/guides/services/ruby.mdx` | Shipped |
| — | — | mysql service type | `docs/guides/services/mysql.mdx` | Shipped |
| — | — | mariadb service type | `docs/guides/services/mariadb.mdx` | Shipped |
| — | — | postgres service type | `docs/guides/services/postgres.mdx` | Shipped |
| — | — | redis service type | `docs/guides/services/redis.mdx` | Shipped |
| — | — | nginx service type | `docs/guides/services/nginx.mdx` | Shipped |
| — | — | apache service type | `docs/guides/services/apache.mdx` | Shipped |

## Tutorials (capability guides — no PRD mapping)

End-to-end tutorials that exercise several capabilities at once.

| PRD | User Story | Feature | Guide Path | Status |
|---|---|---|---|---|
| — | — | everyday app lifecycle (start / inspect / exec / restart / destroy) | `docs/guides/tutorial/app-lifecycle.mdx` | Shipped |
| — | — | Node + Postgres app scaffolded from a recipe | `docs/guides/node-postgres.mdx` | Shipped |

## Recipe stacks (executable recipe READMEs — no PRD mapping)

Each bundled application-stack recipe ships an executable `recipes/<id>/README.mdx`
guide that scaffolds the stack with `lando init --recipe <id>`, starts it, and tears
it down. These run on the same `provider: test` scenario harness; their paths are
outside `docs/guides/` so they are not gate-validated here.

| Recipe | Stack | Guide Path | Status |
|---|---|---|---|
| `lamp` | Apache + PHP + MariaDB | `recipes/lamp/README.mdx` | Shipped |
| `lemp` | Nginx + PHP + MariaDB | `recipes/lemp/README.mdx` | Shipped |
| `wordpress` | WordPress (PHP + MariaDB, WP-CLI) | `recipes/wordpress/README.mdx` | Shipped |
| `drupal` | Drupal 11 (PHP + MariaDB/Postgres, Drush) | `recipes/drupal/README.mdx` | Shipped |
| `drupal-cms` | Drupal CMS / Starshot (PHP + MariaDB/Postgres, Drush) | `recipes/drupal-cms/README.mdx` | Shipped |
